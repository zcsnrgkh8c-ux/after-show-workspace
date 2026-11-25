/**
 * fixture：concert_demo rev2（事件场景：关闭无台阶边 a1 + 移除车辆 B3）
 * 场景=concert_demo / revision=2 / 配套方案=见 fixtures/plans / 演示 seed=20261114
 * 事件注入语义：不是在一次运行中改结果，而是修改场景、提升 revision 后，
 * 从完全相同的初始条件（同一批 scenario+seed 生成的旅客）重新运行。
 * 与 rev1 相比只改变：edge a1.closed=true、fleet 移除 B3；人数、窗口、seed 口径不变，
 * 保证方案对照可归因。旧 revision(rev1) 的方案必须被拒绝。
 */

import type { Scenario } from "../../shared/types.ts";

export const concertDemoRev2: Scenario = {
  schema_version: "1.0",
  scenario_id: "concert_demo",
  revision: 2,
  title: "散场接驳合成场景（事件：a1 封闭、B3 退出）",
  demand_source: "synthetic",
  horizon_s: 1800,
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
    { group_id: "regular", count: 180, release_start_s: 0, release_end_s: 300, needs_step_free: false, walk_time_factor: 1, board_deadline_s: null },
    { group_id: "step_free", count: 40, release_start_s: 0, release_end_s: 300, needs_step_free: true, walk_time_factor: 1.5, board_deadline_s: null },
    { group_id: "deadline", count: 80, release_start_s: 0, release_end_s: 300, needs_step_free: false, walk_time_factor: 1, board_deadline_s: 900 },
  ],
  fleet: [
    { vehicle_id: "B1", capacity: 30, available_from_s: 180, round_trip_s: 360 },
    { vehicle_id: "B2", capacity: 30, available_from_s: 180, round_trip_s: 360 },
  ],
};
