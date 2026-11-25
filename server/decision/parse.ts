import {
  DemandGroup,
  ParsePatch,
  Scenario,
  ScenarioEdge,
  TraceStep,
  ValidationIssue,
} from "../../shared/types";
import { parseWithLlm, llmConfigured, LlmParseOutput } from "./llm";
import { TraceRecorder } from "./trace";

export interface RuleParseResult {
  patch: ParsePatch[];
  summary: string;
  warnings: string[];
}

export interface ParseOutcome {
  patch: ParsePatch[];
  summary: string;
  warnings: string[];
  mode: "llm" | "rules";
  trace: TraceStep[];
  /** 真实成功交换的服务端取证信息；HTTP 响应仍只返回 05 的四字段。 */
  llm_exchange?: LlmParseOutput;
}

const CN_NUMBERS: Record<string, number> = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

const GROUP_ALIASES: Record<string, string[]> = {
  regular: ["普通", "常规", "regular"],
  step_free: ["台阶", "无障碍", "慢行", "step_free", "step-free"],
  deadline: ["末班", "期限", "赶车", "deadline"],
};

function parseNumberToken(text: string): number | null {
  if (/^\d+$/.test(text)) return Number(text);
  return CN_NUMBERS[text] ?? null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tokenRegex(token: string): RegExp {
  return new RegExp(`(?<![a-z0-9_])${escapeRegExp(token)}(?![a-z0-9_])`, "i");
}

function patchKey(patch: ParsePatch): string {
  return `${patch.target}:${patch.id}:${patch.field}`;
}

function dedupe(patch: ParsePatch[]): ParsePatch[] {
  const map = new Map<string, ParsePatch>();
  for (const item of patch) map.set(patchKey(item), item);
  return [...map.values()];
}

function hasGroupContext(text: string): boolean {
  return /(旅客|乘客|人群|旅客组|人群组|group)/i.test(text);
}

function groupAliases(group: DemandGroup): string[] {
  return [group.group_id, ...(GROUP_ALIASES[group.group_id] || [])];
}

function findGroup(scenario: Scenario, text: string): { group: DemandGroup | null; ambiguous: boolean } {
  if (!hasGroupContext(text)) return { group: null, ambiguous: false };
  const matches = scenario.groups.filter((group) =>
    groupAliases(group).some((alias) => tokenRegex(alias).test(text)),
  );
  if (matches.length === 1) return { group: matches[0], ambiguous: false };
  if (matches.length > 1) return { group: null, ambiguous: true };
  return { group: null, ambiguous: false };
}

function exitNodesByDirection(
  scenario: Scenario,
  direction: "west" | "east" | "middle",
): { nodeId: string | null; ambiguous: boolean } {
  const exits = scenario.nodes.filter((node) => node.kind === "exit").sort((a, b) => a.x - b.x);
  if (exits.length === 0) return { nodeId: null, ambiguous: false };
  if (direction === "west") return { nodeId: exits[0].node_id, ambiguous: false };
  if (direction === "east") return { nodeId: exits[exits.length - 1].node_id, ambiguous: false };
  if (exits.length < 3) return { nodeId: null, ambiguous: true };
  return { nodeId: exits[Math.floor(exits.length / 2)].node_id, ambiguous: false };
}

interface NumberedExitMatch {
  requested: number | null;
  nodeId: string | null;
  ambiguous: boolean;
}

/** 优先使用出口 ID 的数字后缀；无后缀时按场景的 x、node_id 稳定顺序编号。 */
function exitNodeByNumber(scenario: Scenario, text: string): NumberedExitMatch {
  const match =
    text.match(/([一二两三四五六七八九十\d]+)\s*号\s*(?:出口|通道)/i) ||
    text.match(/(?:出口|通道)\s*([一二两三四五六七八九十\d]+)\s*号/i);
  if (!match) return { requested: null, nodeId: null, ambiguous: false };

  const requested = parseNumberToken(match[1]);
  if (!requested || requested <= 0) return { requested: null, nodeId: null, ambiguous: false };
  const exits = scenario.nodes.filter((node) => node.kind === "exit");
  const numbered = exits.filter((node) => {
    const suffix = node.node_id.match(/(\d+)$/);
    return suffix !== null && Number(suffix[1]) === requested;
  });
  if (numbered.length === 1) {
    return { requested, nodeId: numbered[0].node_id, ambiguous: false };
  }
  if (numbered.length > 1) return { requested, nodeId: null, ambiguous: true };

  const hasNumericSuffix = exits.some((node) => /(\d+)$/.test(node.node_id));
  if (hasNumericSuffix) return { requested, nodeId: null, ambiguous: false };
  const ordered = [...exits].sort(
    (a, b) => a.x - b.x || a.node_id.localeCompare(b.node_id),
  );
  return {
    requested,
    nodeId: ordered[requested - 1]?.node_id ?? null,
    ambiguous: false,
  };
}

function routeEdgesOf(scenario: Scenario, routeId: string): ScenarioEdge[] {
  const route = scenario.routes.find((item) => item.route_id === routeId);
  if (!route) return [];
  return route.edge_ids
    .map((edgeId) => scenario.edges.find((edge) => edge.edge_id === edgeId))
    .filter((edge): edge is ScenarioEdge => Boolean(edge));
}

function matchingEdges(
  scenario: Scenario,
  text: string,
  warnings: string[],
): ScenarioEdge[] {
  const found = new Map<string, ScenarioEdge>();

  for (const edge of scenario.edges) {
    if (tokenRegex(edge.edge_id).test(text)) found.set(edge.edge_id, edge);
  }

  for (const route of scenario.routes) {
    if (tokenRegex(route.route_id).test(text)) {
      for (const edge of routeEdgesOf(scenario, route.route_id)) found.set(edge.edge_id, edge);
    }
  }

  const numberedExit = exitNodeByNumber(scenario, text);
  if (numberedExit.requested !== null) {
    if (numberedExit.ambiguous || !numberedExit.nodeId) {
      warnings.push(
        `未识别到场景中唯一的 ${numberedExit.requested} 号出口，封路子指令未生成补丁。`,
      );
    } else {
      for (const edge of scenario.edges) {
        if (edge.to === numberedExit.nodeId) found.set(edge.edge_id, edge);
      }
    }
  }

  const directions: Array<{ pattern: RegExp; direction: "west" | "east" | "middle" }> = [
    { pattern: /(西侧|西面|西边|西出口|西通道|西)/i, direction: "west" },
    { pattern: /(东侧|东面|东边|东出口|东通道|东)/i, direction: "east" },
    { pattern: /(中侧|中间|中央|中部)/i, direction: "middle" },
  ];

  for (const item of directions) {
    if (!item.pattern.test(text)) continue;
    const resolved = exitNodesByDirection(scenario, item.direction);
    if (resolved.ambiguous || !resolved.nodeId) {
      warnings.push(`无法唯一确定“${item.direction === "middle" ? "中间" : item.direction === "west" ? "西侧" : "东侧"}”出口，未自动修改。`);
      continue;
    }
    for (const edge of scenario.edges) {
      if (edge.to !== resolved.nodeId) continue;
      const from = scenario.nodes.find((node) => node.node_id === edge.from);
      if (from && from.kind === "source") {
        found.set(edge.edge_id, edge);
      }
    }
  }

  for (const exit of scenario.nodes.filter((node) => node.kind === "exit")) {
    if (tokenRegex(exit.node_id).test(text)) {
      for (const edge of scenario.edges) {
        if (edge.to === exit.node_id) found.set(edge.edge_id, edge);
      }
    }
  }

  return [...found.values()];
}

function edgePatch(edgeId: string, field: "closed", value: boolean): ParsePatch {
  return { target: "edge", id: edgeId, field, value };
}

function summarize(patch: ParsePatch[]): string {
  if (patch.length === 0) return "未生成补丁：未识别到受支持的场景修改。";
  const parts = patch.map((item) => {
    if (item.target === "edge") {
      if (item.field === "closed") return `${item.value ? "关闭" : "重新开放"}边 ${item.id}`;
      return `将边 ${item.id} 的 ${item.field} 改为 ${item.value}`;
    }
    if (item.target === "group") {
      if (item.field === "count") return `将旅客组 ${item.id} 的 count 改为 ${item.value}`;
      if (item.field === "walk_time_factor") {
        return `将旅客组 ${item.id} 的 walk_time_factor 改为 ${item.value}`;
      }
      return `将旅客组 ${item.id} 的 board_deadline_s 改为 ${item.value === null ? "null" : item.value}`;
    }
    return `移除车辆 ${item.id}`;
  });
  return `待确认修改：${parts.join("；")}`;
}

/**
 * 规则解析只产出补丁，不修改场景、不递增 revision。
 * 无模型密钥时 mode=rules，不会伪造 llm trace。
 */
export function parseRules(scenario: Scenario, instruction: string): RuleParseResult {
  const text = instruction.trim();
  const warnings: string[] = [];
  const patch: ParsePatch[] = [];

  const closeIntent = /(关闭|封闭|封路|禁用|停用|close|closed|shut)/i.test(text);
  const openIntent = /(开放|恢复|重开|重新开放|open)/i.test(text);
  const closedValue = closeIntent ? true : openIntent ? false : null;

  if (/(所有|全部|全城|整体)/.test(text) && /(无台阶|无障碍|step[-_ ]?free)/i.test(text) && closeIntent) {
    for (const edge of scenario.edges) {
      if (edge.step_free) patch.push(edgePatch(edge.edge_id, "closed", true));
    }
    warnings.push("按“关闭无台阶路线”处理：所有 step_free=true 的边被关闭，需要避开台阶的旅客可能无法离开。");
  } else if (/(所有|全部)/.test(text) && /(台阶|楼梯|stairs?)/i.test(text) && closeIntent) {
    for (const edge of scenario.edges) {
      if (!edge.step_free) patch.push(edgePatch(edge.edge_id, "closed", true));
    }
    warnings.push("按“关闭台阶路线”处理：所有 step_free=false 的边被关闭。");
  } else if (closedValue !== null) {
    const matched = matchingEdges(scenario, text, warnings);
    if (matched.length > 0) {
      for (const edge of matched) patch.push(edgePatch(edge.edge_id, "closed", closedValue));
    }
  }

  if (closedValue !== null && /(所有|全部)/.test(text) && /(路线|通道|出口|route|exit)/i.test(text)) {
    for (const route of scenario.routes) {
      for (const edge of routeEdgesOf(scenario, route.route_id)) {
        patch.push(edgePatch(edge.edge_id, "closed", closedValue));
      }
    }
    warnings.push("按“全部路线/出口”处理：所有路线边被整体切换 closed 状态。");
  }

  const hasClosedPatch = patch.some(
    (item) => item.target === "edge" && item.field === "closed",
  );
  if (closedValue !== null && !hasClosedPatch && warnings.length === 0) {
    warnings.push("已识别开关/封路意图，但未识别对应出口、路线或边；该子指令未生成补丁。");
  }

  const reduceMatch = text.match(
    /(?:减少|少|裁掉|移除|remove)\s*([一二两三四五六七八九十\d]+)\s*(?:辆|台|vehicle|bus)/i,
  );
  if (reduceMatch) {
    const count = parseNumberToken(reduceMatch[1]);
    if (count && count > 0) {
      const removable = [...scenario.fleet].sort(
        (a, b) =>
          b.available_from_s - a.available_from_s ||
          b.vehicle_id.localeCompare(a.vehicle_id),
      );
      const actual = Math.min(count, removable.length);
      for (let i = 0; i < actual; i += 1) {
        patch.push({
          target: "vehicle",
          id: removable[i].vehicle_id,
          field: "enabled",
          value: false,
        });
      }
      if (count > removable.length) {
        warnings.push(`指令要求减少 ${count} 辆车，但当前只有 ${removable.length} 辆，已全部列入移除补丁。`);
      }
      warnings.push("移除车辆需用户确认；应用时从 fleet 删除对应 vehicle_id，重置场景才能恢复。");
    }
  } else if (/(减少车辆|少一辆车|少车|remove\s+(?:a\s+)?vehicle)/i.test(text)) {
    warnings.push("车辆减少数量不明确，未生成补丁；请写成“减少一辆车”。");
  }
  if (/(增加车辆|加车|多一辆车|add\s+(?:a\s+)?vehicle)/i.test(text)) {
    warnings.push("不支持通过自然语言增加车辆或容量；资源变化必须先修改 Scenario 并经用户确认。");
  }

  const groupInfo = findGroup(scenario, text);
  if (groupInfo.ambiguous) {
    warnings.push("指令同时匹配多个旅客组，无法唯一确定修改对象，未生成人数补丁。");
  }

  const countMatch = text.match(/(增加|减少|改为|设为|调为|调整为)\s*(\d+)\s*人/);
  if (countMatch) {
    if (!groupInfo.group) {
      if (!groupInfo.ambiguous) warnings.push("人数修改未指明旅客组，不能猜测，未生成补丁。");
    } else {
      const delta = Number(countMatch[2]);
      const operation = countMatch[1];
      const next =
        operation === "增加"
          ? groupInfo.group.count + delta
          : operation === "减少"
            ? groupInfo.group.count - delta
            : delta;
      const value = Math.max(0, Math.trunc(next));
      patch.push({
        target: "group",
        id: groupInfo.group.group_id,
        field: "count",
        value,
      });
      if (next < 0) warnings.push("人数减少到负值，已按 0 处理。");
    }
  }

  const deadlineMatch = text.match(/(?:末班|期限|deadline)[^。；，,]{0,16}?(\d+)\s*(?:秒|s)/i);
  if (deadlineMatch) {
    const group =
      groupInfo.group ||
      scenario.groups.find((item) => item.board_deadline_s !== null) ||
      null;
    if (!group) {
      warnings.push("未找到带登车期限的旅客组，未生成期限补丁。");
    } else {
      const value = Number(deadlineMatch[1]);
      if (value > scenario.horizon_s) {
        warnings.push("登车期限晚于模拟窗口结束，未生成补丁。");
      } else {
        patch.push({
          target: "group",
          id: group.group_id,
          field: "board_deadline_s",
          value,
        });
      }
    }
  }

  const percentMatch = text.match(/步行(?:耗时)?[^。；，,]{0,10}?(?:增加|提高)\s*(\d+)\s*%/i);
  const factorMatch = text.match(/步行(?:耗时)?[^。；，,]{0,10}?(\d+(?:\.\d+)?)\s*倍/i);
  if (percentMatch || factorMatch) {
    if (!groupInfo.group) {
      if (!groupInfo.ambiguous) warnings.push("步行耗时修改未指明旅客组，不能猜测，未生成补丁。");
    } else {
      const value = percentMatch
        ? 1 + Number(percentMatch[1]) / 100
        : Number(factorMatch![1]);
      if (Number.isFinite(value) && value > 0) {
        patch.push({
          target: "group",
          id: groupInfo.group.group_id,
          field: "walk_time_factor",
          value,
        });
      }
    }
  }

  const singleEdge = patch.length === 1 && patch[0].target === "edge" ? scenario.edges.find((edge) => edge.edge_id === (patch[0] as { id: string }).id) : null;
  if (singleEdge) {
    const capacityMatch = text.match(/(?:容量|capacity)[^。；，,]{0,8}?(\d+(?:\.\d+)?)/i);
    if (capacityMatch && Number(capacityMatch[1]) > 0) {
      patch.push({
        target: "edge",
        id: singleEdge.edge_id,
        field: "capacity_per_min",
        value: Number(capacityMatch[1]),
      });
    }
    const travelMatch = text.match(/(?:耗时|步行时间|travel)[^。；，,]{0,8}?(\d+(?:\.\d+)?)\s*(?:秒|s)?/i);
    if (travelMatch && Number(travelMatch[1]) > 0) {
      patch.push({
        target: "edge",
        id: singleEdge.edge_id,
        field: "travel_s",
        value: Number(travelMatch[1]),
      });
    }
  }

  if (/(下雨|暴雨|天气|信号灯|摄像头|地震|火灾|URL|http|代码|脚本)/i.test(text)) {
    warnings.push("仅支持 05 约定的场景参数修改；不虚构天气、信号或真实车站数据，也不执行代码、路径或 URL。");
  }

  const unique = dedupe(patch);
  if (unique.length === 0 && warnings.length === 0) {
    warnings.push("未识别到受支持的修改，未生成补丁；可尝试“关闭西侧出口”或“减少一辆车”。");
  }
  if (unique.length > 0) {
    warnings.push("补丁需要用户确认后应用；应用后 revision 加 1，旧方案与旧结果过期。");
  }

  return {
    patch: unique,
    summary: summarize(unique),
    warnings,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** 只接受 05 白名单字段；拒绝未知 ID、未知字段、增加容量、开启已移除车辆。 */
export function sanitizePatch(
  scenario: Scenario,
  raw: unknown[],
): { patch: ParsePatch[]; warnings: string[] } {
  const warnings: string[] = [];
  const patch: ParsePatch[] = [];
  const edges = new Set(scenario.edges.map((edge) => edge.edge_id));
  const groups = new Map(scenario.groups.map((group) => [group.group_id, group]));
  const vehicles = new Set(scenario.fleet.map((vehicle) => vehicle.vehicle_id));

  for (const [index, item] of raw.entries()) {
    if (!isRecord(item)) {
      warnings.push(`模型补丁 #${index + 1} 不是对象，已忽略。`);
      continue;
    }
    if (item.target === "edge") {
      if (typeof item.id !== "string" || !edges.has(item.id)) {
        warnings.push(`模型补丁 #${index + 1} 引用了不存在的边，已忽略。`);
        continue;
      }
      if (item.field === "closed") {
        if (typeof item.value !== "boolean") {
          warnings.push(`模型补丁 #${index + 1} 的 closed 不是布尔值，已忽略。`);
          continue;
        }
        patch.push({ target: "edge", id: item.id, field: "closed", value: item.value });
      } else if (item.field === "travel_s" || item.field === "capacity_per_min") {
        if (typeof item.value !== "number" || !Number.isFinite(item.value) || item.value <= 0) {
          warnings.push(`模型补丁 #${index + 1} 的 ${item.field} 必须为正数，已忽略。`);
          continue;
        }
        patch.push({ target: "edge", id: item.id, field: item.field, value: item.value });
      } else {
        warnings.push(`模型补丁 #${index + 1} 的 edge.field 不在白名单，已忽略。`);
      }
      continue;
    }
    if (item.target === "group") {
      if (typeof item.id !== "string" || !groups.has(item.id)) {
        warnings.push(`模型补丁 #${index + 1} 引用了不存在的旅客组，已忽略。`);
        continue;
      }
      if (item.field === "count") {
        if (typeof item.value !== "number" || !Number.isInteger(item.value) || item.value < 0) {
          warnings.push(`模型补丁 #${index + 1} 的 count 必须为非负整数，已忽略。`);
          continue;
        }
        patch.push({ target: "group", id: item.id, field: "count", value: item.value });
      } else if (item.field === "walk_time_factor") {
        if (typeof item.value !== "number" || !Number.isFinite(item.value) || item.value <= 0) {
          warnings.push(`模型补丁 #${index + 1} 的 walk_time_factor 必须为正数，已忽略。`);
          continue;
        }
        patch.push({ target: "group", id: item.id, field: "walk_time_factor", value: item.value });
      } else if (item.field === "board_deadline_s") {
        if (item.value === null) {
          patch.push({ target: "group", id: item.id, field: "board_deadline_s", value: null });
        } else if (
          typeof item.value === "number" &&
          Number.isFinite(item.value) &&
          item.value >= 0 &&
          item.value <= scenario.horizon_s
        ) {
          patch.push({
            target: "group",
            id: item.id,
            field: "board_deadline_s",
            value: item.value,
          });
        } else {
          warnings.push(`模型补丁 #${index + 1} 的 board_deadline_s 必须在窗口内，已忽略。`);
        }
      } else {
        warnings.push(`模型补丁 #${index + 1} 的 group.field 不在白名单，已忽略。`);
      }
      continue;
    }
    if (item.target === "vehicle") {
      if (typeof item.id !== "string" || !vehicles.has(item.id)) {
        warnings.push(`模型补丁 #${index + 1} 引用了不存在的车辆，已忽略。`);
        continue;
      }
      if (item.field !== "enabled" || item.value !== false) {
        warnings.push(`模型补丁 #${index + 1} 只允许移除车辆（enabled=false），已忽略。`);
        continue;
      }
      patch.push({ target: "vehicle", id: item.id, field: "enabled", value: false });
      continue;
    }
    warnings.push(`模型补丁 #${index + 1} 的 target 不在白名单，已忽略。`);
  }

  return { patch: dedupe(patch).slice(0, 30), warnings };
}

export async function parseScenarioInstruction(
  scenario: Scenario,
  instruction: string,
): Promise<ParseOutcome> {
  const trace = new TraceRecorder();
  const inputRef = `scenario:${scenario.scenario_id}@r${scenario.revision}`;

  if (llmConfigured()) {
    const started = Date.now();
    try {
      const output = await parseWithLlm(scenario, instruction);
      const sanitized = sanitizePatch(scenario, output.patch);
      if (output.patch.length > 0 && sanitized.patch.length === 0) {
        trace.add({
          actor: "scenario_parser",
          action: "parse_instruction",
          source: "llm",
          summary: "模型返回的补丁均未通过白名单校验",
          input_ref: inputRef,
          output_ref: "patch:0",
          status: "rejected",
          duration_ms: output.duration_ms,
        });
        const rules = parseRules(scenario, instruction);
        trace.add({
          actor: "scenario_parser",
          action: "parse_instruction_fallback",
          source: "rules",
          summary: rules.summary,
          input_ref: inputRef,
          output_ref: `patch:${rules.patch.length}`,
          status: "ok",
        });
        return {
          patch: rules.patch,
          summary: rules.summary,
          warnings: [
            ...output.warnings,
            ...sanitized.warnings,
            "模型未给出可用补丁，已切换规则模式。",
            ...rules.warnings,
          ],
          mode: "rules",
          trace: trace.list(),
        };
      }

      trace.add({
        actor: "scenario_parser",
        action: "parse_instruction",
        source: "llm",
        summary: output.summary || summarize(sanitized.patch),
        input_ref: inputRef,
        output_ref: `patch:${sanitized.patch.length}`,
        status: "ok",
        duration_ms: output.duration_ms,
      });
      return {
        patch: sanitized.patch,
        summary: output.summary || summarize(sanitized.patch),
        warnings: [
          ...output.warnings,
          ...sanitized.warnings,
          ...(sanitized.patch.length > 0
            ? ["补丁需要用户确认后应用；应用后 revision 加 1，旧方案与旧结果过期。"]
            : []),
        ],
        mode: "llm",
        trace: trace.list(),
        llm_exchange: output,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      trace.add({
        actor: "scenario_parser",
        action: "parse_instruction",
        source: "llm",
        summary: `模型调用失败：${message.slice(0, 160)}`,
        input_ref: inputRef,
        output_ref: "patch:0",
        status: "error",
        duration_ms: Date.now() - started,
      });
      const rules = parseRules(scenario, instruction);
      trace.add({
        actor: "scenario_parser",
        action: "parse_instruction_fallback",
        source: "rules",
        summary: rules.summary,
        input_ref: inputRef,
        output_ref: `patch:${rules.patch.length}`,
        status: "ok",
      });
      return {
        patch: rules.patch,
        summary: rules.summary,
        warnings: [
          `模型不可用，已切换规则模式：${message.slice(0, 160)}`,
          ...rules.warnings,
        ],
        mode: "rules",
        trace: trace.list(),
      };
    }
  }

  const rules = parseRules(scenario, instruction);
  trace.add({
    actor: "scenario_parser",
    action: "parse_instruction",
    source: "rules",
    summary: rules.summary,
    input_ref: inputRef,
    output_ref: `patch:${rules.patch.length}`,
    status: "ok",
  });
  return {
    patch: rules.patch,
    summary: rules.summary,
    warnings: rules.warnings,
    mode: "rules",
    trace: trace.list(),
  };
}

export function validateInstruction(
  scenario: Scenario,
  instruction: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (typeof instruction !== "string" || instruction.trim() === "") {
    issues.push({ code: "missing_instruction", path: "instruction", message: "instruction 必须为非空字符串", severity: "error" });
  } else if (instruction.length > 500) {
    issues.push({ code: "instruction_too_long", path: "instruction", message: "instruction 不能超过 500 字", severity: "error" });
  }
  if (!scenario || typeof scenario !== "object") {
    issues.push({ code: "missing_scenario", path: "scenario", message: "scenario 必须是对象", severity: "error" });
  }
  return issues;
}
