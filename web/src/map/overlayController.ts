/**
 * 地图覆盖物控制器（与 React 解耦，可用假 AMap 单测）：
 * - rebuildBase：节点/通道覆盖物的创建与销毁（仅在场景或地理映射变化时调用）；
 * - applyFrame：只更新标签文字（回放每帧调用，绝不增删覆盖物）；
 * - rebuildRoutes：方案路线覆盖物的创建与销毁（方案/选中组变化时调用）；
 * - dispose：清理全部覆盖物（组件卸载或地图销毁前调用）。
 */
import type { Plan, Scenario, ScenarioEdge, ScenarioNode, SimulationResult, TimelineFrame } from "../contract/types";
import type { GeoMapping, LngLat } from "./config";
import type { AmapInfoWindowInstance, AmapMapInstance, AmapNamespace, AmapOverlayInstance } from "./types";
import { nodeDisplayName } from "../labels";

const KIND_LABELS: Record<ScenarioNode["kind"], string> = {
  source: "场馆",
  exit: "出口",
  stop: "接驳点",
};

const TEXT_STYLE: Record<string, string> = {
  "background-color": "rgba(255,255,255,.94)",
  border: "1px solid #cbd5e1",
  "border-radius": "4px",
  padding: "1px 5px",
  "font-size": "11px",
  color: "#334155",
};

function edgeStroke(e: ScenarioEdge): { color: string; style: "solid" | "dashed"; dash?: number[] } {
  if (e.closed) return { color: "#b91c1c", style: "dashed", dash: [8, 6] };
  if (!e.step_free) return { color: "#b45309", style: "dashed", dash: [2, 6] };
  return { color: "#64748b", style: "solid" };
}

/** 通道文字标签：默认不贴容量/编号；关闭与台阶用短文字 + 线型双重编码，避免出口附近互相遮挡 */
function edgeText(e: ScenarioEdge, walking: number): string {
  if (e.closed) return "✕已关闭";
  if (!e.step_free) return "台阶";
  return walking > 0 ? `${walking}人步行` : "";
}

function nodeLabel(node: ScenarioNode, queue: number, boarded: number | null): string {
  return (
    nodeDisplayName(node) +
    (queue > 0 ? `｜排队 ${queue}` : "") +
    (boarded !== null ? `｜累计登车 ${boarded}` : "")
  );
}

/** 站点在 t 时刻的累计登车（来自真实 departures_log，非编造） */
function boardedAtStop(result: SimulationResult | null, stopId: string, t: number | null): number | null {
  if (!result || t === null) return null;
  return result.departures_log
    .filter((d) => d.stop_id === stopId && d.depart_s <= t)
    .reduce((s, d) => s + d.boarded_count, 0);
}

export class MapOverlayController {
  /** 节点点击回调（由 React 层注入，用于信息卡联动） */
  onNodeClick: ((nodeId: string) => void) | null = null;

  private readonly nodeMarkers = new Map<string, AmapOverlayInstance>();
  private readonly edgeLines = new Map<string, AmapOverlayInstance>();
  private readonly edgeTexts = new Map<string, AmapOverlayInstance>();
  private routeOverlays: AmapOverlayInstance[] = [];
  private readonly infoWindow: AmapInfoWindowInstance;
  private disposed = false;

  constructor(
    private readonly AMap: AmapNamespace,
    private readonly map: AmapMapInstance
  ) {
    this.infoWindow = new AMap.InfoWindow({ offset: new AMap.Pixel(0, -30) });
  }

  /** 重建节点与通道覆盖物：先全部移除旧的，再按当前场景创建（可重复调用，不残留） */
  rebuildBase(scenario: Scenario, geo: GeoMapping): void {
    if (this.disposed) return;
    const { AMap, map } = this;

    for (const m of this.nodeMarkers.values()) map.remove(m);
    this.nodeMarkers.clear();
    for (const l of this.edgeLines.values()) map.remove(l);
    this.edgeLines.clear();
    for (const t of this.edgeTexts.values()) map.remove(t);
    this.edgeTexts.clear();

    for (const node of scenario.nodes) {
      const pos = geo.nodes[node.node_id];
      if (!pos) continue;
      const marker = new AMap.Marker({
        position: pos,
        anchor: "center",
        content: `<div class="amap-node amap-node-${node.kind}">${node.node_id}</div>`,
        extData: { node_id: node.node_id },
        zIndex: node.kind === "stop" ? 12 : 11,
        title: `${KIND_LABELS[node.kind]} ${node.node_id}`,
      });
      marker.setLabel?.({ content: `<div class="amap-node-label">${nodeLabel(node, 0, null)}</div>`, direction: "top" });
      marker.on("click", () => this.onNodeClick?.(node.node_id));
      map.add(marker);
      this.nodeMarkers.set(node.node_id, marker);
    }

    for (const edge of scenario.edges) {
      const from = geo.nodes[edge.from];
      const to = geo.nodes[edge.to];
      if (!from || !to) continue;
      const geometry = geo.edges?.[edge.edge_id];
      const path: LngLat[] = geometry ?? [from, to];
      const stroke = edgeStroke(edge);
      const line = new AMap.Polyline({
        path,
        strokeColor: stroke.color,
        strokeWeight: Math.min(8, Math.max(2, edge.capacity_per_min / 10)),
        strokeOpacity: edge.closed ? 0.7 : 0.85,
        strokeStyle: stroke.style,
        strokeDashArray: stroke.dash,
        lineJoin: "round",
        zIndex: 5,
        extData: { edge_id: edge.edge_id },
      });
      map.add(line);
      this.edgeLines.set(edge.edge_id, line);
      const text = new AMap.Text({
        position: path[Math.floor(path.length / 2)],
        anchor: "center",
        zIndex: 6,
        style: TEXT_STYLE,
        text: edgeText(edge, 0),
      });
      map.add(text);
      this.edgeTexts.set(edge.edge_id, text);
    }
  }

