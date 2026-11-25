/**
 * engine.test.ts — A 同学验收清单的可执行版本。
 * 运行：node --test server/simulation/engine.test.ts（Node ≥ 24，零依赖）
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Plan, Scenario } from "../../shared/types.ts";
import { simulate } from "./engine.ts";
import { validatePlan, validateScenario } from "./validate.ts";
import { generateDemand } from "./demand.ts";
import { nearestRankP95 } from "./metrics.ts";
import {
  DEMO_SEED,
  baselineNoBoarding,
  baselineRev1,
  baselineRev2,
  baselineZeroDemand,
  candidateSplitRev1,
  concertDemoRev1,
  concertDemoRev2,
  invalidPlans,
  noBoarding,
  zeroDemand,
} from "../../fixtures/index.ts";

/* ---------- 工具 ---------- */

function miniScenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    schema_version: "1.0",
    scenario_id: "mini",
    revision: 1,
    title: "最小合成场景",
    demand_source: "synthetic",
    horizon_s: 200,
    step_s: 5,
    nodes: [
      { node_id: "S", kind: "source", x: 50, y: 10 },
      { node_id: "P", kind: "stop", x: 50, y: 90, boarding_gap_s: 10 },
    ],
    edges: [{ edge_id: "sp", from: "S", to: "P", travel_s: 5, capacity_per_min: 60, step_free: true, closed: false }],
    routes: [{ route_id: "R", edge_ids: ["sp"], stop_id: "P" }],
    groups: [
      { group_id: "g", count: 2, release_start_s: 0, release_end_s: 0, needs_step_free: false, walk_time_factor: 1, board_deadline_s: null },
    ],
    fleet: [{ vehicle_id: "B1", capacity: 10, available_from_s: 0, round_trip_s: 1000 }],
    ...overrides,
  };
}

function miniPlan(overrides: Partial<Plan> = {}): Plan {
  return {
    schema_version: "1.0",
    plan_id: "mini_plan",
    scenario_id: "mini",
    scenario_revision: 1,
    strategy: "baseline",
    name: "mini",
    allocations: [{ group_id: "g", routes: [{ route_id: "R", share: 1 }] }],
    departures: [{ vehicle_id: "B1", stop_id: "P", depart_s: 100 }],
    ...overrides,
  };
}

/* ---------- 1. 确定性：相同输入和 seed 连续运行结果一致 ---------- */

test("相同 (scenario, plan, seed) 连续两次运行结果完全一致", () => {
  const r1 = simulate(concertDemoRev1, baselineRev1, DEMO_SEED);
  const r2 = simulate(concertDemoRev1, baselineRev1, DEMO_SEED);
  assert.equal(r1.status, "valid");
  assert.deepEqual(r1, r2);
});

test("不同 seed 产生不同释放时刻；释放生成与 plan 无关", () => {
  const d1 = generateDemand(concertDemoRev1, DEMO_SEED).map((p) => `${p.person_id}@${p.release_s}`);
  const d2 = generateDemand(concertDemoRev1, 42).map((p) => `${p.person_id}@${p.release_s}`);
  const d3 = generateDemand(concertDemoRev1, DEMO_SEED).map((p) => `${p.person_id}@${p.release_s}`);
  assert.deepEqual(d1, d3); // 同 seed 可复现
  assert.notDeepEqual(d1, d2); // 换 seed 确实改变到达（证明 seed 真实参与计算）
});

test("更换策略不改变同一批旅客的释放时刻（跨 plan 公平）", () => {
  const rBase = simulate(concertDemoRev1, baselineRev1, DEMO_SEED);
  const rCand = simulate(concertDemoRev1, candidateSplitRev1, DEMO_SEED);
  assert.equal(rBase.status, "valid");
  assert.equal(rCand.status, "valid");
  assert.deepEqual(
    rBase.timeline.map((f) => f.released_count),
    rCand.timeline.map((f) => f.released_count),
  );
});

