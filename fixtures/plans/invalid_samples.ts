/**
 * fixture：非法方案样例集（每个样例只违反一条规则，供 B 演示校验拦截）
 * 基准场景=concert_demo rev1（staleRevision 除外，它对照 rev1 场景使用 rev2 号）。
 * 期望：simulate 返回 status "invalid"、metrics 为 null，violations 含对应 code。
 */

import type { Plan } from "../../shared/types.ts";
import { candidateSplitRev1 } from "./candidates.ts";

const base: Plan = candidateSplitRev1;

/** 1) 旧 revision：场景已是 rev1，方案自称 rev2 → PLAN_STALE_REVISION（反之亦然） */
export const invalidStaleRevision: Plan = { ...base, plan_id: "invalid_stale_revision", scenario_revision: 2 };

/** 2) share 之和 ≠ 1（0.5 + 0.3）→ PLAN_SHARE_INVALID */
export const invalidShareSum: Plan = {
  ...base,
  plan_id: "invalid_share_sum",
  allocations: base.allocations.map((a) =>
    a.group_id === "regular" ? { group_id: "regular", routes: [{ route_id: "R1", share: 0.5 }, { route_id: "R3", share: 0.3 }] } : a,
  ),
};

/** 3) 给避台阶组分配含台阶路线 R3 → PLAN_STEP_FREE_VIOLATION */
export const invalidStepFreeOnStairs: Plan = {
  ...base,
  plan_id: "invalid_step_free_on_stairs",
  allocations: base.allocations.map((a) =>
    a.group_id === "step_free" ? { group_id: "step_free", routes: [{ route_id: "R3", share: 1 }] } : a,
  ),
};

/** 4) 事件场景 rev2 中仍分配已关闭的 R1（a1 封闭）→ PLAN_ROUTE_CLOSED（须配合 concertDemoRev2 使用） */
export const invalidClosedRouteRev2: Plan = {
  ...base,
  plan_id: "invalid_closed_route_rev2",
  scenario_revision: 2,
  departures: base.departures.filter((d) => d.vehicle_id !== "B3"), // rev2 已移除 B3，剔除以隔离单一违规
  allocations: base.allocations.map((a) =>
    a.group_id === "regular" ? { group_id: "regular", routes: [{ route_id: "R1", share: 1 }] } : a,
  ),
};

/** 5) 同一车辆班次间隔 < round_trip_s（B1：180s 与 400s，差 220 < 360）→ PLAN_VEHICLE_OVERLAP */
export const invalidVehicleOverlap: Plan = {
  ...base,
  plan_id: "invalid_vehicle_overlap",
  departures: [
    { vehicle_id: "B1", stop_id: "P1", depart_s: 180 },
    { vehicle_id: "B1", stop_id: "P1", depart_s: 400 },
  ],
};

/** 6) 同站班次间隔 < boarding_gap_s（P1：180s 与 200s，差 20 < 30）→ PLAN_STOP_GAP */
export const invalidStopGap: Plan = {
  ...base,
  plan_id: "invalid_stop_gap",
  departures: [
    { vehicle_id: "B1", stop_id: "P1", depart_s: 180 },
    { vehicle_id: "B2", stop_id: "P1", depart_s: 200 },
  ],
};

/** 7) 引用不存在的车辆 B9 → PLAN_VEHICLE_UNKNOWN */
export const invalidUnknownVehicle: Plan = {
  ...base,
  plan_id: "invalid_unknown_vehicle",
  departures: [{ vehicle_id: "B9", stop_id: "P1", depart_s: 180 }],
};
