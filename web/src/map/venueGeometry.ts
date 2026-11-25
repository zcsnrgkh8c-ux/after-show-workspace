/**
 * 场馆真实几何布点（仅展示层）：
 * 用高德 POI 检索把场景节点钉到真实场馆的「各个门」与最近接驳站点上。
 *
 * 需求：出口 E1/E2/E3 不应是随手摆放的示意点，而应对应场馆真实存在的门。
 * 做法：搜索场馆 → 周边搜索「门」→ 按方位角顺时针分配 E1/E2/E3；
 *      周边搜索「地铁站」（不足则「公交站」）→ 按距离分配 P1/P2。
 *
 * 诚实边界：
 * - 坐标来自高德 POI，未经实地核实，生成结果始终 coordVerified=false；
 * - 搜不到的门/站点不编造：对应节点保留原示意坐标，并在 notes/missingNodes 中如实列出；
 * - 仅用于展示映射，绝不进入推演计算（Scenario 的 0~100 示意坐标不变）。
 */
import type { LngLat, GeoMapping } from "./config";
import type { AmapNamespace } from "./types";
import { ensureLocatePlugins } from "./locate";

export interface NearbyPoi {
  name: string;
  position: LngLat;
  /** 距检索中心的距离（米）；高德返回字符串，已转数字 */
  distanceM?: number;
  /** POI 所在城市（来自 PlaceSearch；用于把 AutoComplete 限定到我所在的城市） */
  cityName?: string;
}

export interface NearbySearchPort {
  /** 场馆名 → 场馆中心与规范名称 */
  searchFirst(keyword: string): Promise<{ position: LngLat; name: string } | null>;
  /** 以 center 为圆心周边搜索；不支持周边搜索时返回空数组 */
  searchNearby(keyword: string, center: LngLat, radiusM: number): Promise<NearbyPoi[]>;
  /**
   * 输入提示检索。高校校门等低权重 POI 用 PlaceSearch 搜不到，
   * 但 AutoComplete 能返回（实测：华东交通大学 5 个校门只能这样拿到）。
   * city 给定时按城市限定（泛词召回的关键），未给定时全国检索。
   */
  autocomplete?(keyword: string, city?: string): Promise<NearbyPoi[]>;
}

export interface VenueGeometry {
  geo: GeoMapping;
  /** 数据来源与降级说明（界面如实展示） */
  notes: string[];
  /** 未能在 POI 中找到、只能沿用原示意坐标的节点 */
  missingNodes: string[];
}

export interface VenueGeometryOptions {
  /** 搜索半径：门（米） */
  gateRadiusM?: number;
  /** 搜索半径：接驳站点（米） */
  stopRadiusM?: number;
}

const GATE_POI_LIMIT = 6;
const STOP_POI_LIMIT = 4;

/** 常见城市前缀：POI 常把场馆存为“广州天河体育中心”，而门存为“天河体育中心北门” */
const CITY_PREFIXES = [
  "广州", "北京", "上海", "深圳", "杭州", "成都", "武汉", "西安", "南京", "重庆",
  "天津", "苏州", "长沙", "郑州", "青岛", "沈阳", "昆明", "合肥", "福州", "厦门",
  "济南", "南宁", "海口", "兰州", "太原", "石家庄", "哈尔滨", "长春", "大连", "宁波",
  "无锡", "佛山", "东莞", "珠海",
];

/** 附属出入口：停车场、办公楼、地铁/公交站等，都不是场馆的观众出口 */
const AUXILIARY_PATTERN =
  /停车场|停车库|车库|办公楼|员工|内部|货运|消防|施工|绿化|垃圾|充电|设备|地铁站|公交站|车站|站厅|站台/;
/** 观众出入口的典型命名 */
const PREFERRED_PATTERN = /[东南西北][门入口]|[\d一二三四五六七八九十]+\s*号门|正门|大门|主入口|观众|球迷/;

/**
 * 名称是否真的是“出入口”：必须以门/出入口结尾（允许尾随括号）。
 * 只判断“含门”会把“华东交通大学-门诊部”这类 POI 误当成校门。
 */
export function isGateName(name: string): boolean {
  return /(门|入口)\s*[)）]?$/.test(name);
}

/** 去掉“（示意）”一类后缀与括号内容，得到可用于 POI 检索的场馆核心名 */
export function normalizeVenueKeyword(raw: string): string {
  return raw
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/\s+/g, "")
    .trim();
}

