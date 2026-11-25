/**
 * 定位与地点跳转（仅展示层：结果只用于移动地图视野与放置标记，绝不进入计算模型）。
 *
 * 为什么必须做 IP 定位降级：国内 Chrome/Edge 的浏览器定位依赖境外定位服务，
 * 常年表现为超时或无结果；只挂 navigator.geolocation 必然"定位不可用"。
 * 因此定位分两级：
 *   1) 浏览器精确定位（有 GPS/WiFi 定位能力时最准）；
 *   2) 高德 IP 定位（CitySearch）到城市级 —— 走 JS SDK 服务代理，JS API key 合法可用。
 * 两级都失败时如实说明原因，并引导用户用手动输入所在地兜底，绝不伪造位置。
 *
 * 结构：纯逻辑（locateByGeolocation / locateWithFallback / locateByKeyword）依赖注入端口，可单测；
 * AMap 适配（createGeolocationPort / createCitySearchPort / createPlaceSearchPort）只做回调包装与错误归因。
 */
import type { LngLat } from "./config";
import type { AmapNamespace } from "./types";

export interface UserLocation {
  position: LngLat;
  /** geolocation = 定位获得（含 IP 降级）；manual = 关键词搜索 */
  source: "geolocation" | "manual";
  /** browser = 浏览器精确定位；city = IP 降级到城市级；manual = 手动输入 */
  precision: "browser" | "city" | "manual";
  /** 展示名：定位为「当前定位」/城市名，手动输入为匹配到的地点名 */
  label: string;
  /** 定位精度（米）；仅浏览器精确定位可能有 */
  accuracyM?: number;
}

export type LocateResult = { ok: true; location: UserLocation } | { ok: false; reason: string };

export interface GeolocationPort {
  getCurrentPosition(): Promise<{ position: LngLat; accuracyM?: number }>;
}

export interface CitySearchPort {
  /** IP 定位到城市；无法确定城市时返回 null */
  getLocalCity(): Promise<{ city: string; position: LngLat } | null>;
}

export interface PlaceSearchPort {
  /** 关键词首个命中；无命中返回 null */
  searchFirst(keyword: string): Promise<{ position: LngLat; name: string } | null>;
}

/* ---------- 纯逻辑（注入端口，可单测） ---------- */

/**
 * 查询浏览器定位权限（navigator.permissions）。
 * denied 时必须先引导用户恢复权限——此状态下任何重试都不会弹授权框，
 * 表现为“定位永远失败”，是最常见的误判来源。
 */
export async function getGeolocationPermission(): Promise<"granted" | "denied" | "prompt" | "unknown"> {
  if (typeof navigator === "undefined" || !navigator.permissions?.query) return "unknown";
  try {
    const s = await navigator.permissions.query({ name: "geolocation" as PermissionName });
    return s.state;
  } catch {
    return "unknown";
  }
}

export async function locateByGeolocation(port: GeolocationPort): Promise<LocateResult> {
  try {
    const r = await port.getCurrentPosition();
    return {
      ok: true,
      location: {
        position: r.position,
        source: "geolocation",
        precision: "browser",
        label: "当前定位",
        accuracyM: r.accuracyM,
      },
    };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 定位主入口：三层兜底
 *   1) 浏览器精确定位；
 *   2) 高德 IP 优先定位（GeoLocationFirst:false，绕过国内浏览器定位超时）；
 *   3) CitySearch 城市级定位。
 * 任一层成功即返回，并如实标注精度层级；全部失败才报错。
 */
export async function locateWithFallback(
  geoPort: GeolocationPort,
  cityPort: CitySearchPort,
  ipPort?: GeolocationPort
): Promise<LocateResult> {
  const geo = await locateByGeolocation(geoPort);
  if (geo.ok) return geo;

  // 第二层：IP 优先定位（不走浏览器 geolocation，国内网络下成功率高）
  if (ipPort) {
    const ip = await locateByGeolocation(ipPort);
    if (ip.ok) {
      return {
        ok: true,
        location: { ...ip.location, precision: "city", label: "当前位置（IP 定位）" },
      };
    }
  }

  let city: { city: string; position: LngLat } | null;
  try {
    city = await cityPort.getLocalCity();
  } catch (e) {
    return {
      ok: false,
      reason: `${geo.reason}；IP 定位也不可用（${e instanceof Error ? e.message : "未知原因"}），请输入所在地关键词跳转`,
    };
  }
  if (!city) {
    return { ok: false, reason: `${geo.reason}；IP 定位未返回可用城市范围，请输入所在地关键词跳转` };
  }

  return {
    ok: true,
    location: {
      position: city.position,
      source: "geolocation",
      precision: "city",
      label: city.city,
    },
  };
}

