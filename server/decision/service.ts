import {
  CompareResponse,
  GenerateResponse,
  Objective,
  ParseResponse,
  Plan,
  Scenario,
  SimulationResult,
  TraceStep,
} from "../../shared/types";
import { resultCache } from "./cache";
import { selectRecommendation } from "./compare";
import {
  engine,
  hasErrors,
  InvalidScenarioError,
  traceStatusForResult,
} from "./engine_port";
import { parseScenarioInstruction, validateInstruction } from "./parse";
import { buildPlans, clonePlanWithOverrides } from "./plans";
import { TraceRecorder } from "./trace";

/** 请求层可修正的错误（缺字段、重复 plan_id 等），由 API 层映射为 HTTP 400。 */
export class InvalidRequestError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "InvalidRequestError";
  }
}

function scenarioRef(scenario: Scenario): string {
  return `scenario:${scenario.scenario_id}@r${scenario.revision}`;
}

function errorCodes(issues: Array<{ code: string; severity: string }>): string {
  const codes = issues.filter((item) => item.severity === "error").map((item) => item.code);
  return codes.length > 0 ? [...new Set(codes)].join(",") : "none";
}

function assertValidScenario(scenario: Scenario, trace: TraceRecorder): void {
  const started = Date.now();
  const issues = engine.validateScenario(scenario);
  const errors = issues.filter((item) => item.severity === "error");
  trace.add({
    actor: "engine",
    action: "validate_scenario",
    source: "validator",
    summary:
      errors.length === 0
        ? `场景通过结构校验（${issues.length} 条 warning）`
        : `场景校验失败：${errors.length} 个 error（${errorCodes(issues)}）`,
    input_ref: scenarioRef(scenario),
    output_ref: `issues:${issues.length}`,
    status: errors.length === 0 ? "ok" : "rejected",
    duration_ms: Date.now() - started,
  });
  if (errors.length > 0) throw new InvalidScenarioError(issues);
}

function assertSeed(seed: number): void {
  if (!Number.isInteger(seed) || seed < 0) {
    throw new InvalidRequestError("invalid_seed", "seed 必须为非负整数");
  }
}

function dedupePlanIds(plans: Plan[]): void {
  const seen = new Set<string>();
  for (const plan of plans) {
    const planId = plan && typeof plan.plan_id === "string" ? plan.plan_id : "";
    if (planId === "") {
      throw new InvalidRequestError("missing_plan_id", "每个 plan 必须包含非空 plan_id");
    }
    if (seen.has(planId)) {
      throw new InvalidRequestError("duplicate_plan_id", `plan_id 重复：${planId}`);
    }
    seen.add(planId);
  }
}

/**
 * 生成三类候选方案。出口角色与公交角色分别产出动作，协调器检查共享资源冲突。
 * 三类策略不要求三次模型调用；本路径为确定性规则生成，因此 mode=rules。
 */
