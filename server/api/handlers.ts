import { IncomingMessage } from "node:http";
import {
  CompareResponse,
  DEFAULT_DEMO_SEED,
  GenerateResponse,
  HealthResponse,
  Objective,
  ParseResponse,
  Plan,
  SCHEMA_VERSION,
  Scenario,
  SimulationResult,
} from "../../shared/types";
import { engine, InvalidScenarioError } from "../decision/engine_port";
import { llmConfigured } from "../decision/llm";
import {
  comparePlanCandidates,
  generatePlanCandidates,
  InvalidRequestError,
  parseInstruction,
  simulatePlan,
} from "../decision/service";

const MAX_BODY_BYTES = 2 * 1024 * 1024;

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const OBJECTIVES: Objective[] = ["efficiency", "inclusion", "balanced"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new ApiError(413, "body_too_large", "请求体超过 2MB 限制"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (text === "") {
        reject(new ApiError(400, "empty_body", "请求体不能为空"));
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new ApiError(400, "invalid_json", "请求体不是合法 JSON"));
      }
    });
    req.on("error", (error) => {
      reject(new ApiError(400, "body_read_error", `读取请求体失败：${error.message}`));
    });
  });
}

function requireObject(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) {
    throw new ApiError(400, "invalid_request", "请求体必须是 JSON 对象");
  }
  return body;
}

function requireScenario(value: unknown): Scenario {
  if (!isRecord(value)) {
    throw new ApiError(400, "missing_scenario", "scenario 必须是对象");
  }
  return value as unknown as Scenario;
}

function invalidPlan(path: string, message: string, code = "invalid_plan_structure"): never {
  throw new ApiError(400, code, `${path}：${message}`, { path });
}

/** 只校验 JSON 结构；路线、revision、班次等领域约束仍由 A 判定为 status=invalid。 */
function requirePlan(value: unknown, path: string): Plan {
  if (!isRecord(value)) invalidPlan(path, "必须是对象", "invalid_plan");
  if (value.schema_version !== SCHEMA_VERSION) {
    invalidPlan(`${path}.schema_version`, `必须为 "${SCHEMA_VERSION}"`);
  }
  if (typeof value.plan_id !== "string" || value.plan_id.trim() === "") {
    invalidPlan(`${path}.plan_id`, "必须为非空字符串", "missing_plan_id");
  }
  if (typeof value.scenario_id !== "string" || value.scenario_id.trim() === "") {
    invalidPlan(`${path}.scenario_id`, "必须为非空字符串");
  }
  if (!Number.isInteger(value.scenario_revision) || (value.scenario_revision as number) <= 0) {
    invalidPlan(`${path}.scenario_revision`, "必须为正整数");
  }
  if (!["baseline", "independent", "coordinated"].includes(value.strategy as string)) {
    invalidPlan(`${path}.strategy`, "必须为 baseline | independent | coordinated");
  }
  if (typeof value.name !== "string") invalidPlan(`${path}.name`, "必须为字符串");
  if (!Array.isArray(value.allocations)) invalidPlan(`${path}.allocations`, "必须为数组");
  if (!Array.isArray(value.departures)) invalidPlan(`${path}.departures`, "必须为数组");
  if (
    value.notes !== undefined &&
    (!Array.isArray(value.notes) || value.notes.some((item) => typeof item !== "string"))
  ) {
    invalidPlan(`${path}.notes`, "可选，但必须为字符串数组");
  }

  value.allocations.forEach((allocation, index) => {
    const current = `${path}.allocations[${index}]`;
    if (!isRecord(allocation)) invalidPlan(current, "必须为对象");
    if (typeof allocation.group_id !== "string" || allocation.group_id.trim() === "") {
      invalidPlan(`${current}.group_id`, "必须为非空字符串");
    }
    if (!Array.isArray(allocation.routes)) invalidPlan(`${current}.routes`, "必须为数组");
    allocation.routes.forEach((route, routeIndex) => {
      const routePath = `${current}.routes[${routeIndex}]`;
      if (!isRecord(route)) invalidPlan(routePath, "必须为对象");
      if (typeof route.route_id !== "string" || route.route_id.trim() === "") {
        invalidPlan(`${routePath}.route_id`, "必须为非空字符串");
      }
      if (typeof route.share !== "number" || !Number.isFinite(route.share)) {
        invalidPlan(`${routePath}.share`, "必须为有限数字");
      }
    });
  });

  value.departures.forEach((departure, index) => {
    const current = `${path}.departures[${index}]`;
    if (!isRecord(departure)) invalidPlan(current, "必须为对象");
    if (typeof departure.vehicle_id !== "string" || departure.vehicle_id.trim() === "") {
      invalidPlan(`${current}.vehicle_id`, "必须为非空字符串");
    }
    if (typeof departure.stop_id !== "string" || departure.stop_id.trim() === "") {
      invalidPlan(`${current}.stop_id`, "必须为非空字符串");
    }
    if (!Number.isInteger(departure.depart_s) || (departure.depart_s as number) < 0) {
      invalidPlan(`${current}.depart_s`, "必须为非负整数");
    }
  });

  return value as unknown as Plan;
}

