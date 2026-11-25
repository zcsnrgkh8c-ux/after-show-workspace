/**
 * 定位/跳转后的视野决策（窗口4新增，纯函数可单测）：
 * 复现问题——定位点落在高德国内底图覆盖范围外（境外/代理 IP）时，
 * `setZoomAndCenter` 会把视野移到无瓦片区域，地图看起来“无法显示”。
 * 因此移动视野前先校验覆盖范围与精度：
 * - 境外坐标：不移动视野，提示保持当前视野；
 * - 城市级/IP 级定位：用较小缩放（11/13），避免把城市级点放大到街道级；
 * - 只有浏览器精确定位（精度足够）才用 15 级。
 * 不修改定位算法与坐标转换，只决定“是否移动、移动到哪里”。
 */
import type { LngLat } from "./config";
import type { UserLocation } from "./locate";

/** 高德国内底图覆盖范围（保守 bbox，与 GCJ-02 转换的境外判定一致） */
export function isInChinaCoverage([lng, lat]: LngLat): boolean {
  return lng >= 72.004 && lng <= 137.8347 && lat >= 0.8293 && lat <= 55.8271;
}

/** 按定位精度选择缩放：城市级/IP（>5km 或无精度）11，1~5km 13，精确定位 15 */
export function zoomForLocation(loc: Pick<UserLocation, "precision" | "accuracyM">): number {
  if (loc.precision === "city") return 11;
  const acc = loc.accuracyM;
  if (acc === undefined || !Number.isFinite(acc) || acc > 5000) return 11;
  if (acc > 1000) return 13;
  return 15;
}

export type LocateViewPlan = { move: true; zoom: number } | { move: false; reason: string };

/** 综合判定：是否移动视野、用哪一级缩放 */
export function locateViewPlan(loc: UserLocation): LocateViewPlan {
  if (!isInChinaCoverage(loc.position)) {
    return {
      move: false,
      reason: "请使用国内IP访问",
    };
  }
  return { move: true, zoom: zoomForLocation(loc) };
}
