/**
 * 用户端展示层映射（纯函数，可单测）：
 * 把共享契约中的技术字段转换为普通观众可读的中文文案。
 * 只做字段映射与显示格式转换——不生成新指标、不做推荐排序、不硬编码成绩。
 */
import type {
  Objective,
  Plan,
  Recommendation,
  Scenario,
  ScenarioGroup,
  ScenarioNode,
  SimulationResult,
  Strategy,
  ValidationIssue,
} from "./contract/types";

/* ================= 节点 / 路线可读名称 ================= */

/** 节点可读名：S→场馆，E1→1号出口，P1→接驳点 P1；编号来自 node_id，不写死具体路线 */
export function nodeDisplayName(node: Pick<ScenarioNode, "node_id" | "kind">): string {
  if (node.kind === "source") return "场馆";
  const m = /(\d+)/.exec(node.node_id);
  if (node.kind === "exit") return m ? `${m[1]}号出口` : node.node_id;
  return m ? `接驳点 P${m[1]}` : `接驳点 ${node.node_id}`;
}

/** 路线途经节点序列（node_id）；路线不存在或通道缺失返回 null */
export function routeNodeIds(scenario: Scenario, routeId: string): string[] | null {
  const route = scenario.routes.find((r) => r.route_id === routeId);
  if (!route || route.edge_ids.length === 0) return null;
  const ids: string[] = [];
  const first = scenario.edges.find((e) => e.edge_id === route.edge_ids[0]);
  if (!first) return null;
  ids.push(first.from);
  for (const eid of route.edge_ids) {
    const e = scenario.edges.find((x) => x.edge_id === eid);
    if (!e) return null;
    ids.push(e.to);
  }
  if (ids[ids.length - 1] !== route.stop_id) ids.push(route.stop_id);
  return ids;
}

/** 路线可读序列，例如“场馆 → 1号出口 → 接驳点 P1” */
export function routeSequenceText(scenario: Scenario, routeId: string): string {
  const ids = routeNodeIds(scenario, routeId);
  if (!ids) return routeId;
  return ids
    .map((id) => {
      const node = scenario.nodes.find((n) => n.node_id === id);
      return node ? nodeDisplayName(node) : id;
    })
    .join(" → ");
}

/* ================= 需求类型（普通观众语言） ================= */

export type NeedType = "regular" | "step_free" | "deadline";

export const NEED_ORDER: NeedType[] = ["regular", "step_free", "deadline"];

export const NEED_LABELS: Record<NeedType, string> = {
  regular: "普通出行",
  step_free: "需要无台阶通行",
  deadline: "希望赶上末班",
};

/** 按组属性推导需求类型：避台阶优先，其次截止期限，否则普通出行 */
export function groupNeedType(g: Pick<ScenarioGroup, "needs_step_free" | "board_deadline_s">): NeedType {
  if (g.needs_step_free) return "step_free";
  if (g.board_deadline_s !== null) return "deadline";
  return "regular";
}

export function groupDisplayName(g: Pick<ScenarioGroup, "group_id" | "needs_step_free" | "board_deadline_s">): string {
  return NEED_LABELS[groupNeedType(g)];
}

export interface NeedOption {
  type: NeedType;
  label: string;
  /** 该需求类型覆盖的组（当前场景每组一类；多组时取第一个为默认视角） */
  groupIds: string[];
  peopleCount: number;
}

/** 从当前 Scenario 的实际组推导需求选项；不存在的类型不显示 */
export function needOptionsFromScenario(scenario: Scenario): NeedOption[] {
  const byType = new Map<NeedType, ScenarioGroup[]>();
  for (const g of scenario.groups) {
    const t = groupNeedType(g);
    const list = byType.get(t) ?? [];
    list.push(g);
    byType.set(t, list);
  }
  return NEED_ORDER.filter((t) => byType.has(t)).map((t) => ({
    type: t,
    label: NEED_LABELS[t],
    groupIds: (byType.get(t) ?? []).map((g) => g.group_id),
    peopleCount: (byType.get(t) ?? []).reduce((s, g) => s + g.count, 0),
  }));
}

/* ================= 方案名称 ================= */

