/**
 * 五个接口的运行时响应校验（联调加固要求2）。
 * 只按 05 契约检查必需字段的存在性与类型；校验失败抛 ApiError("bad_response")，
 * 由调用方显式报错，绝不把残缺响应当正常结果使用。
 */
import { ApiError } from "./errors";
import type {
  CompareResponse,
  GenerateResponse,
  HealthResponse,
  ParseResponse,
  SimulationResult,
} from "../contract/types";

function fail(where: string, expect?: string): never {
  throw new ApiError("bad_response", `响应格式不符：${where}${expect ? `（应为 ${expect}）` : ""}`);
}
function obj(d: unknown, where: string): Record<string, unknown> {
  if (typeof d !== "object" || d === null || Array.isArray(d)) fail(where, "object");
  return d as Record<string, unknown>;
}
function str(d: unknown, where: string): string {
  if (typeof d !== "string") fail(where, "string");
  return d;
}
function num(d: unknown, where: string): number {
  if (typeof d !== "number" || !Number.isFinite(d)) fail(where, "number");
  return d;
}
function int(d: unknown, where: string): number {
  const n = num(d, where);
  if (!Number.isInteger(n)) fail(where, "integer");
  return n;
}
function bool(d: unknown, where: string): boolean {
  if (typeof d !== "boolean") fail(where, "boolean");
  return d;
}
function nullableNum(d: unknown, where: string): number | null {
  if (d === null) return null;
  return num(d, where);
}
function nullableStr(d: unknown, where: string): string | null {
  if (d === null) return null;
  return str(d, where);
}
function nullableInt(d: unknown, where: string): number | null {
  if (d === null) return null;
  return int(d, where);
}
function arr(d: unknown, where: string): unknown[] {
  if (!Array.isArray(d)) fail(where, "array");
  return d;
}
function oneOf<T extends string>(d: unknown, where: string, values: readonly T[]): T {
  if (typeof d !== "string" || !values.includes(d as T)) fail(where, values.join("|"));
  return d as T;
}
function strArr(d: unknown, where: string): string[] {
  return arr(d, where).map((x, i) => str(x, `${where}[${i}]`));
}
function numRecord(d: unknown, where: string): Record<string, number> {
  const o = obj(d, where);
  for (const [k, v] of Object.entries(o)) num(v, `${where}.${k}`);
  return o as Record<string, number>;
}

const MODES = ["llm", "rules"] as const;
const STRATEGIES = ["baseline", "independent", "coordinated"] as const;
const RESULT_STATUS = ["valid", "invalid", "error"] as const;
const SEVERITIES = ["error", "warning"] as const;
const TRACE_SOURCES = ["llm", "rules", "simulator", "validator", "cache"] as const;
const TRACE_STATUS = ["ok", "rejected", "error"] as const;
const RECOMMENDATION_STATUS = ["recommended", "tradeoff", "no_valid_candidate"] as const;
const EDGE_FIELDS = ["closed", "travel_s", "capacity_per_min"] as const;
const GROUP_FIELDS = ["count", "walk_time_factor", "board_deadline_s"] as const;

/** 按共享 ParsePatch 判别联合逐项校验；未知目标/字段一律拒绝，不放宽契约 */
function validatePatchItem(item: unknown, where: string): void {
  const p = obj(item, where);
  const target = oneOf(p.target, `${where}.target`, ["edge", "group", "vehicle"] as const);
  str(p.id, `${where}.id`);
  if (!("value" in p)) fail(`${where}.value`, "存在");
  if (target === "edge") {
    const field = oneOf(p.field, `${where}.field`, EDGE_FIELDS);
    if (field === "closed") bool(p.value, `${where}.value`);
    else num(p.value, `${where}.value`);
    return;
  }
  if (target === "group") {
    const field = oneOf(p.field, `${where}.field`, GROUP_FIELDS);
    if (p.value === null) {
      if (field !== "board_deadline_s") fail(`${where}.value`, "仅 board_deadline_s 允许 null");
      return;
    }
    num(p.value, `${where}.value`);
    return;
  }
  if (p.field !== "enabled") fail(`${where}.field`, "enabled");
  if (p.value !== false) fail(`${where}.value`, "false");
}

