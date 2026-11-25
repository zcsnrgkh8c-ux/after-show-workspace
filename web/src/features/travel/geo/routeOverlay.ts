/**
 * 路线覆盖物渲染：每次 render 先清理自建覆盖物再重画；
 * 选中路线加粗高亮不透明，其余淡化；polyline 为 null 的路线跳过绘制；
 * 起终点 Marker 取自真实折线端点；不修改地图 logo / 审图号。
 */
import type { AMapNamespace } from "../vendor/types";

/** 只要求路线具备 ID 与折线；步行/公交结果均可传入 */
export interface DrawableRoute {
  route_id: string;
  polyline: Array<[number, number]> | null;
}

export class RouteOverlay {
  private map: AMapNamespace["Map"];
  private ns: AMapNamespace | null;
  private shapes: unknown[] = [];
  private destroyed = false;

  constructor(map: AMapNamespace["Map"], ns?: AMapNamespace) {
    this.map = map;
    this.ns = ns ?? (typeof window !== "undefined" ? window.AMap ?? null : null);
  }

  /** 移除全部自建覆盖物 */
  clear(): void {
    for (const shape of this.shapes) {
      try {
        this.map.remove(shape);
      } catch {
        // 地图实例已失效时静默跳过
      }
    }
    this.shapes = [];
  }

  /**
   * 渲染路线：先 clear 再画每条 polyline + 起终点 Marker，最后 fitView 一次。
   * selectedRouteId 命中的路线宽 6 不透明高亮，其余宽 3 低透明淡化。
   */
  render(routes: DrawableRoute[], selectedRouteId: string | null): void {
    if (this.destroyed) return;
    this.clear();
    const AMap = this.ns;
    if (!AMap) return;

    let firstPoint: [number, number] | null = null;
    let lastPoint: [number, number] | null = null;

    for (const route of routes) {
      if (!Array.isArray(route.polyline) || route.polyline.length < 2) continue;
      const selected = route.route_id === selectedRouteId;
      try {
        const polyline = new AMap.Polyline({
          path: route.polyline,
          strokeColor: selected ? "#2563eb" : "#64748b",
          strokeWeight: selected ? 6 : 3,
          strokeOpacity: selected ? 0.95 : 0.35,
          showDir: selected,
          bubble: true,
        });
        this.map.add(polyline);
        this.shapes.push(polyline);
      } catch {
        continue;
      }
      if (!firstPoint) firstPoint = route.polyline[0];
      lastPoint = route.polyline[route.polyline.length - 1];
    }

    // 起终点 Marker（取自真实折线端点；无有效折线时不画）
    try {
      if (firstPoint) {
        const startMarker = new AMap.Marker({
          position: firstPoint,
          title: "起点",
        });
        this.map.add(startMarker);
        this.shapes.push(startMarker);
      }
      if (lastPoint) {
        const endMarker = new AMap.Marker({
          position: lastPoint,
          title: "终点",
        });
        this.map.add(endMarker);
        this.shapes.push(endMarker);
      }
    } catch {
      // Marker 失败不影响路线展示
    }

    if (this.shapes.length > 0) {
      try {
        this.map.setFitView(this.shapes);
      } catch {
        // 视口自适应失败时保持当前视野
      }
    }
  }

  /** 清理并销毁；销毁后 render 不再生效 */
  destroy(): void {
    this.clear();
    this.destroyed = true;
    this.ns = null;
  }
}