export function generatePlanCandidates(
  scenario: Scenario,
  objective: Objective,
  seed: number,
): GenerateResponse {
  assertSeed(seed);
  const trace = new TraceRecorder();
  assertValidScenario(scenario, trace);

  const built = buildPlans(
    scenario,
    objective,
    engine.source,
    engine.buildBaselinePlan(scenario),
  );

  trace.add({
    actor: "exit_role",
    action: "allocate_groups",
    source: "rules",
    summary: `出口角色按合法路线与 objective=${objective} 为 ${scenario.groups.length} 个旅客组生成路线份额`,
    input_ref: scenarioRef(scenario),
    output_ref: `allocations:${built.plans[0].allocations.length}`,
    status: "ok",
  });
  trace.add({
    actor: "bus_role",
    action: "schedule_departures",
    source: "rules",
    summary: `公交角色使用既有 ${scenario.fleet.length} 辆车排班，未新增容量`,
    input_ref: scenarioRef(scenario),
    output_ref: `departures:${built.plans[0].departures.length}`,
    status: "ok",
  });
  trace.add({
    actor: "coordinator",
    action: "merge_and_check_shared_resources",
    source: "rules",
    summary:
      built.independent_conflicts.length === 0
        ? "两角色合并后未发现共享站点冲突"
        : `两角色合并后发现 ${built.independent_conflicts.length} 处共享站点冲突：${built.independent_conflicts.join("；")}`,
    input_ref: "roles:exit+bus",
    output_ref: "plans:3",
    status: "ok",
  });

  const plans = built.plans.slice();
  const baseline = built.plans.find((plan) => plan.strategy === "baseline");
  const coordinatedIndex = plans.findIndex((plan) => plan.strategy === "coordinated");

  for (const plan of plans) {
    const started = Date.now();
    const issues = engine.validatePlan(scenario, plan);
    trace.add({
      actor: "engine",
      action: "validate_plan",
      source: "validator",
      summary: `${plan.plan_id} 校验：${issues.filter((item) => item.severity === "error").length} error / ${issues.filter((item) => item.severity === "warning").length} warning`,
      input_ref: `plan:${plan.plan_id}`,
      output_ref: `issues:${issues.length}`,
      status: hasErrors(issues) ? "rejected" : "ok",
      duration_ms: Date.now() - started,
    });
  }

  // 协调方案若仍违反硬约束，回退到基线的安全排班；若基线也不合法，保留原方案让用户看到真实错误。
  if (coordinatedIndex >= 0 && baseline) {
    const coordinated = plans[coordinatedIndex];
    const errors = engine.validatePlan(scenario, coordinated).filter(
      (item) => item.severity === "error",
    );
    if (errors.length > 0) {
      const fallback = clonePlanWithOverrides(coordinated, {
        allocations: baseline.allocations,
        departures: baseline.departures,
        notes: [
          ...(coordinated.notes ?? []),
          `协调方案未通过校验（${errorCodes(errors)}），已回退为基线安全排班；本场景未观察到协同改进。`,
        ],
      });
      const fallbackErrors = engine.validatePlan(scenario, fallback).filter(
        (item) => item.severity === "error",
      );
      if (fallbackErrors.length === 0) {
        plans[coordinatedIndex] = fallback;
        trace.add({
          actor: "coordinator",
          action: "fallback_to_safe_schedule",
          source: "rules",
          summary: `协调方案校验失败（${errorCodes(errors)}），回退为基线安全排班`,
          input_ref: `plan:${coordinated.plan_id}`,
          output_ref: "plan:coordinated_fallback",
          status: "ok",
        });
      } else {
        trace.add({
          actor: "coordinator",
          action: "fallback_to_safe_schedule",
          source: "rules",
          summary: `协调方案与回退方案均未通过校验（${errorCodes(fallbackErrors)}），保留原始候选供展示`,
          input_ref: `plan:${coordinated.plan_id}`,
          output_ref: "plan:unchanged",
          status: "rejected",
        });
      }
    }
  }

  trace.add({
    actor: "decision",
    action: "carry_seed_for_comparison",
    source: "rules",
    summary: `seed=${seed} 将用于后续同条件比较；生成阶段不产生仿真指标`,
    input_ref: scenarioRef(scenario),
    output_ref: `seed:${seed}`,
    status: "ok",
  });

  return { plans, trace: trace.list(), mode: "rules" };
}

function simulateWithCache(
  scenario: Scenario,
  plan: Plan,
  seed: number,
  trace: TraceRecorder,
): SimulationResult {
  const key = resultCache.key(scenario, plan, seed, engine.version);
  const cached = resultCache.get(key);
  if (cached) {
    trace.add({
      actor: "engine",
      action: "simulate_cached",
      source: "cache",
      summary: `命中缓存：${cached.plan_id} status=${cached.status}`,
      input_ref: `plan:${plan.plan_id},seed:${seed}`,
      output_ref: `cache:${key.slice(0, 12)}`,
      status: tracedStatus(cached),
    });
    return cached;
  }

  const started = Date.now();
  const result = engine.simulate(scenario, plan, seed);
  trace.add({
    actor: "engine",
    action: "simulate",
    source: "simulator",
    summary: `引擎 ${engine.version} 完成 ${plan.plan_id}：status=${result.status}${
      result.metrics
        ? `，released=${result.metrics.released_count}，boarded=${result.metrics.boarded_count}，remaining=${result.metrics.remaining_count}`
        : ""
    }`,
    input_ref: `plan:${plan.plan_id},seed:${seed}`,
    output_ref: `result:${result.plan_id}`,
    status: tracedStatus(result),
    duration_ms: Date.now() - started,
  });
  if (result.status !== "error") resultCache.set(key, result);
  return result;
}

