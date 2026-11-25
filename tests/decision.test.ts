import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { Plan } from "../shared/types";
import { resultCache } from "../server/decision/cache";
import { engine } from "../server/decision/engine_port";
import { parseRules, parseScenarioInstruction } from "../server/decision/parse";
import {
  comparePlanCandidates,
  generatePlanCandidates,
  simulatePlan,
} from "../server/decision/service";
import { clearLlmEnv, clone, loadScenario } from "./helpers";

const SEED = 20261114;

test.beforeEach(() => {
  clearLlmEnv();
  resultCache.clear();
});

test("规则解析“关闭西侧通道，减少一辆车”只产出补丁，不修改输入场景", () => {
  const scenario = loadScenario("concert_demo.scenario.json");
  const before = JSON.stringify(scenario);
  const outcome = parseRules(scenario, "关闭西侧通道，减少一辆车");

  assert.equal(JSON.stringify(scenario), before, "解析不得修改输入场景");
  assert.ok(
    outcome.patch.some(
      (item) => item.target === "edge" && item.id === "a1" && item.field === "closed" && item.value === true,
    ),
    "应关闭西侧出口边 a1",
  );
  assert.ok(
    outcome.patch.some((item) => item.target === "vehicle" && item.field === "enabled" && item.value === false),
    "应生成移除一辆车的补丁",
  );
  assert.ok(outcome.warnings.some((item) => item.includes("用户确认")));
});

test("规则解析按场景识别 2 号出口并同时减车，未知出口子指令明确警告", () => {
  const scenario = loadScenario("concert_demo.scenario.json");
  const before = JSON.stringify(scenario);
  const outcome = parseRules(scenario, "关闭2号出口，减少一辆车");

  assert.ok(outcome.patch.some(
    (item) => item.target === "edge" && item.id === "b1" && item.field === "closed" && item.value === true,
  ));
  assert.ok(outcome.patch.some((item) => item.target === "vehicle" && item.value === false));
  assert.equal(JSON.stringify(scenario), before, "仍只能产出待确认 patch，不得修改场景");

  const unknown = parseRules(scenario, "关闭9号出口，减少一辆车");
  assert.equal(unknown.patch.some((item) => item.target === "edge" && item.field === "closed"), false);
  assert.ok(unknown.patch.some((item) => item.target === "vehicle"));
  assert.ok(unknown.warnings.some((item) => item.includes("9 号出口") && item.includes("未生成补丁")));
});

test("集成运行只加载 A 引擎，且 baseline 与 A 的唯一实现一致", () => {
  const scenario = loadScenario("concert_demo.scenario.json");
  const aBaseline = engine.buildBaselinePlan(scenario);
  const generated = generatePlanCandidates(scenario, "balanced", SEED);
  const baseline = generated.plans.find((plan) => plan.strategy === "baseline")!;

  assert.equal(engine.source, "external");
  assert.equal(engine.version, "1.0.0");
  assert.deepEqual(baseline.allocations, aBaseline.allocations);
  assert.deepEqual(baseline.departures, aBaseline.departures);
});

test("无模型密钥时 mode=rules 且 trace 不包含伪造的 llm 调用", async () => {
  const scenario = loadScenario("concert_demo.scenario.json");
  const outcome = await parseScenarioInstruction(scenario, "关闭西侧通道，减少一辆车");

  assert.equal(outcome.mode, "rules");
  assert.ok(outcome.patch.length > 0);
  assert.ok(outcome.trace.length > 0);
  assert.equal(outcome.trace.some((step) => step.source === "llm"), false);
  assert.ok(outcome.trace.every((step) => step.step >= 1));
});

test("模型超时先由服务端降级 rules，不泄露凭据，给前端预留等待窗口", async () => {
  const scenario = loadScenario("concert_demo.scenario.json");
  const stalled = http.createServer(() => {
    // 故意不响应，验证 LLM_TIMEOUT_MS 触发后的服务端降级。
  });
  await new Promise<void>((resolve) => stalled.listen(0, "127.0.0.1", resolve));
  const address = stalled.address();
  if (!address || typeof address === "string") throw new Error("无法取得测试端口");

  const secret = "sk-local-timeout-secret";
  process.env.LLM_API_KEY = secret;
  process.env.LLM_MODEL = "deepseek-chat";
  process.env.LLM_BASE_URL = `http://127.0.0.1:${address.port}`;
  process.env.LLM_TIMEOUT_MS = "100";

  try {
    const started = Date.now();
    const outcome = await parseScenarioInstruction(scenario, "关闭2号出口，减少一辆车");
    const elapsed = Date.now() - started;
    assert.equal(outcome.mode, "rules");
    assert.ok(outcome.trace.some((step) => step.source === "llm" && step.status === "error"));
    assert.ok(outcome.trace.some((step) => step.source === "rules" && step.status === "ok"));
    assert.ok(elapsed >= 90 && elapsed < 5000, `服务端应及时降级，实际 ${elapsed}ms`);
    assert.equal(outcome.warnings.join("\n").includes(secret), false);
  } finally {
    clearLlmEnv();
    stalled.closeAllConnections();
    await new Promise<void>((resolve) => stalled.close(() => resolve()));
  }
});

