/**
 * A 模块统一入口。B 同学只从这里导入，不触碰内部文件。
 *
 * 最小调用示例：
 *   import { simulate, validateScenario, validatePlan, buildBaselinePlan } from "./server/simulation/index.ts";
 *   const plan = buildBaselinePlan(scenario);          // 或 B 自己构造的合法 plan
 *   const result = simulate(scenario, plan, 20261114); // 同输入同 seed 必得同结果
 */

export { simulate, ENGINE_VERSION } from "./engine.ts";
export { validateScenario, validatePlan } from "./validate.ts";
export { buildBaselinePlan } from "./baseline.ts";
export { generateDemand, assignRoutes } from "./demand.ts";
export { nearestRankP95, computeMetrics } from "./metrics.ts";
