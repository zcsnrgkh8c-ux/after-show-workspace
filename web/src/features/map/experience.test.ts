/**
 * 窗口2 局部测试：首页地图体验的数据状态推导（纯函数）。
 * 关注：过期/无结果边界、无可行路线不画成功路线、合法结果才可回放、
 * 关闭/台阶/截止等阻断情形的准确文案——不做任何指标编造。
 */
import { describe, expect, it } from "vitest";
import { cloneDefaultScenario } from "../../contract/defaultScenario";
import type { Plan, SimulationResult, TimelineFrame } from "../../contract/types";
import type { HealthState, RunBundle } from "../../state/store";
import { mapExperienceStatus, mapServeView, planRoutesForMap, playableTimeline } from "./experience";

/* ---------- 夹具 ---------- */

const scenario = cloneDefaultScenario();

const bundleStub = { scenario_id: "concert_demo" } as unknown as RunBundle;

const healthOk: HealthState = { state: "ok", engine_ready: true };
const healthDown: HealthState = { state: "down", message: "网络错误" };
const healthChecking: HealthState = { state: "checking" };
const healthEngineNotReady: HealthState = { state: "ok", engine_ready: false };

/** 三组各有分配：regular→R1、step_free→R3（含台阶）、deadline→R2 */
const planAll: Plan = {
  allocations: [
    { group_id: "regular", routes: [{ route_id: "R1", share: 1 }] },
    { group_id: "step_free", routes: [{ route_id: "R3", share: 1 }] },
    { group_id: "deadline", routes: [{ route_id: "R2", share: 1 }] },
  ],
} as unknown as Plan;

function mkFrame(t: number): TimelineFrame {
  return {
    t_s: t,
    released_count: 0,
    boarded_count: 0,
    queued_count: 0,
    walking_count: 0,
    node_queues: {},
    edge_counts: {},
    group_counts: {},
  };
}

function mkMetrics(overrides: Partial<SimulationResult["metrics"]> = {}): SimulationResult["metrics"] {
  return {
    released_count: 300,
    boarded_count: 300,
    remaining_count: 0,
    mean_queue_wait_all_released_s: 100,
    p95_queue_wait_boarded_s: 200,
    missed_deadline_count: 0,
    clearance_time_s: 900,
    ...overrides,
  } as NonNullable<SimulationResult["metrics"]>;
}

/** 合法结果：三组全部登车；deadline 组 24 人错过末班（默认场景口径） */
const validResult = {
  status: "valid",
  metrics: mkMetrics({ missed_deadline_count: 24 }),
  group_metrics: [
    { ...mkMetrics({ missed_deadline_count: 0 }), group_id: "regular" },
    { ...mkMetrics(), group_id: "step_free" },
    { ...mkMetrics({ missed_deadline_count: 24 }), group_id: "deadline" },
  ],
  timeline: [mkFrame(0), mkFrame(300)],
  departures_log: [],
  violations: [],
} as unknown as SimulationResult;

const remainingResult = {
  status: "valid",
  metrics: mkMetrics({ boarded_count: 288, remaining_count: 12 }),
  group_metrics: [
    { ...mkMetrics(), group_id: "regular" },
    { ...mkMetrics({ boarded_count: 28, remaining_count: 12 }), group_id: "step_free" },
    { ...mkMetrics(), group_id: "deadline" },
  ],
  timeline: [mkFrame(0)],
  departures_log: [],
  violations: [],
} as unknown as SimulationResult;

const invalidResult = {
  status: "invalid",
  metrics: null,
  group_metrics: [],
  timeline: [],
  departures_log: [],
  violations: [{ code: "PLAN_STOP_GAP", path: "plan", message: "班次冲突", severity: "error" }],
} as unknown as SimulationResult;

const validNoMetrics = {
  status: "valid",
  metrics: null,
  group_metrics: [],
  timeline: [],
  departures_log: [],
  violations: [],
} as unknown as SimulationResult;

/* ---------- 整体状态 ---------- */

describe("mapExperienceStatus：过期/无结果/就绪边界", () => {
  it("旧结果过期：outdated，不再把旧结果当有效建议", () => {
    const s = mapExperienceStatus({ bundle: bundleStub, outdated: true, inReplay: false, health: healthOk });
    expect(s.kind).toBe("outdated");
    expect(s.kind === "outdated" && s.note).toContain("不再作为有效建议");
  });

  it("无结果：按健康状态给出准确原因（服务不可达 / 引擎未就绪 / 连接中 / 尚未计算）", () => {
    const down = mapExperienceStatus({ bundle: null, outdated: false, inReplay: false, health: healthDown });
    expect(down.kind).toBe("no_result");
    expect(down.kind === "no_result" && down.note).toContain("服务暂不可达");

    const notReady = mapExperienceStatus({ bundle: null, outdated: false, inReplay: false, health: healthEngineNotReady });
    expect(notReady.kind === "no_result" && notReady.note).toContain("引擎未就绪");

    const checking = mapExperienceStatus({ bundle: null, outdated: false, inReplay: false, health: healthChecking });
    expect(checking.kind === "no_result" && checking.note).toContain("正在连接服务");

    const fresh = mapExperienceStatus({ bundle: null, outdated: false, inReplay: false, health: healthOk });
    expect(fresh.kind === "no_result" && fresh.note).toContain("尚未生成接驳方案");
  });

  it("有结果：ready；回放时附已保存结果说明，实时时无附加说明", () => {
    const live = mapExperienceStatus({ bundle: bundleStub, outdated: false, inReplay: false, health: healthOk });
    expect(live.kind).toBe("ready");
    expect(live.kind === "ready" && live.note).toBeNull();

    const replay = mapExperienceStatus({ bundle: bundleStub, outdated: false, inReplay: true, health: healthOk });
    expect(replay.kind).toBe("ready");
    expect(replay.kind === "ready" && replay.note).toContain("已保存结果");
  });
});

