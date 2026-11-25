/**
 * 真实步行动线的纯逻辑（可单测）：
 * - plannableEdges：挑出可规划通道（未关闭、两端有坐标）；
 * - mergeRealRoutes：只把成功通道的真实折线写入 geo.edges，失败通道保留原样；
 * - buildRealRouteNotes：把成功/失败结果写成如实的中文说明。
 */
import type { Scenario, ScenarioEdge } from "../contract/types";
import type { GeoMapping, LngLat } from "./config";

export interface RealEdgeRoute {
  edge_id: string;
  distance_m: number | null;
  duration_s: number | null;
  polyline: LngLat[];
}

export interface RealEdgeFailure {
  edge_id: string;
  reason: string;
}

/** 可规划通道：未关闭且起终点都有坐标（已关闭通道不发起请求） */
export function plannableEdges(scenario: Scenario, geo: GeoMapping): ScenarioEdge[] {
  return scenario.edges.filter(
    (e) => !e.closed && geo.nodes[e.from] !== undefined && geo.nodes[e.to] !== undefined
  );
}

/** 合并真实折线：只覆盖成功通道；原 geo 不被修改 */
export function mergeRealRoutes(geo: GeoMapping, routes: RealEdgeRoute[]): GeoMapping {
  if (routes.length === 0) return geo;
  const edges: Record<string, LngLat[]> = { ...(geo.edges ?? {}) };
  for (const r of routes) {
    if (r.polyline.length >= 2) edges[r.edge_id] = r.polyline;
  }
  return { ...geo, edges };
}

function edgeEnds(edge: ScenarioEdge): string {
  return `${edge.from}→${edge.to}`;
}

function formatDistance(distance: number | null): string {
  if (distance === null) return "距离未返回";
  return distance >= 1000 ? `${(distance / 1000).toFixed(1)} km` : `${Math.round(distance)} 米`;
}

function formatDuration(duration: number | null): string {
  if (duration === null) return "时间未返回";
  if (duration < 60) return `约 ${Math.round(duration)} 秒`;
  return `约 ${Math.round(duration / 60)} 分钟`;
}

/**
 * 结果说明：首行固定口径，其后逐条列出真实路线/失败原因。
 * 不把失败通道写成成功，也不把模拟客流与高德时间混为一谈。
 */
export function buildRealRouteNotes(
  edges: ScenarioEdge[],
  routes: RealEdgeRoute[],
  failures: RealEdgeFailure[]
): string[] {
  const byId = new Map(edges.map((e) => [e.edge_id, e]));
  const total = routes.length + failures.length;
  const notes: string[] = [
    `真实步行动线：${routes.length}/${total} 条来自高德步行规划。路线走向、距离与时间为高德返回；客流指标仍为模拟，不进入推演。`,
  ];
  for (const r of routes) {
    const edge = byId.get(r.edge_id);
    notes.push(
      `${r.edge_id}（${edge ? edgeEnds(edge) : "—"}）：高德步行 ${formatDistance(r.distance_m)} / ${formatDuration(r.duration_s)}`
    );
  }
  for (const f of failures) {
    const edge = byId.get(f.edge_id);
    notes.push(`${f.edge_id}（${edge ? edgeEnds(edge) : "—"}）：未取到真实路线（${f.reason}），保留模拟示意线`);
  }
  return notes;
}
