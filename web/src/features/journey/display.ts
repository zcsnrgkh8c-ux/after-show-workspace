/**
 * journey 模块局部展示推导（纯函数，可单测）。
 * 只做字段映射与状态归类：复用 labels.ts 公共 helper，不重算仿真、不生成新指标、
 * 不把分流份额当成个人概率；null 一律保留 null 语义（显示为“—”），不冒充 0。
 */
import type { Plan, Recommendation, Scenario, SimulationResult } from "../../contract/types";
import type { RunBundle } from "../../state/store";
import {
  groupKeyMetrics,
  humanizeReason,
  planDisplayName,
  routeClosed,
  routeSequenceText,
  routeStepFree,
  serveStatusForGroup,
  type GroupKeyMetrics,
  type ServeStatus,
} from "../../labels";

/* ================= 路线列表（建议卡“路线与通行条件”） ================= */

export interface JourneyRouteItem {
  routeId: string;
  /** 途经序列可读文本；路线在场景中缺失时为 null（不猜测途经位置） */
  sequenceText: string | null;
  /** 组内分流比例（0~100 取整）；share 非法时为 null */
  sharePct: number | null;
  /** 通行条件；路线缺失时为 null，不猜测 */
  closed: boolean | null;
  stepFree: boolean | null;
  /** scenario.routes 中不存在该路线 */
  missing: boolean;
}

function sharePctOf(share: number): number | null {
  if (!Number.isFinite(share) || share < 0 || share > 1) return null;
  return Math.round(share * 100);
}

/**
 * 当前方案对某组的分流路线展示项。
 * plan 缺失、分配缺失或分配为空都返回 []（页面统一按“未安排路线”呈现，不虚构路线）。
 */
export function routeItemsForGroup(scenario: Scenario, plan: Plan | null, groupId: string): JourneyRouteItem[] {
  if (!plan) return [];
  const alloc = plan.allocations.find((a) => a.group_id === groupId);
  if (!alloc) return [];
  return alloc.routes.map((rs) => {
    const sharePct = sharePctOf(rs.share);
    const exists = scenario.routes.some((r) => r.route_id === rs.route_id);
    if (!exists) {
      return { routeId: rs.route_id, sequenceText: null, sharePct, closed: null, stepFree: null, missing: true };
    }
    return {
      routeId: rs.route_id,
      sequenceText: routeSequenceText(scenario, rs.route_id),
      sharePct,
      closed: routeClosed(scenario, rs.route_id),
      stepFree: routeStepFree(scenario, rs.route_id),
      missing: false,
    };
  });
}

/* ================= 建议卡整体状态 ================= */

export interface ReadyView {
  planName: string;
  /** 仅当当前方案与服务端推荐一致且推荐可用时为 true；不自行排名 */
  isRecommended: boolean;
  /** 服务端推荐存在取舍（仅对推荐方案本身展示） */
  recTradeoff: boolean;
  /** 服务端本轮无可用推荐 */
  recNoValid: boolean;
  /**
   * 推荐理由（技术词已转用户语言）。
   * 只在当前方案就是推荐方案且结果未过期时提供——推荐理由解释的是推荐方案，
   * 不把它当作所有方案的解释。非推荐方案为 null，另用 recPlanName 说明系统推荐。
   */
  recReason: string | null;
  recTradeoffItems: string[];
  /** 存在可用推荐但当前查看的不是它时，给出推荐方案名（如“协调接驳方案”）；否则 null */
  recPlanName: string | null;
  /** 当前方案模拟结果状态；none = 尚无该方案结果，error = 推演失败 */
  resultStatus: "valid" | "invalid" | "error" | "none";
  /** 组服务状态（区分无路线 / 通道关闭 / 校验失败 / 运力不足），来自 labels 公共推导 */
  serve: ServeStatus | null;
  routes: JourneyRouteItem[];
  /** 组级关键指标；结果无效或组缺失时为 null，字段 null 表示无数据 */
  metrics: GroupKeyMetrics | null;
}

export type JourneyCardState =
  | { kind: "no_bundle" }
  | { kind: "no_candidates" }
  | { kind: "group_missing" }
  | { kind: "plan_missing" }
  /** 结果对应旧场景/旧 seed/旧目标：不与当前场景拼接渲染，由页面呈现“情况已变化” */
  | { kind: "outdated"; bundleRevision: number; currentRevision: number }
  | { kind: "ready"; view: ReadyView };

/**
 * 建议卡状态归类：区分首次无结果 / 服务端无候选 / 选中组不在场景 / 选中方案不在候选 /
 * 结果已过期（场景、seed 或目标变化）/ 正常展示。
 * 只读 bundle 内已匹配的方案与结果，不做任何重算、不把当前场景与旧 bundle 拼成新结果。
 */
