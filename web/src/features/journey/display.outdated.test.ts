/**
 * 过期守卫与推荐理由绑定单测（本轮修复回归）：
 * 1) 结果过期（场景/seed/目标变化）→ outdated 状态，不与当前场景拼接渲染；
 * 2) 推荐理由只解释推荐方案本身——查看非推荐方案时不得出现指向另一方案的“为什么推荐”。
 * 浏览器全链路复现由窗口4执行。
 */
import { describe, expect, it } from "vitest";
import { cloneDefaultScenario } from "../../contract/defaultScenario";
import type { Plan, SimulationResult } from "../../contract/types";
import type { RunBundle } from "../../state/store";
import { journeyCardState, routeSummaryForCard } from "./display";

function makePlan(overrides: Partial<Plan>): Plan {
  return {
    schema_version: "1.0",
    plan_id: "p1",
    scenario_id: "concert_demo",
    scenario_revision: 1,
    strategy: "coordinated",
    name: "",
    allocations: [],
    departures: [],
    ...overrides,
  };
}

function makeResult(planId: string, overrides: Partial<SimulationResult>): SimulationResult {
  return {
    schema_version: "1.0",
    engine_version: "test",
    scenario_id: "concert_demo",
    scenario_revision: 1,
    plan_id: planId,
    seed: 1,
    status: "valid",
    violations: [],
    metrics: { released_count: 300, boarded_count: 300, remaining_count: 0, mean_queue_wait_all_released_s: 100, p95_queue_wait_boarded_s: 120, missed_deadline_count: 0, clearance_time_s: 600 },
    group_metrics: [],
    timeline: [],
    departures_log: [],
    ...overrides,
  };
}

function makeBundle(overrides: Partial<RunBundle>): RunBundle {
  return {
    scenario_id: "concert_demo",
    scenario_revision: 1,
    seed: 1,
    objective: "balanced",
    plans: [],
    generate_trace: [],
    generate_mode: "rules",
    results: [],
    recommendation: null,
    compare_trace: [],
    compare_mode: "rules",
    finished_at: 0,
    ...overrides,
  };
}

function expectReady(state: ReturnType<typeof journeyCardState>) {
  if (state.kind !== "ready") throw new Error(`expected ready, got ${state.kind}`);
  return state.view;
}

const basePlan = makePlan({ plan_id: "p_base", strategy: "baseline" });
const coordPlan = makePlan({ plan_id: "p_coord", strategy: "coordinated" });
const bundle: RunBundle = makeBundle({
  plans: [basePlan, coordPlan],
  results: [makeResult("p_base", {}), makeResult("p_coord", {})],
  recommendation: { plan_id: "p_coord", status: "recommended", reason: "plan_coordinated_x 的 remaining_count 最小", tradeoffs: ["错过末班人数=24"] },
});

describe("过期守卫（情况已变化）", () => {
  it("outdated=true 时无论选中什么方案都返回 outdated，不与当前场景拼接", () => {
    const state = journeyCardState(cloneDefaultScenario(), bundle, "p_coord", "regular", true);
    expect(state).toEqual({ kind: "outdated", bundleRevision: 1, currentRevision: 1 });
  });

  it("outdated 优先于 ready/plan_missing/no_candidates", () => {
    const empty = makeBundle({});
    expect(journeyCardState(cloneDefaultScenario(), empty, null, "regular", true).kind).toBe("outdated");
    const staleBundle = makeBundle({ scenario_revision: 2, plans: [coordPlan], results: [makeResult("p_coord", {})] });
    expect(journeyCardState(cloneDefaultScenario(), staleBundle, "p_coord", "regular", true)).toEqual({
      kind: "outdated",
      bundleRevision: 2,
      currentRevision: 1,
    });
  });

  it("outdated=false 时正常 ready（回归不误伤）", () => {
    expect(journeyCardState(cloneDefaultScenario(), bundle, "p_coord", "regular", false).kind).toBe("ready");
  });
});