export async function locateByKeyword(port: PlaceSearchPort, keyword: string): Promise<LocateResult> {
  const kw = keyword.trim();
  if (kw === "") return { ok: false, reason: "请输入地点关键词后再跳转" };
  let hit: { position: LngLat; name: string } | null;
  try {
    hit = await port.searchFirst(kw);
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
  if (!hit) return { ok: false, reason: `未找到与“${kw}”匹配的地点，可更换关键词重试` };
  return {
    ok: true,
    location: { position: hit.position, source: "manual", precision: "manual", label: hit.name },
  };
}

/** “用我的位置找附近出口”允许的最大定位误差：超过此值必须先确认具体地点 */
export const NEARBY_SEARCH_MAX_ACCURACY_M = 1000;

/**
 * 能否用当前定位作为“找我附近的出口”的检索圆心。
 * 城市级/IP 粗定位（实测误差可达 ±50 公里）与精度未知/过大的定位一律拒绝，
 * 要求用户先输入并确认具体地点，避免以错误的圆心检索出口。
 * 手动输入/选择的具体地点视为用户已确认，允许检索。
 */
export function nearbySearchEligibility(
  loc: UserLocation | null
): { ok: true } | { ok: false; reason: string } {
  if (loc === null) {
    return { ok: false, reason: "请先点“定位到我的位置”，或输入具体地点后跳转" };
  }
  if (loc.source === "manual") return { ok: true };
  if (loc.precision !== "browser") {
    return {
      ok: false,
      reason: "当前为城市级/IP 粗定位（误差可达数十公里），请先输入并确认具体地点，再找附近出口",
    };
  }
  if (loc.accuracyM === undefined || !Number.isFinite(loc.accuracyM)) {
    return { ok: false, reason: "当前定位未返回精度，无法确认附近出口；请先输入并确认具体地点" };
  }
  if (loc.accuracyM > NEARBY_SEARCH_MAX_ACCURACY_M) {
    return {
      ok: false,
      reason: `当前定位误差约 ±${Math.round(loc.accuracyM)} 米，范围过大；请先输入并确认具体地点`,
    };
  }
  return { ok: true };
}

/** 结果说明文案（精度如实展示，不夸大；IP 降级明确告知用户） */
export function describeLocation(loc: UserLocation): string {
  if (loc.precision === "browser") {
    const acc = loc.accuracyM !== undefined ? `（精度约 ±${Math.round(loc.accuracyM)}m）` : "";
    return `已定位到当前位置${acc}`;
  }
  if (loc.precision === "city") {
    return `浏览器精确定位不可用，已降级为城市级定位：${loc.label}（可输入更精确的地点跳转）`;
  }
  return `已跳转到：${loc.label}`;
}

/* ---------- AMap 插件适配 ---------- */

export const AMAP_PLUGIN_TIMEOUT_MS = 10_000;
export const GEOLOCATION_TIMEOUT_MS = 9_000;

let pluginsReady: Promise<void> | null = null;

/** 超时包装：插件回调不触发时不得让 UI 永久停在“定位中” */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

/** 定位/搜索/IP 定位插件懒加载（SDK 单例，全局只需加载一次；超时清缓存允许重试） */
export function ensureLocatePlugins(AMap: AmapNamespace): Promise<void> {
  if (!pluginsReady) {
    pluginsReady = new Promise<void>((resolve, reject) => {
      if (typeof AMap.plugin !== "function") {
        reject(new Error("当前高德 SDK 不支持插件加载，可改用地点关键词跳转"));
        return;
      }
      const timer = setTimeout(() => {
        pluginsReady = null;
        reject(new Error(`定位插件加载超时（>${AMAP_PLUGIN_TIMEOUT_MS / 1000}s），请检查网络后重试`));
      }, AMAP_PLUGIN_TIMEOUT_MS);
      AMap.plugin(["AMap.Geolocation", "AMap.CitySearch", "AMap.PlaceSearch", "AMap.AutoComplete"], () => {
        clearTimeout(timer);
        resolve();
      });
    });
    pluginsReady.catch(() => {
      pluginsReady = null;
    });
  }
  return pluginsReady;
}

/** 测试用：重置插件加载缓存 */
export function resetLocatePluginsForTest(): void {
  pluginsReady = null;
}

/** 定位失败归因：授权/超时给出可操作建议，其余如实透传 */
function normalizeGeoError(raw: string | undefined): string {
  const m = raw ?? "";
  if (/denied|permission|授权/i.test(m)) {
    return "浏览器拒绝了定位授权：请在地址栏允许定位，或改用地点关键词跳转";
  }
  if (/timeout|超时/i.test(m)) {
    return "浏览器定位超时（国内网络环境下常见）：已尝试城市级定位，也可用地点关键词跳转";
  }
  return `定位失败${m !== "" ? `：${m}` : ""}，可改用地点关键词跳转`;
}

export function createGeolocationPort(AMap: AmapNamespace): GeolocationPort {
  return {
    getCurrentPosition: () =>
      ensureLocatePlugins(AMap).then(() =>
        withTimeout(
          new Promise<{ position: LngLat; accuracyM?: number }>((resolve, reject) => {
            if (!AMap.Geolocation) {
              reject(new Error("定位插件不可用，可改用地点关键词跳转"));
              return;
            }
            const geo = new AMap.Geolocation({
              enableHighAccuracy: true,
              // 缩短浏览器定位等待：失败后要走 IP 降级，不能把用户卡住太久
              timeout: 5000,
              showButton: false, // UI 由本项目提供，不用插件内置按钮
              showMarker: false, // 标记由 AmapView 统一管理
              showCircle: false,
            });
            geo.getCurrentPosition((status, result) => {
              if (status === "complete" && result.position) {
                resolve({
                  position: [result.position.lng, result.position.lat],
                  accuracyM: typeof result.accuracy === "number" ? result.accuracy : undefined,
                });
              } else {
                reject(new Error(normalizeGeoError(result.message ?? result.info)));
              }
            });
          }),
          GEOLOCATION_TIMEOUT_MS,
          "浏览器定位超时（国内网络环境下常见），已尝试 IP 定位"
        )
      ),
  };
}

/** IP 优先的定位端口：GeoLocationFirst=false 直接走 IP 定位，不等浏览器定位超时 */
export function createIpGeolocationPort(AMap: AmapNamespace): GeolocationPort {
  return {
    getCurrentPosition: () =>
      ensureLocatePlugins(AMap).then(() =>
        withTimeout(
          new Promise<{ position: LngLat; accuracyM?: number }>((resolve, reject) => {
            if (!AMap.Geolocation) {
              reject(new Error("定位插件不可用"));
              return;
            }
            const geo = new AMap.Geolocation({
              GeoLocationFirst: false, // 优先 IP 定位
              noIpLocate: false,
              timeout: 8000,
              showButton: false,
              showMarker: false,
              showCircle: false,
            });
            geo.getCurrentPosition((status, result) => {
              if (status === "complete" && result.position) {
                resolve({
                  position: [result.position.lng, result.position.lat],
                  accuracyM: typeof result.accuracy === "number" ? result.accuracy : undefined,
                });
              } else {
                reject(new Error(result.info ?? result.message ?? "IP 定位失败"));
              }
            });
          }),
          GEOLOCATION_TIMEOUT_MS + 3000,
          "IP 定位超时"
        )
      ),
  };
}

/** 解析 CitySearch 城市边界：兼容数组与 "lng1,lat1;lng2,lat2" 字符串两种格式 */
export function parseCityBounds(b: unknown): { sw: LngLat; ne: LngLat } | null {
  if (Array.isArray(b) && b.length === 2 && Array.isArray(b[0]) && Array.isArray(b[1])) {
    const [sw, ne] = b as unknown[][];
    if (sw.length >= 2 && ne.length >= 2) {
      const s = sw.slice(0, 2).map(Number);
      const n = ne.slice(0, 2).map(Number);
      if (s.every(Number.isFinite) && n.every(Number.isFinite)) {
        return { sw: [s[0], s[1]], ne: [n[0], n[1]] };
      }
    }
  }
  if (typeof b === "string") {
    const parts = b.split(";");
    if (parts.length === 2) {
      const p1 = parts[0].split(",").map(Number);
      const p2 = parts[1].split(",").map(Number);
      if (p1.length >= 2 && p2.length >= 2 && p1.every(Number.isFinite) && p2.every(Number.isFinite)) {
        return { sw: [p1[0], p1[1]], ne: [p2[0], p2[1]] };
      }
    }
  }
  return null;
}

export function createCitySearchPort(AMap: AmapNamespace): CitySearchPort {
  return {
    getLocalCity: () =>
      ensureLocatePlugins(AMap).then(
        () =>
          new Promise<{ city: string; position: LngLat } | null>((resolve, reject) => {
            if (!AMap.CitySearch) {
              reject(new Error("IP 定位插件不可用"));
              return;
            }
            const cs = new AMap.CitySearch();
            cs.getLocalCity((status, result) => {
              if (status !== "complete" || !result.city) {
                reject(new Error(result.info ?? "定位服务未返回城市"));
                return;
              }
              const bounds = parseCityBounds(result.bounds);
              if (!bounds) {
                // 有城市名但无边界：给出城市名但无法定位，交由上层如实说明
                resolve(null);
                return;
              }
              resolve({
                city: result.city,
                position: [(bounds.sw[0] + bounds.ne[0]) / 2, (bounds.sw[1] + bounds.ne[1]) / 2],
              });
            });
          })
      ),
  };
}

export function createPlaceSearchPort(AMap: AmapNamespace): PlaceSearchPort {
  return {
    searchFirst: (keyword) =>
      ensureLocatePlugins(AMap).then(
        () =>
          new Promise<{ position: LngLat; name: string } | null>((resolve, reject) => {
            if (!AMap.PlaceSearch) {
              reject(new Error("地点搜索插件不可用"));
              return;
            }
            const ps = new AMap.PlaceSearch({});
            ps.search(keyword, (status, result) => {
              if (status === "complete" && result.poiList?.pois && result.poiList.pois.length > 0) {
                const poi = result.poiList.pois[0];
                if (poi.location) {
                  resolve({ position: [poi.location.lng, poi.location.lat], name: poi.name ?? keyword });
                } else {
                  resolve(null); // 命中但无坐标：视为未找到，不猜位置
                }
              } else if (status === "no_data") {
                resolve(null);
              } else {
                reject(new Error(`地点搜索失败${result.info ? `：${result.info}` : ""}`));
              }
            });
          })
      ),
  };
}
