/**
 * 共同接口契约 1.0（依据 05_共同接口与联调约定）。
 *
 * 归属说明：按 05 约定由 A 发布并维护核心仿真类型，B 的 HTTP/Trace 类型
 * 也在本文件统一发布。A 的 canonical 名称为主；B 旧名称仅保留为类型别名，
 * 不形成第二套 JSON schema。字段变更须先同步 05 与三方调用方。
 */

export const SCHEMA_VERSION = "1.0" as const;
export const DEFAULT_DEMO_SEED = 20261114;

export type SchemaVersion = typeof SCHEMA_VERSION;

/* ------------------------------------------------------------------ */
/* Scenario                                                            */
/* ------------------------------------------------------------------ */

export type NodeKind = "source" | "exit" | "stop";

export interface ScenarioNode {
  node_id: string;
  kind: NodeKind;
  x: number;
  y: number;
  /** 仅 stop 节点使用；近似站点装载资源占用 */
  boarding_gap_s?: number;
}

export interface ScenarioEdge {
  edge_id: string;
  from: string;
  to: string;
  travel_s: number;
  /** 人/分钟 */
  capacity_per_min: number;
  step_free: boolean;
  closed: boolean;
}

export interface ScenarioRoute {
  route_id: string;
  edge_ids: string[];
  stop_id: string;
}

export interface ScenarioGroup {
  group_id: string;
  count: number;
  release_start_s: number;
  release_end_s: number;
  needs_step_free: boolean;
  /** 乘在通道步行时间上，1.5 表示耗时增加 50% */
  walk_time_factor: number;
  board_deadline_s: number | null;
}

/** B 旧名称别名；新代码使用 A 发布的 ScenarioGroup。 */
export type DemandGroup = ScenarioGroup;

export interface FleetVehicle {
  vehicle_id: string;
  capacity: number;
  available_from_s: number;
  round_trip_s: number;
}

/** B 旧名称别名；新代码使用 A 发布的 FleetVehicle。 */
export type Vehicle = FleetVehicle;

export interface Scenario {
  schema_version: SchemaVersion;
  scenario_id: string;
  revision: number;
  title: string;
  demand_source: string;
  horizon_s: number;
  step_s: number;
  nodes: ScenarioNode[];
  edges: ScenarioEdge[];
  routes: ScenarioRoute[];
  groups: ScenarioGroup[];
  fleet: FleetVehicle[];
}

/* ------------------------------------------------------------------ */
/* Plan                                                                */
/* ------------------------------------------------------------------ */

export type PlanStrategy = "baseline" | "independent" | "coordinated";
/** B 旧名称别名；新代码使用 A 发布的 PlanStrategy。 */
export type Strategy = PlanStrategy;
export type Objective = "efficiency" | "inclusion" | "balanced";

export interface RouteShare {
  route_id: string;
  share: number;
}

export interface GroupAllocation {
  group_id: string;
  /** 空数组表示该组暂不分配路线，留在 S 等待，不能从总人数中删除 */
  routes: RouteShare[];
}

export interface PlannedDeparture {
  vehicle_id: string;
  stop_id: string;
  depart_s: number;
}

/** B 旧名称别名；新代码使用 A 发布的 PlannedDeparture。 */
export type Departure = PlannedDeparture;

export interface Plan {
  schema_version: SchemaVersion;
  plan_id: string;
  scenario_id: string;
  scenario_revision: number;
  strategy: PlanStrategy;
  name: string;
  allocations: GroupAllocation[];
  departures: PlannedDeparture[];
  notes?: string[];
}

/* ------------------------------------------------------------------ */
/* Validation / Simulation                                             */
/* ------------------------------------------------------------------ */

export type Severity = "error" | "warning";

export interface ValidationIssue {
  code: string;
  path: string;
  message: string;
  severity: Severity;
}

export interface Metrics {
  released_count: number;
  boarded_count: number;
  remaining_count: number;
  mean_queue_wait_all_released_s: number | null;
  p95_queue_wait_boarded_s: number | null;
  missed_deadline_count: number;
  clearance_time_s: number | null;
}

export interface GroupMetrics extends Metrics {
  group_id: string;
}