export function journeyCardState(
  scenario: Scenario,
  bundle: RunBundle | null,
  selectedPlanId: string | null,
  selectedGroupId: string | null,
  outdated = false
): JourneyCardState {
  if (!bundle) return { kind: "no_bundle" };
  if (outdated) {
    return { kind: "outdated", bundleRevision: bundle.scenario_revision, currentRevision: scenario.revision };
  }
  if (bundle.plans.length === 0) return { kind: "no_candidates" };
  if (!selectedGroupId || !scenario.groups.some((g) => g.group_id === selectedGroupId)) {
    return { kind: "group_missing" };
  }
  const plan = selectedPlanId ? bundle.plans.find((p) => p.plan_id === selectedPlanId) ?? null : null;
  if (!plan) return { kind: "plan_missing" };

  const result: SimulationResult | null = bundle.results.find((r) => r.plan_id === plan.plan_id) ?? null;
  const rec: Recommendation | null = bundle.recommendation;
  const recUsable = rec !== null && rec.status !== "no_valid_candidate" && rec.plan_id !== null ? rec : null;
  const recPlan = recUsable ? bundle.plans.find((p) => p.plan_id === recUsable.plan_id) ?? null : null;
  const isRecommended = recUsable !== null && recUsable.plan_id === plan.plan_id;

  return {
    kind: "ready",
    view: {
      planName: planDisplayName(plan),
      isRecommended,
      // “存在取舍”只描述推荐方案本身；查看非推荐方案时不展示该徽标
      recTradeoff: isRecommended && rec?.status === "tradeoff",
      recNoValid: rec?.status === "no_valid_candidate",
      recReason: isRecommended && recUsable ? humanizeReason(recUsable.reason) : null,
      recTradeoffItems: isRecommended && recUsable ? recUsable.tradeoffs.map(humanizeReason) : [],
      recPlanName: recPlan !== null && !isRecommended ? planDisplayName(recPlan) : null,
      resultStatus: result ? result.status : "none",
      serve: serveStatusForGroup(scenario, plan, result, selectedGroupId),
      routes: routeItemsForGroup(scenario, plan, selectedGroupId),
      metrics: groupKeyMetrics(scenario, result, selectedGroupId),
    },
  };
}

/* ================= 局部格式化 ================= */

/**
 * 摘要卡路线速览的选择推导（与 selectedRouteId 联动）：
 * - 用户已点选且该路线信息可展示 → 显示点选的那条（isSelected=true）；
 * - 未点选 → 显示首条，但仅作为组级分流的入口呈现（total>1 时注明分流），
 *   不默认宣称首条是“个人最佳路线”；
 * - sequenceText 缺失的路线不进速览（避免“路线信息缺失”占据摘要位）。
 */
export function routeSummaryForCard(
  routes: JourneyRouteItem[],
  selectedRouteId: string | null
): { routeId: string; sequenceText: string; total: number; isSelected: boolean } | null {
  if (routes.length === 0) return null;
  const displayable = routes.filter((r) => r.sequenceText !== null);
  if (displayable.length === 0) return null;
  const picked =
    (selectedRouteId ? displayable.find((r) => r.routeId === selectedRouteId) : undefined) ?? displayable[0];
  return {
    routeId: picked.routeId,
    sequenceText: picked.sequenceText as string,
    total: routes.length,
    isSelected: picked.routeId === selectedRouteId,
  };
}

/* ================= 当前场景与数据模式（页面顶部上下文） ================= */

export type JourneyModeTone = "sim" | "replay" | "mock";

export interface JourneyContextView {
  sceneTitle: string;
  /** 数据模式短标签：模拟推演 / 已保存结果回放 / 开发占位数据 */
  modeLabel: string;
  /** 模式说明（一句话，含事实边界） */
  modeNote: string;
  tone: JourneyModeTone;
}

/**
 * 首页顶部“当前场景与数据模式”的纯展示推导。
 * 优先级：开发 MOCK > 已保存回放 > 实时模拟；只描述数据来源，不判断结果新鲜度
 * （过期由建议卡与外壳横幅负责，避免同一信息重复堆叠）。
 */
export function journeyContextFor(
  scenario: Pick<Scenario, "title">,
  opts: { inReplay: boolean; replayLabel?: string | null; mock?: boolean }
): JourneyContextView {
  const sceneTitle = scenario.title.trim() || "当前场景";
  if (opts.mock) {
    return {
      sceneTitle,
      modeLabel: "开发占位数据",
      modeNote: "前端占位数据，非真实引擎计算；仅用于流程校对",
      tone: "mock",
    };
  }
  if (opts.inReplay) {
    const label = opts.replayLabel?.trim() ?? "";
    return {
      sceneTitle,
      modeLabel: "已保存结果回放",
      modeNote: label ? `历史计算快照「${label}」，非本次计算` : "历史计算快照，非本次计算",
      tone: "replay",
    };
  }
  return {
    sceneTitle,
    modeLabel: "模拟推演",
    modeNote: "合成场景的群体推演，不是实时导航",
    tone: "sim",
  };
}

/** 模拟平均排队的易读显示；非有限数显示“—”（无样本，不是 0） */
export function formatWaitSeconds(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const s = Math.round(v);
  if (s < 60) return `${s} 秒`;
  return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}
