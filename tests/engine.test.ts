import assert from "node:assert/strict";
import test from "node:test";
import { Plan } from "../shared/types";
import { engine } from "../server/decision/engine_port";
import { buildPlans } from "../server/decision/plans";
import { clone, loadScenario } from "./helpers";

const SEED = 20261114;

function assertConservation(timeline: { released_count: number; boarded_count: number; walking_count: number; queued_count: number; t_s: number }[]): void {
  for (const frame of timeline) {
    assert.equal(
      frame.released_count,
      frame.boarded_count + frame.walking_count + frame.queued_count,
      `t=${frame.t_s} 人数不守恒`,
    );
  }
}

test("场景样例通过 validateScenario", () => {
  const scenario = loadScenario("concert_demo.scenario.json");
  const errors = engine.validateScenario(scenario).filter((item) => item.severity === "error");
  assert.deepEqual(errors, []);
});

test("逐帧人数守恒，终帧与汇总一致", () => {
  const scenario = loadScenario("concert_demo.scenario.json");
  const { plans } = buildPlans(scenario, "balanced", engine.source);
  const baseline = plans.find((plan) => plan.strategy === "baseline")!;
  const result = engine.simulate(scenario, baseline, SEED);

  assert.equal(result.status, "valid");
  assert.ok(result.metrics);
  assertConservation(result.timeline);

  const last = result.timeline[result.timeline.length - 1];
  assert.equal(last.t_s, scenario.horizon_s);
  assert.equal(last.released_count, result.metrics!.released_count);
  assert.equal(last.boarded_count, result.metrics!.boarded_count);
  assert.equal(
    result.metrics!.remaining_count,
    result.metrics!.released_count - result.metrics!.boarded_count,
  );
  assert.equal(result.metrics!.released_count, 300);
});

test("同一输入与 seed 重复运行结果一致", () => {
  const scenario = loadScenario("concert_demo.scenario.json");
  const { plans } = buildPlans(scenario, "balanced", engine.source);
  const baseline = plans.find((plan) => plan.strategy === "baseline")!;
  const first = engine.simulate(scenario, baseline, SEED);
  const second = engine.simulate(scenario, baseline, SEED);
  assert.deepEqual(first.metrics, second.metrics);
  assert.deepEqual(first.timeline, second.timeline);
  assert.deepEqual(first.departures_log, second.departures_log);
});

test("零需求时人平均等待与 P95 为 null，清空时间为 0", () => {
  const scenario = clone(loadScenario("concert_demo.scenario.json"));
  for (const group of scenario.groups) group.count = 0;
  const plan: Plan = {
    schema_version: "1.0",
    plan_id: "plan_zero",
    scenario_id: scenario.scenario_id,
    scenario_revision: scenario.revision,
    strategy: "baseline",
    name: "零需求",
    allocations: scenario.groups.map((group) => ({ group_id: group.group_id, routes: [] })),
    departures: [],
    notes: [],
  };
  const result = engine.simulate(scenario, plan, SEED);
  assert.equal(result.status, "valid");
  assert.equal(result.metrics!.released_count, 0);
  assert.equal(result.metrics!.remaining_count, 0);
  assert.equal(result.metrics!.mean_queue_wait_all_released_s, null);
  assert.equal(result.metrics!.p95_queue_wait_boarded_s, null);
  assert.equal(result.metrics!.clearance_time_s, 0);
});

test("关闭路线被分给旅客组时返回 invalid，且 metrics 为 null", () => {
  const scenario = clone(loadScenario("concert_demo.scenario.json"));
  scenario.edges.find((edge) => edge.edge_id === "a1")!.closed = true;
  const { plans } = buildPlans(scenario, "balanced", engine.source);
  const baseline = plans.find((plan) => plan.strategy === "baseline")!;
  const forced: Plan = clone(baseline);
  forced.allocations = forced.allocations.map((allocation) =>
    allocation.group_id === "regular"
      ? { group_id: "regular", routes: [{ route_id: "R1", share: 1 }] }
      : allocation,
  );

  const result = engine.simulate(scenario, forced, SEED);
  assert.equal(result.status, "invalid");
  assert.equal(result.metrics, null);
  assert.equal(result.timeline.length, 0);
  assert.ok(result.violations.some((item) => item.code === "PLAN_ROUTE_CLOSED"));
});

test("旧 revision 的方案被拒绝执行", () => {
  const scenario = loadScenario("concert_demo.scenario.json");
  const { plans } = buildPlans(scenario, "balanced", engine.source);
  const stale: Plan = clone(plans[0]);
  stale.scenario_revision = scenario.revision + 1;
  const result = engine.simulate(scenario, stale, SEED);
  assert.equal(result.status, "invalid");
  assert.ok(result.violations.some((item) => item.code === "PLAN_STALE_REVISION"));
});

test("减少车辆后引用已删除车辆被拒绝", () => {
  const reduced = loadScenario("concert_demo_closed_reduced.scenario.json");
  const base = loadScenario("concert_demo.scenario.json");
  const { plans } = buildPlans(base, "balanced", engine.source);
  const plan: Plan = clone(plans[0]);
  plan.scenario_id = reduced.scenario_id;
  plan.scenario_revision = reduced.revision;

  const result = engine.simulate(reduced, plan, SEED);
  assert.equal(result.status, "invalid");
  assert.ok(result.violations.some((item) => item.code === "PLAN_VEHICLE_UNKNOWN"));
});

test("P95 只统计已登车者，未登车者仍计入 released 与等待", () => {
  const scenario = loadScenario("concert_demo.scenario.json");
  const { plans } = buildPlans(scenario, "balanced", engine.source);
  const result = engine.simulate(scenario, plans[0], SEED);
  const metrics = result.metrics!;
  if (metrics.boarded_count > 0) {
    assert.notEqual(metrics.p95_queue_wait_boarded_s, null);
  } else {
    assert.equal(metrics.p95_queue_wait_boarded_s, null);
  }
  if (metrics.remaining_count > 0) {
    assert.ok(metrics.mean_queue_wait_all_released_s !== null);
  }
});

test("场景结构错误会被 validateScenario 报出", () => {
  const scenario = clone(loadScenario("concert_demo.scenario.json"));
  scenario.schema_version = "2.0" as unknown as "1.0";
  scenario.groups[0].count = -1;
  const errors = engine.validateScenario(scenario).filter((item) => item.severity === "error");
  assert.ok(errors.some((item) => item.code === "SCHEMA_VERSION_UNSUPPORTED"));

  scenario.schema_version = "1.0";
  const countErrors = engine.validateScenario(scenario).filter((item) => item.severity === "error");
  assert.ok(countErrors.some((item) => item.code === "SCN_COUNT_INVALID"));
});