test("生成三类策略：baseline/coordinated 合法，independent 的共享站点冲突被判 invalid", () => {
  const scenario = loadScenario("concert_demo.scenario.json");
  const generated = generatePlanCandidates(scenario, "balanced", SEED);
  const [baseline, independent, coordinated] = generated.plans;

  assert.equal(generated.plans.length, 3);
  assert.equal(generated.mode, "rules");
  assert.deepEqual(
    generated.plans.map((plan) => plan.strategy),
    ["baseline", "independent", "coordinated"],
  );

  const errorsOf = (plan: Plan) =>
    engine.validatePlan(scenario, plan).filter((item) => item.severity === "error");
  assert.deepEqual(errorsOf(baseline), []);
  assert.deepEqual(errorsOf(coordinated), []);
  assert.ok(errorsOf(independent).some((item) => item.code === "PLAN_STOP_GAP"));

  const independentResult = simulatePlan(scenario, independent, SEED);
  assert.equal(independentResult.status, "invalid");
  assert.equal(independentResult.metrics, null);
});

test("compare 返回真实结果，invalid 候选不参与推荐", () => {
  const scenario = loadScenario("concert_demo.scenario.json");
  const generated = generatePlanCandidates(scenario, "balanced", SEED);
  const compared = comparePlanCandidates(scenario, generated.plans, SEED, "balanced");

  assert.equal(compared.results.length, 3);
  assert.equal(compared.mode, "rules");

  const valid = compared.results.filter((item) => item.status === "valid");
  const invalid = compared.results.filter((item) => item.status === "invalid");
  assert.equal(valid.length, 2);
  assert.equal(invalid.length, 1);
  assert.equal(invalid[0].plan_id, generated.plans[1].plan_id);

  assert.notEqual(compared.recommendation.status, "no_valid_candidate");
  assert.notEqual(compared.recommendation.plan_id, generated.plans[1].plan_id);
  assert.ok(
    valid.some((item) => item.plan_id === compared.recommendation.plan_id),
    "推荐必须来自 valid 结果",
  );

  for (const result of valid) {
    assert.ok(result.metrics);
    assert.ok(result.timeline.length > 0);
    assert.ok(result.group_metrics.length === scenario.groups.length);
    assert.equal(
      result.metrics!.released_count,
      result.metrics!.boarded_count + result.metrics!.remaining_count,
    );
  }

  assert.ok(compared.trace.some((step) => step.source === "validator"));
  assert.ok(compared.trace.some((step) => step.source === "simulator"));
  assert.ok(compared.recommendation.reason.length > 0);

  const cached = comparePlanCandidates(scenario, generated.plans, SEED, "balanced");
  assert.deepEqual(cached.results, compared.results);
  assert.ok(cached.trace.some((step) => step.source === "cache"));
});

test("全部候选无效时返回 no_valid_candidate，并明确不等于场景无解", () => {
  const scenario = loadScenario("concert_demo.scenario.json");
  const generated = generatePlanCandidates(scenario, "efficiency", SEED);
  const stale = generated.plans.slice(0, 2).map((plan, index) => {
    const next: Plan = clone(plan);
    next.plan_id = `stale_${index}`;
    next.scenario_revision = scenario.revision + 1;
    return next;
  });

  const compared = comparePlanCandidates(scenario, stale, SEED, "efficiency");
  assert.equal(compared.results.every((item) => item.status === "invalid"), true);
  assert.equal(compared.recommendation.status, "no_valid_candidate");
  assert.equal(compared.recommendation.plan_id, null);
  assert.ok(compared.recommendation.reason.includes("不等于该场景"));
  assert.ok(compared.recommendation.tradeoffs.length > 0);
});

test("关键指标完全并列时状态为 tradeoff，不靠 plan_id 宣称胜出", () => {
  const scenario = loadScenario("concert_demo.scenario.json");
  const generated = generatePlanCandidates(scenario, "efficiency", SEED);
  const baseline = generated.plans[0];
  const twinA: Plan = clone(baseline);
  const twinB: Plan = clone(baseline);
  twinA.plan_id = "twin_a";
  twinB.plan_id = "twin_b";

  const compared = comparePlanCandidates(scenario, [twinA, twinB], SEED, "efficiency");
  assert.deepEqual(compared.results.map((item) => item.status), ["valid", "valid"]);
  assert.equal(compared.recommendation.status, "tradeoff");
  assert.ok(compared.recommendation.reason.includes("并列"));
});

test("failure 场景保留需避开台阶的旅客组，不强行分配到楼梯路线", () => {
  const scenario = loadScenario("concert_demo_stepfree_blocked.scenario.json");
  const generated = generatePlanCandidates(scenario, "balanced", SEED);
  const baseline = generated.plans[0];
  const stepFree = baseline.allocations.find((item) => item.group_id === "step_free");
  assert.ok(stepFree);
  assert.deepEqual(stepFree!.routes, []);

  const result = simulatePlan(scenario, baseline, SEED);
  assert.equal(result.status, "valid");
  const group = result.group_metrics.find((item) => item.group_id === "step_free")!;
  assert.equal(group.released_count, 40);
  assert.equal(group.boarded_count, 0);
  assert.equal(result.metrics!.remaining_count >= 40, true);
});

test("封路减车场景的候选不经过关闭路线，也不引用已删除车辆", () => {
  const scenario = loadScenario("concert_demo_closed_reduced.scenario.json");
  const generated = generatePlanCandidates(scenario, "inclusion", SEED);

  for (const plan of generated.plans.filter((item) => item.strategy !== "independent")) {
    for (const allocation of plan.allocations) {
      assert.equal(allocation.routes.some((item) => item.route_id === "R1"), false);
    }
    for (const departure of plan.departures) {
      assert.equal(departure.vehicle_id === "B3", false);
    }
    assert.equal(simulatePlan(scenario, plan, SEED).status, "valid");
  }
});