/* ---------- 2. 正常场景与事件场景从相同初始条件重跑 ---------- */

test("事件 rev2（关 a1 + 减 B3）与 rev1 共享同一批释放时刻，但结果真实不同", () => {
  const r1 = simulate(concertDemoRev1, baselineRev1, DEMO_SEED);
  const r2 = simulate(concertDemoRev2, baselineRev2, DEMO_SEED);
  assert.equal(r1.status, "valid");
  assert.equal(r2.status, "valid");
  assert.deepEqual(
    r1.timeline.map((f) => f.released_count),
    r2.timeline.map((f) => f.released_count),
  );
  assert.notDeepEqual(r1.metrics, r2.metrics); // 事件必须真实改变结果，KPI 非硬编码
  assert.equal(r2.departures_log.every((d) => d.vehicle_id !== "B3"), true); // 已删除车辆不再出现
});

/* ---------- 3. validateScenario ---------- */

test("validateScenario 拦截非法引用、非正耗时/容量、无效版本、越窗时刻", () => {
  const bad = structuredClone(concertDemoRev1);
  bad.edges[0].to = "NOPE";
  bad.edges[1].travel_s = -5;
  bad.edges[2].capacity_per_min = 0;
  bad.revision = 0;
  bad.groups[0].release_end_s = 9999;
  const codes = validateScenario(bad).filter((i) => i.severity === "error").map((i) => i.code);
  for (const c of ["SCN_REF_UNKNOWN", "SCN_VALUE_NONPOSITIVE", "SCN_REVISION_INVALID", "SCN_TIME_OUT_OF_WINDOW"]) {
    assert.ok(codes.includes(c), `应包含 ${c}，实际 ${codes}`);
  }
});

test("“合法但无可达路线”（全部边关闭）是结构合法场景，不误报错误", () => {
  const issues = validateScenario(noBoarding);
  assert.equal(issues.filter((i) => i.severity === "error").length, 0);
});

/* ---------- 4. validatePlan 与班次容量 ---------- */

test("基线方案在四类场景下均合法（无 error 级违规）", () => {
  for (const [sc, pl] of [
    [concertDemoRev1, baselineRev1],
    [concertDemoRev2, baselineRev2],
    [zeroDemand, baselineZeroDemand],
    [noBoarding, baselineNoBoarding],
  ] as const) {
    const errors = validatePlan(sc, pl).filter((i) => i.severity === "error");
    assert.deepEqual(errors, [], `${sc.scenario_id} 基线应合法: ${JSON.stringify(errors)}`);
  }
});

test("非法方案样例逐一被拦截，status=invalid 且 metrics=null", () => {
  const cases: [Plan, Scenario, string][] = [
    [invalidPlans.invalidStaleRevision, concertDemoRev1, "PLAN_STALE_REVISION"],
    [invalidPlans.invalidShareSum, concertDemoRev1, "PLAN_SHARE_INVALID"],
    [invalidPlans.invalidStepFreeOnStairs, concertDemoRev1, "PLAN_STEP_FREE_VIOLATION"],
    [invalidPlans.invalidClosedRouteRev2, concertDemoRev2, "PLAN_ROUTE_CLOSED"],
    [invalidPlans.invalidVehicleOverlap, concertDemoRev1, "PLAN_VEHICLE_OVERLAP"],
    [invalidPlans.invalidStopGap, concertDemoRev1, "PLAN_STOP_GAP"],
    [invalidPlans.invalidUnknownVehicle, concertDemoRev1, "PLAN_VEHICLE_UNKNOWN"],
  ];
  for (const [plan, scenario, code] of cases) {
    const r = simulate(scenario, plan, DEMO_SEED);
    assert.equal(r.status, "invalid", `${plan.plan_id} 应为 invalid`);
    assert.equal(r.metrics, null);
    assert.ok(r.violations.some((v) => v.code === code), `${plan.plan_id} 应含 ${code}`);
  }
});