describe("推荐理由绑定当前方案", () => {
  it("查看推荐方案：显示理由与取舍，recPlanName 为 null", () => {
    const view = expectReady(journeyCardState(cloneDefaultScenario(), bundle, "p_coord", "regular", false));
    expect(view.isRecommended).toBe(true);
    expect(view.recReason).toContain("协调接驳方案");
    expect(view.recTradeoffItems).toHaveLength(1);
    expect(view.recPlanName).toBeNull();
  });

  it("查看非推荐方案（如固定班次）：不出现指向协调方案的理由，改为明示系统推荐对象", () => {
    const view = expectReady(journeyCardState(cloneDefaultScenario(), bundle, "p_base", "regular", false));
    expect(view.isRecommended).toBe(false);
    expect(view.recReason).toBeNull();
    expect(view.recTradeoffItems).toEqual([]);
    expect(view.recTradeoff).toBe(false);
    expect(view.recPlanName).toBe("协调接驳方案");
  });

  it("服务端无可用推荐：recNoValid=true，不产生任何推荐理由或推荐对象名", () => {
    const noRec = makeBundle({
      plans: [basePlan, coordPlan],
      results: [makeResult("p_base", {}), makeResult("p_coord", {})],
      recommendation: { plan_id: null, status: "no_valid_candidate", reason: "无合法候选", tradeoffs: [] },
    });
    const view = expectReady(journeyCardState(cloneDefaultScenario(), noRec, "p_base", "regular", false));
    expect(view.recNoValid).toBe(true);
    expect(view.recReason).toBeNull();
    expect(view.recPlanName).toBeNull();
    expect(view.recTradeoff).toBe(false);
  });
});

describe("routeSummaryForCard：摘要速览与 selectedRouteId 联动", () => {
  const routes = [
    { routeId: "R1", sequenceText: "场馆 → 1号出口 → 接驳点 P1", sharePct: 51, closed: false, stepFree: true, missing: false },
    { routeId: "R2", sequenceText: "场馆 → 2号出口 → 接驳点 P2", sharePct: 49, closed: false, stepFree: true, missing: false },
    { routeId: "R3", sequenceText: "场馆 → 3号出口 → 接驳点 P2", sharePct: 36, closed: false, stepFree: false, missing: false },
  ] as const;

  it("未点选 → 显示首条并带组级分流总数，不宣称个人最佳", () => {
    const s = routeSummaryForCard([...routes], null);
    expect(s).toEqual({ routeId: "R1", sequenceText: routes[0].sequenceText, total: 3, isSelected: false });
  });

  it("点选 R2 → 摘要速览切换为 R2 并标记 isSelected", () => {
    expect(routeSummaryForCard([...routes], "R2")).toEqual({
      routeId: "R2",
      sequenceText: routes[1].sequenceText,
      total: 3,
      isSelected: true,
    });
  });

  it("点选的路线信息缺失（sequenceText 为 null）→ 回退首条可展示路线", () => {
    const withMissing = [
      { routeId: "R1", sequenceText: null, sharePct: 50, closed: null, stepFree: null, missing: true },
      { routeId: "R2", sequenceText: "场馆 → 2号出口 → 接驳点 P2", sharePct: 50, closed: false, stepFree: true, missing: false },
    ];
    expect(routeSummaryForCard(withMissing, "R1")).toEqual({
      routeId: "R2",
      sequenceText: "场馆 → 2号出口 → 接驳点 P2",
      total: 2,
      isSelected: false, // R1 不可展示，实际展示的是 R2 且非点选态
    });
  });

  it("全部路线信息缺失 → 不提供速览（不显示“路线信息缺失”占摘要位）", () => {
    const allMissing = [
      { routeId: "R9", sequenceText: null, sharePct: null, closed: null, stepFree: null, missing: true },
    ];
    expect(routeSummaryForCard(allMissing, null)).toBeNull();
    expect(routeSummaryForCard([], null)).toBeNull();
  });

  it("单条路线 → total=1，不渲染分流注记", () => {
    const single = [routes[1]];
    const s = routeSummaryForCard([...single], null);
    expect(s).toEqual({ routeId: "R2", sequenceText: routes[1].sequenceText, total: 1, isSelected: false });
  });
});