  /** 帧标签更新：只改文字，不增删任何覆盖物 */
  applyFrame(scenario: Scenario, geo: GeoMapping, frame: TimelineFrame | null, result: SimulationResult | null): void {
    if (this.disposed) return;
    const t = frame?.t_s ?? null;
    for (const node of scenario.nodes) {
      const marker = this.nodeMarkers.get(node.node_id);
      if (!marker) continue;
      const queue = frame?.node_queues[node.node_id] ?? 0;
      const boarded = node.kind === "stop" ? boardedAtStop(result, node.node_id, t) : null;
      marker.setLabel?.({ content: `<div class="amap-node-label">${nodeLabel(node, queue, boarded)}</div>`, direction: "top" });
    }
    for (const edge of scenario.edges) {
      const text = this.edgeTexts.get(edge.edge_id);
      if (!text) continue;
      const walking = frame?.edge_counts[edge.edge_id] ?? 0;
      text.setText?.(edgeText(edge, walking));
    }
  }

  /** 重绘方案路线覆盖物：先清旧再建新；selectedRouteId 优先（选中路线加粗），否则按 selectedGroupId 命中加粗 */
  rebuildRoutes(scenario: Scenario, geo: GeoMapping, plan: Plan | null, selectedGroupId: string | null, selectedRouteId?: string | null): void {
    if (this.disposed) return;
    const { AMap, map } = this;
    for (const o of this.routeOverlays) map.remove(o);
    this.routeOverlays = [];
    if (!plan) return;

    const usage = new Map<string, { group_id: string; share: number }[]>();
    for (const a of plan.allocations) {
      for (const r of a.routes) {
        if (!usage.has(r.route_id)) usage.set(r.route_id, []);
        usage.get(r.route_id)!.push({ group_id: a.group_id, share: r.share });
      }
    }

    for (const [routeId, users] of usage) {
      const route = scenario.routes.find((r) => r.route_id === routeId);
      if (!route) continue;
      const path: LngLat[] = [];
      for (const eid of route.edge_ids) {
        const e = scenario.edges.find((x) => x.edge_id === eid);
        if (!e) continue;
        const seg: LngLat[] =
          geo.edges?.[eid] ?? [geo.nodes[e.from], geo.nodes[e.to]].filter((p): p is LngLat => p !== undefined);
        for (const p of seg) {
          const last = path[path.length - 1];
          if (!last || last[0] !== p[0] || last[1] !== p[1]) path.push(p);
        }
      }
      if (path.length < 2) continue;

      const focus = selectedRouteId ?? null;
      const emphasized =
        focus !== null
          ? routeId === focus
          : selectedGroupId !== null && users.some((u) => u.group_id === selectedGroupId);
      const line = new AMap.Polyline({
        path,
        strokeColor: emphasized ? "#315CE7" : "#94a3b8",
        strokeWeight: emphasized ? 7 : 3,
        strokeOpacity: emphasized ? 0.95 : 0.45,
        strokeStyle: "solid",
        lineJoin: "round",
        showDir: true,
        zIndex: emphasized ? 9 : 8,
        extData: { route_id: routeId },
      });
      map.add(line);
      this.routeOverlays.push(line);

      // 份额短标签只在用户点选单条路线时标注一处；默认组视角不在图上铺全部份额（比例由路线卡承载）
      if (focus !== null && routeId === focus) {
        const mine = users.find((u) => u.group_id === selectedGroupId);
        const share = mine ? `（本组 ${(mine.share * 100).toFixed(0)}%）` : "";
        const text = new AMap.Text({
          position: path[Math.floor(path.length / 2)],
          anchor: "bottom-center",
          zIndex: 10,
          style: TEXT_STYLE,
          text: `路线 ${routeId}${share}`,
        });
        map.add(text);
        this.routeOverlays.push(text);
      }
    }
  }

  /** 节点信息窗（内容来自当前场景与聚合帧） */
  showNodeInfo(scenario: Scenario, geo: GeoMapping, frame: TimelineFrame | null, nodeId: string): void {
    if (this.disposed) return;
    const node = scenario.nodes.find((n) => n.node_id === nodeId);
    const pos = geo.nodes[nodeId];
    if (!node || !pos) return;
    const queue = frame?.node_queues[nodeId] ?? 0;
    this.infoWindow.setContent(
      `<div style="font-size:12px;line-height:1.6"><b>${KIND_LABELS[node.kind]} ${node.node_id}</b><br/>` +
        `当前排队：${queue} 人（聚合模拟数据）` +
        (node.kind === "stop" && node.boarding_gap_s !== undefined ? `<br/>站点发车间隔：${node.boarding_gap_s}s` : "") +
        `</div>`
    );
    this.infoWindow.open(this.map, pos);
  }

  /** 清理全部覆盖物（配合外部 map.destroy() 使用） */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      for (const m of this.nodeMarkers.values()) this.map.remove(m);
      for (const l of this.edgeLines.values()) this.map.remove(l);
      for (const t of this.edgeTexts.values()) this.map.remove(t);
      for (const o of this.routeOverlays) this.map.remove(o);
      this.infoWindow.close();
    } catch {
      /* 清理失败不阻塞卸载 */
    }
    this.nodeMarkers.clear();
    this.edgeLines.clear();
    this.edgeTexts.clear();
    this.routeOverlays = [];
    this.onNodeClick = null;
  }
}
