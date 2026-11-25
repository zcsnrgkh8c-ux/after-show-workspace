import {
  DemandGroup,
  Scenario,
  ScenarioEdge,
  ScenarioRoute,
  ScenarioNode,
} from "../../shared/types";

export function nodeById(scenario: Scenario, nodeId: string): ScenarioNode | undefined {
  return scenario.nodes.find((node) => node.node_id === nodeId);
}

export function edgeById(scenario: Scenario, edgeId: string): ScenarioEdge | undefined {
  return scenario.edges.find((edge) => edge.edge_id === edgeId);
}

export function routeById(scenario: Scenario, routeId: string): ScenarioRoute | undefined {
  return scenario.routes.find((route) => route.route_id === routeId);
}

export function groupById(scenario: Scenario, groupId: string): DemandGroup | undefined {
  return scenario.groups.find((group) => group.group_id === groupId);
}

export function routeEdges(scenario: Scenario, route: ScenarioRoute): ScenarioEdge[] {
  return route.edge_ids
    .map((edgeId) => edgeById(scenario, edgeId))
    .filter((edge): edge is ScenarioEdge => Boolean(edge));
}

/** 路线是否含关闭边；缺失边也按不可用处理。 */
export function isRouteClosed(scenario: Scenario, route: ScenarioRoute): boolean {
  if (route.edge_ids.length === 0) return true;
  const edges = routeEdges(scenario, route);
  if (edges.length !== route.edge_ids.length) return true;
  return edges.some((edge) => edge.closed);
}

/** 路线是否全程无台阶。 */
export function isRouteStepFree(scenario: Scenario, route: ScenarioRoute): boolean {
  const edges = routeEdges(scenario, route);
  if (edges.length !== route.edge_ids.length || edges.length === 0) return false;
  return edges.every((edge) => edge.step_free);
}

export function routeTravelSeconds(
  scenario: Scenario,
  route: ScenarioRoute,
  walkTimeFactor: number,
): number {
  const total = routeEdges(scenario, route).reduce((sum, edge) => sum + edge.travel_s, 0);
  return total * walkTimeFactor;
}

/** 按群组约束筛选当前场景中可分配的路线（不修改场景）。 */
export function legalRoutesForGroup(scenario: Scenario, groupId: string): ScenarioRoute[] {
  const group = groupById(scenario, groupId);
  if (!group) return [];
  return scenario.routes.filter((route) => {
    if (isRouteClosed(scenario, route)) return false;
    if (group.needs_step_free && !isRouteStepFree(scenario, route)) return false;
    return true;
  });
}

export function sourceNodeId(scenario: Scenario): string {
  const source = scenario.nodes.find((node) => node.kind === "source");
  return source ? source.node_id : "";
}

export function stopNodeIds(scenario: Scenario): string[] {
  return scenario.nodes.filter((node) => node.kind === "stop").map((node) => node.node_id);
}

export function boardingGapSeconds(scenario: Scenario, stopId: string): number {
  const stop = nodeById(scenario, stopId);
  return typeof stop?.boarding_gap_s === "number" ? stop.boarding_gap_s : 0;
}

/** 最大余数法：同余数按 route_id 升序，不随机增减总人数。 */
export function largestRemainderCounts(
  total: number,
  shares: Array<{ route_id: string; share: number }>,
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
