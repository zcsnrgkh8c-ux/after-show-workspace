/**
 * fixture：供 B 调用的候选方案输入样例（合法）
 * 场景=concert_demo / revision=1 / 演示 seed=20261114
 * 说明：A 只提供合法样例与基线，不负责声称哪个方案由 AI 生成、不做自然语言解释。
 * candidateSplitRev1 与基线共享同一场景、同一批 scenario+seed 生成的旅客、
 * 相同窗口与物理约束，只有 plan 不同，可直接对照归因。
 */

import type { Plan } from "../../shared/types.ts";

/** 候选：分流到两条线（regular 走 R1/R3 各半，deadline 走 R1/R2 各半） */
export const candidateSplitRev1: Plan = {
  schema_version: "1.0",
  plan_id: "candidate_split_rev1",
  scenario_id: "concert_demo",
  scenario_revision: 1,
  strategy: "coordinated",
  name: "分流候选样例（供 B 联调，非 AI 生成声明）",
  allocations: [
    { group_id: "regular", routes: [{ route_id: "R1", share: 0.5 }, { route_id: "R3", share: 0.5 }] },
    { group_id: "step_free", routes: [{ route_id: "R2", share: 1 }] },
    { group_id: "deadline", routes: [{ route_id: "R1", share: 0.5 }, { route_id: "R2", share: 0.5 }] },
  ],
  departures: [
    { vehicle_id: "B1", stop_id: "P1", depart_s: 180 },
    { vehicle_id: "B2", stop_id: "P2", depart_s: 180 },
    { vehicle_id: "B3", stop_id: "P1", depart_s: 240 },
    { vehicle_id: "B1", stop_id: "P1", depart_s: 540 },
    { vehicle_id: "B2", stop_id: "P2", depart_s: 540 },
    { vehicle_id: "B3", stop_id: "P1", depart_s: 600 },
    { vehicle_id: "B1", stop_id: "P1", depart_s: 900 },
    { vehicle_id: "B2", stop_id: "P2", depart_s: 900 },
    { vehicle_id: "B3", stop_id: "P1", depart_s: 960 },
    { vehicle_id: "B1", stop_id: "P1", depart_s: 1260 },
    { vehicle_id: "B2", stop_id: "P2", depart_s: 1260 },
    { vehicle_id: "B3", stop_id: "P1", depart_s: 1320 },
    { vehicle_id: "B1", stop_id: "P1", depart_s: 1620 },
    { vehicle_id: "B2", stop_id: "P2", depart_s: 1620 },
    { vehicle_id: "B3", stop_id: "P1", depart_s: 1680 },
  ],
  notes: ["合法样例：仅演示数据形状，不代表最优；比较优先看 remaining_count 与 missed_deadline_count。"],
};
