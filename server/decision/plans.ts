import {
  Departure,
  GroupAllocation,
  Objective,
  Plan,
  Scenario,
  ScenarioRoute,
} from "../../shared/types";
import { buildBaselinePlan } from "../simulation/baseline";
import {
  boardingGapSeconds,
  groupById,
  largestRemainderCounts,
  legalRoutesForGroup,
  routeEdges,
  routeTravelSeconds,
  stopNodeIds,
} from "./scenario_utils";

type AllocationStyle = "independent" | "coordinated";
type ScheduleStyle = "safe" | "independent";

interface BuildPlanResult {
  plans: Plan[];
  independent_conflicts: string[];
}

interface Trip {
  vehicle_id: string;
  base_s: number;
}

function slug(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "scenario";
}

function planId(scenario: Scenario, strategy: string, objective: Objective): string {
  return `plan_${strategy}_${slug(scenario.scenario_id)}_r${scenario.revision}_${objective}`;
}

function routeWeight(
  scenario: Scenario,
  route: ScenarioRoute,
  groupId: string,
  style: AllocationStyle,
  objective: Objective,
): number {
  const group = groupById(scenario, groupId);
  if (!group) return 1;
  const edges = routeEdges(scenario, route);
  const travel = routeTravelSeconds(scenario, route, group.walk_time_factor);
  const capacity = edges.length > 0 ? Math.min(...edges.map((edge) => edge.capacity_per_min)) : 1;
  if (travel <= 0) return 1;

  if (style === "independent") return capacity / travel;
  if (objective === "efficiency") return capacity / travel;
  if (objective === "inclusion") {
    const priority = group.needs_step_free || group.board_deadline_s !== null;
    return priority ? 1 : capacity / travel;
  }
  return Math.sqrt(capacity / travel);
}

function sharesFor(
  weights: Array<{ route_id: string; weight: number }>,
): Array<{ route_id: string; share: number }> {
  const usable = weights.filter((item) => item.weight > 0 && Number.isFinite(item.weight));
  if (usable.length === 0) return [];
  const total = usable.reduce((sum, item) => sum + item.weight, 0);
  if (total <= 0) return [];
  if (usable.length === 1) return [{ route_id: usable[0].route_id, share: 1 }];

  const shares = usable.map((item) => ({
    route_id: item.route_id,
    share: item.weight / total,
  }));
  const sum = shares.slice(0, -1).reduce((value, item) => value + item.share, 0);
  shares[shares.length - 1].share = 1 - sum;
  return shares;
}

function buildAllocations(
  scenario: Scenario,
  style: AllocationStyle,
  objective: Objective,
): { allocations: GroupAllocation[]; notes: string[] } {
  const notes: string[] = [];
  const allocations: GroupAllocation[] = [];

  for (const group of scenario.groups) {
    const legal = legalRoutesForGroup(scenario, group.group_id);
    if (legal.length === 0) {
      allocations.push({ group_id: group.group_id, routes: [] });
      notes.push(`旅客组 ${group.group_id} 当前没有合法可达路线，留在 S 等待，仍计入未满足服务需求。`);
      continue;
    }

    let weights = legal.map((route) => ({
      route_id: route.route_id,
      weight: routeWeight(scenario, route, group.group_id, style, objective),
    }));

    if (style === "independent") {
      const travel = new Map(
        legal.map((route) => [
          route.route_id,
          routeTravelSeconds(scenario, route, group.walk_time_factor),
        ]),
      );
      const fastest = Math.min(...travel.values());
      weights = legal.map((route) => ({
        route_id: route.route_id,
        weight: Math.abs((travel.get(route.route_id) ?? fastest) - fastest) <= 1e-6 ? 1 : 0,
      }));
    }

    const shares = sharesFor(weights);
    allocations.push({
      group_id: group.group_id,
      routes: shares.length > 0 ? shares : [],
    });
    if (shares.length === 0) {
      notes.push(`旅客组 ${group.group_id} 的合法路线权重为 0，未分配路线。`);
    }
  }

  return { allocations, notes };
}

function stopDemand(
  scenario: Scenario,
  allocations: GroupAllocation[],
  priorityOnly: boolean,
): Map<string, number> {
  const routes = new Map(scenario.routes.map((route) => [route.route_id, route]));
  const demand = new Map<string, number>();
  for (const stopId of stopNodeIds(scenario)) demand.set(stopId, 0);

  for (const allocation of allocations) {
    const group = groupById(scenario, allocation.group_id);
    if (!group) continue;
    if (priorityOnly && !(group.needs_step_free || group.board_deadline_s !== null)) continue;
    if (allocation.routes.length === 0) continue;
    const counts = largestRemainderCounts(group.count, allocation.routes);
    for (const item of allocation.routes) {
      const route = routes.get(item.route_id);
      if (!route) continue;
      const count = counts.get(item.route_id) || 0;
      demand.set(route.stop_id, (demand.get(route.stop_id) || 0) + count);
    }
  }
  return demand;
}

