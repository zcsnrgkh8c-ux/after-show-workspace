import {
  Plan,
  Scenario,
  SimulationResult,
  TraceStatus,
  TraceStep,
  ValidationIssue,
} from "../../shared/types";

export interface EnginePort {
  validateScenario(scenario: Scenario): ValidationIssue[];
  validatePlan(scenario: Scenario, plan: Plan): ValidationIssue[];
  simulate(scenario: Scenario, plan: Plan, seed: number): SimulationResult;
  /** 05 第 6 节约定：唯一固定规则基线由 A 提供。 */
  buildBaselinePlan(scenario: Scenario): Plan;
  source: "external";
  version: string;
}

type EngineModule = Partial<EnginePort> & {
  ENGINE_VERSION?: unknown;
};

function toEnginePort(moduleValue: unknown): EnginePort {
  if (!moduleValue || typeof moduleValue !== "object") {
    throw new Error("A 的 server/simulation 未导出可用模块对象");
  }
  const candidate = moduleValue as EngineModule;
  const required = ["validateScenario", "validatePlan", "simulate", "buildBaselinePlan"] as const;
  const missing = required.filter((name) => typeof candidate[name] !== "function");
  if (missing.length > 0) {
    throw new Error(`A 的 server/simulation 缺少函数：${missing.join(", ")}`);
  }
  if (typeof candidate.ENGINE_VERSION !== "string" || candidate.ENGINE_VERSION.trim() === "") {
    throw new Error("A 的 server/simulation 缺少有效的 ENGINE_VERSION");
  }
  return {
    validateScenario: candidate.validateScenario!.bind(candidate),
    validatePlan: candidate.validatePlan!.bind(candidate),
    simulate: candidate.simulate!.bind(candidate),
    buildBaselinePlan: candidate.buildBaselinePlan!.bind(candidate),
    source: "external",
    version: candidate.ENGINE_VERSION,
  };
}

/** 正式模式只加载 A；加载失败直接终止启动，禁止静默回退 bridge 指标。 */
function loadExternalEngine(): EnginePort {
  const modulePath = require("path").join(__dirname, "..", "simulation");
  try {
    return toEnginePort(require(modulePath));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`正式模式加载 A 仿真引擎失败（${modulePath}）：${message}`);
  }
}

export const engine: EnginePort = loadExternalEngine();

export class InvalidScenarioError extends Error {
  constructor(public readonly issues: ValidationIssue[]) {
    super("场景未通过 validateScenario");
    this.name = "InvalidScenarioError";
  }
}

export function hasErrors(issues: ValidationIssue[]): boolean {
  return issues.some((item) => item.severity === "error");
}

export function errorIssues(issues: ValidationIssue[]): ValidationIssue[] {
  return issues.filter((item) => item.severity === "error");
}

export function traceStatusForResult(status: SimulationResult["status"]): TraceStatus {
  if (status === "valid") return "ok";
  if (status === "invalid") return "rejected";
  return "error";
}

export type { TraceStep };
