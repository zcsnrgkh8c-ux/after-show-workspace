/**
 * 公交 / 地铁路线规划适配（AMap.Transfer）——展示层。
 *
 * 边界：
 * - 只解析高德真实返回；距离单位米、时间单位秒；缺字段为 null，不补 0；
 * - 折线由步行 steps 与公交/地铁 segment.path 摊平；高德未返回时为 null，禁止造直线；
 * - 本模块不接服务端出行建议（现有建议契约仅覆盖步行），页面明确说明；
 * - 公交/地铁的无台阶、电梯与实时到站信息高德未提供，一律不声称已核实。
 */
import type { AMapNamespace } from "../vendor/types";
import type { GeoPlace, PreferenceKind } from "../../../contract/travel";
import { loadAmapWithPlugins } from "../vendor/amapLoader";
import { readCoord, shortRandom } from "./geolocation";

export type TransitLegKind = "walking" | "bus" | "subway" | "railway" | "taxi" | "other";

export interface TransitLeg {
  kind: TransitLegKind;
  /** 短标签：步行 / 公交 / 地铁 / 火车 / 出租车 */
  label: string;
  /** 线路与站点说明；无则为 null */
  detail: string | null;
  distance_m: number | null;
  duration_s: number | null;
}

export interface TransitRoute {
  route_id: string;
  provider: "amap";
  queried_at: string;
  mode: "transit";
  distance_m: number | null;
  estimated_duration_s: number | null;
  walking_distance_m: number | null;
  transfer_count: number | null;
  legs: TransitLeg[];
  /** GCJ-02 [lng,lat] 折线；高德未返回时 null */
  polyline: Array<[number, number]> | null;
}

export type TransitSearchStatus = "ok" | "no_route" | "provider_error";

/** 本次公交请求实际采用的高德策略（default = 未传 policy，用高德默认） */
export type TransitPolicyChoice = "default" | "least_transfer" | "least_walk";

export interface TransitSearchResult {
  request_id: string;
  candidate_set_id: string;
  origin: GeoPlace;
  destination: GeoPlace;
  mode: "transit";
  status: TransitSearchStatus;
  routes: TransitRoute[];
  error_code: string | null;
  message: string | null;
  /** 实际传给高德 Transfer 的策略；供界面如实展示，避免“选了没生效” */
  policy: TransitPolicyChoice;
  /** 请求时勾选了无台阶硬需求，但高德公交规划无此参数，结果未据此筛选 */
  step_free_unverified: boolean;
}