export function validateHealth(d: unknown): HealthResponse {
  const o = obj(d, "health");
  str(o.status, "health.status");
  str(o.schema_version, "health.schema_version");
  bool(o.engine_ready, "health.engine_ready");
  bool(o.llm_configured, "health.llm_configured");
  return o as unknown as HealthResponse;
}

export function validateParseResponse(d: unknown): ParseResponse {
  const o = obj(d, "parse");
  arr(o.patch, "parse.patch").forEach((item, i) => validatePatchItem(item, `parse.patch[${i}]`));
  str(o.summary, "parse.summary");
  strArr(o.warnings, "parse.warnings");
  oneOf(o.mode, "parse.mode", MODES);
  return o as unknown as ParseResponse;
}

function validatePlan(d: unknown, where: string): void {
  const p = obj(d, where);
  str(p.schema_version, `${where}.schema_version`);
  str(p.plan_id, `${where}.plan_id`);
  str(p.scenario_id, `${where}.scenario_id`);
  int(p.scenario_revision, `${where}.scenario_revision`);
  oneOf(p.strategy, `${where}.strategy`, STRATEGIES);
  str(p.name, `${where}.name`);
  arr(p.allocations, `${where}.allocations`).forEach((a, i) => {
    const ao = obj(a, `${where}.allocations[${i}]`);
    str(ao.group_id, `${where}.allocations[${i}].group_id`);
    arr(ao.routes, `${where}.allocations[${i}].routes`).forEach((r, j) => {
      const ro = obj(r, `${where}.allocations[${i}].routes[${j}]`);
      str(ro.route_id, `${where}.allocations[${i}].routes[${j}].route_id`);
      const share = num(ro.share, `${where}.allocations[${i}].routes[${j}].share`);
      if (share < 0 || share > 1) fail(`${where}.allocations[${i}].routes[${j}].share`, "0~1");
    });
  });
  arr(p.departures, `${where}.departures`).forEach((dep, i) => {
    const depO = obj(dep, `${where}.departures[${i}]`);
    str(depO.vehicle_id, `${where}.departures[${i}].vehicle_id`);
    str(depO.stop_id, `${where}.departures[${i}].stop_id`);
    num(depO.depart_s, `${where}.departures[${i}].depart_s`);
  });
  if (p.notes !== undefined) strArr(p.notes, `${where}.notes`);
}

function validateTrace(d: unknown, where: string): void {
  arr(d, where).forEach((t, i) => {
    const to = obj(t, `${where}[${i}]`);
    num(to.step, `${where}[${i}].step`);
    str(to.actor, `${where}[${i}].actor`);
    str(to.action, `${where}[${i}].action`);
    oneOf(to.source, `${where}[${i}].source`, TRACE_SOURCES);
    str(to.summary, `${where}[${i}].summary`);
    oneOf(to.status, `${where}[${i}].status`, TRACE_STATUS);
    if (to.duration_ms !== undefined) num(to.duration_ms, `${where}[${i}].duration_ms`);
    // 共享契约中 input_ref / output_ref 为必填字符串
    str(to.input_ref, `${where}[${i}].input_ref`);
    str(to.output_ref, `${where}[${i}].output_ref`);
  });
}

export function validateGenerateResponse(d: unknown): GenerateResponse {
  const o = obj(d, "generate");
  arr(o.plans, "generate.plans").forEach((p, i) => validatePlan(p, `generate.plans[${i}]`));
  validateTrace(o.trace, "generate.trace");
  oneOf(o.mode, "generate.mode", MODES);
  return o as unknown as GenerateResponse;
}

function validateMetrics(d: unknown, where: string): void {
  const m = obj(d, where);
  int(m.released_count, `${where}.released_count`);
  int(m.boarded_count, `${where}.boarded_count`);
  int(m.remaining_count, `${where}.remaining_count`);
  nullableNum(m.mean_queue_wait_all_released_s, `${where}.mean_queue_wait_all_released_s`);
  nullableNum(m.p95_queue_wait_boarded_s, `${where}.p95_queue_wait_boarded_s`);
  int(m.missed_deadline_count, `${where}.missed_deadline_count`);
  nullableNum(m.clearance_time_s, `${where}.clearance_time_s`);
}