test("旧 revision 方案对新场景拒绝执行", () => {
  const r = simulate(concertDemoRev2, baselineRev1, DEMO_SEED); // rev1 基线 × rev2 场景
  assert.equal(r.status, "invalid");
  assert.ok(r.violations.some((v) => v.code === "PLAN_STALE_REVISION"));
});

test("运行时每个班次登车人数不超过车辆容量；空车班次保留记录", () => {
  const r = simulate(concertDemoRev1, baselineRev1, DEMO_SEED);
  const capOf = new Map(concertDemoRev1.fleet.map((v) => [v.vehicle_id, v.capacity]));
  for (const d of r.departures_log) {
    assert.ok(d.boarded_count <= capOf.get(d.vehicle_id)!, `${d.vehicle_id}@${d.depart_s} 超载`);
  }
  const rz = simulate(zeroDemand, baselineZeroDemand, DEMO_SEED);
  assert.ok(rz.departures_log.length > 0 && rz.departures_log.every((d) => d.boarded_count === 0), "空车班次必须保留");
});

/* ---------- 5. 逐帧人数守恒，终帧与汇总一致 ---------- */

test("300 人样例每一帧满足 released = boarded + walking + queued，终帧与汇总一致", () => {
  for (const plan of [baselineRev1, candidateSplitRev1]) {
    const r = simulate(concertDemoRev1, plan, DEMO_SEED);
    assert.equal(r.status, "valid");
    for (const f of r.timeline) {
      assert.equal(f.released_count, f.boarded_count + f.walking_count + f.queued_count, `t=${f.t_s} 不守恒`);
    }
    const last = r.timeline[r.timeline.length - 1];
    assert.equal(last.released_count, r.metrics!.released_count);
    assert.equal(last.boarded_count, r.metrics!.boarded_count);
    assert.equal(last.queued_count + last.walking_count, r.metrics!.remaining_count);
  }
});

/* ---------- 6. 低容量边小数余额跨步累计，不会永久停摆 ---------- */

test("q<1 的边按 credit 累计逐步放行（2 人先后通过容量 6 人/分钟的边）", () => {
  const sc = miniScenario({
    edges: [{ edge_id: "sp", from: "S", to: "P", travel_s: 5, capacity_per_min: 6, step_free: true, closed: false }],
  });
  const r = simulate(sc, miniPlan(), 7);
  assert.equal(r.status, "valid");
  assert.equal(r.metrics!.boarded_count, 2); // 两人最终都通过
  const f0 = r.timeline.find((f) => f.t_s === 0)!;
  const f5 = r.timeline.find((f) => f.t_s === 5)!;
  const f15 = r.timeline.find((f) => f.t_s === 15)!;
  assert.equal(f0.walking_count, 0); // q=0.5，首步无整数名额
  assert.equal(f0.queued_count, 2);
  assert.equal(f5.walking_count, 1); // 第二步累计出 1 个名额
  assert.equal(f15.walking_count, 1); // 第二人随后放行（不同时同边）
  assert.equal(r.metrics!.clearance_time_s, 100);
});

/* ---------- 7. 期限口径：逾期登车 + 截止后未登车；等于期限算赶上 ---------- */