function tracedStatus(result: SimulationResult): TraceStep["status"] {
  return traceStatusForResult(result.status);
}

/** 单方案推演：格式错误由 API 层拦截；领域约束不满足返回 status=invalid。 */
export function simulatePlan(scenario: Scenario, plan: Plan, seed: number): SimulationResult {
  assertSeed(seed);
  const trace = new TraceRecorder();
  assertValidScenario(scenario, trace);
  return simulateWithCache(scenario, plan, seed, trace);
}

export function comparePlanCandidates(
  scenario: Scenario,
  plans: Plan[],
  seed: number,
  objective: Objective,
): CompareResponse {
  assertSeed(seed);
  if (!Array.isArray(plans) || plans.length === 0) {
    throw new InvalidRequestError("empty_plans", "plans 必须为非空数组");
  }
  dedupePlanIds(plans);

  const trace = new TraceRecorder();
  assertValidScenario(scenario, trace);

  const results: SimulationResult[] = [];
  for (const plan of plans) {
    const started = Date.now();
    const issues = engine.validatePlan(scenario, plan);
    trace.add({
      actor: "engine",
      action: "validate_plan",
      source: "validator",
      summary: `${plan.plan_id} 校验：${issues.filter((item) => item.severity === "error").length} error / ${issues.filter((item) => item.severity === "warning").length} warning`,
      input_ref: `plan:${plan.plan_id}`,
      output_ref: `issues:${issues.length}`,
      status: hasErrors(issues) ? "rejected" : "ok",
      duration_ms: Date.now() - started,
    });
    results.push(simulateWithCache(scenario, plan, seed, trace));
  }

  const recommendation = selectRecommendation(scenario, results, objective);
  const validCount = results.filter((result) => result.status === "valid").length;
  trace.add({
    actor: "decision",
    action: "recommend",
    source: "rules",
    summary: `objective=${objective}，${validCount}/${results.length} 个方案 valid；推荐结果 ${recommendation.status}${recommendation.plan_id ? `：${recommendation.plan_id}` : ""}`,
    input_ref: `results:${results.length}`,
    output_ref: `recommendation:${recommendation.status}`,
    status: recommendation.status === "no_valid_candidate" ? "rejected" : "ok",
  });

  return { results, recommendation, trace: trace.list(), mode: "rules" };
}

/**
 * 自然语言解析：只产出待确认 patch，不修改场景、不递增 revision。
 * 无模型密钥或模型失败时 mode=rules，trace 不伪造 llm 调用。
 */
export async function parseInstruction(
  scenario: Scenario,
  instruction: string,
): Promise<ParseResponse> {
  const issues = validateInstruction(scenario, instruction);
  const instructionErrors = issues.filter(
    (item) => item.severity === "error" && item.path === "instruction",
  );
  if (instructionErrors.length > 0) {
    throw new InvalidRequestError(
      "invalid_instruction",
      instructionErrors.map((item) => item.message).join("；"),
      instructionErrors,
    );
  }

  const trace: TraceRecorder = new TraceRecorder();
  assertValidScenario(scenario, trace);
  const outcome = await parseScenarioInstruction(scenario, instruction);

  // 05 的 parse 响应只有 patch/summary/warnings/mode；trace 记录在服务端日志，供联调核对。
  console.log(
    `[parse] ${scenarioRef(scenario)} mode=${outcome.mode} patch=${outcome.patch.length} ` +
      `steps=${outcome.trace.map((step) => `${step.source}:${step.status}`).join(",")}`,
  );

  return {
    patch: outcome.patch,
    summary: outcome.summary,
    warnings: outcome.warnings,
    mode: outcome.mode,
  };
}
