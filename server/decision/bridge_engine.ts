/**
 * 【临时参考引擎｜fixture/待联调】
 *
 * 05 约定 A 拥有 server/simulation 与仿真核心。A 的首版尚未联通时，B 用本文件
 * 提供确定性参考实现，只为让决策层、接口与前端可以用同一契约联调。所有数值都按
 * 05 的规则实际计算，不写死指标、不伪造提升率。
 *
 * 一旦 A 交付 server/simulation，engine_port 会优先加载 A 的版本，本文件退出主路径。
 */

import {
  DemandGroup,
  Departure,
  GroupCounts,
  GroupMetrics,
  Metrics,
  Plan,
  Scenario,
  ScenarioEdge,
  ScenarioRoute,
  SimulationResult,
  TimelineFrame,
  ValidationIssue,
  DepartureLog,
} from "../../shared/types";

export const REFERENCE_ENGINE_VERSION = "reference-0.1.0+fixture";

const EPS = 1e-9;

function issue(
  code: string,
  path: string,
  message: string,
  severity: "error" | "warning" = "error",
): ValidationIssue {
  return { code, path, message, severity };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 0;
}

function isPositiveNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

function edgeMapOf(scenario: Scenario): Map<string, ScenarioEdge> {
  return new Map((scenario.edges || []).map((edge) => [edge.edge_id, edge]));
}

/* ------------------------------------------------------------------ */
/* validateScenario                                                    */
/* ------------------------------------------------------------------ */