/**
 * 生成用于匹配门 POI 的核心词候选（任一命中即可）：
 * 全名、去城市前缀名、尾部 4 字。
 * 只取全名前 N 字会漏掉“广州天河体育中心” → “天河体育中心北门”这类写法，故必须多候选。
 */
export function venueCoreKeys(venueName: string): string[] {
  const core = normalizeVenueKeyword(venueName);
  if (core === "") return [];
  const keys = new Set<string>([core]);
  for (const p of CITY_PREFIXES) {
    if (core.startsWith(p) && core.length > p.length + 2) keys.add(core.slice(p.length));
  }
  if (core.length > 4) keys.add(core.slice(-4));
  return [...keys].filter((k) => k.length >= 2);
}

/** 两点间距离（米，Haversine） */
export function distanceM(a: LngLat, b: LngLat): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * 按地理位置去重：同一个门常被录成两条 POI（如“南区(北2门)”与“双港东校区南区(北2门)”，
 * 坐标仅差 1 米）。距离小于阈值视为同一个点，保留先出现的一条。
 */
export function dedupeByProximity(pois: NearbyPoi[], thresholdM = 30): NearbyPoi[] {
  const kept: NearbyPoi[] = [];
  for (const p of pois) {
    if (kept.some((k) => distanceM(k.position, p.position) < thresholdM)) continue;
    kept.push(p);
  }
  return kept;
}

/** 相对场馆中心的方位角（0=正北，顺时针） */
export function bearingDeg(center: LngLat, p: LngLat): number {
  const latRad = (center[1] * Math.PI) / 180;
  const dx = (p[0] - center[0]) * Math.cos(latRad);
  const dy = p[1] - center[1];
  let deg = (Math.atan2(dx, dy) * 180) / Math.PI;
  if (deg < 0) deg += 360;
  return deg;
}

/**
 * 判断 POI 是否像“这个场馆的门”：名称必须含方位/编号特征，且命中任一核心词。
 * 只放宽到“含门”会把远处小区的门当成出口，因此核心词不命中一律不采用。
 *
 * 停车场/办公楼等附属出入口优先排除：它们不是观众出口，
 * 但若场馆只有这些 POI（高德数据常见），退回使用并在说明中明确标注。
 */
export function pickGates(venueName: string, pois: NearbyPoi[]): NearbyPoi[] {
  const keys = venueCoreKeys(venueName);
  const base = pois.filter(
    (p) => isGateName(p.name) && (keys.length === 0 || keys.some((k) => p.name.includes(k)))
  );
  const preferred = base.filter((p) => !AUXILIARY_PATTERN.test(p.name));
  if (preferred.length > 0) {
    // 方位门/编号门优先，其余次之
    return preferred.sort(
      (a, b) => (PREFERRED_PATTERN.test(b.name) ? 1 : 0) - (PREFERRED_PATTERN.test(a.name) ? 1 : 0)
    );
  }
  return base;
}

/** 是否为附属出入口（停车场、办公楼等，非观众出口） */
export function isAuxiliaryGate(name: string): boolean {
  return AUXILIARY_PATTERN.test(name);
}