export const STRATEGY_LABELS: Record<Strategy, string> = {
  baseline: "固定规则",
  independent: "分角色独立",
  coordinated: "协调修订",
};

/** 优化目标可读名（统一由窗口4维护，各页面不再各自定义） */
export const OBJECTIVE_LABELS: Record<Objective, string> = {
  efficiency: "效率优先",
  inclusion: "包容优先",
  balanced: "平衡",
};

export function objectiveDisplayName(o: Objective): string {
  return OBJECTIVE_LABELS[o] ?? o;
}

const STRATEGY_PLAN_NAMES: Record<Strategy, string> = {
  baseline: "固定班次方案",
  independent: "分组独立方案",
  coordinated: "协调接驳方案",
};

/** plan_id 等技术名不直接展示；用户层按策略映射（真实 plan_id 保留在运行详情） */
export function planDisplayName(plan: Pick<Plan, "strategy">): string {
  return STRATEGY_PLAN_NAMES[plan.strategy];
}

/* ================= 路线可用性 ================= */

export function routeStepFree(scenario: Scenario, routeId: string): boolean {
  const route = scenario.routes.find((r) => r.route_id === routeId);
  if (!route) return false;
  return route.edge_ids.every((eid) => scenario.edges.find((e) => e.edge_id === eid)?.step_free ?? false);
}

export function routeClosed(scenario: Scenario, routeId: string): boolean {
  const route = scenario.routes.find((r) => r.route_id === routeId);
  if (!route) return true;
  return route.edge_ids.some((eid) => scenario.edges.find((e) => e.edge_id === eid)?.closed ?? true);
}

/* ================= 需求组服务状态 ================= */

export type ServeStatus =
  | { level: "ok"; text: string; warning?: string }
  | { level: "blocked"; reason: "no_route" | "no_open_route" | "invalid_plan"; text: string; hint?: string }
  | { level: "unknown"; text: string };

/** 校验问题短语映射；未知 code 不猜测，保留原码 */
const VIOLATION_LABELS: Record<string, string> = {
  PLAN_STOP_GAP: "班次安排冲突",
};

export function violationShortText(v: Pick<ValidationIssue, "code" | "message">): string {
  return VIOLATION_LABELS[v.code] ?? v.code;
}

/**
 * 当前方案对某需求组的服务状态（纯展示推导，来自同一份 Scenario/Plan/Result）：
 * 区分“没有符合条件的路线 / 运力不足未登车 / 方案校验失败”，不把剩余人数一律解释成断路。
 */
export function serveStatusForGroup(
  scenario: Scenario,
  plan: Plan | null,
  result: SimulationResult | null | undefined,
  groupId: string
): ServeStatus {
  const group = scenario.groups.find((g) => g.group_id === groupId);
  if (!group) return { level: "unknown", text: "当前场景中未找到该需求组" };
  if (!plan) return { level: "unknown", text: "尚未生成接驳方案" };

  if (result && result.status === "invalid") {
    const err = result.violations.find((v) => v.severity === "error");
    return {
      level: "blocked",
      reason: "invalid_plan",
      text: `方案校验未通过（${err ? violationShortText(err) : "存在校验问题"}），未参与推荐`,
      hint: "该方案的结果不可用；可在“方案对比”查看其他方案或原因明细",
    };
  }

  const alloc = plan.allocations.find((a) => a.group_id === groupId);
  const routes = alloc?.routes ?? [];
  if (routes.length === 0) {
    return {
      level: "blocked",
      reason: "no_route",
      text: "本方案未为该需求安排接驳路线",
      hint: "该组旅客将留在场馆等待；可更换方案或调整演示情境后重新计算",
    };
  }

  const closedRoutes = routes.filter((r) => routeClosed(scenario, r.route_id));
  if (closedRoutes.length === routes.length) {
    return {
      level: "blocked",
      reason: "no_open_route",
      text: "当前缺少满足需求的开放路线",
      hint: `分配的 ${routes.length} 条路线均包含已关闭通道`,
    };
  }

  if (group.needs_step_free) {
    const nonCompliant = routes.filter((r) => !routeStepFree(scenario, r.route_id));
    if (nonCompliant.length > 0) {
      return {
        level: "blocked",
        reason: "no_open_route",
        text: "分配路线包含台阶，不满足该组需求",
        hint: "该组需要全程无台阶的路线",
      };
    }
  }

  if (!result || result.status !== "valid" || result.metrics === null) {
    return { level: "unknown", text: "暂无该方案的模拟结果" };
  }

  const gm = result.group_metrics.find((m) => m.group_id === groupId) ?? null;
  const remaining = gm ? gm.remaining_count : null;
  if (remaining !== null && remaining > 0) {
    return {
      level: "ok",
      text: "已安排接驳路线",
      warning: `模拟窗口结束仍有 ${remaining} 人未登车（运力不足或释放较晚）`,
    };
  }
  let warning: string | undefined;
  if (gm && group.board_deadline_s !== null && gm.missed_deadline_count > 0) {
    warning = `该组有 ${gm.missed_deadline_count} 人晚于截止时间登车`;
  }
  return { level: "ok", text: "该需求已有可行的接驳路线", warning };
}

