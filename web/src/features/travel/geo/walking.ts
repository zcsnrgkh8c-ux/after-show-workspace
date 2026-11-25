/**
 * 步行路线规划适配（AMap.Walking）：
 * - 只解析高德真实返回；距离单位米、时间单位秒；缺字段为 null；
 * - polyline 由各 step.path 摊平为 GCJ-02 [lng,lat]，高德未返回时为 null；
 * - 绝不合成直线或假路线；空 routes → no_route，错误 → provider_error。
 */
import type { AMapNamespace } from "../vendor/types";
import type {
  GeoPlace,
  RouteSearchResult,
  TravelRoute,
  TravelRouteStep,
} from "../../../contract/travel";
import { loadAmapWithPlugins } from "../vendor/amapLoader";
import { readCoord, shortRandom } from "./geolocation";

export interface PlanWalkingInput {
  origin: GeoPlace;
  destination: GeoPlace;
  /** 已就绪的 AMap 命名空间；缺省时按需加载 AMap.Walking 插件 */
  amap?: AMapNamespace;
  /**
   * 规划超时（毫秒，默认 12000）。
   * AMap.Walking 在个别网络/密钥状态下既不回调也不抛错，若无超时会永久占用规划锁、
   * 用户无法重试；超时按 provider_error(timeout) 返回，迟到回调被忽略。
   */
  timeout_ms?: number;
}

const DEFAULT_WALKING_TIMEOUT_MS = 12_000;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** 数值字段解析：仅接受有限数字（或纯数字字符串），缺失/非法 → null */
function numOrNull(v: unknown): number | null {
  if (isFiniteNumber(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return null;
}

/** 生成请求身份：优先 crypto.randomUUID，环境缺失时降级 */
function genId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `id-${Date.now().toString(36)}-${shortRandom()}`;
}

/** 单条 step 解析：instruction/distance/time 缺为 null */
function parseStep(raw: unknown): TravelRouteStep | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  return {
    instruction: typeof o.instruction === "string" ? o.instruction : "",
    distance_m: numOrNull(o.distance),
    duration_s: numOrNull(o.time),
  };
}

/** 摊平各 step.path 为 [lng,lat] 数组；无任何有效坐标时返回 null（禁止造直线） */
function parsePolyline(steps: unknown): Array<[number, number]> | null {
  if (!Array.isArray(steps)) return null;
  const polyline: Array<[number, number]> = [];
  for (const step of steps) {
    if (typeof step !== "object" || step === null) continue;
    const path = (step as { path?: unknown }).path;
    if (!Array.isArray(path)) continue;
    for (const p of path) {
      const coord = readCoord(p);
      if (coord) polyline.push([coord.lng, coord.lat]);
    }
  }
  return polyline.length > 0 ? polyline : null;
}

function parseRoute(
  raw: unknown,
  index: number,
  ctx: {
    request_id: string;
    queried_at: string;
  },
): TravelRoute {
  const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const distance = numOrNull(o.distance);
  const stepsRaw = Array.isArray(o.steps) ? o.steps : [];
  return {
    route_id: `amap-r${index + 1}-${shortRandom()}`,
    provider: "amap",
    queried_at: ctx.queried_at,
    mode: "walking",
    distance_m: distance,
    estimated_duration_s: numOrNull(o.time),
    walking_distance_m: distance,
    transfer_count: 0,
    steps: stepsRaw
      .map(parseStep)
      .filter((s): s is TravelRouteStep => s !== null),
    polyline: parsePolyline(stepsRaw),
    step_free_evidence: "unknown",
    step_free_note: null,
  };
}

/** 错误归类：timeout / network / provider_error */
function classifyProviderError(info: string, message: string): string {
  const s = `${info} ${message}`.toUpperCase();
  if (s.includes("TIMEOUT")) return "timeout";
  if (s.includes("NETWORK") || s.includes("CONNECTION") || s.includes("FETCH")) {
    return "network";
  }
  return "provider_error";
}

/**
 * 纯函数：解析 AMap.Walking.search 回调结果。
 * raw 形如 { status: "complete"|"error", info?, message?, routes?: [...] }。
 */