/** 生成展示用几何：成功部分来自 POI，失败部分沿用 fallback 中的原坐标 */
export function buildVenueGeometry(
  venue: { position: LngLat; name: string },
  rawGates: NearbyPoi[],
  rawStops: NearbyPoi[],
  fallback: GeoMapping | null
): VenueGeometry {
  const notes: string[] = [];
  const missingNodes: string[] = [];

  const gates = pickGates(venue.name, rawGates)
    .slice(0, GATE_POI_LIMIT)
    .sort((a, b) => bearingDeg(venue.position, a.position) - bearingDeg(venue.position, b.position));

  const nodes: Record<string, LngLat> = { S: venue.position };

  const exitIds = ["E1", "E2", "E3"];
  exitIds.forEach((id, i) => {
    const gate = gates[i];
    if (gate) {
      nodes[id] = gate.position;
    } else {
      const fb = fallback?.nodes[id];
      if (fb) nodes[id] = fb;
      missingNodes.push(id);
    }
  });

  const stops = [...rawStops].slice(0, STOP_POI_LIMIT);
  const stopIds = ["P1", "P2"];
  stopIds.forEach((id, i) => {
    const stop = stops[i];
    if (stop) {
      nodes[id] = stop.position;
    } else {
      const fb = fallback?.nodes[id];
      if (fb) nodes[id] = fb;
      missingNodes.push(id);
    }
  });

  if (gates.length > 0) {
    const auxOnly = gates.every((g) => isAuxiliaryGate(g.name));
    if (auxOnly) {
      notes.push(
        `未找到观众出入口，以下为场馆附属出入口（停车场等），仅供参考：${gates.map((g) => g.name).join("、")}`
      );
    } else {
      notes.push(
        `出口坐标来自高德 POI：${venue.name} 周边找到 ${gates.length} 个门（${gates.map((g) => g.name).join("、")}），按方位角顺时针分配`
      );
    }
  } else {
    notes.push("未在 POI 中找到该场馆的门，出口沿用原示意坐标");
  }
  if (stops.length > 0) {
    notes.push(`接驳点坐标来自最近的接驳站点：${stops.map((s) => s.name).join("、")}`);
  } else {
    notes.push("未在 POI 中找到周边接驳站点，接驳点沿用原示意坐标");
  }
  if (missingNodes.length > 0) {
    notes.push(`以下节点未获取到真实坐标，保留原示意位置：${missingNodes.join("、")}`);
  }
  notes.push("以上坐标来自高德 POI 检索，未实地核实，仅作布局示意；不进入推演计算");

  return {
    geo: {
      venueName: venue.name,
      coordVerified: false, // POI 检索不等于实地核实，必须保持 false
      center: venue.position,
      nodes,
      // 不生成 edges：由地图按两端直连并标注“模拟通道示意”
    },
    notes,
    missingNodes,
  };
}

/* ---------- AMap 适配 ---------- */

function toPoiList(raw: { name?: string; location?: { lng: number; lat: number }; distance?: string | number; cityname?: string }[]): NearbyPoi[] {
  return raw
    .filter((p): p is { name: string; location: { lng: number; lat: number }; distance?: string | number; cityname?: string } =>
      typeof p.name === "string" && p.name !== "" && p.location !== undefined
    )
    .map((p) => {
      const d = typeof p.distance === "number" ? p.distance : typeof p.distance === "string" ? Number(p.distance) : NaN;
      return {
        name: p.name,
        position: [p.location.lng, p.location.lat] as LngLat,
        distanceM: Number.isFinite(d) ? d : undefined,
        cityName: typeof p.cityname === "string" && p.cityname !== "" ? p.cityname : undefined,
      };
    });
}

export function createNearbySearchPort(AMap: AmapNamespace): NearbySearchPort {
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
                const pois = toPoiList(result.poiList.pois);
                const first = pois[0];
                if (first) resolve({ position: first.position, name: first.name });
                else resolve(null);
              } else if (status === "no_data") {
                resolve(null);
              } else {
                reject(new Error(`场馆检索失败${result.info ? `：${result.info}` : ""}`));
              }
            });
          })
      ),

    searchNearby: (keyword, center, radiusM) =>
      ensureLocatePlugins(AMap).then(
        () =>
          new Promise<NearbyPoi[]>((resolve) => {
            if (!AMap.PlaceSearch) {
              resolve([]);
              return;
            }
            const ps = new AMap.PlaceSearch({ pageSize: 20 });
            if (typeof ps.searchNearBy !== "function") {
              // 该 SDK 版本不支持周边搜索：返回空，由上层如实标注“沿用示意坐标”
              resolve([]);
              return;
            }
            ps.searchNearBy(keyword, center, radiusM, (status, result) => {
              if (status === "complete" && result.poiList?.pois) {
                resolve(toPoiList(result.poiList.pois));
              } else {
                resolve([]); // 周边无结果不是异常，交由上层如实说明
              }
            });
          })
      ),

    // 输入提示：高校校门这类低权重 POI 只能通过 AutoComplete 拿到；
    // city 给定时限定到该城市（泛词召回的关键），未给定时全国检索
    autocomplete: (keyword, city) =>
      ensureLocatePlugins(AMap).then(
        () =>
          new Promise<NearbyPoi[]>((resolve) => {
            const run = (attempt: number) => {
              if (!AMap.AutoComplete) {
                resolve([]);
                return;
              }
              const ac = new AMap.AutoComplete(
                city ? { city, citylimit: true } : { citylimit: false }
              );
              ac.search(keyword, (status, result) => {
                if (status === "complete") {
                  const tips = (result && result.tips) || [];
                  resolve(
                    tips
                      .filter((t): t is { name: string; location: { lng: number; lat: number } } =>
                        typeof t.name === "string" && t.name !== "" && t.location !== undefined
                      )
                      .map((t) => ({
                        name: t.name,
                        position: [t.location.lng, t.location.lat] as LngLat,
                      }))
                  );
                  return;
                }
                // status=error 多为并发限流：延迟重试一次
                if (attempt < 1) {
                  setTimeout(() => run(attempt + 1), 300);
                  return;
                }
                resolve([]);
              });
            };
            run(0);
          })
      ),
  };
}

