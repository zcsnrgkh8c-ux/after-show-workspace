/**
 * 单次定位适配（AMap.Geolocation）：
 * - 只允许 getCurrentPosition 单次定位，禁用 watchPosition；
 * - IP 近似必须标注 "IP近似"，不得冒充精确 GPS；
 * - 失败按浏览器语义映射：PERMISSION_DENIED→denied、TIMEOUT→timeout、
 *   POSITION_UNAVAILABLE→unavailable，其余→error。
 * 所有数字来自高德真实返回；缺字段为 null，不补造。
 */
import type { AMapNamespace } from "../vendor/types";
import type { GeoPlace } from "../../../contract/travel";
import { loadAmapWithPlugins } from "../vendor/amapLoader";

export type LocateOutcome =
  | { status: "ok"; place: GeoPlace }
  | {
      status: "denied" | "timeout" | "unavailable" | "error";
      message: string;
    };

export interface LocateOptions {
  /** 定位超时毫秒数，默认 10000 */
  timeout_ms?: number;
  /** 已就绪的 AMap 命名空间；缺省时按需加载 AMap.Geolocation 插件 */
  amap?: AMapNamespace;
}

/** 生成会话内唯一短随机串 */
export function shortRandom(): string {
  return Math.random().toString(36).slice(2, 10);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** 从 LngLat 实例（getLng/getLat）或普通 {lng,lat} 读取坐标，非法返回 null */
export function readCoord(
  p: unknown,
): { lng: number; lat: number } | null {
  if (typeof p !== "object" || p === null) return null;
  const o = p as Record<string, unknown>;
  const withGet = o as {
    getLng?: unknown;
    getLat?: unknown;
    lng?: unknown;
    lat?: unknown;
  };
  const lng = typeof withGet.getLng === "function" ? withGet.getLng() : withGet.lng;
  const lat = typeof withGet.getLat === "function" ? withGet.getLat() : withGet.lat;
  if (!isFiniteNumber(lng) || !isFiniteNumber(lat)) return null;
  if (lng < -180 || lng > 180 || lat < -90 || lat > 90) return null;
  return { lng, lat };
}

/** 按定位类型归类来源说明：html5/gps → GPS；ip → IP近似 */
function classifySourceNote(type: unknown): string {
  const t = typeof type === "string" ? type.toLowerCase() : "";
  if (t === "ip") return "IP近似";
  return "GPS";
}

/**
 * WGS-84 → GCJ-02 转换（浏览器定位是 WGS-84，高德坐标为 GCJ-02）。
 * 标准偏移算法（纯函数，偏移量约 100~700m，视区域而定）；
 * 精确转换需服务端，展示用途下该精度足够，且结果标注 coord_system=GCJ-02。
 */
export function wgs84ToGcj02(lng: number, lat: number): { lng: number; lat: number } {
  const a = 6378245.0;
  const ee = 0.00669342162296594323;
  const transformLat = (x: number, y: number): number => {
    let ret =
      -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
    ret += ((20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin((y / 3.0) * Math.PI)) * 2.0) / 3.0;
    ret += ((160.0 * Math.sin((y / 12.0) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30.0)) * 2.0) / 3.0;
    return ret;
  };
  const transformLng = (x: number, y: number): number => {
    let ret =
      300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
    ret += ((20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin((x / 3.0) * Math.PI)) * 2.0) / 3.0;
    ret += ((150.0 * Math.sin((x / 12.0) * Math.PI) + 300.0 * Math.sin((x / 30.0) * Math.PI)) * 2.0) / 3.0;
    return ret;
  };
  // 境外坐标不转换（高德 GCJ-02 仅覆盖国内）
  if (lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271) {
    return { lng, lat };
  }
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / ((a * (1 - ee)) / (magic * sqrtMagic) * Math.PI);
  dLng = (dLng * 180.0) / ((a / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return { lng: lng + dLng, lat: lat + dLat };
}

/**
 * 浏览器精确定位（navigator.geolocation，单次）：
 * 真实 GPS/用户授权优先——CDP 注入演示也走这条；失败返回语义化状态，由上层决定是否落 IP。
 * 浏览器坐标为 WGS-84，内部转换为 GCJ-02（coord_system 如实标注）。
 */
function locateByBrowserOnce(timeoutMs: number): Promise<LocateOutcome> {
  return new Promise<LocateOutcome>((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      resolve({ status: "unavailable", message: "浏览器不支持定位" });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const accuracy = isFiniteNumber(pos.coords.accuracy) ? pos.coords.accuracy : null;
        const gcj = wgs84ToGcj02(pos.coords.longitude, pos.coords.latitude);
        resolve({
          status: "ok",
          place: {
            place_id: `geo-${shortRandom()}`,
            label: "当前位置",
            lng: gcj.lng,
            lat: gcj.lat,
            coord_system: "GCJ-02",
            source: "geolocation",
            accuracy_m: accuracy,
            source_note: "GPS",
            city: null,
            address: null,
          },
        });
      },
      (err) => {
        const code = isFiniteNumber(err.code) ? err.code : null;
        if (err.code === err.PERMISSION_DENIED || code === 1) {
          resolve({ status: "denied", message: "定位权限被拒绝，请手动输入起点地点" });
        } else if (err.code === err.TIMEOUT || code === 3) {
          resolve({ status: "timeout", message: "定位超时，请重试或手动输入起点地点" });
        } else if (err.code === err.POSITION_UNAVAILABLE || code === 2) {
          resolve({ status: "unavailable", message: "当前无法获取位置信息，请手动输入起点地点" });
        } else {
          resolve({ status: "error", message: `定位失败：${err.message || "未知错误"}` });
        }
      },
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30_000 },
    );
  });
}