export interface PlanTransitInput {
  origin: GeoPlace;
  destination: GeoPlace;
  /** 城市名（公交规划必填）；缺省依次取起点/终点城市，再尝试高德 CitySearch */
  city?: string | null;
  /** 路线偏好：少换乘/少步行映射为高德 Transfer policy；均衡不传 */
  preference?: PreferenceKind | null;
  /** 无台阶硬需求：高德 Transfer 不支持该参数，仅在结果里如实标记“未筛选” */
  needs_step_free?: boolean;
  amap?: AMapNamespace;
  timeout_ms?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const PLUGIN_TIMEOUT_MS = 10_000;
const CITY_TIMEOUT_MS = 3_000;

/**
 * 偏好 → 高德 policy：2=最少换乘、3=最少步行（TransferPolicy.LEAST_TRANSFER / LEAST_WALK）。
 * 均衡不传 policy，使用高德默认策略。
 */
export function transitPolicyFor(pref: PreferenceKind | null | undefined): TransitPolicyChoice {
  if (pref === "less_transfer") return "least_transfer";
  if (pref === "less_walking") return "least_walk";
  return "default";
}

/** 解析为 Transfer 构造参数值；优先用 SDK 的 TransferPolicy 枚举，缺失时回退官方数值 */
function policyValue(choice: TransitPolicyChoice, AMap: AMapNamespace): number | null {
  if (choice === "default") return null;
  const bag = AMap as unknown as { TransferPolicy?: Record<string, unknown> };
  const raw =
    choice === "least_transfer" ? bag.TransferPolicy?.LEAST_TRANSFER : bag.TransferPolicy?.LEAST_WALK;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  return choice === "least_transfer" ? 2 : 3;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function numOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function genId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `id-${Date.now().toString(36)}-${shortRandom()}`;
}

/** 摊平一组坐标点（兼容 AMap.LngLat 实例与普通对象） */
function appendPath(target: Array<[number, number]>, path: unknown): void {
  if (!Array.isArray(path)) return;
  for (const p of path) {
    const coord = readCoord(p);
    if (!coord) continue;
    const last = target[target.length - 1];
    if (last && last[0] === coord.lng && last[1] === coord.lat) continue;
    target.push([coord.lng, coord.lat]);
  }
}

function parseWalkingLeg(seg: Record<string, unknown>): { leg: TransitLeg; polyline: Array<[number, number]> } {
  const walking = isRecord(seg.walking) ? seg.walking : {};
  const steps = Array.isArray(walking.steps) ? walking.steps : [];
  const polyline: Array<[number, number]> = [];
  for (const step of steps) {
    if (!isRecord(step)) continue;
    appendPath(polyline, step.path);
  }
  return {
    leg: {
      kind: "walking",
      label: "步行",
      detail: null,
      distance_m: numOrNull(walking.distance),
      duration_s: numOrNull(walking.time),
    },
    polyline,
  };
}

function stopPair(departure: unknown, arrival: unknown): string | null {
  const from = isRecord(departure) ? strOrNull(departure.name) : null;
  const to = isRecord(arrival) ? strOrNull(arrival.name) : null;
  if (from && to) return `${from} → ${to}`;
  return from ?? to;
}

function parseBusLeg(seg: Record<string, unknown>): { leg: TransitLeg; polyline: Array<[number, number]> } {
  const bus = isRecord(seg.bus) ? seg.bus : {};
  const buslines = Array.isArray(bus.buslines) ? bus.buslines : [];
  const line = isRecord(buslines[0]) ? buslines[0] : {};
  const name = strOrNull(line.name) ?? "公交线路";
  const isSubway = /地铁|轨道交通|轻轨/.test(name);
  const via = numOrNull(line.via_num);
  const stops = stopPair(line.departure_stop, line.arrival_stop);
  const detailParts = [name];
  if (via !== null) detailParts.push(`共 ${via} 站`);
  if (stops) detailParts.push(stops);
  const polyline: Array<[number, number]> = [];
  appendPath(polyline, line.path);
  return {
    leg: {
      kind: isSubway ? "subway" : "bus",
      label: isSubway ? "地铁" : "公交",
      detail: detailParts.join(" · "),
      distance_m: numOrNull(line.distance) ?? numOrNull(bus.distance),
      duration_s: numOrNull(line.time) ?? numOrNull(bus.time),
    },
    polyline,
  };
}

function parseRailwayLeg(seg: Record<string, unknown>): { leg: TransitLeg; polyline: Array<[number, number]> } {
  const railway = isRecord(seg.railway) ? seg.railway : {};
  const trips = Array.isArray(railway.trips) ? railway.trips : [];
  const trip = isRecord(trips[0]) ? trips[0] : railway;
  const name = strOrNull(railway.name) ?? strOrNull(trip.name) ?? "火车";
  const stops = stopPair(railway.departure_stop ?? trip.departure_stop, railway.arrival_stop ?? trip.arrival_stop);
  const polyline: Array<[number, number]> = [];
  appendPath(polyline, trip.path);
  if (polyline.length === 0) appendPath(polyline, railway.path);
  return {
    leg: {
      kind: "railway",
      label: "火车",
      detail: stops ? `${name} · ${stops}` : name,
      distance_m: numOrNull(railway.distance) ?? numOrNull(trip.distance),
      duration_s: numOrNull(railway.time) ?? numOrNull(trip.time),
    },
    polyline,
  };
}

function parseTaxiLeg(seg: Record<string, unknown>): { leg: TransitLeg; polyline: Array<[number, number]> } {
  const taxi = isRecord(seg.taxi) ? seg.taxi : {};
  const polyline: Array<[number, number]> = [];
  appendPath(polyline, taxi.path);
  return {
    leg: {
      kind: "taxi",
      label: "出租车",
      detail: null,
      distance_m: numOrNull(taxi.distance),
      duration_s: numOrNull(taxi.time),
    },
    polyline,
  };
}

/**
 * JSAPI 2.0 Transfer 实际回调格式：segment 使用 transit_mode + transit 字段
 * （WALK / SUBWAY / BUS / RAILWAY / TAXI），线路名在 transit.lines[0].name，
 * 站点在 transit.on_station / off_station，整条路线折线在 plan.path。
 * 同时保留旧格式（segment.walking / segment.bus / segment.railway / segment.taxi）兼容。
 */
function parseNewSegment(seg: Record<string, unknown>, mode: string): { leg: TransitLeg; polyline: Array<[number, number]> } {
  const transit = isRecord(seg.transit) ? seg.transit : {};
  const kind: TransitLegKind =
    mode === "WALK"
      ? "walking"
      : mode === "SUBWAY"
        ? "subway"
        : mode === "BUS"
          ? "bus"
          : mode === "RAILWAY"
            ? "railway"
            : mode === "TAXI"
              ? "taxi"
              : "other";
  const label =
    kind === "walking"
      ? "步行"
      : kind === "subway"
        ? "地铁"
        : kind === "bus"
          ? "公交"
          : kind === "railway"
            ? "火车"
            : kind === "taxi"
              ? "出租车"
              : "其他";

  const instruction = strOrNull(seg.instruction);
  const lines = Array.isArray(transit.lines) ? transit.lines : [];
  const line = isRecord(lines[0]) ? lines[0] : {};
  const lineName = strOrNull(line.name);
  const onStation = isRecord(transit.on_station) ? strOrNull(transit.on_station.name) : null;
  const offStation = isRecord(transit.off_station) ? strOrNull(transit.off_station.name) : null;
  const via = numOrNull(transit.via_num);

  let detail: string | null = instruction;
  if (kind !== "walking") {
    const parts: string[] = [];
    if (lineName) parts.push(lineName);
    else if (instruction) parts.push(instruction);
    if (via !== null) parts.push(`共 ${via} 站`);
    if (onStation && offStation) parts.push(`${onStation} → ${offStation}`);
    detail = parts.length > 0 ? parts.join(" · ") : null;
  }

  const polyline: Array<[number, number]> = [];
  appendPath(polyline, transit.path);
  if (kind === "walking") {
    const steps = Array.isArray(transit.steps) ? transit.steps : [];
    for (const step of steps) {
      if (isRecord(step)) appendPath(polyline, step.path);
    }
  }

  return {
    leg: {
      kind,
      label,
      detail,
      distance_m: numOrNull(seg.distance),
      duration_s: numOrNull(seg.time),
    },
    polyline,
  };
}

function parsePlan(raw: unknown, index: number, queriedAt: string): TransitRoute | null {
  if (!isRecord(raw)) return null;
  const segments = Array.isArray(raw.segments) ? raw.segments : [];
  const legs: TransitLeg[] = [];
  const polyline: Array<[number, number]> = [];
  let walkingSum: number | null = null;

  // 新版返回自带整条路线折线（plan.path），优先使用
  appendPath(polyline, raw.path);
  const hasPlanPath = polyline.length >= 2;

  for (const segment of segments) {
    if (!isRecord(segment)) continue;
    let parsed: { leg: TransitLeg; polyline: Array<[number, number]> } | null = null;
    if (typeof segment.transit_mode === "string") {
      parsed = parseNewSegment(segment, segment.transit_mode.toUpperCase());
    } else if (isRecord(segment.walking)) parsed = parseWalkingLeg(segment);
    else if (isRecord(segment.bus)) parsed = parseBusLeg(segment);
    else if (isRecord(segment.railway)) parsed = parseRailwayLeg(segment);
    else if (isRecord(segment.taxi)) parsed = parseTaxiLeg(segment);
    if (!parsed) continue;
    legs.push(parsed.leg);
    // plan.path 缺失时才用分段 path 拼接
    if (!hasPlanPath) {
      for (const p of parsed.polyline) {
        const last = polyline[polyline.length - 1];
        if (!last || last[0] !== p[0] || last[1] !== p[1]) polyline.push(p);
      }
    }
    if (parsed.leg.kind === "walking" && parsed.leg.distance_m !== null) {
      walkingSum = (walkingSum ?? 0) + parsed.leg.distance_m;
    }
  }

  if (legs.length === 0) return null;
  const transitLegs = legs.filter((l) => l.kind !== "walking" && l.kind !== "taxi").length;
  const walking = numOrNull(raw.walking_distance) ?? walkingSum;

  return {
    route_id: `amap-t${index + 1}-${shortRandom()}`,
    provider: "amap",
    queried_at: queriedAt,
    mode: "transit",
    distance_m: numOrNull(raw.distance),
    estimated_duration_s: numOrNull(raw.time),
    walking_distance_m: walking,
    transfer_count: transitLegs > 0 ? Math.max(0, transitLegs - 1) : null,
    legs,
    polyline: polyline.length >= 2 ? polyline : null,
  };
}

/** 纯函数：解析 AMap.Transfer.search 回调（raw 为 {status, result} 或直接 result） */
export function parseTransitResult(
  raw: unknown,
  ctx: {
    request_id: string;
    candidate_set_id: string;
    origin: GeoPlace;
    destination: GeoPlace;
    queried_at: string;
    policy?: TransitPolicyChoice;
    step_free_unverified?: boolean;
  }
): TransitSearchResult {
  const base = {
    request_id: ctx.request_id,
    candidate_set_id: ctx.candidate_set_id,
    origin: ctx.origin,
    destination: ctx.destination,
    mode: "transit" as const,
    policy: ctx.policy ?? ("default" as TransitPolicyChoice),
    step_free_unverified: ctx.step_free_unverified ?? false,
  };
  if (!isRecord(raw)) {
    return { ...base, status: "provider_error", routes: [], error_code: "provider_error", message: "公交规划返回数据异常" };
  }
  const status = raw.status;
  const result = isRecord(raw.result) ? raw.result : raw;
  if (status !== "complete") {
    const info = strOrNull(result.info);
    const message = strOrNull(result.message);
    const code = `${info ?? ""} ${message ?? ""}`.toUpperCase();
    const errorCode = code.includes("TIMEOUT")
      ? "timeout"
      : code.includes("NETWORK") || code.includes("CONNECTION")
        ? "network"
        : "provider_error";
    return {
      ...base,
      status: "provider_error",
      routes: [],
      error_code: errorCode,
      message:
        message ??
        info ??
        (errorCode === "timeout" ? "公交规划请求超时" : "公交规划服务返回错误"),
    };
  }

  const plans = Array.isArray(result.plans) ? result.plans : [];
  const routes = plans
    .map((p, i) => parsePlan(p, i, ctx.queried_at))
    .filter((r): r is TransitRoute => r !== null);
  if (routes.length === 0) {
    return { ...base, status: "no_route", routes: [], error_code: null, message: "高德未返回可行公交/地铁方案" };
  }
  return { ...base, status: "ok", routes, error_code: null, message: null };
}

function pluginReady(AMap: AMapNamespace, name: string): boolean {
  const short = name.includes(".") ? name.slice(name.indexOf(".") + 1) : name;
  const bag = AMap as unknown as Record<string, unknown>;
  return Boolean(bag[name] ?? bag[short]);
}

function ensurePlugin(AMap: AMapNamespace, name: string, timeoutMs = PLUGIN_TIMEOUT_MS): Promise<void> {
  if (pluginReady(AMap, name)) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`高德插件 ${name} 加载超时`)), timeoutMs);
    try {
      AMap.plugin([name], () => {
        clearTimeout(timer);
        if (pluginReady(AMap, name)) resolve();
        else reject(new Error(`高德插件 ${name} 回调已触发但不可用`));
      });
    } catch (err) {
      clearTimeout(timer);
      reject(new Error(`加载高德插件 ${name} 失败：${err instanceof Error ? err.message : String(err)}`));
    }
  });
}

