/**
 * 单段通道的真实步行规划（展示层）：调用高德 AMap.Walking，把通道两端点之间的
 * 真实步行折线取回来；任何失败都如实返回原因，绝不用直线冒充真实路线。
 *
 * 边界：
 * - 只接受高德真实返回；折线为空 → 失败，不合成；
 * - 12s 硬超时（AMap.Walking 个别情况下既不回调也不抛错），迟到回调忽略；
 * - 距离/时间缺失为 null，不补 0；本结果不进入任何推演计算。
 */
import type { LngLat } from "./config";
import type { AmapNamespace } from "./types";

export interface EdgeWalkingSuccess {
  distance_m: number | null;
  duration_s: number | null;
  polyline: LngLat[];
}

export type EdgeWalkingOutcome = { ok: true; value: EdgeWalkingSuccess } | { ok: false; reason: string };

const DEFAULT_TIMEOUT_MS = 12_000;
const PLUGIN_TIMEOUT_MS = 10_000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function numOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/** 兼容普通对象 {lng,lat} 与 AMap.LngLat 实例（getLng/getLat） */
function readPoint(v: unknown): LngLat | null {
  if (!isRecord(v)) return null;
  const o = v as { lng?: unknown; lat?: unknown; getLng?: unknown; getLat?: unknown };
  const lng =
    typeof o.lng === "number" ? o.lng : typeof o.getLng === "function" ? (o.getLng as () => unknown)() : null;
  const lat =
    typeof o.lat === "number" ? o.lat : typeof o.getLat === "function" ? (o.getLat as () => unknown)() : null;
  if (typeof lng !== "number" || typeof lat !== "number") return null;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return [lng, lat];
}

/** 纯函数：解析 AMap.Walking.search 回调（raw 为 {status, result} 或直接 result） */
export function parseEdgeWalking(raw: unknown): EdgeWalkingOutcome {
  if (!isRecord(raw)) return { ok: false, reason: "步行规划返回数据异常" };
  const status = raw.status;
  const result = isRecord(raw.result) ? raw.result : raw;
  if (status !== "complete") {
    const info = typeof result.info === "string" ? result.info : "";
    const message = typeof result.message === "string" ? result.message : "";
    return { ok: false, reason: `高德步行规划失败${info || message ? `：${message || info}` : ""}` };
  }
  const routes = Array.isArray(result.routes) ? result.routes : [];
  const first = routes[0];
  if (!isRecord(first)) return { ok: false, reason: "高德未返回可行步行路线" };

  const steps = Array.isArray(first.steps) ? first.steps : [];
  const polyline: LngLat[] = [];
  for (const step of steps) {
    if (!isRecord(step)) continue;
    const path = step.path;
    if (!Array.isArray(path)) continue;
    for (const p of path) {
      const point = readPoint(p);
      if (point) polyline.push(point);
    }
  }
  if (polyline.length < 2) return { ok: false, reason: "高德未返回步行折线（不使用直线替代）" };

  return {
    ok: true,
    value: {
      distance_m: numOrNull(first.distance),
      duration_s: numOrNull(first.time),
      polyline,
    },
  };
}

/** 加载 AMap.Walking 插件（已存在时直接返回） */
export function ensureWalkingPlugin(AMap: AmapNamespace, timeoutMs = PLUGIN_TIMEOUT_MS): Promise<void> {
  if (AMap.Walking) return Promise.resolve();
  if (typeof AMap.plugin !== "function") {
    return Promise.reject(new Error("高德 JSAPI 不支持插件加载，无法规划步行路线"));
  }
  const plugin = AMap.plugin;
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("高德步行插件加载超时")), timeoutMs);
    try {
      plugin(["AMap.Walking"], () => {
        clearTimeout(timer);
        if (AMap.Walking) resolve();
        else reject(new Error("高德步行插件回调已触发但构造器不可用"));
      });
    } catch (err) {
      clearTimeout(timer);
      reject(new Error(`加载高德步行插件失败：${err instanceof Error ? err.message : String(err)}`));
    }
  });
}

/** 规划一条通道的真实步行路线 */
export function planEdgeWalking(
  AMap: AmapNamespace,
  from: LngLat,
  to: LngLat,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<EdgeWalkingOutcome> {
  const WalkingCtor = AMap.Walking;
  const LngLatCtor = AMap.LngLat;
  if (typeof WalkingCtor !== "function") {
    return Promise.resolve({ ok: false, reason: "高德步行插件不可用" });
  }

  return new Promise<EdgeWalkingOutcome>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (outcome: EdgeWalkingOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolve(outcome);
    };
    timer = setTimeout(() => {
      finish({ ok: false, reason: `步行规划超时（>${Math.round(timeoutMs / 1000)}s）` });
    }, timeoutMs);

    try {
      const walking = new WalkingCtor({});
      const origin = typeof LngLatCtor === "function" ? new LngLatCtor(from[0], from[1]) : { lng: from[0], lat: from[1] };
      const destination = typeof LngLatCtor === "function" ? new LngLatCtor(to[0], to[1]) : { lng: to[0], lat: to[1] };
      walking.search(origin, destination, (status: unknown, result: unknown) => {
        finish(parseEdgeWalking({ status, result }));
      });
    } catch (err) {
      finish({ ok: false, reason: `调用步行规划失败：${err instanceof Error ? err.message : String(err)}` });
    }
  });
}
