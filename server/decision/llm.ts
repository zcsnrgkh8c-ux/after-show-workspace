import { Scenario } from "../../shared/types";

export interface LlmParseOutput {
  patch: unknown[];
  summary: string;
  warnings: string[];
  model: string;
  duration_ms: number;
  /** 仅用于服务端脱敏验收取证，不进入 05 的 parse HTTP 响应。 */
  request_messages: Array<{ role: "system" | "user"; content: string }>;
  raw_content: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function llmConfigured(): boolean {
  return Boolean(process.env.LLM_API_KEY && process.env.LLM_MODEL);
}

/** 服务端先超时并降级；前端 parse 超时必须大于该值，建议额外留出 5 秒。 */
export function llmTimeoutMs(): number {
  const raw = process.env.LLM_TIMEOUT_MS;
  if (raw === undefined) return 15000;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 100 && value <= 120000 ? value : 15000;
}

function endpoint(): string {
  const base = (process.env.LLM_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3").replace(/\/+$/, "");
  return base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
}

function scenarioDigest(scenario: Scenario): string {
  const edges = scenario.edges
    .map((edge) => `${edge.edge_id}(${edge.from}->${edge.to},closed=${edge.closed},step_free=${edge.step_free})`)
    .join("; ");
  const routes = scenario.routes
    .map((route) => `${route.route_id}[${route.edge_ids.join(",")}]->${route.stop_id}`)
    .join("; ");
  const groups = scenario.groups
    .map(
      (group) =>
        `${group.group_id}(count=${group.count},needs_step_free=${group.needs_step_free},` +
        `walk_time_factor=${group.walk_time_factor},board_deadline_s=${group.board_deadline_s})`,
    )
    .join("; ");
  const fleet = scenario.fleet
    .map(
      (vehicle) =>
        `${vehicle.vehicle_id}(capacity=${vehicle.capacity},available_from_s=${vehicle.available_from_s},` +
        `round_trip_s=${vehicle.round_trip_s})`,
    )
    .join("; ");
  return [
    `scenario_id=${scenario.scenario_id}; revision=${scenario.revision}; horizon_s=${scenario.horizon_s}; step_s=${scenario.step_s}`,
    `edges: ${edges}`,
    `routes: ${routes}`,
    `groups: ${groups}`,
    `fleet: ${fleet}`,
  ].join("\n");
}

function extractContent(payload: unknown): string {
  if (!isRecord(payload)) throw new Error("模型响应不是对象");
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) throw new Error("模型响应缺少 choices");
  const first = choices[0];
  if (!isRecord(first) || !isRecord(first.message)) throw new Error("模型响应缺少 message");
  const content = first.message.content;
  if (typeof content !== "string" || content.trim() === "") throw new Error("模型响应 content 为空");
  return content;
}

function stripFences(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("```")) {
    return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  }
  return trimmed;
}

/**
 * 真实调用 OpenAI 兼容接口。只有本函数成功返回，trace 才允许写 source=llm/status=ok。
 * 失败由调用方记录 source=llm/status=error，再降级到规则模式。
 */
export async function parseWithLlm(
  scenario: Scenario,
  instruction: string,
): Promise<LlmParseOutput> {
  const apiKey = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL;
  if (!apiKey || !model) throw new Error("LLM_API_KEY 或 LLM_MODEL 未配置");

  const started = Date.now();
  const system = [
    "你是大型活动散场沙盘的场景修改解析器。",
    "只输出一个 JSON 对象，不要 Markdown，不要解释段落。",
    "JSON 形如 {\"patch\":[...],\"summary\":\"...\",\"warnings\":[\"...\"]}。",
    "patch 只允许以下三类：",
    "1) {\"target\":\"edge\",\"id\":\"已存在边ID\",\"field\":\"closed|travel_s|capacity_per_min\",\"value\":布尔或数字}",
    "2) {\"target\":\"group\",\"id\":\"已存在旅客组ID\",\"field\":\"count|walk_time_factor|board_deadline_s\",\"value\":数字或null}",
    "3) {\"target\":\"vehicle\",\"id\":\"已存在车辆ID\",\"field\":\"enabled\",\"value\":false}",
    "不得修改 ID，不得新增车辆或容量，不得虚构天气、信号灯或真实车站数据，不得输出代码、路径或 URL。",
    "模糊指令不要猜测，写入 warnings。修改只是待确认补丁，不会自动应用。",
  ].join("\n");
  const user = `当前场景：\n${scenarioDigest(scenario)}\n\n用户指令：${instruction}`;

  const requestMessages: Array<{ role: "system" | "user"; content: string }> = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];

  const response = await fetch(endpoint(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 800,
      response_format: { type: "json_object" },
      messages: requestMessages,
    }),
    signal: AbortSignal.timeout(llmTimeoutMs()),
  });

  if (!response.ok) {
    // 不回显供应商错误体：部分服务会在其中附带密钥后缀或请求标识。
    throw new Error(`模型接口 HTTP ${response.status}`);
  }

  const payload = (await response.json()) as unknown;
  const content = stripFences(extractContent(payload));
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("模型输出不是合法 JSON");
  }
  if (!isRecord(parsed)) throw new Error("模型输出必须是 JSON 对象");

  const patch = Array.isArray(parsed.patch) ? parsed.patch : [];
  const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
  const warnings = Array.isArray(parsed.warnings)
    ? parsed.warnings.filter((item): item is string => typeof item === "string" && item.trim() !== "")
    : [];

  return {
    patch,
    summary,
    warnings,
    model,
    duration_ms: Date.now() - started,
    request_messages: requestMessages,
    raw_content: content,
  };
}