function requireObjective(value: unknown): Objective {
  if (typeof value !== "string" || !OBJECTIVES.includes(value as Objective)) {
    throw new ApiError(
      400,
      "invalid_objective",
      `objective 必须是 ${OBJECTIVES.join(" | ")} 之一`,
    );
  }
  return value as Objective;
}

function readSeed(value: unknown): number {
  if (value === undefined) return DEFAULT_DEMO_SEED;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ApiError(400, "invalid_seed", "seed 必须为非负整数");
  }
  return value;
}

export function health(): HealthResponse {
  return {
    status: "ok",
    schema_version: SCHEMA_VERSION,
    engine_ready: typeof engine.validateScenario === "function" && typeof engine.simulate === "function",
    llm_configured: llmConfigured(),
  };
}

function wrapScenarioError(error: InvalidScenarioError): ApiError {
  return new ApiError(400, "invalid_scenario", "场景未通过结构校验", error.issues);
}

export async function parseScene(body: unknown): Promise<ParseResponse> {
  const record = requireObject(body);
  const scenario = requireScenario(record.scenario);
  if (typeof record.instruction !== "string") {
    throw new ApiError(400, "missing_instruction", "instruction 必须为字符串");
  }
  try {
    return await parseInstruction(scenario, record.instruction);
  } catch (error) {
    if (error instanceof InvalidScenarioError) throw wrapScenarioError(error);
    throw error;
  }
}

export function generate(body: unknown): GenerateResponse {
  const record = requireObject(body);
  const scenario = requireScenario(record.scenario);
  const objective = requireObjective(record.objective);
  const seed = readSeed(record.seed);
  try {
    return generatePlanCandidates(scenario, objective, seed);
  } catch (error) {
    if (error instanceof InvalidScenarioError) throw wrapScenarioError(error);
    throw error;
  }
}

export function simulate(body: unknown): SimulationResult {
  const record = requireObject(body);
  const scenario = requireScenario(record.scenario);
  const plan = requirePlan(record.plan, "plan");
  const seed = readSeed(record.seed);
  try {
    return simulatePlan(scenario, plan, seed);
  } catch (error) {
    if (error instanceof InvalidScenarioError) throw wrapScenarioError(error);
    throw error;
  }
}

export function compare(body: unknown): CompareResponse {
  const record = requireObject(body);
  const scenario = requireScenario(record.scenario);
  const objective = requireObjective(record.objective);
  const seed = readSeed(record.seed);
  if (!Array.isArray(record.plans)) {
    throw new ApiError(400, "invalid_plans", "plans 必须为数组");
  }
  const plans = record.plans.map((item, index) => requirePlan(item, `plans[${index}]`));
  try {
    return comparePlanCandidates(scenario, plans, seed, objective);
  } catch (error) {
    if (error instanceof InvalidScenarioError) throw wrapScenarioError(error);
    throw error;
  }
}

/** 统一把内部错误映射为 HTTP 状态与错误信封，不向外泄露堆栈。 */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof InvalidScenarioError) return wrapScenarioError(error);
  if (error instanceof InvalidRequestError) {
    return new ApiError(400, error.code, error.message, error.details);
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error("[api] 内部错误:", error);
  return new ApiError(500, "internal_error", `内部执行失败：${message.slice(0, 300)}`);
}