export function validateScenario(scenario: Scenario): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!scenario || typeof scenario !== "object") {
    return [issue("invalid_scenario", "$", "场景必须是 JSON 对象")];
  }

  if (scenario.schema_version !== "1.0") {
    issues.push(issue("invalid_schema_version", "schema_version", "仅支持 schema_version=1.0"));
  }
  if (typeof scenario.scenario_id !== "string" || scenario.scenario_id.trim() === "") {
    issues.push(issue("missing_scenario_id", "scenario_id", "scenario_id 必须为非空字符串"));
  }
  if (!isNonNegativeInteger(scenario.revision)) {
    issues.push(issue("invalid_revision", "revision", "revision 必须为非负整数"));
  }
  if (typeof scenario.title !== "string" || scenario.title.trim() === "") {
    issues.push(issue("missing_title", "title", "title 必须为非空字符串"));
  }
  if (typeof scenario.demand_source !== "string" || scenario.demand_source.trim() === "") {
    issues.push(issue("missing_demand_source", "demand_source", "demand_source 必须为非空字符串"));
  }
  if (!isPositiveNumber(scenario.horizon_s) || !Number.isInteger(scenario.horizon_s)) {
    issues.push(issue("invalid_horizon", "horizon_s", "horizon_s 必须为正整数秒"));
  }
  if (!isPositiveNumber(scenario.step_s) || !Number.isInteger(scenario.step_s)) {
    issues.push(issue("invalid_step", "step_s", "step_s 必须为正整数秒"));
  }
  if (
    isPositiveNumber(scenario.horizon_s) &&
    isPositiveNumber(scenario.step_s) &&
    scenario.horizon_s % scenario.step_s !== 0
  ) {
    issues.push(
      issue(
        "horizon_not_step_multiple",
        "horizon_s",
        "horizon_s 不是 step_s 的整数倍，终帧仍按 horizon_s 统计",
        "warning",
      ),
    );
  }

  const nodes = Array.isArray(scenario.nodes) ? scenario.nodes : [];
  if (!Array.isArray(scenario.nodes) || nodes.length === 0) {
    issues.push(issue("missing_nodes", "nodes", "nodes 必须为非空数组"));
  }
  const nodeIds = new Set<string>();
  nodes.forEach((node, index) => {
    const path = `nodes[${index}]`;
    if (!node || typeof node !== "object") {
      issues.push(issue("invalid_node", path, "节点必须是对象"));
      return;
    }
    if (typeof node.node_id !== "string" || node.node_id.trim() === "") {
      issues.push(issue("missing_node_id", `${path}.node_id`, "node_id 必须为非空字符串"));
    } else if (nodeIds.has(node.node_id)) {
      issues.push(issue("duplicate_node_id", `${path}.node_id`, `节点 ID 重复：${node.node_id}`));
    } else {
      nodeIds.add(node.node_id);
    }
    if (node.kind !== "source" && node.kind !== "exit" && node.kind !== "stop") {
      issues.push(issue("invalid_node_kind", `${path}.kind`, "kind 只能是 source/exit/stop"));
    }
    if (!isFiniteNumber(node.x) || !isFiniteNumber(node.y)) {
      issues.push(issue("invalid_node_coordinate", path, "x、y 必须为有限数字"));
    }
    if (node.kind === "stop" && node.boarding_gap_s !== undefined) {
      if (!isFiniteNumber(node.boarding_gap_s) || node.boarding_gap_s < 0) {
        issues.push(issue("invalid_boarding_gap", `${path}.boarding_gap_s`, "boarding_gap_s 必须为非负数"));
      }
    }
  });
  if (!nodes.some((node) => node.kind === "source")) {
    issues.push(issue("missing_source", "nodes", "场景至少需要一个 source 节点"));
  }

  const sourceIds = new Set(nodes.filter((node) => node.kind === "source").map((node) => node.node_id));
  const stopIds = new Set(nodes.filter((node) => node.kind === "stop").map((node) => node.node_id));

  const edges = Array.isArray(scenario.edges) ? scenario.edges : [];
  if (!Array.isArray(scenario.edges)) {
    issues.push(issue("missing_edges", "edges", "edges 必须为数组"));
  }
  const edgeIds = new Set<string>();
  const edgeMap = new Map<string, ScenarioEdge>();
  edges.forEach((edge, index) => {
    const path = `edges[${index}]`;
    if (!edge || typeof edge !== "object") {
      issues.push(issue("invalid_edge", path, "边必须是对象"));
      return;
    }
    if (typeof edge.edge_id !== "string" || edge.edge_id.trim() === "") {
      issues.push(issue("missing_edge_id", `${path}.edge_id`, "edge_id 必须为非空字符串"));
    } else if (edgeIds.has(edge.edge_id)) {
      issues.push(issue("duplicate_edge_id", `${path}.edge_id`, `边 ID 重复：${edge.edge_id}`));
    } else {
      edgeIds.add(edge.edge_id);
      edgeMap.set(edge.edge_id, edge);
    }
    if (!nodeIds.has(edge.from)) {
      issues.push(issue("missing_edge_from", `${path}.from`, `from 引用了不存在的节点：${edge.from}`));
    }
    if (!nodeIds.has(edge.to)) {
      issues.push(issue("missing_edge_to", `${path}.to`, `to 引用了不存在的节点：${edge.to}`));
    }
    if (!isPositiveNumber(edge.travel_s)) {
      issues.push(issue("invalid_travel_s", `${path}.travel_s`, "travel_s 必须为正数"));
    }
    if (!isPositiveNumber(edge.capacity_per_min)) {
      issues.push(issue("invalid_capacity", `${path}.capacity_per_min`, "capacity_per_min 必须为正数"));
    }
    if (typeof edge.step_free !== "boolean") {
      issues.push(issue("invalid_step_free", `${path}.step_free`, "step_free 必须为布尔值"));
    }
    if (typeof edge.closed !== "boolean") {
      issues.push(issue("invalid_closed", `${path}.closed`, "closed 必须为布尔值"));
    }
  });

  const routes = Array.isArray(scenario.routes) ? scenario.routes : [];
  if (!Array.isArray(scenario.routes)) {
    issues.push(issue("missing_routes", "routes", "routes 必须为数组"));
  }
  const routeIds = new Set<string>();
  routes.forEach((route, index) => {
    const path = `routes[${index}]`;
    if (!route || typeof route !== "object") {
      issues.push(issue("invalid_route", path, "路线必须是对象"));
      return;
    }
    if (typeof route.route_id !== "string" || route.route_id.trim() === "") {
      issues.push(issue("missing_route_id", `${path}.route_id`, "route_id 必须为非空字符串"));
    } else if (routeIds.has(route.route_id)) {
      issues.push(issue("duplicate_route_id", `${path}.route_id`, `路线 ID 重复：${route.route_id}`));
    } else {
      routeIds.add(route.route_id);
    }
    if (!Array.isArray(route.edge_ids) || route.edge_ids.length === 0) {
      issues.push(issue("empty_route", `${path}.edge_ids`, "路线必须包含至少一条边"));
      return;
    }
    let previousTo: string | null = null;
    let chainOk = true;
    for (let i = 0; i < route.edge_ids.length; i += 1) {
      const edge = edgeMap.get(route.edge_ids[i]);
      if (!edge) {
        issues.push(
          issue("missing_route_edge", `${path}.edge_ids[${i}]`, `路线引用了不存在的边：${route.edge_ids[i]}`),
        );
        chainOk = false;
        break;
      }
      if (previousTo !== null && edge.from !== previousTo) {
        issues.push(
          issue("discontinuous_route", `${path}.edge_ids[${i}]`, `路线不连续：${previousTo} -> ${edge.from}`),
        );
        chainOk = false;
      }
      previousTo = edge.to;
    }
    if (chainOk && previousTo !== null) {
      const first = edgeMap.get(route.edge_ids[0]);
      if (first && !sourceIds.has(first.from)) {
        issues.push(issue("route_not_from_source", `${path}.edge_ids[0]`, "路线必须从 source 节点开始"));
      }
      if (route.stop_id !== previousTo) {
        issues.push(issue("route_stop_mismatch", `${path}.stop_id`, "stop_id 必须等于路线最后一条边的终点"));
      }
      if (!stopIds.has(route.stop_id)) {
        issues.push(issue("route_stop_not_stop", `${path}.stop_id`, "路线终点必须是 stop 节点"));
      }
    }
  });

  const groups = Array.isArray(scenario.groups) ? scenario.groups : [];
  if (!Array.isArray(scenario.groups)) {
    issues.push(issue("missing_groups", "groups", "groups 必须为数组"));
  }
  const groupIds = new Set<string>();
  groups.forEach((group, index) => {
    const path = `groups[${index}]`;
    if (!group || typeof group !== "object") {
      issues.push(issue("invalid_group", path, "旅客组必须是对象"));
      return;
    }
    if (typeof group.group_id !== "string" || group.group_id.trim() === "") {
      issues.push(issue("missing_group_id", `${path}.group_id`, "group_id 必须为非空字符串"));
    } else if (groupIds.has(group.group_id)) {
      issues.push(issue("duplicate_group_id", `${path}.group_id`, `旅客组 ID 重复：${group.group_id}`));
    } else {
      groupIds.add(group.group_id);
    }
    if (!isNonNegativeInteger(group.count)) {
      issues.push(issue("invalid_group_count", `${path}.count`, "count 必须为非负整数"));
    }
    if (!isFiniteNumber(group.release_start_s) || group.release_start_s < 0) {
      issues.push(issue("invalid_release_start", `${path}.release_start_s`, "release_start_s 必须为非负数"));
    }
    if (!isFiniteNumber(group.release_end_s) || group.release_end_s < 0) {
      issues.push(issue("invalid_release_end", `${path}.release_end_s`, "release_end_s 必须为非负数"));
    }
    if (
      isFiniteNumber(group.release_start_s) &&
      isFiniteNumber(group.release_end_s) &&
      group.release_end_s < group.release_start_s
    ) {
      issues.push(issue("release_window_inverted", path, "release_end_s 不能早于 release_start_s"));
    }
    if (isFiniteNumber(scenario.horizon_s) && isFiniteNumber(group.release_end_s) && group.release_end_s > scenario.horizon_s) {
      issues.push(issue("release_outside_horizon", `${path}.release_end_s`, "释放区间必须在模拟窗口内"));
    }
    if (!isPositiveNumber(group.walk_time_factor)) {
      issues.push(issue("invalid_walk_factor", `${path}.walk_time_factor`, "walk_time_factor 必须为正数"));
    }
    if (typeof group.needs_step_free !== "boolean") {
      issues.push(issue("invalid_needs_step_free", `${path}.needs_step_free`, "needs_step_free 必须为布尔值"));
    }
    if (group.board_deadline_s !== null) {
      if (!isFiniteNumber(group.board_deadline_s) || group.board_deadline_s < 0) {
        issues.push(issue("invalid_deadline", `${path}.board_deadline_s`, "board_deadline_s 必须为非负数或 null"));
      } else if (isFiniteNumber(scenario.horizon_s) && group.board_deadline_s > scenario.horizon_s) {
        issues.push(issue("deadline_outside_horizon", `${path}.board_deadline_s`, "登车期限不能晚于模拟窗口结束"));
      }
    }
  });

  const fleet = Array.isArray(scenario.fleet) ? scenario.fleet : [];
  if (!Array.isArray(scenario.fleet)) {
    issues.push(issue("missing_fleet", "fleet", "fleet 必须为数组"));
  }
  const vehicleIds = new Set<string>();
  fleet.forEach((vehicle, index) => {
    const path = `fleet[${index}]`;
    if (!vehicle || typeof vehicle !== "object") {
      issues.push(issue("invalid_vehicle", path, "车辆必须是对象"));
      return;
    }
    if (typeof vehicle.vehicle_id !== "string" || vehicle.vehicle_id.trim() === "") {
      issues.push(issue("missing_vehicle_id", `${path}.vehicle_id`, "vehicle_id 必须为非空字符串"));
    } else if (vehicleIds.has(vehicle.vehicle_id)) {
      issues.push(issue("duplicate_vehicle_id", `${path}.vehicle_id`, `车辆 ID 重复：${vehicle.vehicle_id}`));
    } else {
      vehicleIds.add(vehicle.vehicle_id);
    }
    if (!isPositiveNumber(vehicle.capacity) || !Number.isInteger(vehicle.capacity)) {
      issues.push(issue("invalid_vehicle_capacity", `${path}.capacity`, "capacity 必须为正整数"));
    }
    if (!isFiniteNumber(vehicle.available_from_s) || vehicle.available_from_s < 0) {
      issues.push(issue("invalid_available_from", `${path}.available_from_s`, "available_from_s 必须为非负数"));
    }
    if (!isPositiveNumber(vehicle.round_trip_s)) {
      issues.push(issue("invalid_round_trip", `${path}.round_trip_s`, "round_trip_s 必须为正数"));
    }
  });

  return issues;
}

