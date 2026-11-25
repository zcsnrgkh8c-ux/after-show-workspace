/**
 * baseline.ts — 固定规则基线方案生成器。
 *
 * 规则简单、可解释、完全合法：
 * - 客流：每组固定分配到“总步行耗时最短”的开放合法路线
 *   （避台阶组只在无台阶开放路线中选；无合法路线则 routes: []，留在 S）。
 * - 公交：车辆按 ID 顺序轮流固定服务 P1/P2，首班为 available_from_s，
 *   之后每 round_trip_s 一班；与同站上一班冲突时向后平移以满足 boarding_gap_s。
 * 全程无随机数；封路、减车后的新 revision 会生成仍合法的新基线。
 */

import type { Plan, PlannedDeparture, Scenario } from "../../shared/types.ts";
import { routeIsClosed, routeIsStepFree } from "./validate.ts";

const alignUp = (v: number, step: number): number => Math.ceil(v / step - 1e-9) * step;

export function buildBaselinePlan(scenario: Scenario): Plan {
  const edgeById = new Map(scenario.edges.map((e) => [e.edge_id, e]));
  const routeTravel = (edgeIds: string[]): number =>
    edgeIds.reduce((a, id) => a + (edgeById.get(id)?.travel_s ?? Number.POSITIVE_INFINITY), 0);

  const allocations = scenario.groups.map((g) => {
    const eligible = scenario.routes
      .filter((r) => !routeIsClosed(scenario, r))
      .filter((r) => !g.needs_step_free || routeIsStepFree(scenario, r))
      .sort((a, b) => routeTravel(a.edge_ids) - routeTravel(b.edge_ids) || (a.route_id < b.route_id ? -1 : 1));
    if (eligible.length === 0) return { group_id: g.group_id, routes: [] };
    return { group_id: g.group_id, routes: [{ route_id: eligible[0].route_id, share: 1 }] };
  });

  const stops = scenario.nodes
    .filter((n) => n.kind === "stop")
    .map((n) => n.node_id)
    .sort();
  const vehicles = [...scenario.fleet].sort((a, b) => (a.vehicle_id < b.vehicle_id ? -1 : 1));
  const gapOf = new Map(
    scenario.nodes.filter((n) => n.kind === "stop").map((n) => [n.node_id, n.boarding_gap_s ?? 0]),
  );

  const departures: PlannedDeparture[] = [];
  const lastDepartByStop = new Map<string, number>();
  // 按时间顺序在车辆间轮转排班：每次取下一班最早的车辆，避免先排的车辆把同站窗口全部占满
  const pending = vehicles.map((v, i) => ({
    v,
    stop: stops[i % stops.length],
    t: v.available_from_s,
  }));
  for (;;) {
    const pendingValid = pending.filter((p) => p.t <= scenario.horizon_s);
    if (pendingValid.length === 0) break;
    pendingValid.sort((a, b) => a.t - b.t || (a.v.vehicle_id < b.v.vehicle_id ? -1 : 1));
    const cur = pendingValid[0];
    const last = lastDepartByStop.get(cur.stop);
    const gap = gapOf.get(cur.stop) ?? 0;
    let cand = cur.t;
    if (last !== undefined && cand - last < gap) cand = last + gap;
    cand = alignUp(cand, scenario.step_s);
    if (cand <= scenario.horizon_s) {
      departures.push({ vehicle_id: cur.v.vehicle_id, stop_id: cur.stop, depart_s: cand });
      lastDepartByStop.set(cur.stop, cand);
    }
    cur.t = alignUp(cand + cur.v.round_trip_s, scenario.step_s);
  }
  departures.sort((a, b) => a.depart_s - b.depart_s || (a.vehicle_id < b.vehicle_id ? -1 : 1));

  return {
    schema_version: scenario.schema_version,
    plan_id: `baseline_${scenario.scenario_id}_rev${scenario.revision}`,
    scenario_id: scenario.scenario_id,
    scenario_revision: scenario.revision,
    strategy: "baseline",
    name: "固定规则基线（最短步行路线 + 固定班次）",
    allocations,
    departures,
    notes: [
      "合成基线：每组固定分配到总步行耗时最短的开放合法路线；车辆按 ID 轮流固定服务站点，班次间隔取 round_trip_s 与站点 boarding_gap_s 的约束最大值。",
    ],
  };
}
