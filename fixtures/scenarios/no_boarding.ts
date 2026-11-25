/**
 * fixture：no_boarding rev1（无人登车边界场景：全部路线关闭）
 * 场景=no_boarding / revision=1 / 演示 seed=20261114
 * 合成假设：路网同 concert_demo，但六条边全部关闭（结构合法场景：
 * “合法但无可达路线”不是错误）。基线对所有组只能给出 routes: []，
 * 旅客释放后留在 S 队列，无人能登车。
 * 期望口径：boarded_count = 0；p95 = null；clearance_time_s = null；
 * remaining_count = released_count；有期限组计入 missed_deadline_count；
 * 各组仍完整保留在汇总、group_metrics 与 timeline 中。
 */

import type { Scenario } from "../../shared/types.ts";

export const noBoarding: Scenario = {
  schema_version: "1.0",
  scenario_id: "no_boarding",
  revision: 1,
  title: "无人登车边界场景（全部路线关闭，旅客滞留 S）",
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
    { edge_id: "a1", from: "S", to: "E1", travel_s: 60, capacity_per_min: 60, step_free: true, closed: true },
    { edge_id: "a2", from: "E1", to: "P1", travel_s: 60, capacity_per_min: 40, step_free: true, closed: true },
    { edge_id: "b1", from: "S", to: "E2", travel_s: 90, capacity_per_min: 45, step_free: true, closed: true },
    { edge_id: "b2", from: "E2", to: "P2", travel_s: 60, capacity_per_min: 45, step_free: true, closed: true },
    { edge_id: "c1", from: "S", to: "E3", travel_s: 45, capacity_per_min: 35, step_free: false, closed: true },
    { edge_id: "c2", from: "E3", to: "P2", travel_s: 45, capacity_per_min: 35, step_free: false, closed: true },
  ],
  routes: [
    { route_id: "R1", edge_ids: ["a1", "a2"], stop_id: "P1" },
    { route_id: "R2", edge_ids: ["b1", "b2"], stop_id: "P2" },
    { route_id: "R3", edge_ids: ["c1", "c2"], stop_id: "P2" },
  ],
  groups: [
    { group_id: "regular", count: 60, release_start_s: 0, release_end_s: 300, needs_step_free: false, walk_time_factor: 1, board_deadline_s: null },
    { group_id: "step_free", count: 20, release_start_s: 0, release_end_s: 300, needs_step_free: true, walk_time_factor: 1.5, board_deadline_s: null },
    { group_id: "deadline", count: 30, release_start_s: 0, release_end_s: 300, needs_step_free: false, walk_time_factor: 1, board_deadline_s: 450 },
  ],
  fleet: [
    { vehicle_id: "B1", capacity: 30, available_from_s: 180, round_trip_s: 360 },
  ],
};