/* ------------------------------------------------------------------ */
/* validatePlan                                                        */
/* ------------------------------------------------------------------ */

export function validatePlan(scenario: Scenario, plan: Plan): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!plan || typeof plan !== "object") {
    return [issue("invalid_plan", "$", "方案必须是 JSON 对象")];
  }
  if (plan.schema_version !== "1.0") {
    issues.push(issue("invalid_plan_schema_version", "schema_version", "仅支持 schema_version=1.0"));
  }
  if (typeof plan.plan_id !== "string" || plan.plan_id.trim() === "") {
    issues.push(issue("missing_plan_id", "plan_id", "plan_id 必须为非空字符串"));
  }
  if (plan.scenario_id !== scenario.scenario_id) {
    issues.push(issue("plan_scenario_mismatch", "scenario_id", "方案 scenario_id 与场景不一致"));
  }
  if (plan.scenario_revision !== scenario.revision) {
    issues.push(issue("stale_plan_revision", "scenario_revision", "方案属于旧场景 revision，拒绝执行"));
  }
  if (plan.strategy !== "baseline" && plan.strategy !== "independent" && plan.strategy !== "coordinated") {
    issues.push(issue("invalid_strategy", "strategy", "strategy 只能是 baseline/independent/coordinated"));
  }

  const groups = new Map((scenario.groups || []).map((group) => [group.group_id, group]));
  const routes = new Map((scenario.routes || []).map((route) => [route.route_id, route]));
  const nodes = new Map((scenario.nodes || []).map((node) => [node.node_id, node]));
  const vehicles = new Map((scenario.fleet || []).map((vehicle) => [vehicle.vehicle_id, vehicle]));
  const edges = edgeMapOf(scenario);

  const allocations = Array.isArray(plan.allocations) ? plan.allocations : [];
  if (!Array.isArray(plan.allocations)) {
    issues.push(issue("missing_allocations", "allocations", "allocations 必须为数组"));
  }
  const allocationCount = new Map<string, number>();
  allocations.forEach((allocation, index) => {
    const path = `allocations[${index}]`;
    if (!allocation || typeof allocation !== "object") {
      issues.push(issue("invalid_allocation", path, "旅客组分配必须是对象"));
      return;
    }
    const groupId = allocation.group_id;
    allocationCount.set(groupId, (allocationCount.get(groupId) || 0) + 1);
    const group = groups.get(groupId);
    if (!group) {
      issues.push(issue("unknown_group", `${path}.group_id`, `未知旅客组：${groupId}`));
    }
    if (!Array.isArray(allocation.routes)) {
      issues.push(issue("invalid_allocation_routes", `${path}.routes`, "routes 必须为数组"));
      return;
    }

    if (allocation.routes.length === 0) {
      return;
    }

    let shareSum = 0;
    const seenRoutes = new Set<string>();
    allocation.routes.forEach((item, routeIndex) => {
      const routePath = `${path}.routes[${routeIndex}]`;
      if (!item || typeof item !== "object") {
        issues.push(issue("invalid_route_share", routePath, "路线份额必须是对象"));
        return;
      }
      if (seenRoutes.has(item.route_id)) {
        issues.push(issue("duplicate_route_share", `${routePath}.route_id`, `路线份额重复：${item.route_id}`));
      }
      seenRoutes.add(item.route_id);
      if (!isFiniteNumber(item.share) || item.share < 0 || item.share > 1) {
        issues.push(issue("invalid_share", `${routePath}.share`, "share 必须在 [0,1] 内"));
      } else {
        shareSum += item.share;
      }
      const route = routes.get(item.route_id);
      if (!route) {
        issues.push(issue("unknown_route", `${routePath}.route_id`, `未知路线：${item.route_id}`));
        return;
      }
      if (!isFiniteNumber(item.share) || item.share <= EPS) return;
      const routeEdgeList = route.edge_ids
        .map((edgeId) => edges.get(edgeId))
        .filter((edge): edge is ScenarioEdge => Boolean(edge));
      if (routeEdgeList.length !== route.edge_ids.length || routeEdgeList.some((edge) => edge.closed)) {
        issues.push(issue("unavailable_route", `${routePath}.route_id`, `路线不可用（含缺失或关闭边）：${item.route_id}`));
      }
      if (group && group.needs_step_free && routeEdgeList.some((edge) => !edge.step_free)) {
        issues.push(
          issue(
            "step_required",
            `${routePath}.route_id`,
            `需要避开台阶的旅客组不能分配有台阶路线：${item.route_id}`,
          ),
        );
      }
    });

    if (Math.abs(shareSum - 1) > 1e-6) {
      issues.push(issue("share_sum_invalid", `${path}.routes`, `非空 routes 的 share 之和必须为 1，当前为 ${shareSum}`));
    }
  });

  for (const groupId of groups.keys()) {
    const count = allocationCount.get(groupId) || 0;
    if (count === 0) {
      issues.push(issue("missing_group_allocation", "allocations", `旅客组缺少 allocation：${groupId}`));
    } else if (count > 1) {
      issues.push(issue("duplicate_group_allocation", "allocations", `旅客组存在多项 allocation：${groupId}`));
    }
  }

  const departures = Array.isArray(plan.departures) ? plan.departures : [];
  if (!Array.isArray(plan.departures)) {
    issues.push(issue("missing_departures", "departures", "departures 必须为数组"));
  }
  const normalizedDepartures: Array<{ departure: Departure; index: number; vehicle: string; stop: string }> = [];
  departures.forEach((departure, index) => {
    const path = `departures[${index}]`;
    if (!departure || typeof departure !== "object") {
      issues.push(issue("invalid_departure", path, "班次必须是对象"));
      return;
    }
    const vehicle = vehicles.get(departure.vehicle_id);
    if (!vehicle) {
      issues.push(issue("unknown_vehicle", `${path}.vehicle_id`, `未知车辆：${departure.vehicle_id}`));
    }
    const stop = nodes.get(departure.stop_id);
    if (!stop) {
      issues.push(issue("unknown_stop", `${path}.stop_id`, `未知站点：${departure.stop_id}`));
    } else if (stop.kind !== "stop") {
      issues.push(issue("departure_not_at_stop", `${path}.stop_id`, "发车点必须是 stop 节点"));
    }
    if (!isFiniteNumber(departure.depart_s) || departure.depart_s < 0) {
      issues.push(issue("invalid_depart_s", `${path}.depart_s`, "depart_s 必须为非负数"));
      return;
    }
    if (vehicle && departure.depart_s < vehicle.available_from_s - EPS) {
      issues.push(issue("departure_before_available", `${path}.depart_s`, "首班不能早于车辆 available_from_s"));
    }
    if (isPositiveNumber(scenario.horizon_s) && departure.depart_s > scenario.horizon_s) {
      issues.push(
        issue("departure_after_horizon", `${path}.depart_s`, "班次晚于模拟窗口结束，不会执行", "warning"),
      );
    }
    normalizedDepartures.push({
      departure,
      index,
      vehicle: departure.vehicle_id,
      stop: departure.stop_id,
    });
  });

  const byVehicle = new Map<string, Array<{ departure: Departure; index: number }>>();
  const byStop = new Map<string, Array<{ departure: Departure; index: number }>>();
  for (const item of normalizedDepartures) {
    if (!byVehicle.has(item.vehicle)) byVehicle.set(item.vehicle, []);
    byVehicle.get(item.vehicle)!.push({ departure: item.departure, index: item.index });
    if (!byStop.has(item.stop)) byStop.set(item.stop, []);
    byStop.get(item.stop)!.push({ departure: item.departure, index: item.index });
  }

  for (const [vehicleId, list] of byVehicle) {
    const vehicle = vehicles.get(vehicleId);
    if (!vehicle) continue;
    list.sort((a, b) => a.departure.depart_s - b.departure.depart_s || a.index - b.index);
    for (let i = 1; i < list.length; i += 1) {
      const previous = list[i - 1].departure;
      const current = list[i].departure;
      if (current.depart_s - previous.depart_s < vehicle.round_trip_s - 1e-6) {
        issues.push(
          issue(
            "vehicle_round_trip_conflict",
            `departures[${list[i].index}].depart_s`,
            `车辆 ${vehicleId} 的相邻发车间隔小于 round_trip_s=${vehicle.round_trip_s}`,
          ),
        );
      }
    }
  }

  for (const [stopId, list] of byStop) {
    const stop = nodes.get(stopId);
    if (!stop) continue;
    const gap = typeof stop.boarding_gap_s === "number" ? stop.boarding_gap_s : 0;
    list.sort((a, b) => a.departure.depart_s - b.departure.depart_s || a.index - b.index);
    for (let i = 1; i < list.length; i += 1) {
      const previous = list[i - 1].departure;
      const current = list[i].departure;
      if (current.depart_s - previous.depart_s < gap - 1e-6) {
        issues.push(
          issue(
            "stop_boarding_conflict",
            `departures[${list[i].index}].depart_s`,
            `站点 ${stopId} 的相邻发车间隔小于 boarding_gap_s=${gap}`,
          ),
        );
      }
    }
  }

  return issues;
}