/**
 * 纯函数：解析 AMap.Geolocation.getCurrentPosition 的回调结果。
 * raw 形如 { status: "complete"|"error", result: {...} }；
 * error 分支兼容 info（PERMISSION_DENIED/TIMEOUT/POSITION_UNAVAILABLE）、
 * 数字错误码（1/2/3）与 message 字段。
 */
export function parseLocateOutcome(raw: unknown): LocateOutcome {
  if (typeof raw !== "object" || raw === null) {
    return { status: "error", message: "定位返回数据异常" };
  }
  const obj = raw as { status?: unknown; result?: unknown };

  if (obj.status === "complete") {
    const result =
      typeof obj.result === "object" && obj.result !== null
        ? (obj.result as Record<string, unknown>)
        : {};
    const coord = readCoord(result.position);
    if (!coord) {
      return { status: "error", message: "定位成功但未返回有效坐标" };
    }
    const accuracy = isFiniteNumber(result.accuracy) ? result.accuracy : null;
    const place: GeoPlace = {
      place_id: `geo-${shortRandom()}`,
      label: "当前位置",
      lng: coord.lng,
      lat: coord.lat,
      coord_system: "GCJ-02",
      source: "geolocation",
      accuracy_m: accuracy,
      source_note: classifySourceNote(result.location_type ?? result.type),
      city: null,
      address: null,
    };
    return { status: "ok", place };
  }

  // 失败分支：提取 info / code / message
  const result =
    typeof obj.result === "object" && obj.result !== null
      ? (obj.result as Record<string, unknown>)
      : {};
  const info = typeof result.info === "string" ? result.info.toUpperCase() : "";
  const message = typeof result.message === "string" ? result.message : "";
  const code = isFiniteNumber(result.code) ? result.code : null;

  if (info.includes("PERMISSION_DENIED") || code === 1) {
    return {
      status: "denied",
      message: "定位权限被拒绝，请手动输入起点地点",
    };
  }
  if (info.includes("TIMEOUT") || code === 3) {
    return { status: "timeout", message: "定位超时，请重试或手动输入起点地点" };
  }
  if (info.includes("POSITION_UNAVAILABLE") || code === 2) {
    return { status: "unavailable", message: "当前无法获取位置信息，请手动输入起点地点" };
  }
  return {
    status: "error",
    message: `定位失败：${message || info || "未知错误"}`,
  };
}

/** 单次定位入口：浏览器精确定位优先（真实 GPS/授权/演示注入），失败再落 AMap（IP 近似，如实标注） */
export async function locateOnce(opts?: LocateOptions): Promise<LocateOutcome> {
  const timeoutMs = opts?.timeout_ms ?? 10_000;

  // 1) 浏览器精确定位：CDP 注入/真实 GPS 都走这里，坐标为 WGS-84 → 内部转 GCJ-02。
  //    拒绝授权不落 IP（尊重用户明确选择），其余失败降级 IP 并如实标注“IP近似”。
  const browser = await locateByBrowserOnce(timeoutMs);
  if (browser.status === "ok" || browser.status === "denied") return browser;

  // 2) AMap.Geolocation（其内部浏览器定位不可用时自动落 IP 近似）
  let AMap: AMapNamespace;
  try {
    AMap = opts?.amap ?? (await loadAmapWithPlugins(["AMap.Geolocation"]));
  } catch (err) {
    return browser.status === "timeout"
      ? { status: "timeout", message: "定位超时，请重试或手动输入起点地点" }
      : { status: "error", message: `定位插件不可用：${err instanceof Error ? err.message : String(err)}` };
  }
  const GeolocationCtor = AMap.Geolocation;
  if (typeof GeolocationCtor !== "function") {
    return { status: "error", message: "定位插件 AMap.Geolocation 不可用" };
  }

  return new Promise<LocateOutcome>((resolve) => {
    try {
      const geo = new GeolocationCtor({
        enableHighAccuracy: true,
        timeout: timeoutMs,
      });
      // 仅单次 getCurrentPosition，禁用 watchPosition
      geo.getCurrentPosition((status: unknown, result: unknown) => {
        resolve(parseLocateOutcome({ status, result }));
      });
    } catch (err) {
      resolve({
        status: "error",
        message: `调用定位失败：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });
}
