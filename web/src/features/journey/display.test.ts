/**
 * journey 模块展示推导单测（窗口1局部）：
 * 覆盖无可用路线、组指标与 null 语义、无合法结果、状态归类与推荐标记。
 * 不测 CSS 类名与组件渲染；浏览器全链路由窗口4执行。
 */
import { describe, expect, it } from "vitest";
import { cloneDefaultScenario } from "../../contract/defaultScenario";
import type { Plan, SimulationResult } from "../../contract/types";
import type { RunBundle } from "../../state/store";
import type { ServeStatus } from "../../labels";
import { formatWaitSeconds, journeyCardState, routeItemsForGroup, type ReadyView } from "./display";

/* ================= 测试数据构造 ================= */

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

function makeResult(overrides: Partial<SimulationResult>): SimulationResult {
  return {
    schema_version: "1.0",
    engine_version: "test",
    scenario_id: "concert_demo",
    scenario_revision: 1,
    plan_id: "p1",
    seed: 1,
    status: "valid",
    violations: [],
    metrics: null,
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

function expectServeBlocked(view: ReadyView): Extract<ServeStatus, { level: "blocked" }> {
  if (view.serve?.level !== "blocked") throw new Error(`expected blocked, got ${view.serve?.level ?? "null"}`);
  return view.serve;
}

function expectServeOk(view: ReadyView): Extract<ServeStatus, { level: "ok" }> {
  if (view.serve?.level !== "ok") throw new Error(`expected ok, got ${view.serve?.level ?? "null"}`);
  return view.serve;
}

/* ================= 路线列表 ================= */

describe("routeItemsForGroup", () => {
  const scenario = cloneDefaultScenario();

  it("多条分流路线完整呈现：序列、份额与通行条件来自场景，不汇总分母", () => {
    const plan = makePlan({
      allocations: [
        { group_id: "regular", routes: [{ route_id: "R2", share: 0.6 }, { route_id: "R3", share: 0.4 }] },
      ],
    });
    const items = routeItemsForGroup(scenario, plan, "regular");
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      routeId: "R2",
      sequenceText: "场馆 → 2号出口 → 接驳点 P2",
      sharePct: 60,
      closed: false,
      stepFree: true,
      missing: false,
    });
    expect(items[1]).toMatchObject({
      routeId: "R3",
      sequenceText: "场馆 → 3号出口 → 接驳点 P2",
      sharePct: 40,
      closed: false,
      stepFree: false,
    });
  });

  it("route_id 不在场景中：不猜测序列与通行条件，份额保留", () => {
    const plan = makePlan({
      allocations: [{ group_id: "regular", routes: [{ route_id: "RX", share: 1 }] }],
    });
    const items = routeItemsForGroup(scenario, plan, "regular");
    expect(items[0].missing).toBe(true);
    expect(items[0].sequenceText).toBeNull();
    expect(items[0].closed).toBeNull();
    expect(items[0].stepFree).toBeNull();
    expect(items[0].sharePct).toBe(100);
  });

  it("share 非法（超界/非数字）显示为缺失而不是猜测", () => {
    const plan = makePlan({
      allocations: [{ group_id: "regular", routes: [{ route_id: "R1", share: 1.5 }] }],
    });
    expect(routeItemsForGroup(scenario, plan, "regular")[0].sharePct).toBeNull();
  });

  it("分配为空 / 分配缺失 / 无方案都返回空列表（按未安排路线呈现）", () => {
    const plan = makePlan({ allocations: [{ group_id: "regular", routes: [] }] });
    expect(routeItemsForGroup(scenario, plan, "regular")).toEqual([]);
    expect(routeItemsForGroup(scenario, plan, "ghost")).toEqual([]);
    expect(routeItemsForGroup(scenario, null, "regular")).toEqual([]);
  });
});

/* ================= 建议卡状态归类 ================= */