/** 把“江西省南昌市青山湖区”“上海市黄浦区”这类字符串归一为城市名 */
function normalizeCity(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (s === "") return null;
  const cityIdx = s.indexOf("市");
  if (cityIdx > 0) {
    const withCity = s.slice(0, cityIdx + 1);
    const provinceIdx = withCity.lastIndexOf("省");
    return provinceIdx >= 0 ? withCity.slice(provinceIdx + 1) : withCity;
  }
  return s;
}

/** 城市兜底：起点/终点都没有城市时用高德 CitySearch 取当前城市 */
async function getLocalCity(AMap: AMapNamespace): Promise<string | null> {
  try {
    await ensurePlugin(AMap, "AMap.CitySearch");
    if (!AMap.CitySearch) return null;
    return await new Promise<string | null>((resolve) => {
      let settled = false;
      const done = (v: string | null) => {
        if (!settled) {
          settled = true;
          resolve(v);
        }
      };
      const timer = setTimeout(() => done(null), CITY_TIMEOUT_MS);
      try {
        const search = new AMap.CitySearch();
        search.getLocalCity((status: unknown, result: any) => {
          clearTimeout(timer);
          done(status === "complete" && typeof result?.city === "string" ? result.city : null);
        });
      } catch {
        clearTimeout(timer);
        done(null);
      }
    });
  } catch {
    return null;
  }
}