export interface GroupFrameCounts {
  released_count: number;
  boarded_count: number;
  queued_count: number;
  walking_count: number;
}

export interface TimelineFrame {
  t_s: number;
  released_count: number;
  boarded_count: number;
  queued_count: number;
  walking_count: number;
  node_queues: Record<string, number>;
  edge_counts: Record<string, number>;
  group_counts: Record<string, GroupFrameCounts>;
}

/** B 旧名称别名；新代码使用 A 发布的 GroupFrameCounts。 */
export type GroupCounts = GroupFrameCounts;

export interface DepartureLogEntry {
  vehicle_id: string;
  stop_id: string;
  depart_s: number;
  boarded_count: number;
}

/** B 旧名称别名；新代码使用 A 发布的 DepartureLogEntry。 */
export type DepartureLog = DepartureLogEntry;

export type SimulationStatus = "valid" | "invalid" | "error";
/** B 旧名称别名；新代码使用 A 发布的 SimulationStatus。 */
export type ResultStatus = SimulationStatus;

export interface SimulationResult {
  schema_version: SchemaVersion;
  engine_version: string;
  /** 输入结构损坏时身份字段允许为 null，不以空字符串伪造身份。 */
  scenario_id: string | null;
  scenario_revision: number | null;
  plan_id: string | null;
  seed: number | null;
  status: SimulationStatus;
  violations: ValidationIssue[];
  metrics: Metrics | null;
  group_metrics: GroupMetrics[];
  timeline: TimelineFrame[];
  departures_log: DepartureLogEntry[];
}

/* ------------------------------------------------------------------ */
/* Trace                                                               */
/* ------------------------------------------------------------------ */

export type TraceSource = "llm" | "rules" | "simulator" | "validator" | "cache";
export type TraceStatus = "ok" | "rejected" | "error";
export type DecisionMode = "llm" | "rules";

export interface TraceStep {
  step: number;
  actor: string;
  action: string;
  source: TraceSource;
  summary: string;
  input_ref: string;
  output_ref: string;
  status: TraceStatus;
  duration_ms?: number;
}

/* ------------------------------------------------------------------ */
/* Patch                                                               */
/* ------------------------------------------------------------------ */

export type EdgePatchField = "closed" | "travel_s" | "capacity_per_min";
export type GroupPatchField = "count" | "walk_time_factor" | "board_deadline_s";

export interface EdgePatch {
  target: "edge";
  id: string;
  field: EdgePatchField;
  value: boolean | number;
}

export interface GroupPatch {
  target: "group";
  id: string;
  field: GroupPatchField;
  value: number | null;
}

export interface VehicleRemovalPatch {
  target: "vehicle";
  id: string;
  field: "enabled";
  value: false;
}

export type ParsePatch = EdgePatch | GroupPatch | VehicleRemovalPatch;

/* ------------------------------------------------------------------ */
/* Recommendation                                                      */
/* ------------------------------------------------------------------ */

export type RecommendationStatus = "recommended" | "tradeoff" | "no_valid_candidate";

export interface Recommendation {
  plan_id: string | null;
  status: RecommendationStatus;
  reason: string;
  tradeoffs: string[];
}

/* ------------------------------------------------------------------ */
/* HTTP request / response                                             */
/* ------------------------------------------------------------------ */

export interface HealthResponse {
  status: "ok";
  schema_version: SchemaVersion;
  engine_ready: boolean;
  llm_configured: boolean;
}

export interface ParseRequest {
  scenario: Scenario;
  instruction: string;
}

export interface ParseResponse {
  patch: ParsePatch[];
  summary: string;
  warnings: string[];
  mode: DecisionMode;
}

export interface GenerateRequest {
  scenario: Scenario;
  objective: Objective;
  seed: number;
}

export interface GenerateResponse {
  plans: Plan[];
  trace: TraceStep[];
  mode: DecisionMode;
}

export interface SimulateRequest {
  scenario: Scenario;
  plan: Plan;
  seed: number;
}

export interface CompareRequest {
  scenario: Scenario;
  plans: Plan[];
  seed: number;
  objective: Objective;
}

export interface CompareResponse {
  results: SimulationResult[];
  recommendation: Recommendation;
  trace: TraceStep[];
  mode: DecisionMode;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}