/* ------------------------------------------------------------------ */
/* simulate                                                            */
/* ------------------------------------------------------------------ */

interface PersonSeed {
  person_id: string;
  group_id: string;
  release_s: number;
  sequence: number;
}

interface PersonState extends PersonSeed {
  status: "unreleased" | "queued" | "walking" | "boarded";
  route_id: string | null;
  edge_ids: string[];
  edge_index: number;
  node_id: string | null;
  walk_end_s: number | null;
  boarded_at_s: number | null;
  wait_s: number;
}

interface ScheduledDeparture extends Departure {
  effective_s: number;
  order: number;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function snapDown(value: number, step: number): number {
  return Math.floor(value / step + 1e-9) * step;
}

function buildDemand(scenario: Scenario, seed: number): PersonSeed[] {
  const random = mulberry32(seed);
  const step = scenario.step_s;
  const lastRelease = Math.max(0, snapDown(scenario.horizon_s - step, step));
  const persons: PersonSeed[] = [];

  for (const group of scenario.groups) {
    for (let i = 0; i < group.count; i += 1) {
      const unit = random();
      const raw = group.release_start_s + unit * (group.release_end_s - group.release_start_s);
      const release = Math.min(lastRelease, Math.max(0, snapDown(raw, step)));
      persons.push({
        person_id: `${group.group_id}_${String(i + 1).padStart(4, "0")}`,
        group_id: group.group_id,
        release_s: release,
        sequence: i,
      });
    }
  }

  persons.sort((a, b) => a.person_id.localeCompare(b.person_id));
  return persons;
}

function assignRoutes(
  scenario: Scenario,
  plan: Plan,
  seeds: PersonSeed[],
): PersonState[] {
  const routes = new Map((scenario.routes || []).map((route) => [route.route_id, route]));
  const allocations = new Map((plan.allocations || []).map((allocation) => [allocation.group_id, allocation]));
  const byGroup = new Map<string, PersonSeed[]>();
  for (const seed of seeds) {
    if (!byGroup.has(seed.group_id)) byGroup.set(seed.group_id, []);
    byGroup.get(seed.group_id)!.push(seed);
  }

  const routeByPerson = new Map<string, ScenarioRoute | null>();
  for (const group of scenario.groups) {
    const groupSeeds = byGroup.get(group.group_id) || [];
    const allocation = allocations.get(group.group_id);
    if (!allocation || !Array.isArray(allocation.routes) || allocation.routes.length === 0) {
      for (const seed of groupSeeds) routeByPerson.set(seed.person_id, null);
      continue;
    }

    const counts = largestRemainderLike(allocation.routes, groupSeeds.length);
    let cursor = 0;
    for (const item of allocation.routes) {
      const count = counts.get(item.route_id) || 0;
      const route = routes.get(item.route_id) || null;
      for (let i = 0; i < count && cursor < groupSeeds.length; i += 1) {
        routeByPerson.set(groupSeeds[cursor].person_id, route);
        cursor += 1;
      }
    }
    while (cursor < groupSeeds.length) {
      routeByPerson.set(groupSeeds[cursor].person_id, null);
      cursor += 1;
    }
  }

  return seeds.map((seed) => {
    const route = routeByPerson.get(seed.person_id) || null;
    return {
      ...seed,
      status: "unreleased",
      route_id: route ? route.route_id : null,
      edge_ids: route ? route.edge_ids.slice() : [],
      edge_index: 0,
      node_id: null,
      walk_end_s: null,
      boarded_at_s: null,
      wait_s: 0,
    };
  });
}

/** 与 scenario_utils.largestRemainderCounts 相同口径，保留在此避免运行时循环依赖。 */
function largestRemainderLike(
  shares: Array<{ route_id: string; share: number }>,
  total: number,
): Map<string, number> {
  const result = new Map<string, number>();
  const usable = shares.filter((item) => item.share > 0);
  if (total <= 0 || usable.length === 0) {
    for (const item of shares) result.set(item.route_id, 0);
    return result;
  }

  let assigned = 0;
  const rows = usable.map((item) => {
    const raw = item.share * total;
    const base = Math.floor(raw);
    assigned += base;
    return { route_id: item.route_id, base, remainder: raw - base };
  });

  rows.sort((a, b) => {
    if (Math.abs(b.remainder - a.remainder) > 1e-9) return b.remainder - a.remainder;
    return a.route_id.localeCompare(b.route_id);
  });

  let deficit = total - assigned;
  for (const row of rows) {
    if (deficit <= 0) break;
    row.base += 1;
    deficit -= 1;
  }

  for (const item of shares) {
    const row = rows.find((candidate) => candidate.route_id === item.route_id);
    result.set(item.route_id, row ? row.base : 0);
  }
  return result;
}

function groupCountsFor(
  groupIds: string[],
  persons: PersonState[],
): Record<string, GroupCounts> {
  const result: Record<string, GroupCounts> = {};
  for (const groupId of groupIds) {
    result[groupId] = { released_count: 0, boarded_count: 0, queued_count: 0, walking_count: 0 };
  }
  for (const person of persons) {
    if (person.status === "unreleased") continue;
    const counts = result[person.group_id];
    if (!counts) continue;
    counts.released_count += 1;
    if (person.status === "boarded") counts.boarded_count += 1;
    else if (person.status === "walking") counts.walking_count += 1;
    else counts.queued_count += 1;
  }
  return result;
}

function snapshotFrame(
  scenario: Scenario,
  persons: PersonState[],
  t: number,
): TimelineFrame {
  let released = 0;
  let boarded = 0;
  let walking = 0;
  let queued = 0;
  const nodeQueues: Record<string, number> = {};
  const edgeCounts: Record<string, number> = {};
  for (const node of scenario.nodes) nodeQueues[node.node_id] = 0;
  for (const edge of scenario.edges) edgeCounts[edge.edge_id] = 0;

  for (const person of persons) {
    if (person.status === "unreleased") continue;
    released += 1;
    if (person.status === "boarded") {
      boarded += 1;
      continue;
    }
    if (person.status === "walking") {
      walking += 1;
      const edgeId = person.edge_ids[person.edge_index];
      if (edgeId) edgeCounts[edgeId] = (edgeCounts[edgeId] || 0) + 1;
      continue;
    }
    queued += 1;
    if (person.node_id) nodeQueues[person.node_id] = (nodeQueues[person.node_id] || 0) + 1;
  }

  if (released !== boarded + walking + queued) {
    throw new Error(
      `人数守恒失败：released=${released}, boarded=${boarded}, walking=${walking}, queued=${queued}`,
    );
  }

  return {
    t_s: t,
    released_count: released,
    boarded_count: boarded,
    queued_count: queued,
    walking_count: walking,
    node_queues: nodeQueues,
    edge_counts: edgeCounts,
    group_counts: groupCountsFor(scenario.groups.map((group) => group.group_id), persons),
  };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function metricsFor(
  persons: PersonState[],
  groups: Map<string, DemandGroup>,
  groupId: string | null,
): Metrics {
  const subset = groupId ? persons.filter((person) => person.group_id === groupId) : persons;
  const released = subset.filter((person) => person.status !== "unreleased");
  const boarded = subset.filter((person) => person.status === "boarded");
  const waitTotal = released.reduce((sum, person) => sum + person.wait_s, 0);
  const boardedWaits = boarded
    .map((person) => person.wait_s)
    .sort((a, b) => a - b);

  let p95: number | null = null;
  if (boardedWaits.length > 0) {
    const rank = Math.ceil(0.95 * boardedWaits.length);
    p95 = boardedWaits[Math.max(0, rank - 1)];
  }

  let missedDeadline = 0;
  for (const person of subset) {
    const group = groups.get(person.group_id);
    if (!group || group.board_deadline_s === null) continue;
    if (person.boarded_at_s === null || person.boarded_at_s > group.board_deadline_s) {
      missedDeadline += 1;
    }
  }

  let clearance: number | null = null;
  if (subset.length === 0) {
    clearance = 0;
  } else if (released.length === subset.length && boarded.length === subset.length) {
    clearance = boarded.reduce((latest, person) => Math.max(latest, person.boarded_at_s ?? 0), 0);
  }

  return {
    released_count: released.length,
    boarded_count: boarded.length,
    remaining_count: released.length - boarded.length,
    mean_queue_wait_all_released_s: released.length === 0 ? null : round3(waitTotal / released.length),
    p95_queue_wait_boarded_s: p95,
    missed_deadline_count: missedDeadline,
    clearance_time_s: clearance,
  };
}

function invalidResult(
  scenario: Scenario,
  plan: Plan,
  seed: number,
  violations: ValidationIssue[],
): SimulationResult {
  return {
    schema_version: "1.0",
    engine_version: REFERENCE_ENGINE_VERSION,
    scenario_id: scenario && typeof scenario.scenario_id === "string" ? scenario.scenario_id : "",
    scenario_revision:
      scenario && Number.isInteger(scenario.revision) ? scenario.revision : 0,
    plan_id: plan && typeof plan.plan_id === "string" ? plan.plan_id : "",
    seed,
    status: "invalid",
    violations,
    metrics: null,
    group_metrics: [],
    timeline: [],
    departures_log: [],
  };
}

export function simulate(scenario: Scenario, plan: Plan, seed: number): SimulationResult {
  if (!isNonNegativeInteger(seed)) {
    return invalidResult(scenario, plan, seed, [
      issue("invalid_seed", "seed", "seed 必须为非负整数"),
    ]);
  }

  const scenarioIssues = validateScenario(scenario);
  const scenarioErrors = scenarioIssues.filter((item) => item.severity === "error");
  if (scenarioErrors.length > 0) {
    return invalidResult(scenario, plan, seed, scenarioIssues);
  }

  const planIssues = validatePlan(scenario, plan);
  const planErrors = planIssues.filter((item) => item.severity === "error");
  if (planErrors.length > 0) {
    return invalidResult(scenario, plan, seed, planIssues);
  }

  const warnings = [...scenarioIssues, ...planIssues].filter((item) => item.severity === "warning");
  const groups = new Map(scenario.groups.map((group) => [group.group_id, group]));
  const edges = edgeMapOf(scenario);
  const nodes = new Map(scenario.nodes.map((node) => [node.node_id, node]));
  const vehicles = new Map(scenario.fleet.map((vehicle) => [vehicle.vehicle_id, vehicle]));
  const source = scenario.nodes.find((node) => node.kind === "source");
  const sourceId = source ? source.node_id : "";

  const persons = assignRoutes(scenario, plan, buildDemand(scenario, seed));
  const queues = new Map<string, PersonState[]>();
  for (const node of scenario.nodes) queues.set(node.node_id, []);
  const credits = new Map<string, number>();
  for (const edge of scenario.edges) credits.set(edge.edge_id, 0);

  const releases = new Map<number, PersonState[]>();
  for (const person of persons) {
    if (!releases.has(person.release_s)) releases.set(person.release_s, []);
    releases.get(person.release_s)!.push(person);
  }
  for (const list of releases.values()) {
    list.sort((a, b) => a.person_id.localeCompare(b.person_id));
  }

  const scheduled: ScheduledDeparture[] = (plan.departures || [])
    .map((departure, index) => ({
      ...departure,
      effective_s: Math.ceil(departure.depart_s / scenario.step_s) * scenario.step_s,
      order: index,
    }))
    .sort(
      (a, b) =>
        a.effective_s - b.effective_s ||
        a.depart_s - b.depart_s ||
        a.vehicle_id.localeCompare(b.vehicle_id) ||
        a.stop_id.localeCompare(b.stop_id) ||
        a.order - b.order,
    );

  const timeline: TimelineFrame[] = [];
  const departuresLog: DepartureLog[] = [];
  let departureIndex = 0;

  for (let t = 0; t < scenario.horizon_s; t += scenario.step_s) {
    // ① 完成步行，加入下一节点队列
    for (const person of persons) {
      if (person.status !== "walking" || person.walk_end_s === null) continue;
      if (person.walk_end_s > t) continue;
      person.edge_index += 1;
      const completedEdge = edges.get(person.edge_ids[person.edge_index - 1]);
      const nodeId = completedEdge ? completedEdge.to : sourceId;
      person.status = "queued";
      person.node_id = nodeId;
      person.walk_end_s = null;
      const queue = queues.get(nodeId);
      if (queue) queue.push(person);
    }

    // ② 释放新旅客
    const releasedNow = releases.get(t);
    if (releasedNow) {
      for (const person of releasedNow) {
        const firstEdge = person.edge_ids.length > 0 ? edges.get(person.edge_ids[0]) : undefined;
        const nodeId = firstEdge ? firstEdge.from : sourceId;
        person.status = "queued";
        person.node_id = nodeId;
        const queue = queues.get(nodeId);
        if (queue) queue.push(person);
      }
    }

    // ③ 按计划发车并 FIFO 登车
    while (departureIndex < scheduled.length && scheduled[departureIndex].effective_s === t) {
      const departure = scheduled[departureIndex];
      const vehicle = vehicles.get(departure.vehicle_id);
      const queue = queues.get(departure.stop_id) || [];
      const capacity = vehicle ? Math.max(0, Math.floor(vehicle.capacity)) : 0;
      const boardingCount = Math.min(queue.length, capacity);
      const boarding = queue.splice(0, boardingCount);
      for (const person of boarding) {
        person.status = "boarded";
        person.boarded_at_s = t;
        person.node_id = null;
        person.walk_end_s = null;
      }
      departuresLog.push({
        vehicle_id: departure.vehicle_id,
        stop_id: departure.stop_id,
        depart_s: t,
        boarded_count: boarding.length,
      });
      departureIndex += 1;
    }

    // ④ 按边容量放行进入下一段步行
    for (const edge of scenario.edges) {
      const quota = (edge.capacity_per_min * scenario.step_s) / 60;
      let credit = (credits.get(edge.edge_id) || 0) + quota;
      const slots = Math.floor(credit + 1e-9);
      credit -= slots;
      credits.set(edge.edge_id, credit);
      if (slots <= 0) continue;

      const queue = queues.get(edge.from);
      if (!queue || queue.length === 0) continue;

      const admitted: PersonState[] = [];
      for (let i = 0; i < queue.length && admitted.length < slots; ) {
        const person = queue[i];
        if (person.edge_ids[person.edge_index] === edge.edge_id) {
          queue.splice(i, 1);
          admitted.push(person);
        } else {
          i += 1;
        }
      }

      for (const person of admitted) {
        const group = groups.get(person.group_id);
        const factor = group ? group.walk_time_factor : 1;
        const duration = Math.max(
          scenario.step_s,
          Math.ceil((edge.travel_s * factor) / scenario.step_s) * scenario.step_s,
        );
        person.status = "walking";
        person.node_id = null;
        person.walk_end_s = t + duration;
      }
    }

    // ⑤ 队列等待按 [t, t+step) 累计；已经登车或进入步行的人不再计入
    for (const person of persons) {
      if (person.status === "queued") person.wait_s += scenario.step_s;
    }

    timeline.push(snapshotFrame(scenario, persons, t));
  }

  // 终帧与汇总结果使用同一状态，避免窗口终点额外累加一帧等待
  timeline.push(snapshotFrame(scenario, persons, scenario.horizon_s));

  const metrics = metricsFor(persons, groups, null);
  const groupMetrics: GroupMetrics[] = scenario.groups.map((group) => ({
    group_id: group.group_id,
    ...metricsFor(persons, groups, group.group_id),
  }));

  // 对节点集合做一次存在性断言，避免未知字段或脏数据静默影响计算
  for (const person of persons) {
    if (person.node_id !== null && !nodes.has(person.node_id)) {
      throw new Error(`旅客 ${person.person_id} 位于未知节点 ${person.node_id}`);
    }
  }

  return {
    schema_version: "1.0",
    engine_version: REFERENCE_ENGINE_VERSION,
    scenario_id: scenario.scenario_id,
    scenario_revision: scenario.revision,
    plan_id: plan.plan_id,
    seed,
    status: "valid",
    violations: warnings,
    metrics,
    group_metrics: groupMetrics,
    timeline,
    departures_log: departuresLog,
  };
}