/** 公交/地铁路线规划入口；内部生成 request_id / candidate_set_id */
export async function planTransit(input: PlanTransitInput): Promise<TransitSearchResult> {
  const requestId = genId();
  const candidateSetId = genId();
  const queriedAt = new Date().toISOString();
  const policyChoice = transitPolicyFor(input.preference);
  const stepFreeUnverified = input.needs_step_free === true;
  const ctx = {
    request_id: requestId,
    candidate_set_id: candidateSetId,
    origin: input.origin,
    destination: input.destination,
    queried_at: queriedAt,
    policy: policyChoice,
    step_free_unverified: stepFreeUnverified,
  };

  let AMap: AMapNamespace;
  try {
    AMap = input.amap ?? (await loadAmapWithPlugins(["AMap.Transfer"]));
    if (!AMap.Transfer) await ensurePlugin(AMap, "AMap.Transfer");
  } catch (err) {
    return {
      ...ctx,
      mode: "transit",
      status: "provider_error",
      routes: [],
      error_code: "plugin_missing",
      message: `公交规划插件不可用：${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!AMap.Transfer) {
    return {
      ...ctx,
      mode: "transit",
      status: "provider_error",
      routes: [],
      error_code: "plugin_missing",
      message: "公交规划插件 AMap.Transfer 不可用",
    };
  }

  const city =
    normalizeCity(input.city) ??
    normalizeCity(input.origin.city) ??
    normalizeCity(input.destination.city) ??
    (await getLocalCity(AMap));
  if (!city) {
    return {
      ...ctx,
      mode: "transit",
      status: "provider_error",
      routes: [],
      error_code: "missing_city",
      message: "公交规划需要城市：请把起点或终点改为带城市的地点后重试",
    };
  }

  const timeoutMs = input.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  return new Promise<TransitSearchResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (r: TransitSearchResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolve(r);
    };
    timer = setTimeout(() => {
      finish({
        ...ctx,
        mode: "transit",
        status: "provider_error",
        routes: [],
        error_code: "timeout",
        message: `公交路线规划超时（>${Math.round(timeoutMs / 1000)}s）：高德未返回结果，请重试`,
      });
    }, timeoutMs);

    try {
      const options: Record<string, unknown> = { city, autoFitView: false };
      // 少换乘/少步行：显式传给高德 Transfer，否则界面选择等于没选
      const policy = policyValue(policyChoice, AMap);
      if (policy !== null) options.policy = policy;
      const transfer = new AMap.Transfer(options);
      const origin = new AMap.LngLat(input.origin.lng, input.origin.lat);
      const destination = new AMap.LngLat(input.destination.lng, input.destination.lat);
      transfer.search(origin, destination, (status: unknown, result: unknown) => {
        finish(parseTransitResult({ status, result }, ctx));
      });
    } catch (err) {
      finish({
        ...ctx,
        mode: "transit",
        status: "provider_error",
        routes: [],
        error_code: "provider_error",
        message: `调用公交规划失败：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });
}