function allTrips(scenario: Scenario): Trip[] {
  const trips: Trip[] = [];
  for (const vehicle of scenario.fleet) {
    if (!(vehicle.round_trip_s > 0)) continue;
    for (let k = 0; k < 1000; k += 1) {
      const base = vehicle.available_from_s + k * vehicle.round_trip_s;
      if (base >= scenario.horizon_s) break;
      trips.push({ vehicle_id: vehicle.vehicle_id, base_s: base });
    }
  }
  trips.sort((a, b) => a.base_s - b.base_s || a.vehicle_id.localeCompare(b.vehicle_id));
  return trips;
}

function weightedStopCycle(
  scenario: Scenario,
  demand: Map<string, number>,
  priorityDemand: Map<string, number>,
  objective: Objective,
  tripCount: number,
): string[] {
  const stops = [...demand.entries()].filter(([, count]) => count > 0).map(([stopId]) => stopId);
  if (stops.length === 0) return [];

  const total = stops.reduce((sum, stopId) => sum + (demand.get(stopId) || 0), 0);
  const slots = Math.max(stops.length, Math.min(12, Math.max(1, tripCount)));
  const shares = stops.map((stopId) => ({
    route_id: stopId,
    share: (demand.get(stopId) || 0) / total,
  }));
  const counts = largestRemainderCounts(slots, shares);

  const ordered = [...stops].sort((a, b) => {
    if (objective === "inclusion") {
      const priorityDiff = (priorityDemand.get(b) || 0) - (priorityDemand.get(a) || 0);
      if (priorityDiff !== 0) return priorityDiff;
    }
    const demandDiff = (demand.get(b) || 0) - (demand.get(a) || 0);
    return demandDiff !== 0 ? demandDiff : a.localeCompare(b);
  });

  const remaining = new Map(counts);
  const cycle: string[] = [];
  while (cycle.length < slots) {
    let added = false;
    for (const stopId of ordered) {
      const left = remaining.get(stopId) || 0;
      if (left <= 0) continue;
      cycle.push(stopId);
      remaining.set(stopId, left - 1);
      added = true;
      if (cycle.length >= slots) break;
    }
    if (!added) break;
  }
  return cycle;
}

function scheduleSafe(
  scenario: Scenario,
  allocations: GroupAllocation[],
  objective: Objective,
): Departure[] {
  const demand = stopDemand(scenario, allocations, false);
  const priority = stopDemand(scenario, allocations, true);
  const trips = allTrips(scenario);
  const cycle = weightedStopCycle(scenario, demand, priority, objective, trips.length);
  if (cycle.length === 0) return [];

  const vehicleNext = new Map<string, number>();
  const stopNext = new Map<string, number>();
  const departures: Departure[] = [];
  let cycleIndex = 0;

  for (const trip of trips) {
    const stopId = cycle[cycleIndex % cycle.length];
    cycleIndex += 1;
    const gap = boardingGapSeconds(scenario, stopId);
    const depart = Math.max(
      trip.base_s,
      vehicleNext.get(trip.vehicle_id) ?? 0,
      stopNext.get(stopId) ?? 0,
    );
    if (depart >= scenario.horizon_s) continue;
    departures.push({
      vehicle_id: trip.vehicle_id,
      stop_id: stopId,
      depart_s: depart,
    });
    vehicleNext.set(trip.vehicle_id, depart + getRoundTrip(scenario, trip.vehicle_id));
    stopNext.set(stopId, depart + gap);
  }

  return departures.sort(
    (a, b) =>
      a.depart_s - b.depart_s ||
      a.vehicle_id.localeCompare(b.vehicle_id) ||
      a.stop_id.localeCompare(b.stop_id),
  );
}

function getRoundTrip(scenario: Scenario, vehicleId: string): number {
  const vehicle = scenario.fleet.find((item) => item.vehicle_id === vehicleId);
  return vehicle ? vehicle.round_trip_s : 0;
}