/* ================= 组级关键指标 ================= */

export interface GroupKeyMetrics {
  /** 该组人数（分母） */
  total: number;
  boarded: number | null;
  released: number | null;
  remaining: number | null;
  /** 全部已释放口径的模拟平均排队；null 不显示为 0 */
  meanWait: number | null;
  /** 仅截止组有意义；null 表示无该项 */
  missedDeadline: number | null;
}

/** 从组级指标取关键 2~3 项；结果无效或组缺失返回 null，绝不编造数字 */
export function groupKeyMetrics(
  scenario: Scenario,
  result: SimulationResult | null | undefined,
  groupId: string
): GroupKeyMetrics | null {
  const g = scenario.groups.find((x) => x.group_id === groupId);
  if (!g) return null;
  if (!result || result.status !== "valid") return null;
  const gm = result.group_metrics.find((m) => m.group_id === groupId) ?? null;
  return {
    total: g.count,
    boarded: gm ? gm.boarded_count : null,
    released: gm ? gm.released_count : null,
    remaining: gm ? gm.remaining_count : null,
    meanWait: gm ? gm.mean_queue_wait_all_released_s : null,
    missedDeadline: g.board_deadline_s !== null ? (gm ? gm.missed_deadline_count : null) : null,
  };
}

/* ================= 推荐理由（技术词 → 用户词） ================= */

const REASON_TERM_MAP: [RegExp, string][] = [
  [/plan_coordinated[\w]*/g, "协调接驳方案"],
  [/plan_independent[\w]*/g, "分组独立方案"],
  [/plan_baseline[\w]*/g, "固定班次方案"],
  [/remaining_count/g, "模拟结束仍未登车人数"],
  [/mean_queue_wait_all_released_s/g, "模拟平均排队时长"],
  [/p95_queue_wait_boarded_s/g, "登车样本 P95 排队"],
  [/missed_deadline_count/g, "错过末班人数"],
  [/boarded_count/g, "已登车人数"],
  [/released_count/g, "已释放人数"],
  [/clearance_time_s/g, "清空时刻"],
  [/字典序/g, "同分时的固定先后顺序"],
  [/lexicographic/gi, "同分时的固定先后顺序"],
];

/** 只替换已知技术词，其余内容原样保留；原文可在详情查看 */
export function humanizeReason(reason: string): string {
  let out = reason;
  for (const [re, label] of REASON_TERM_MAP) out = out.replace(re, label);
  return out;
}

/* ================= 推荐状态 ================= */

export function recommendationHeadline(rec: Pick<Recommendation, "status">): string {
  if (rec.status === "recommended") return "系统当前推荐";
  if (rec.status === "tradeoff") return "系统当前推荐（存在取舍）";
  return "暂无可计算结果";
}

/* ================= 时间格式 ================= */

/** 900 → “15:00”；模拟时刻统一用易读的 mm:ss */
export function fmtClock(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "—";
  const total = Math.round(s);
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

export function fmtSimTime(s: number): string {
  return `模拟第 ${fmtClock(s)}`;
}
