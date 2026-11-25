/**
 * fixture：zero_demand rev1（零需求边界场景）
 * 场景=zero_demand / revision=1 / 演示 seed=20261114
 * 合成假设：路网与车辆同 concert_demo，但三个旅客组人数全部为 0。
 * 期望口径：clearance_time_s = 0；两项等待指标 = null（不得伪装成 0）；
 * 所有组仍保留在 group_metrics 与 timeline 中；班次照常记录（空车）。
 */

import type { Scenario } from "../../shared/types.ts";

export const zeroDemand: Scenario = {
  schema_version: "1.0",
  scenario_id: "zero_demand",
  revision: 1,
  title: "零需求边界场景（全部旅客组人数为 0）",
  demand_source: "synthetic",
  horizon_s: 600,
  step_s: 5,
  nodes: [
    { node_id: "S", kind: "source", x: 50, y: 15 },
    { node_id: "E1", kind: "exit", x: 20, y: 45 },
    { node_id: "E2", kind: "exit", x: 50, y: 45 },
    { node_id: "E3", kind: "exit", x: 80, y: 45 },
    { node_id: "P1", kind: "stop", x: 25, y: 85, boarding_gap_s: 30 },
    { node_id: "P2", kind: "stop", x: 75, y: 85, boarding_gap_s: 30 },
  ],
  edges: [
    { edge_id: "a1", from: "S", to: "E1", travel_s: 60, capacity_per_min: 60, step_free: true, closed: false },
    { edge_id: "a2", from: "E1", to: "P1", travel_s: 60, capacity_per_min: 40, step_free: true, closed: false },
    { edge_id: "b1", from: "S", to: "E2", travel_s: 90, capacity_per_min: 45, step_free: true, closed: false },
    { edge_id: "b2", from: "E2", to: "P2", travel_s: 60, capacity_per_min: 45, step_free: true, closed: false },
    { edge_id: "c1", from: "S", to: "E3", travel_s: 45, capacity_per_min: 35, step_free: false, closed: false },
    { edge_id: "c2", from: "E3", to: "P2", travel_s: 45, capacity_per_min: 35, step_free: false, closed: false },
  ],
  routes: [
    { route_id: "R1", edge_ids: ["a1", "a2"], stop_id: "P1" },
    { route_id: "R2", edge_ids: ["b1", "b2"], stop_id: "P2" },
    { route_id: "R3", edge_ids: ["c1", "c2"], stop_id: "P2" },
  ],
  groups: [
    { group_id: "regular", count: 0, release_start_s: 0, release_end_s: 300, needs_step_free: false, walk_time_factor: 1, board_deadline_s: null },
    { group_id: "step_free", count: 0, release_start_s: 0, release_end_s: 300, needs_step_free: true, walk_time_factor: 1.5, board_deadline_s: null },
    { group_id: "deadline", count: 0, release_start_s: 0, release_end_s: 300, needs_step_free: false, walk_time_factor: 1, board_deadline_s: 450 },
  ],
  fleet: [
    { vehicle_id: "B1", capacity: 30, available_from_s: 180, round_trip_s: 360 },
    { vehicle_id: "B2", capacity: 30, available_from_s: 180, round_trip_s: 360 },
  ],
};
