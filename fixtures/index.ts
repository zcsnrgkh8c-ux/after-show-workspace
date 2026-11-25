/**
 * fixtures/index.ts — A 模块可复现演示输入汇总。
 *
 * 命名约定：文件与导出名均区分“场景、revision、方案、种子”；
 * 所有输入均为合成（demand_source: "synthetic"），合成假设写在各文件头注释。
 * 同一场景内比较方案时保持需求、seed、窗口和物理约束一致，只改变 plan。
 * 演示默认 seed = 20261114（05 约定）。
 */

import { buildBaselinePlan } from "../server/simulation/baseline.ts";
import { concertDemoRev1 } from "./scenarios/concert_demo_rev1.ts";
import { concertDemoRev2 } from "./scenarios/concert_demo_rev2.ts";
import { zeroDemand } from "./scenarios/zero_demand.ts";
import { noBoarding } from "./scenarios/no_boarding.ts";

export const DEMO_SEED = 20261114;

export { concertDemoRev1, concertDemoRev2, zeroDemand, noBoarding };
export { candidateSplitRev1 } from "./plans/candidates.ts";
export * as invalidPlans from "./plans/invalid_samples.ts";

/** 合法基线 = 由确定性规则函数对场景实际生成，不手写 KPI、不违反约束 */
export const baselineRev1 = buildBaselinePlan(concertDemoRev1);
export const baselineRev2 = buildBaselinePlan(concertDemoRev2);
export const baselineZeroDemand = buildBaselinePlan(zeroDemand);
export const baselineNoBoarding = buildBaselinePlan(noBoarding);
