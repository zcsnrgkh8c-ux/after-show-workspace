/**
 * 第二阶段「我的出行」契约（路径规划：定位 / 手选地点 / 高德真实路线 / 出行建议）。
 *
 * 归属：本文件是 travel 模块唯一契约源，由窗口4角色统一维护。
 * 不得与 shared/types.ts 的散场仿真模型混用，不进 SimulationResult / Scenario / ParsePatch。
 * 红线：
 * - 距离单位米、时间单位秒；坐标一律 GCJ-02，[lng, lat] 顺序。
 * - 所有数字必须来自高德真实返回；缺失字段为 null，禁止用直线距离/步速补造。
 * - 无台阶通行证据缺失必须如实 "unknown"，不能把缺失当作满足或当作不满足。
 */

export const TRAVEL_SCHEMA_VERSION = "1.0" as const;

/* ------------------------------------------------------------------ */
/* 地点                                                                */
/* ------------------------------------------------------------------ */

export type CoordSystem = "GCJ-02";

export type GeoPlaceSource = "geolocation" | "poi";

/** 已确认的真实地点（定位成功或用户点选 POI 后才产生） */
export interface GeoPlace {
  /** 前端生成的稳定标识（同一次会话内不重复） */
  place_id: string;
  /** 展示名称 */
  label: string;
  /** GCJ-02 经度，范围 [-180, 180] */
  lng: number;
  /** GCJ-02 纬度，范围 [-90, 90] */
  lat: number;
  coord_system: CoordSystem;
  source: GeoPlaceSource;
  /** 定位精度（米）；POI 选点为 null */
  accuracy_m: number | null;
  /** 来源说明（如 "GPS"、"IP近似"、"POI"），缺省 null */
  source_note: string | null;
  /** 城市/行政区（用于搜索范围），可空 */
  city: string | null;
  /** 地址，可空 */
  address: string | null;
}

/** 输入提示候选（尚未确认的地点，用户点选后才成为 GeoPlace） */
export interface PlaceSuggestion {
  suggestion_id: string;
  label: string;
  district: string | null;
  address: string | null;
  /** 有坐标才能直接确认；仅行政区/同名提示可能为 null，需二次解析或用户改选 */
  location: { lng: number; lat: number } | null;
}

/* ------------------------------------------------------------------ */
/* 路线请求与结果（前端 → 高德 JS SDK）                                  */
/* ------------------------------------------------------------------ */

/** 本阶段仅步行；公交（Transfer）作为后续小步扩展，不阻塞主链路 */
export type TravelMode = "walking";

export type PreferenceKind = "balanced" | "less_walking" | "less_transfer";

export interface TravelPreference {
  preference: PreferenceKind;
  /** 无台阶通行硬需求 */
  needs_step_free: boolean;
  /** 用户补充说明，服务端限长（≤200 字符），只作为数据不作为指令 */
  note: string | null;
}

export interface TravelRequest {
  request_id: string;
  origin: GeoPlace;
  destination: GeoPlace;
  mode: TravelMode;
  preference: TravelPreference;
}

export interface TravelRouteStep {
  instruction: string;
  distance_m: number | null;
  duration_s: number | null;
}

/** 台阶证据：unknown=未核实（缺字段）；satisfied/unsatisfied 必须有真实字段依据 */
export type StepFreeEvidence = "unknown" | "satisfied" | "unsatisfied";

export interface TravelRoute {
  route_id: string;
  provider: "amap";
  /** ISO8601 查询时间 */
  queried_at: string;
  mode: TravelMode;
  distance_m: number | null;
  estimated_duration_s: number | null;
  walking_distance_m: number | null;
  transfer_count: number | null;
  steps: TravelRouteStep[];
  /** GCJ-02 [lng,lat] 折线；高德未返回时 null，禁止前端造直线 */
  polyline: Array<[number, number]> | null;
  step_free_evidence: StepFreeEvidence;
  step_free_note: string | null;
}

export type RouteSearchStatus = "ok" | "no_route" | "provider_error";

export interface RouteSearchResult {
  request_id: string;
  candidate_set_id: string;
  origin: GeoPlace;
  destination: GeoPlace;
  mode: TravelMode;
  status: RouteSearchStatus;
  routes: TravelRoute[];
  /** provider_error 时的错误类别（如 invalid_key / quota_exceeded / timeout / network） */
  error_code: string | null;
  message: string | null;
}

/* ------------------------------------------------------------------ */
/* 出行建议（前端 → 服务端 POST /api/travel/advice）                    */
/* ------------------------------------------------------------------ */

/** 发给服务端的候选摘要：剔除坐标、地址与完整折线，模型无需内容不外发 */
export interface RouteCandidateSummary {
  route_id: string;
  mode: TravelMode;
  distance_m: number | null;
  estimated_duration_s: number | null;
  walking_distance_m: number | null;
  transfer_count: number | null;
  step_free_evidence: StepFreeEvidence;
}

export interface AdviceRequest {
  request_id: string;
  candidate_set_id: string;
  preference: TravelPreference;
  /** 1~6 条，route_id 在集合内唯一 */
  candidates: RouteCandidateSummary[];
}

/** mode=llm 仅在真实模型调用成功且输出通过校验时允许；失败降级为 rules */
export type AdviceMode = "llm" | "rules" | "unavailable";

export type AdviceReasonCode =
  | "single_candidate"
  | "shorter_duration"
  | "less_walking"
  | "fewer_transfers"
  | "balanced_default"
  | "step_free_satisfied"
  | "no_candidate_meets_preference";

/** 证据引用：仅允许指向候选摘要中真实存在且非 null 的指标字段 */
export type AdviceMetricField =
  | "distance_m"
  | "estimated_duration_s"
  | "walking_distance_m"
  | "transfer_count"
  | "step_free_evidence";

export interface AdviceEvidenceRef {
  route_id: string;
  metric: AdviceMetricField;
}

export interface AdviceResponse {
  request_id: string;
  candidate_set_id: string;
  mode: AdviceMode;
  selected_route_id: string | null;
  reason_codes: AdviceReasonCode[];
  evidence: AdviceEvidenceRef[];
  /** 服务端校验后的说明文字（≤500 字符），数字由程序从候选事实填入 */
  explanation: string;
  warnings: string[];
  /** llm 失败降级到 rules 时填 "llm"，纯 rules 为 null；不得把 rules 标成 AI */
  degraded_from: "llm" | null;
}