/* ---------- 需求服务状态 ---------- */

describe("mapServeView：无可行路线/台阶/关闭/截止的准确展示", () => {
  it("未选择需求 → unknown；无方案 → unknown（不误报阻断）", () => {
    expect(mapServeView(scenario, planAll, validResult, null)).toMatchObject({ level: "unknown", title: "尚未选择出行需求" });
    expect(mapServeView(scenario, null, null, "regular").level).toBe("unknown");
  });

  it("分配为空 → blocked（no_route），不画成功路线", () => {
    const planNoRoute = { allocations: [{ group_id: "regular", routes: [] }] } as unknown as Plan;
    const v = mapServeView(scenario, planNoRoute, validResult, "regular");
    expect(v.level).toBe("blocked");
    expect(v.title).toContain("未为该需求安排接驳路线");
  });

  it("路线全部关闭 → blocked（no_open_route）", () => {
    const closed = cloneDefaultScenario();
    for (const e of closed.edges) if (e.edge_id === "a1" || e.edge_id === "a2") e.closed = true;
    const v = mapServeView(closed, planAll, validResult, "regular");
    expect(v.level).toBe("blocked");
    expect(v.title).toContain("缺少满足需求的开放路线");
  });

  it("无台阶组被分配含台阶路线 → blocked，只认实际合法分配", () => {
    const v = mapServeView(scenario, planAll, validResult, "step_free");
    expect(v.level).toBe("blocked");
    expect(v.title).toContain("包含台阶");
  });

  it("合法结果 + 全部登车但有 24 人错过末班 → ok 且保留截止警示（登车≠赶上截止）", () => {
    const v = mapServeView(scenario, planAll, validResult, "deadline");
    expect(v.level).toBe("ok");
    expect(v.warning).toContain("24");
    expect(v.warning).toContain("截止");
  });

  it("合法结果 + 仍有滞留 → ok 且保留滞留警示（不误报断路）", () => {
    // step_free 组改为合法无台阶路线 R2（b1/b2 均无台阶），仅剩滞留警示
    const planLegal = {
      allocations: [
        { group_id: "regular", routes: [{ route_id: "R1", share: 1 }] },
        { group_id: "step_free", routes: [{ route_id: "R2", share: 1 }] },
        { group_id: "deadline", routes: [{ route_id: "R2", share: 1 }] },
      ],
    } as unknown as Plan;
    const v = mapServeView(scenario, planLegal, remainingResult, "step_free");
    expect(v.level).toBe("ok");
    expect(v.warning).toContain("未登车");
  });

  it("方案校验未通过（invalid）→ blocked，不展示指标", () => {
    const v = mapServeView(scenario, planAll, invalidResult, "regular");
    expect(v.level).toBe("blocked");
    expect(v.title).toContain("校验未通过");
  });

  it("valid 但无指标 → unknown（null 不当 0，也不当作可用）", () => {
    const v = mapServeView(scenario, planAll, validNoMetrics, "regular");
    expect(v.level).toBe("unknown");
  });
});

/* ---------- 地图路线与回放边界 ---------- */

describe("planRoutesForMap / playableTimeline：不画成功路线、不播伪造帧", () => {
  it("过期或无结果时不画任何方案路线", () => {
    const outdated = mapExperienceStatus({ bundle: bundleStub, outdated: true, inReplay: false, health: healthOk });
    expect(planRoutesForMap(outdated, { level: "ok", title: "" }, planAll)).toBeNull();

    const noResult = mapExperienceStatus({ bundle: null, outdated: false, inReplay: false, health: healthOk });
    expect(planRoutesForMap(noResult, { level: "ok", title: "" }, planAll)).toBeNull();
  });

  it("当前需求被阻断时不画该方案路线（不显示成功路线）；就绪且可行时才画", () => {
    const ready = mapExperienceStatus({ bundle: bundleStub, outdated: false, inReplay: false, health: healthOk });
    expect(planRoutesForMap(ready, { level: "blocked", title: "x" }, planAll)).toBeNull();
    expect(planRoutesForMap(ready, { level: "ok", title: "" }, planAll)).toBe(planAll);
  });

  it("回放条件：仅合法结果且存在真实时间线", () => {
    expect(playableTimeline(validResult)).toBe(true);
    expect(playableTimeline({ ...validResult, timeline: [] } as unknown as SimulationResult)).toBe(false);
    expect(playableTimeline(invalidResult)).toBe(false);
    expect(playableTimeline(null)).toBe(false);
  });
});