/** 一键布点：检索场馆及其门/接驳站点，生成展示几何（失败部分保留原示意坐标） */
export async function resolveVenueGeometry(
  port: NearbySearchPort,
  venueKeyword: string,
  fallback: GeoMapping | null,
  opts: VenueGeometryOptions = {}
): Promise<VenueGeometry | null> {
  const keyword = normalizeVenueKeyword(venueKeyword);
  if (keyword === "") return null;

  const venue = await port.searchFirst(keyword);
  if (!venue) return null;

  const gateRadiusM = opts.gateRadiusM ?? 600;
  const stopRadiusM = opts.stopRadiusM ?? 1500;

  // 校门检索双通道：
  // 1) AutoComplete 按“场馆名+方位/门”检索 —— 高校校门只有这里能搜到；
  // 2) PlaceSearch 周边搜“门/入口” —— 覆盖商场、场馆等 NameSearch 能返回的情况。
  const AC_SUFFIXES = ["门", "西", "东", "南", "北", "校门", "正门"];
  const acKeywords = AC_SUFFIXES.map((s) => `${keyword}${s}`);

  const [acBatches, gateA, gateB, metro, bus] = await Promise.all([
    port.autocomplete
      ? mapInBatches(acKeywords, (k) => port.autocomplete!(k))
      : Promise.resolve([] as NearbyPoi[][]),
    port.searchNearby("门", venue.position, gateRadiusM),
    port.searchNearby("入口", venue.position, gateRadiusM),
    port.searchNearby("地铁站", venue.position, stopRadiusM),
    port.searchNearby("公交站", venue.position, stopRadiusM),
  ]);

  const seen = new Set<string>();
  const merged: NearbyPoi[] = [];
  for (const p of [...acBatches.flat(), ...gateA, ...gateB]) {
    const key = `${p.name}@${p.position[0]},${p.position[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(p);
  }
  const gates = dedupeByProximity(merged);

  // 地铁站优先，同类型按距离升序；不足 2 个再用公交站补
  const byDistance = (a: NearbyPoi, b: NearbyPoi) => (a.distanceM ?? Infinity) - (b.distanceM ?? Infinity);
  const stops = [...[...metro].sort(byDistance), ...[...bus].sort(byDistance)].slice(0, STOP_POI_LIMIT);

  return buildVenueGeometry(venue, gates, stops, fallback);
}

/** 高德检索并发会限流（实测 20 并发约 35% 返回 error），统一分批执行 */
const SEARCH_BATCH_SIZE = 4;
const SEARCH_BATCH_GAP_MS = 150;

async function mapInBatches<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += SEARCH_BATCH_SIZE) {
    const batch = items.slice(i, i + SEARCH_BATCH_SIZE);
    out.push(...(await Promise.all(batch.map(fn))));
    if (i + SEARCH_BATCH_SIZE < items.length) {
      await new Promise((r) => setTimeout(r, SEARCH_BATCH_GAP_MS));
    }
  }
  return out;
}

/* ---------- 以“我的位置”为中心检索附近出口 ---------- */

/** 可能带有观众出入口的场所类型（用于以我的位置为中心时先找场馆） */
const NEARBY_VENUE_KEYWORDS = ["大学", "学院", "体育中心", "体育馆", "会展中心", "剧院", "场馆", "学校", "广场"];
const NEARBY_MAX_VENUES = 4;
/** 最近召回场馆距配置主场馆多近时，才沿用主场馆名检索门（同校区） */
const BASE_HINT_NEAR_M = 600;
/** 同一场地内的父/子设施（如体育中心与其体育馆）视为同一归属 */
const SAME_COMPLEX_M = 300;
const GATE_SUFFIXES = ["门", "西", "东", "南", "北"];

/**
 * 两个场所名是否同源（如“华东交通大学南区田径场” ⊂ “华东交通大学”）：
 * 用于判断召回的子设施是否可以沿用主场馆名检索门。
 * 仅靠距离不够——交大旁边 500m 的“南昌国际体育中心”并不是交大的子设施。
 */
function namesRelated(a: string, b: string): boolean {
  const na = normalizeVenueKeyword(a);
  const nb = normalizeVenueKeyword(b);
  if (na === "" || nb === "") return false;
  return na.includes(nb) || nb.includes(na);
}

export interface NearbyGateResult {
  /** 最近的门/出入口，按距我的位置升序 */
  gates: NearbyPoi[];
  /** 找到的场馆，按距离升序 */
  venues: NearbyPoi[];
}

export interface NearbyGateOptions {
  /** 我所在的城市（AutoComplete 城市限定；泛词全国召回不到具体场馆） */
  city?: string;
  /**
   * 主场馆名提示（可选）：周边召回的常是“南区田径场/体育馆”这类子设施，
   * 校门挂在主场馆名下——“子设施名+方位”检索不到时，“主场馆名+方位”能召回。
   * 仅当最近召回场馆也在主场馆范围内（venueAnchor 600m 内）才会生效。
   */
  venueKeyword?: string;
  /**
   * 主场馆参考坐标（配置的场馆 S/center）：用于判断主名提示是否适用于当前位置，
   * 避免在别处仍用默认主场馆名检索、把原场馆的门算到新地点头上。
   */
  venueAnchor?: LngLat;
}

/**
 * 以用户当前位置为中心搜索附近场馆的出口。
 * 场馆召回双通道（缺一不可）：
 * 1) PlaceSearch.searchNearby —— 覆盖 NameSearch 能召回的场馆；
 * 2) AutoComplete 按场馆类型关键词检索 —— 实测 searchNearby 对大学/场馆类 POI
 *    经常不召回（与 §9 低权重问题同源），输入提示能返回。
 * AutoComplete 是城市级检索：泛词（“大学”）全国召回不到具体场馆，
 * 必须限定到“我所在的城市”——city 来自 opts.city（map.getCity，中心即定位点）；
 * 未提供时全国检索（召回可能为空，由上层如实提示，不编造）。
 * AutoComplete 结果按 Haversine 裁剪到 radiusM 内。
 */
export async function findNearbyGates(
  port: NearbySearchPort,
  center: LngLat,
  radiusM = 3000,
  opts: NearbyGateOptions = {}
): Promise<NearbyGateResult> {
  const city = typeof opts.city === "string" && opts.city.trim() !== "" ? opts.city.trim() : undefined;
  const venueKeyword =
    typeof opts.venueKeyword === "string" ? normalizeVenueKeyword(opts.venueKeyword) : "";

  const venueBatches = await mapInBatches(NEARBY_VENUE_KEYWORDS, (k) =>
    port.searchNearby(k, center, radiusM)
  );

  // AutoComplete 是城市级检索：结果需按距我的位置过滤到请求半径内
  const acVenueBatches = port.autocomplete
    ? await mapInBatches(NEARBY_VENUE_KEYWORDS, (k) => port.autocomplete!(k, city))
    : ([] as NearbyPoi[][]);

  const venuePool = dedupeByProximity(
    [...venueBatches.flat(), ...acVenueBatches.flat()]
      .filter((v) => !AUXILIARY_PATTERN.test(v.name))
      .map((v) => ({ ...v, distanceM: distanceM(center, v.position) }))
      .filter((v) => (v.distanceM ?? Infinity) <= radiusM)
  )
    .sort((a, b) => (a.distanceM ?? Infinity) - (b.distanceM ?? Infinity))
    .slice(0, NEARBY_MAX_VENUES);

  // 没召回任何场馆时不检索门：否则会凭空复用主场馆名，把原场馆的门挂到新地点
  if (venuePool.length === 0) return { gates: [], venues: [] };

  const nearest = venuePool[0];
  const anchorDistance = opts.venueAnchor ? distanceM(nearest.position, opts.venueAnchor) : 0;
  // 只有最近场馆确实在配置主场馆范围内（同校区/子设施），且名称与主场馆同源时，
  // 才沿用主场馆名；在附近选中其他场馆（如“南昌国际体育中心”）时用该场馆自己的名字，
  // 否则会把它 3km 内的默认场馆（华交）门错误归属到新场馆。
  const useBaseHint =
    venueKeyword !== "" &&
    anchorDistance <= BASE_HINT_NEAR_M &&
    namesRelated(nearest.name, venueKeyword);
  const attributionName = useBaseHint
    ? venueKeyword
    : normalizeVenueKeyword(nearest.name) || nearest.name;

  // 门检索关键词：归属场馆名 + 同一场地内（300m）的父/子设施名，各自加方位后缀；
  // 校门挂在主场馆名下，仅用子设施名（“南区田径场+西”）会全部落空
  const nameKeys = new Set<string>([attributionName]);
  for (const v of venuePool) {
    if (distanceM(nearest.position, v.position) <= SAME_COMPLEX_M) {
      const k = normalizeVenueKeyword(v.name);
      if (k !== "") nameKeys.add(k);
    }
  }
  const gateKeywords = new Set<string>();
  for (const k of nameKeys) for (const s of GATE_SUFFIXES) gateKeywords.add(`${k}${s}`);

  const gateBatches = await mapInBatches([...gateKeywords], (kw) =>
    port.autocomplete ? port.autocomplete(kw, city) : Promise.resolve([] as NearbyPoi[])
  );

  // 只采用归属场馆（或同场地父/子设施）名下的门，再做半径裁剪：
  // AutoComplete 是城市级检索，会混入别处同名/同类型场馆的门。
  const candidates = dedupeByProximity(gateBatches.flat()).filter((g) => isGateName(g.name));
  const attributed = dedupeByProximity(
    [...nameKeys].flatMap((name) => pickGates(name, candidates))
  );
  const gates = attributed
    .map((g) => ({ ...g, distanceM: distanceM(center, g.position) }))
    .filter((g) => (g.distanceM ?? Infinity) <= radiusM)
    .sort((a, b) => (a.distanceM ?? Infinity) - (b.distanceM ?? Infinity));

  return { gates, venues: venuePool };
}

/**
 * 生成“以我的位置找出口”的展示布点：
 * - 只写入真实检索到的出口/接驳点，缺失节点不沿用原场馆坐标（避免跨场馆连线）；
 * - 一个出口都没找到时只保留 S（我的位置），用于清空上一地点的场馆布局。
 */
export function buildNearbyLayout(
  myLocation: LngLat,
  venues: NearbyPoi[],
  gates: NearbyPoi[],
  stops: NearbyPoi[]
): { geo: GeoMapping; notes: string[] } {
  const venueName = venues[0]?.name ?? "我的位置附近";
  const origin = venues[0]?.position ?? myLocation;

  if (gates.length === 0) {
    return {
      geo: { venueName, coordVerified: false, center: origin, nodes: { S: origin } },
      notes: [
        `我的位置周边 3km 内没有找到场馆出入口${venues[0] ? `（最近场馆：${venueName}）` : ""}，已清空原场馆布局。`,
        "可换个地点或扩大范围后重试；当前仅保留“我的位置”标记。",
      ],
    };
  }

  const nodes: Record<string, LngLat> = { S: origin };
  (["E1", "E2", "E3"] as const).forEach((id, i) => {
    const g = gates[i];
    if (g) nodes[id] = g.position;
  });
  (["P1", "P2"] as const).forEach((id, i) => {
    const s = stops[i];
    if (s) nodes[id] = s.position;
  });

  return {
    geo: { venueName, coordVerified: false, center: nodes.S, nodes },
    notes: [
      `以我的位置为圆心，找到 ${gates.length} 个出入口，最近的已设为 E1/E2/E3：`,
      ...gates.slice(0, 3).map((g) => `${g.name}（距我 ${Math.round(g.distanceM ?? 0)}m）`),
      gates.length < 3 ? "出口不足 3 个：未找到的节点不再用原场馆坐标补齐" : "",
      stops.length > 0 ? `接驳点取最近站点：${stops.map((s) => s.name).join("、")}` : "未找到周边地铁/公交站",
      "坐标来自高德 POI，未实地核实，仅作布局示意；不进入推演计算",
    ].filter((line) => line !== ""),
  };
}