export function parseWalkingResult(
  raw: unknown,
  ctx: {
    request_id: string;
    candidate_set_id: string;
    origin: GeoPlace;
    destination: GeoPlace;
    queried_at: string;
  },
): RouteSearchResult {
  const base = {
    request_id: ctx.request_id,
    candidate_set_id: ctx.candidate_set_id,
    origin: ctx.origin,
    destination: ctx.destination,
    mode: "walking" as const,
  };
  if (typeof raw !== "object" || raw === null) {
    return {
      ...base,
      status: "provider_error",
      routes: [],
      error_code: "provider_error",
      message: "步行规划返回数据异常",
    };
  }
  const o = raw as { status?: unknown; info?: unknown; message?: unknown; routes?: unknown; result?: unknown };
  // 兼容两种形态：routes/info/message 在顶层，或包裹在 result 字段下（getCurrentPosition/search 回调包装）
  const inner =
    typeof o.result === "object" && o.result !== null
      ? (o.result as Record<string, unknown>)
      : {};
  const routesUnknown = Array.isArray(o.routes) ? o.routes : Array.isArray(inner.routes) ? inner.routes : [];
  const pickStr = (a: unknown, b: unknown): string =>
    typeof a === "string" ? a : typeof b === "string" ? b : "";

  if (o.status === "complete") {
    if (routesUnknown.length === 0) {
      return {
        ...base,
        status: "no_route",
        routes: [],
        error_code: null,
        message: "高德未返回可行步行路线",
      };
    }
    return {
      ...base,
      status: "ok",
      routes: routesUnknown.map((r, i) => parseRoute(r, i, ctx)),
      error_code: null,
      message: null,
    };
  }

  const info = pickStr(o.info, inner.info);
  const message = pickStr(o.message, inner.message);
  const errorCode = classifyProviderError(info, message);
  const humanMessage =
    errorCode === "timeout"
      ? `步行路线规划超时：${message || info || "请稍后重试"}`
      : errorCode === "network"
        ? `步行路线规划网络异常：${message || info || "请检查网络后重试"}`
        : `步行路线规划失败：${message || info || "服务返回错误"}`;
  return {
    ...base,
    status: "provider_error",
    routes: [],
    error_code: errorCode,
    message: humanMessage,
  };
}

/** 步行路线规划入口：内部生成 request_id / candidate_set_id */
export async function planWalking(input: PlanWalkingInput): Promise<RouteSearchResult> {
  const requestId = genId();
  const candidateSetId = genId();
  const queriedAt = new Date().toISOString();
  const base = {
    request_id: requestId,
    candidate_set_id: candidateSetId,
    origin: input.origin,
    destination: input.destination,
    mode: "walking" as const,
    queried_at: queriedAt,
  };
  const ctx = {
    request_id: requestId,
    candidate_set_id: candidateSetId,
    origin: input.origin,
    destination: input.destination,
    queried_at: queriedAt,
  };

  let AMap: AMapNamespace;
  try {
    AMap = input.amap ?? (await loadAmapWithPlugins(["AMap.Walking"]));
  } catch (err) {
    return {
      request_id: requestId,
      candidate_set_id: candidateSetId,
      origin: input.origin,
      destination: input.destination,
      mode: "walking",
      status: "provider_error",
      routes: [],
      error_code: "provider_error",
      message: `路线规划插件不可用：${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const WalkingCtor = AMap.Walking;
  if (typeof WalkingCtor !== "function" || typeof AMap.LngLat !== "function") {
    return {
      request_id: requestId,
      candidate_set_id: candidateSetId,
      origin: input.origin,
      destination: input.destination,
      mode: "walking",
      status: "provider_error",
      routes: [],
      error_code: "plugin_missing",
      message: "路线规划插件 AMap.Walking 不可用",
    };
  }

  return new Promise<RouteSearchResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (r: RouteSearchResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolve(r);
    };
    const timeoutMs = input.timeout_ms ?? DEFAULT_WALKING_TIMEOUT_MS;
    timer = setTimeout(() => {
      finish({
        request_id: requestId,
        candidate_set_id: candidateSetId,
        origin: input.origin,
        destination: input.destination,
        mode: "walking",
        status: "provider_error",
        routes: [],
        error_code: "timeout",
        message: `步行路线规划超时（>${Math.round(timeoutMs / 1000)}s）：高德未返回结果，请重试或改用示意图`,
      });
    }, timeoutMs);
    try {
      const walking = new WalkingCtor({});
      const oLngLat = new AMap.LngLat(input.origin.lng, input.origin.lat);
      const dLngLat = new AMap.LngLat(input.destination.lng, input.destination.lat);
      walking.search(oLngLat, dLngLat, (status: unknown, result: unknown) => {
        finish(parseWalkingResult({ status, result }, ctx));
      });
    } catch (err) {
      finish({
        request_id: requestId,
        candidate_set_id: candidateSetId,
        origin: input.origin,
        destination: input.destination,
        mode: "walking",
        status: "provider_error",
        routes: [],
        error_code: "provider_error",
        message: `调用步行规划失败：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });
}