test("missed_deadline_count 同时统计逾期登车者与窗口结束仍未登车者；未清空 clearance=null", () => {
  const sc = miniScenario({
    groups: [
      { group_id: "dl10", count: 1, release_start_s: 0, release_end_s: 0, needs_step_free: false, walk_time_factor: 1, board_deadline_s: 10 },
      { group_id: "dl20", count: 1, release_start_s: 0, release_end_s: 0, needs_step_free: false, walk_time_factor: 1, board_deadline_s: 20 },
    ],
    fleet: [{ vehicle_id: "B1", capacity: 1, available_from_s: 0, round_trip_s: 1000 }],
  });
  const plan = miniPlan({
    allocations: [
      { group_id: "dl10", routes: [{ route_id: "R", share: 1 }] },
      { group_id: "dl20", routes: [{ route_id: "R", share: 1 }] },
    ],
    departures: [{ vehicle_id: "B1", stop_id: "P", depart_s: 20 }],
  });
  const r = simulate(sc, plan, 7);
  assert.equal(r.status, "valid");
  // dl10 先到先登（FIFO 按 person_id），20s 登车晚于 10s 期限 → 逾期；dl20 容量满未登车 → 截止后未登
  assert.equal(r.metrics!.boarded_count, 1);
  assert.equal(r.metrics!.missed_deadline_count, 2);
  assert.equal(r.metrics!.clearance_time_s, null);
  const g10 = r.group_metrics.find((g) => g.group_id === "dl10")!;
  const g20 = r.group_metrics.find((g) => g.group_id === "dl20")!;
  assert.equal(g10.missed_deadline_count, 1);
  assert.equal(g20.missed_deadline_count, 1);
  // 等待口径可精确复算：dl10 在 P 等 [5,20)=15s；dl20 等 [5,200)=195s
  assert.equal(r.metrics!.p95_queue_wait_boarded_s, 15);
  assert.equal(r.metrics!.mean_queue_wait_all_released_s, (15 + 195) / 2);
});

test("登车时刻等于期限算赶上", () => {
  const sc = miniScenario({
    groups: [
      { group_id: "dl", count: 1, release_start_s: 0, release_end_s: 0, needs_step_free: false, walk_time_factor: 1, board_deadline_s: 20 },
    ],
  });
  const plan = miniPlan({
    allocations: [{ group_id: "dl", routes: [{ route_id: "R", share: 1 }] }],
    departures: [{ vehicle_id: "B1", stop_id: "P", depart_s: 20 }],
  });
  const r = simulate(sc, plan, 7);
  assert.equal(r.metrics!.missed_deadline_count, 0);
  assert.equal(r.metrics!.clearance_time_s, 20);
});

/* ---------- 8. P95：nearest-rank 且仅已登车者 ---------- */

test("nearestRankP95 口径：空样本 null、单样本自身、n=20 取第 19 位", () => {
  assert.equal(nearestRankP95([]), null);
  assert.equal(nearestRankP95([5]), 5);
  const v = Array.from({ length: 20 }, (_, i) => i + 1);
  assert.equal(nearestRankP95(v), 19); // ceil(0.95*20)=19
});

test("P95 只统计已登车者，滞留者不稀释也不掩盖", () => {
  const r = simulate(noBoarding, baselineNoBoarding, DEMO_SEED);
  assert.equal(r.metrics!.boarded_count, 0);
  assert.equal(r.metrics!.p95_queue_wait_boarded_s, null);
  assert.equal(r.metrics!.remaining_count, r.metrics!.released_count);
});

/* ---------- 9. 零需求与无人登车边界 ---------- */

test("零需求：clearance=0、等待指标 null、组与时间线完整保留", () => {
  const r = simulate(zeroDemand, baselineZeroDemand, DEMO_SEED);
  assert.equal(r.status, "valid");
  assert.deepEqual(
    { ...r.metrics! },
    {
      released_count: 0,
      boarded_count: 0,
      remaining_count: 0,
      mean_queue_wait_all_released_s: null,
      p95_queue_wait_boarded_s: null,
      missed_deadline_count: 0,
      clearance_time_s: 0,
    },
  );
  assert.equal(r.group_metrics.length, 3);
  assert.ok(r.group_metrics.every((g) => g.released_count === 0 && g.mean_queue_wait_all_released_s === null));
  assert.equal(r.timeline.length, zeroDemand.horizon_s / zeroDemand.step_s + 1);
  assert.ok(r.timeline.every((f) => f.released_count === 0));
});

