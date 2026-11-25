/**
 * run_demo.ts — 重新生成给 C 的真实 SimulationResult 样例。
 * 运行：node fixtures/run_demo.ts
 * 输出：fixtures/samples/*.result.json（全部由引擎实际计算，禁止手工改动；
 * 场景或引擎更新后必须重新运行本脚本，否则视为过期回放数据）。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { simulate } from "../server/simulation/index.ts";
import {
  DEMO_SEED,
  baselineNoBoarding,
  baselineRev1,
  baselineRev2,
  baselineZeroDemand,
  candidateSplitRev1,
  concertDemoRev1,
  concertDemoRev2,
  noBoarding,
  zeroDemand,
} from "./index.ts";

const outDir = join(__dirname, "samples");
mkdirSync(outDir, { recursive: true });

const runs = [
  { name: `concert_demo_rev1__baseline__seed${DEMO_SEED}`, scenario: concertDemoRev1, plan: baselineRev1 },
  { name: `concert_demo_rev1__candidate_split__seed${DEMO_SEED}`, scenario: concertDemoRev1, plan: candidateSplitRev1 },
  { name: `concert_demo_rev2__baseline__seed${DEMO_SEED}`, scenario: concertDemoRev2, plan: baselineRev2 },
  { name: `zero_demand_rev1__baseline__seed${DEMO_SEED}`, scenario: zeroDemand, plan: baselineZeroDemand },
  { name: `no_boarding_rev1__baseline__seed${DEMO_SEED}`, scenario: noBoarding, plan: baselineNoBoarding },
] as const;

for (const { name, scenario, plan } of runs) {
  const result = simulate(scenario, plan, DEMO_SEED);
  writeFileSync(join(outDir, `${name}.result.json`), JSON.stringify(result, null, 2));
  const m = result.metrics;
  console.log(
    [
      `${name}  [${result.status}]`,
      m
        ? `released=${m.released_count} boarded=${m.boarded_count} remaining=${m.remaining_count} ` +
          `mean_wait=${m.mean_queue_wait_all_released_s?.toFixed(1) ?? "null"}s ` +
          `p95=${m.p95_queue_wait_boarded_s ?? "null"}s missed=${m.missed_deadline_count} ` +
          `clearance=${m.clearance_time_s ?? "null"}s departures=${result.departures_log.length} frames=${result.timeline.length}`
        : `violations=${result.violations.map((v) => v.code).join(",")}`,
    ].join("\n  "),
  );
}