describe("journeyCardState", () => {
  const scenario = cloneDefaultScenario();

  it("无结果 / 无候选 / 组缺失 / 方案缺失 各自归类，不互相冒充", () => {
    expect(journeyCardState(scenario, null, null, "regular")).toEqual({ kind: "no_bundle" });
    expect(journeyCardState(scenario, makeBundle({}), "p1", "regular")).toEqual({ kind: "no_candidates" });

    const plan = makePlan({ allocations: [{ group_id: "regular", routes: [] }] });
    expect(journeyCardState(scenario, makeBundle({ plans: [plan] }), "p1", "ghost")).toEqual({
      kind: "group_missing",
    });
    expect(journeyCardState(scenario, makeBundle({ plans: [plan] }), "other", "regular")).toEqual({
      kind: "plan_missing",
    });
  });

  it("只有与服务端推荐一致时才标记推荐；尊重当前选中的其他方案", () => {
    const planA = makePlan({
      plan_id: "p1",
      allocations: [{ group_id: "regular", routes: [{ route_id: "R1", share: 1 }] }],
    });
    const planB = makePlan({
      plan_id: "p2",
      strategy: "baseline",
      allocations: [{ group_id: "regular", routes: [{ route_id: "R2", share: 1 }] }],
    });
    const bundle = makeBundle({
      plans: [planA, planB],
      recommendation: { plan_id: "p1", status: "recommended", reason: "plan_coordinated 更优", tradeoffs: [] },
    });

    const viewA = expectReady(journeyCardState(scenario, bundle, "p1", "regular"));
    expect(viewA.isRecommended).toBe(true);
    expect(viewA.planName).toBe("协调接驳方案");

    const viewB = expectReady(journeyCardState(scenario, bundle, "p2", "regular"));
    expect(viewB.isRecommended).toBe(false);
    expect(viewB.planName).toBe("固定班次方案");
  });

  it("no_valid_candidate：不标推荐、不给理由，recNoValid 显式提示", () => {
    const plan = makePlan({
      plan_id: "p1",
      allocations: [{ group_id: "regular", routes: [{ route_id: "R1", share: 1 }] }],
    });
    const bundle = makeBundle({
      plans: [plan],
      recommendation: { plan_id: null, status: "no_valid_candidate", reason: "所有候选不可用", tradeoffs: [] },
    });
    const view = expectReady(journeyCardState(scenario, bundle, "p1", "regular"));
    expect(view.recNoValid).toBe(true);
    expect(view.isRecommended).toBe(false);
    expect(view.recReason).toBeNull();
    expect(view.recTradeoffItems).toEqual([]);
  });

  it("结果无效（invalid）：无指标、受阻状态为方案校验失败", () => {
    const plan = makePlan({
      plan_id: "p1",
      allocations: [{ group_id: "regular", routes: [{ route_id: "R1", share: 1 }] }],
    });
    const result = makeResult({
      status: "invalid",
      violations: [{ code: "PLAN_STOP_GAP", path: "plan", message: "班次冲突", severity: "error" }],
    });
    const bundle = makeBundle({ plans: [plan], results: [result] });
    const view = expectReady(journeyCardState(scenario, bundle, "p1", "regular"));
    expect(view.resultStatus).toBe("invalid");
    expect(view.metrics).toBeNull();
    expect(expectServeBlocked(view).reason).toBe("invalid_plan");
  });

  it("结果有效但缺该组指标：字段为 null 而不是 0（null 语义）", () => {
    const plan = makePlan({
      plan_id: "p1",
      allocations: [{ group_id: "regular", routes: [{ route_id: "R1", share: 1 }] }],
    });
    const bundle = makeBundle({
      plans: [plan],
      results: [makeResult({ group_metrics: [] })],
    });
    const view = expectReady(journeyCardState(scenario, bundle, "p1", "regular"));
    expect(view.metrics).not.toBeNull();
    expect(view.metrics?.boarded).toBeNull();
    expect(view.metrics?.released).toBeNull();
    expect(view.metrics?.remaining).toBeNull();
    expect(view.metrics?.meanWait).toBeNull();
  });

  it("无可用通道：分配路线全部含关闭通道时受阻且注明原因", () => {
    const scenarioClosed = cloneDefaultScenario();
    scenarioClosed.edges = scenarioClosed.edges.map((e) =>
      e.edge_id === "a1" || e.edge_id === "a2" ? { ...e, closed: true } : e
    );
    const plan = makePlan({
      plan_id: "p1",
      allocations: [{ group_id: "regular", routes: [{ route_id: "R1", share: 1 }] }],
    });
    const bundle = makeBundle({
      plans: [plan],
      results: [makeResult({ group_metrics: [
        {
          group_id: "regular",
          released_count: 180,
          boarded_count: 0,
          remaining_count: 180,
          mean_queue_wait_all_released_s: null,
          p95_queue_wait_boarded_s: null,
          missed_deadline_count: 0,
          clearance_time_s: null,
        },
      ] })],
    });
    const view = expectReady(journeyCardState(scenarioClosed, bundle, "p1", "regular"));
    expect(expectServeBlocked(view).reason).toBe("no_open_route");
  });

  it("仍有旅客未登车：是带警告的可行状态，不是断路", () => {
    const plan = makePlan({
      plan_id: "p1",
      allocations: [{ group_id: "regular", routes: [{ route_id: "R1", share: 1 }] }],
    });
    const bundle = makeBundle({
      plans: [plan],
      results: [makeResult({
        metrics: {
          released_count: 180,
          boarded_count: 150,
          remaining_count: 30,
          mean_queue_wait_all_released_s: 95,
          p95_queue_wait_boarded_s: 200,
          missed_deadline_count: 0,
          clearance_time_s: 1500,
        },
        group_metrics: [
          {
            group_id: "regular",
            released_count: 180,
            boarded_count: 150,
            remaining_count: 30,
            mean_queue_wait_all_released_s: 95,
            p95_queue_wait_boarded_s: 200,
            missed_deadline_count: 0,
            clearance_time_s: 1500,
          },
        ],
      })],
    });
    const view = expectReady(journeyCardState(scenario, bundle, "p1", "regular"));
    expect(expectServeOk(view).warning).toContain("30");
    expect(view.metrics?.remaining).toBe(30);
  });

  it("末班组显示错过截止人数；同结果的普通组该项为 null", () => {
    const plan = makePlan({
      plan_id: "p1",
      allocations: [{ group_id: "deadline", routes: [{ route_id: "R2", share: 1 }] }],
    });
    const bundle = makeBundle({
      plans: [plan],
      results: [makeResult({ group_metrics: [
        {
          group_id: "deadline",
          released_count: 80,
          boarded_count: 56,
          remaining_count: 24,
          mean_queue_wait_all_released_s: 120.4,
          p95_queue_wait_boarded_s: 300,
          missed_deadline_count: 24,
          clearance_time_s: null,
        },
      ] })],
    });
    const deadlineView = expectReady(journeyCardState(scenario, bundle, "p1", "deadline"));
    expect(deadlineView.metrics?.missedDeadline).toBe(24);
    expect(deadlineView.metrics?.total).toBe(80);
    expect(deadlineView.metrics?.boarded).toBe(56);
  });
});

/* ================= 局部格式化 ================= */

describe("formatWaitSeconds", () => {
  it("秒与分钟的易读格式；非有限数显示 —（无样本，不是 0）", () => {
    expect(formatWaitSeconds(45)).toBe("45 秒");
    expect(formatWaitSeconds(120.4)).toBe("2 分 0 秒");
    expect(formatWaitSeconds(Number.NaN)).toBe("—");
    expect(formatWaitSeconds(Number.POSITIVE_INFINITY)).toBe("—");
  });
});