test("无人登车：全体滞留 S，指标 null 正确，组级结果保留，warning 提示未满足服务", () => {
  const r = simulate(noBoarding, baselineNoBoarding, DEMO_SEED);
  assert.equal(r.status, "valid");
  assert.equal(r.metrics!.released_count, 110);
  assert.equal(r.metrics!.boarded_count, 0);
  assert.equal(r.metrics!.remaining_count, 110);
  // 110 人全部释放并滞留 S 至窗口结束：均值等待为正数（未满足服务计入统计，不删除）
  assert.ok(typeof r.metrics!.mean_queue_wait_all_released_s === "number" && r.metrics!.mean_queue_wait_all_released_s > 0);
  assert.equal(r.metrics!.clearance_time_s, null);
  assert.equal(r.metrics!.missed_deadline_count, 30); // deadline 组全体错过
  assert.equal(r.group_metrics.length, 3);
  const last = r.timeline[r.timeline.length - 1];
  assert.equal(last.node_queues["S"], 110);
  assert.ok(r.violations.some((v) => v.code === "PLAN_UNMET_GROUP" && v.severity === "warning"));
  assert.ok(r.departures_log.every((d) => d.boarded_count === 0));
});

/* ---------- 10. invalid 与 error 分流 ---------- */

test("非法 seed 返回 invalid 而非崩溃；status 只取 valid/invalid/error", () => {
  const r = simulate(concertDemoRev1, baselineRev1, -1);
  assert.equal(r.status, "invalid");
  assert.ok(r.violations.some((v) => v.code === "SEED_INVALID"));
  const r2 = simulate(concertDemoRev1, baselineRev1, DEMO_SEED);
  assert.ok(["valid", "invalid", "error"].includes(r2.status));
});

/* ---------- 11. 给 C 的样例结果字段完整（timeline 可回放） ---------- */

test("SimulationResult 字段符合 05 顶层结构，timeline 帧含全部回放所需字段", () => {
  const r = simulate(concertDemoRev1, baselineRev1, DEMO_SEED);
  for (const k of [
    "schema_version", "engine_version", "scenario_id", "scenario_revision",
    "plan_id", "seed", "status", "violations", "metrics", "group_metrics", "timeline", "departures_log",
  ]) {
    assert.ok(k in r, `缺少顶层字段 ${k}`);
  }
  const f = r.timeline[0];
  for (const k of ["t_s", "released_count", "boarded_count", "queued_count", "walking_count", "node_queues", "edge_counts", "group_counts"]) {
    assert.ok(k in f, `帧缺少字段 ${k}`);
  }
  assert.deepEqual(Object.keys(f.node_queues).sort(), ["E1", "E2", "E3", "P1", "P2", "S"]);
  assert.deepEqual(Object.keys(f.edge_counts).sort(), ["a1", "a2", "b1", "b2", "c1", "c2"]);
  assert.equal(r.seed, DEMO_SEED);
  assert.equal(r.scenario_revision, 1);
});

/* ---------- 12. 规模护栏与结构补强 ---------- */

test("护栏：时间步总数超限返回 invalid（防内存爆炸）", () => {
  const sc = miniScenario({ horizon_s: 500_005 }); // 500005/5 = 100001 帧 > 100000
  const issues = validateScenario(sc).filter((i) => i.severity === "error");
  assert.ok(issues.some((i) => i.code === "SCN_GRID_TOO_FINE"));
  const r = simulate(sc, miniPlan(), 7);
  assert.equal(r.status, "invalid");
  assert.equal(r.metrics, null);
});