export function validateSimulationResult(d: unknown): SimulationResult {
  const o = obj(d, "result");
  str(o.schema_version, "result.schema_version");
  str(o.engine_version, "result.engine_version");
  // 共享契约允许损坏输入下身份为 null；调用方必须据此拒绝过期/错身份结果
  nullableStr(o.scenario_id, "result.scenario_id");
  nullableInt(o.scenario_revision, "result.scenario_revision");
  nullableStr(o.plan_id, "result.plan_id");
  nullableInt(o.seed, "result.seed");
  oneOf(o.status, "result.status", RESULT_STATUS);
  arr(o.violations, "result.violations").forEach((v, i) => {
    const vo = obj(v, `result.violations[${i}]`);
    str(vo.code, `result.violations[${i}].code`);
    str(vo.path, `result.violations[${i}].path`);
    str(vo.message, `result.violations[${i}].message`);
    oneOf(vo.severity, `result.violations[${i}].severity`, SEVERITIES);
  });
  if (o.metrics !== null) validateMetrics(o.metrics, "result.metrics");
  arr(o.group_metrics, "result.group_metrics").forEach((g, i) => {
    const go = obj(g, `result.group_metrics[${i}]`);
    str(go.group_id, `result.group_metrics[${i}].group_id`);
    validateMetrics(g, `result.group_metrics[${i}]`);
  });
  arr(o.timeline, "result.timeline").forEach((f, i) => {
    const fo = obj(f, `result.timeline[${i}]`);
    num(fo.t_s, `result.timeline[${i}].t_s`);
    int(fo.released_count, `result.timeline[${i}].released_count`);
    int(fo.boarded_count, `result.timeline[${i}].boarded_count`);
    int(fo.queued_count, `result.timeline[${i}].queued_count`);
    int(fo.walking_count, `result.timeline[${i}].walking_count`);
    numRecord(fo.node_queues, `result.timeline[${i}].node_queues`);
    numRecord(fo.edge_counts, `result.timeline[${i}].edge_counts`);
    const gc = obj(fo.group_counts, `result.timeline[${i}].group_counts`);
    for (const [gid, gv] of Object.entries(gc)) {
      const gvo = obj(gv, `result.timeline[${i}].group_counts.${gid}`);
      int(gvo.released_count, `result.timeline[${i}].group_counts.${gid}.released_count`);
      int(gvo.boarded_count, `result.timeline[${i}].group_counts.${gid}.boarded_count`);
      int(gvo.queued_count, `result.timeline[${i}].group_counts.${gid}.queued_count`);
      int(gvo.walking_count, `result.timeline[${i}].group_counts.${gid}.walking_count`);
    }
  });
  arr(o.departures_log, "result.departures_log").forEach((dep, i) => {
    const depO = obj(dep, `result.departures_log[${i}]`);
    str(depO.vehicle_id, `result.departures_log[${i}].vehicle_id`);
    str(depO.stop_id, `result.departures_log[${i}].stop_id`);
    num(depO.depart_s, `result.departures_log[${i}].depart_s`);
    int(depO.boarded_count, `result.departures_log[${i}].boarded_count`);
  });
  return o as unknown as SimulationResult;
}

export function validateCompareResponse(d: unknown): CompareResponse {
  const o = obj(d, "compare");
  arr(o.results, "compare.results").forEach((r) => validateSimulationResult(r));
  if (o.recommendation === null || o.recommendation === undefined) {
    fail("compare.recommendation", "object（共享契约中为必填）");
  }
  {
    const rec = obj(o.recommendation, "compare.recommendation");
    if (rec.plan_id !== null) str(rec.plan_id, "compare.recommendation.plan_id");
    oneOf(rec.status, "compare.recommendation.status", RECOMMENDATION_STATUS);
    str(rec.reason, "compare.recommendation.reason");
    strArr(rec.tradeoffs, "compare.recommendation.tradeoffs");
  }
  validateTrace(o.trace, "compare.trace");
  oneOf(o.mode, "compare.mode", MODES);
  return o as unknown as CompareResponse;
}