function scheduleIndependent(
  scenario: Scenario,
  allocations: GroupAllocation[],
): { departures: Departure[]; conflicts: string[] } {
  const demand = stopDemand(scenario, allocations, false);
  const entries = [...demand.entries()].filter(([, count]) => count > 0);
  if (entries.length === 0) return { departures: [], conflicts: [] };
  entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const busiestStop = entries[0][0];

  const departures: Departure[] = [];
  for (const vehicle of scenario.fleet) {
    if (!(vehicle.round_trip_s > 0)) continue;
    for (let k = 0; k < 1000; k += 1) {
      const depart = vehicle.available_from_s + k * vehicle.round_trip_s;
      if (depart >= scenario.horizon_s) break;
      departures.push({
        vehicle_id: vehicle.vehicle_id,
        stop_id: busiestStop,
        depart_s: depart,
      });
    }
  }
  departures.sort(
    (a, b) =>
      a.depart_s - b.depart_s ||
      a.vehicle_id.localeCompare(b.vehicle_id) ||
      a.stop_id.localeCompare(b.stop_id),
  );

  const conflicts: string[] = [];
  const byStop = new Map<string, Departure[]>();
  for (const departure of departures) {
    if (!byStop.has(departure.stop_id)) byStop.set(departure.stop_id, []);
    byStop.get(departure.stop_id)!.push(departure);
  }
  for (const [stopId, list] of byStop) {
    const gap = boardingGapSeconds(scenario, stopId);
    list.sort((a, b) => a.depart_s - b.depart_s);
    for (let i = 1; i < list.length; i += 1) {
      const diff = list[i].depart_s - list[i - 1].depart_s;
      if (diff < gap - 1e-6) {
        conflicts.push(
          `${stopId} 站点发车间隔 ${diff}s < boarding_gap_s ${gap}s（${list[i - 1].vehicle_id} 与 ${list[i].vehicle_id}）`,
        );
      }
    }
  }

  return { departures, conflicts };
}

function fixtureNote(engineSource: "external" | "fixture"): string {
  return engineSource === "fixture"
    ? "仿真引擎：fixture/待联调参考实现（A 引擎未联通）"
    : "仿真引擎：A 的 server/simulation";
}

export function buildPlans(
  scenario: Scenario,
  objective: Objective,
  engineSource: "external" | "fixture",
  baselinePlan: Plan = buildBaselinePlan(scenario),
): BuildPlanResult {
  const independent = buildAllocations(scenario, "independent", objective);
  const coordinated = buildAllocations(scenario, "coordinated", objective);

  const independentSchedule = scheduleIndependent(scenario, independent.allocations);
  const coordinatedDepartures = scheduleSafe(scenario, coordinated.allocations, objective);

  const commonNote = fixtureNote(engineSource);
  const integratedBaseline: Plan = {
    ...baselinePlan,
    notes: [
      ...(baselinePlan.notes ?? []),
      "基线唯一来源：A 的 buildBaselinePlan；B 不再另算一套基线。",
      commonNote,
    ],
  };

  const independentPlan: Plan = {
    schema_version: "1.0",
    plan_id: planId(scenario, "independent", objective),
    scenario_id: scenario.scenario_id,
    scenario_revision: scenario.revision,
    strategy: "independent",
    name: "分角色独立安排",
    allocations: independent.allocations,
    departures: independentSchedule.departures,
    notes: [
      "出口角色按最快合法路线分流；公交角色独立排班，未先占用共享站点。",
      ...independent.notes,
      ...(independentSchedule.conflicts.length > 0
        ? [`合并后共享站点冲突：${independentSchedule.conflicts.join("；")}`]
        : []),
      commonNote,
    ],
  };

  const coordinatedPlan: Plan = {
    schema_version: "1.0",
    plan_id: planId(scenario, "coordinated", objective),
    scenario_id: scenario.scenario_id,
    scenario_revision: scenario.revision,
    strategy: "coordinated",
    name: "协调修订方案",
    allocations: coordinated.allocations,
    departures: coordinatedDepartures,
    notes: [
      `协调器按站点 boarding_gap_s 与车辆 round_trip_s 错峰，并按 ${objective} 目标重排站点。`,
      ...(independentSchedule.conflicts.length > 0
        ? [`修复独立方案共享站点冲突 ${independentSchedule.conflicts.length} 处。`]
        : ["独立方案未出现共享站点冲突。"]),
      ...coordinated.notes,
      commonNote,
    ],
  };

  return {
    plans: [integratedBaseline, independentPlan, coordinatedPlan],
    independent_conflicts: independentSchedule.conflicts,
  };
}

export function clonePlanWithOverrides(
  plan: Plan,
  overrides: Partial<Pick<Plan, "plan_id" | "strategy" | "name" | "allocations" | "departures" | "notes">>,
): Plan {
  return {
    ...plan,
    ...overrides,
    allocations: overrides.allocations ?? plan.allocations,
    departures: overrides.departures ?? plan.departures,
    notes: overrides.notes ?? plan.notes,
  };
}