test("护栏：总需求超上限、多 source、边自环、路线成环提示", () => {
  const big = miniScenario({
    groups: [
      { group_id: "g", count: 100_001, release_start_s: 0, release_end_s: 0, needs_step_free: false, walk_time_factor: 1, board_deadline_s: null },
    ],
  });
  assert.ok(validateScenario(big).some((i) => i.code === "SCN_DEMAND_TOO_LARGE" && i.severity === "error"));

  const twoSrc = miniScenario({
    nodes: [
      { node_id: "S", kind: "source", x: 50, y: 10 },
      { node_id: "S2", kind: "source", x: 30, y: 10 },
      { node_id: "P", kind: "stop", x: 50, y: 90, boarding_gap_s: 10 },
    ],
  });
  assert.ok(validateScenario(twoSrc).some((i) => i.code === "SCN_MULTI_SOURCE" && i.severity === "error"));

  const selfLoop = miniScenario({
    edges: [{ edge_id: "sp", from: "S", to: "S", travel_s: 5, capacity_per_min: 60, step_free: true, closed: false }],
  });
  assert.ok(validateScenario(selfLoop).some((i) => i.code === "SCN_EDGE_SELF_LOOP" && i.severity === "error"));

  const loopRoute = miniScenario({
    edges: [
      { edge_id: "e1", from: "S", to: "P", travel_s: 5, capacity_per_min: 60, step_free: true, closed: false },
      { edge_id: "e2", from: "P", to: "S", travel_s: 5, capacity_per_min: 60, step_free: true, closed: false },
    ],
    routes: [{ route_id: "R", edge_ids: ["e1", "e2", "e1"], stop_id: "P" }],
  });
  const loopIssues = validateScenario(loopRoute);
  assert.ok(loopIssues.some((i) => i.code === "SCN_ROUTE_LOOP" && i.severity === "warning"));
  assert.equal(loopIssues.filter((i) => i.severity === "error").length, 0);
});

test("嵌套未知字段（如拼错的 travel_sX）产生 warning 而非静默忽略", () => {
  const bad = structuredClone(concertDemoRev1) as unknown as { edges: Record<string, unknown>[] };
  bad.edges[0].travel_sX = 5; // 手滑多写的字段
  const issues = validateScenario(bad as unknown as Scenario);
  const w = issues.find((i) => i.path === "edges[0].travel_sX");
  assert.ok(w && w.code === "SCHEMA_UNKNOWN_FIELD" && w.severity === "warning");
  assert.equal(issues.filter((i) => i.severity === "error").length, 0); // 不阻断
});

test("fleet 为空是合法的资源不足场景：warning 提示且照常 valid 运行", () => {
  const sc = miniScenario({ fleet: [] });
  const plan = miniPlan({ departures: [] });
  const r = simulate(sc, plan, 7);
  assert.equal(r.status, "valid");
  assert.ok(r.violations.some((v) => v.code === "SCN_NO_FLEET" && v.severity === "warning"));
  assert.equal(r.metrics!.boarded_count, 0);
  assert.equal(r.metrics!.remaining_count, 2);
  assert.equal(r.metrics!.clearance_time_s, null);
});

test("班次站点无需求时提示 PLAN_STOP_NO_DEMAND（rev2 基线 P1 将持续空车）", () => {
  const v2 = validatePlan(concertDemoRev2, baselineRev2);
  assert.ok(v2.some((i) => i.code === "PLAN_STOP_NO_DEMAND" && i.message.includes("P1")));
  const v1 = validatePlan(concertDemoRev1, baselineRev1);
  assert.ok(!v1.some((i) => i.code === "PLAN_STOP_NO_DEMAND")); // rev1 基线两站均有需求
});

test("share 浮点容差：0.1+0.2+0.7 判定为合法", () => {
  const plan: Plan = {
    ...candidateSplitRev1,
    plan_id: "float_share",
    allocations: [
      { group_id: "regular", routes: [{ route_id: "R1", share: 0.1 }, { route_id: "R2", share: 0.2 }, { route_id: "R3", share: 0.7 }] },
      { group_id: "step_free", routes: [{ route_id: "R2", share: 1 }] },
      { group_id: "deadline", routes: [{ route_id: "R1", share: 1 }] },
    ],
  };
  const errors = validatePlan(concertDemoRev1, plan).filter((i) => i.severity === "error");
  assert.deepEqual(errors, []);
});

test("validatePlan 对未通过校验的 scenario 直接拒绝（独立调用防御）", () => {
  const badScenario = miniScenario({ revision: 0 });
  const issues = validatePlan(badScenario, miniPlan());
  assert.deepEqual(issues.map((i) => i.code), ["PLAN_SCENARIO_INVALID"]);
});
