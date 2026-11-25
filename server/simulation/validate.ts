/**
 * validate.ts — 场景与方案校验器（A 模块）。
 * error 级 → simulate 返回 status "invalid"；warning 级不阻断计算。
 * “合法但无可达路线”不是结构错误：旅客保留在 S，记 warning，照常 valid 运行。
 */

import type { Plan, Scenario, ScenarioEdge, ScenarioRoute, ValidationIssue } from "../../shared/types.ts";
import { SCHEMA_VERSION } from "../../shared/types.ts";

function err(code: string, path: string, message: string): ValidationIssue {
  return { code, path, message, severity: "error" };
}
function warn(code: string, path: string, message: string): ValidationIssue {
  return { code, path, message, severity: "warning" };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isNonNegInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const isPosInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;
const isPosNum = (v: unknown): v is number => isNum(v) && v > 0;
const isNonEmptyStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
/** 时刻须离散到 step_s（所有契约时刻字段在校验后保证为整数） */
const alignedTo = (v: number, step: number): boolean => Number.isInteger(v) && v % step === 0;

const KNOWN_SCENARIO_KEYS = new Set([
  "schema_version", "scenario_id", "revision", "title", "demand_source",
  "horizon_s", "step_s", "nodes", "edges", "routes", "groups", "fleet",
]);
const KNOWN_PLAN_KEYS = new Set([
  "schema_version", "plan_id", "scenario_id", "scenario_revision",
  "strategy", "name", "allocations", "departures", "notes",
]);
const KNOWN_NODE_KEYS = new Set(["node_id", "kind", "x", "y", "boarding_gap_s"]);
const KNOWN_EDGE_KEYS = new Set(["edge_id", "from", "to", "travel_s", "capacity_per_min", "step_free", "closed"]);
const KNOWN_ROUTE_KEYS = new Set(["route_id", "edge_ids", "stop_id"]);
const KNOWN_GROUP_KEYS = new Set(["group_id", "count", "release_start_s", "release_end_s", "needs_step_free", "walk_time_factor", "board_deadline_s"]);
const KNOWN_VEHICLE_KEYS = new Set(["vehicle_id", "capacity", "available_from_s", "round_trip_s"]);
const KNOWN_ALLOC_KEYS = new Set(["group_id", "routes"]);
const KNOWN_ROUTE_SHARE_KEYS = new Set(["route_id", "share"]);
const KNOWN_DEPARTURE_KEYS = new Set(["vehicle_id", "stop_id", "depart_s"]);

/** 嵌套对象的未知字段也不得悄悄生效：拼错的键（如 travel_sX）必须显式提示 */
function warnUnknownKeys(obj: Record<string, unknown>, known: Set<string>, path: string, issues: ValidationIssue[]): void {
  for (const k of Object.keys(obj)) {
    if (!known.has(k)) issues.push(warn("SCHEMA_UNKNOWN_FIELD", `${path}.${k}`, `未知字段 "${k}" 将被忽略，不影响计算`));
  }
}

/** 第一版合成规模护栏（非契约口径，防恶意/手滑输入撑爆内存） */
const MAX_FRAMES = 100_000;
const MAX_PERSONS = 100_000;

/** 路线是否经过关闭边 / 非无台阶边（供校验与需求分配共用） */
export function routeIsClosed(scenario: Scenario, route: ScenarioRoute): boolean {
  return route.edge_ids.some((id) => scenario.edges.find((e) => e.edge_id === id)?.closed ?? true);
}
export function routeIsStepFree(scenario: Scenario, route: ScenarioRoute): boolean {
  return route.edge_ids.every((id) => scenario.edges.find((e) => e.edge_id === id)?.step_free ?? false);
}

export function validateScenario(scenario: Scenario): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const s = scenario as unknown as Record<string, unknown>;
  if (!isObj(s)) {
    return [err("SCHEMA_NOT_OBJECT", "scenario", "scenario 必须是对象")];
  }
  if (s.schema_version !== SCHEMA_VERSION) {
    issues.push(err("SCHEMA_VERSION_UNSUPPORTED", "schema_version", `schema_version 必须为 "${SCHEMA_VERSION}"`));
    return issues; // 版本不符时结构未知，不再继续解释字段
  }
  for (const k of Object.keys(s)) {
    if (!KNOWN_SCENARIO_KEYS.has(k)) issues.push(warn("SCHEMA_UNKNOWN_FIELD", k, `未知字段 "${k}" 将被忽略，不影响计算`));
  }

  if (!isNonEmptyStr(s.scenario_id)) issues.push(err("SCN_ID_INVALID", "scenario_id", "scenario_id 必须为非空字符串"));
  if (!isPosInt(s.revision)) issues.push(err("SCN_REVISION_INVALID", "revision", "revision 必须为正整数"));
  if (typeof s.title !== "string") issues.push(err("SCN_TITLE_INVALID", "title", "title 必须为字符串"));
  if (!isNonEmptyStr(s.demand_source)) {
    issues.push(err("SCN_DEMAND_SOURCE_INVALID", "demand_source", "demand_source 必须为非空字符串"));
  } else if (s.demand_source !== "synthetic") {
    issues.push(warn("SCN_DEMAND_SOURCE", "demand_source", "第一版输入应明确标注为 synthetic"));
  }

  const stepOk = isPosInt(s.step_s);
  if (!isPosInt(s.horizon_s)) issues.push(err("SCN_HORIZON_INVALID", "horizon_s", "horizon_s 必须为正整数秒"));
  if (!stepOk) issues.push(err("SCN_STEP_INVALID", "step_s", "step_s 必须为正整数秒"));
  if (isPosInt(s.horizon_s) && stepOk && (s.horizon_s as number) % (s.step_s as number) !== 0) {
    issues.push(err("SCN_TIME_NOT_ALIGNED", "horizon_s", "horizon_s 必须是 step_s 的整数倍"));
  }
  if (isPosInt(s.horizon_s) && stepOk && (s.horizon_s as number) / (s.step_s as number) > MAX_FRAMES) {
    issues.push(err("SCN_GRID_TOO_FINE", "step_s", `时间步总数超过护栏 ${MAX_FRAMES} 帧，请增大 step_s 或缩小 horizon_s`));
  }
  const step = stepOk ? (s.step_s as number) : 1;
  const horizon = isPosInt(s.horizon_s) ? (s.horizon_s as number) : Number.POSITIVE_INFINITY;

  /* nodes */
  const nodes: Record<string, unknown>[] = Array.isArray(s.nodes) ? (s.nodes as Record<string, unknown>[]) : [];
  if (!Array.isArray(s.nodes)) issues.push(err("SCN_NODES_INVALID", "nodes", "nodes 必须为数组"));
  const nodeIds = new Set<string>();
  const nodeKind = new Map<string, string>();
  nodes.forEach((n, i) => {
    const p = `nodes[${i}]`;
    if (!isObj(n)) { issues.push(err("SCN_NODE_INVALID", p, "节点必须为对象")); return; }
    warnUnknownKeys(n, KNOWN_NODE_KEYS, p, issues);
    if (!isNonEmptyStr(n.node_id)) issues.push(err("SCN_ID_INVALID", `${p}.node_id`, "node_id 必须为非空字符串"));
    else if (nodeIds.has(n.node_id)) issues.push(err("SCN_ID_DUPLICATE", `${p}.node_id`, `node_id "${n.node_id}" 重复`));
    else nodeIds.add(n.node_id);
    if (n.kind !== "source" && n.kind !== "exit" && n.kind !== "stop") {
      issues.push(err("SCN_NODE_KIND", `${p}.kind`, "kind 必须为 source | exit | stop"));
    } else if (isNonEmptyStr(n.node_id)) {
      nodeKind.set(n.node_id, n.kind);
    }
    if (!isNum(n.x) || n.x < 0 || n.x > 100 || !isNum(n.y) || n.y < 0 || n.y > 100) {
      issues.push(err("SCN_COORD_RANGE", `${p}.x`, "x/y 必须在 0~100 的示意画布范围内"));
    }
    if (n.kind === "stop") {
      if (!isPosNum(n.boarding_gap_s)) issues.push(err("SCN_VALUE_NONPOSITIVE", `${p}.boarding_gap_s`, "站点必须提供正数 boarding_gap_s"));
    } else if (n.boarding_gap_s !== undefined) {
      issues.push(warn("SCHEMA_UNKNOWN_FIELD", `${p}.boarding_gap_s`, "非站点节点的 boarding_gap_s 将被忽略"));
    }
  });
  if (nodeIds.size > 0) {
    const kinds = [...nodeKind.values()];
    const sourceCount = kinds.filter((k) => k === "source").length;
    if (sourceCount === 0) issues.push(err("SCN_NO_SOURCE", "nodes", "至少需要一个 source 节点"));
    if (sourceCount > 1) issues.push(err("SCN_MULTI_SOURCE", "nodes", "第一版世界固定为单一场馆，source 节点必须恰为 1 个"));
    if (!kinds.includes("stop")) issues.push(err("SCN_NO_STOP", "nodes", "至少需要一个 stop 节点"));
  }

  /* edges */
  const edges: Record<string, unknown>[] = Array.isArray(s.edges) ? (s.edges as Record<string, unknown>[]) : [];
  if (!Array.isArray(s.edges)) issues.push(err("SCN_EDGES_INVALID", "edges", "edges 必须为数组"));
  const edgeIds = new Set<string>();
  edges.forEach((e, i) => {
    const p = `edges[${i}]`;
    if (!isObj(e)) { issues.push(err("SCN_EDGE_INVALID", p, "边必须为对象")); return; }
    warnUnknownKeys(e, KNOWN_EDGE_KEYS, p, issues);
    if (!isNonEmptyStr(e.edge_id)) issues.push(err("SCN_ID_INVALID", `${p}.edge_id`, "edge_id 必须为非空字符串"));
    else if (edgeIds.has(e.edge_id)) issues.push(err("SCN_ID_DUPLICATE", `${p}.edge_id`, `edge_id "${e.edge_id}" 重复`));
    else edgeIds.add(e.edge_id);
    for (const end of ["from", "to"] as const) {
      if (!isNonEmptyStr(e[end]) || !nodeIds.has(e[end] as string)) {
        issues.push(err("SCN_REF_UNKNOWN", `${p}.${end}`, `边引用了不存在的节点 "${String(e[end])}"`));
      }
    }
    if (isNonEmptyStr(e.from) && e.from === e.to) {
      issues.push(err("SCN_EDGE_SELF_LOOP", `${p}.to`, `边 "${String(e.edge_id)}" 起止节点相同，无意义`));
    }
    if (!isPosNum(e.travel_s)) issues.push(err("SCN_VALUE_NONPOSITIVE", `${p}.travel_s`, "travel_s 必须为正数"));
    if (!isPosNum(e.capacity_per_min)) issues.push(err("SCN_VALUE_NONPOSITIVE", `${p}.capacity_per_min`, "capacity_per_min 必须为正数"));
    if (typeof e.step_free !== "boolean") issues.push(err("SCN_FIELD_INVALID", `${p}.step_free`, "step_free 必须为布尔值"));
    if (typeof e.closed !== "boolean") issues.push(err("SCN_FIELD_INVALID", `${p}.closed`, "closed 必须为布尔值"));
  });

  /* routes */
  const routes: Record<string, unknown>[] = Array.isArray(s.routes) ? (s.routes as Record<string, unknown>[]) : [];
  if (!Array.isArray(s.routes)) issues.push(err("SCN_ROUTES_INVALID", "routes", "routes 必须为数组"));
  const routeIds = new Set<string>();
  routes.forEach((r, i) => {
    const p = `routes[${i}]`;
    if (!isObj(r)) { issues.push(err("SCN_ROUTE_INVALID", p, "路线必须为对象")); return; }
    warnUnknownKeys(r, KNOWN_ROUTE_KEYS, p, issues);
    if (!isNonEmptyStr(r.route_id)) issues.push(err("SCN_ID_INVALID", `${p}.route_id`, "route_id 必须为非空字符串"));
    else if (routeIds.has(r.route_id)) issues.push(err("SCN_ID_DUPLICATE", `${p}.route_id`, `route_id "${r.route_id}" 重复`));
    else routeIds.add(r.route_id);
    const ids = Array.isArray(r.edge_ids) ? r.edge_ids : null;
    if (!ids || ids.length === 0) {
      issues.push(err("SCN_ROUTE_EMPTY", `${p}.edge_ids`, "路线至少包含一条边"));
    } else {
      let chainOk = true;
      ids.forEach((id, j) => {
        if (!isNonEmptyStr(id) || !edgeIds.has(id)) {
          issues.push(err("SCN_REF_UNKNOWN", `${p}.edge_ids[${j}]`, `路线引用了不存在的边 "${String(id)}"`));
          chainOk = false;
        }
      });
      if (chainOk) {
        const edgeById = new Map(edges.map((e) => [e.edge_id as string, e]));
        const seq = ids.map((id) => edgeById.get(id as string)!);
        for (let j = 0; j + 1 < seq.length; j++) {
          if (seq[j].to !== seq[j + 1].from) {
            issues.push(err("SCN_ROUTE_NOT_CONTIGUOUS", `${p}.edge_ids`, `边 "${String(ids[j])}" 与 "${String(ids[j + 1])}" 不连续`));
          }
        }
        const firstFrom = seq[0].from as string;
        if (nodeKind.get(firstFrom) !== "source") {
          issues.push(err("SCN_ROUTE_NOT_FROM_SOURCE", `${p}.edge_ids`, "路线首边必须起自 source 节点"));
        }
        const lastTo = seq[seq.length - 1].to;
        if (r.stop_id !== lastTo) {
          issues.push(err("SCN_ROUTE_STOP_MISMATCH", `${p}.stop_id`, `stop_id "${String(r.stop_id)}" 必须等于末边终点 "${String(lastTo)}"`));
        }
        const nodeSeq = [seq[0].from, ...seq.map((e) => e.to)];
        if (new Set(nodeSeq).size !== nodeSeq.length) {
          issues.push(warn("SCN_ROUTE_LOOP", `${p}.edge_ids`, "路线重复经过同一节点，请确认不是笔误"));
        }
      }
    }
    if (!isNonEmptyStr(r.stop_id) || !nodeIds.has(r.stop_id as string)) {
      issues.push(err("SCN_REF_UNKNOWN", `${p}.stop_id`, `路线终点引用了不存在的节点 "${String(r.stop_id)}"`));
    } else if (nodeKind.get(r.stop_id as string) !== "stop") {
      issues.push(err("SCN_ROUTE_STOP_KIND", `${p}.stop_id`, `节点 "${r.stop_id}" 不是 stop`));
    }
  });

  /* groups */
  const groups: Record<string, unknown>[] = Array.isArray(s.groups) ? (s.groups as Record<string, unknown>[]) : [];
  if (!Array.isArray(s.groups)) issues.push(err("SCN_GROUPS_INVALID", "groups", "groups 必须为数组"));
  const groupIds = new Set<string>();
  groups.forEach((g, i) => {
    const p = `groups[${i}]`;
    if (!isObj(g)) { issues.push(err("SCN_GROUP_INVALID", p, "旅客组必须为对象")); return; }
    warnUnknownKeys(g, KNOWN_GROUP_KEYS, p, issues);
    if (!isNonEmptyStr(g.group_id)) issues.push(err("SCN_ID_INVALID", `${p}.group_id`, "group_id 必须为非空字符串"));
    else if (groupIds.has(g.group_id)) issues.push(err("SCN_ID_DUPLICATE", `${p}.group_id`, `group_id "${g.group_id}" 重复`));
    else groupIds.add(g.group_id);
    if (!isNonNegInt(g.count)) issues.push(err("SCN_COUNT_INVALID", `${p}.count`, "count 必须为非负整数"));
    for (const f of ["release_start_s", "release_end_s"] as const) {
      const v = g[f];
      if (!isNonNegInt(v) || v > horizon) {
        issues.push(err("SCN_TIME_OUT_OF_WINDOW", `${p}.${f}`, `${f} 必须在 [0, horizon_s] 内`));
      } else if (!alignedTo(v, step)) {
        issues.push(err("SCN_TIME_NOT_ALIGNED", `${p}.${f}`, `${f} 必须离散到 step_s`));
      }
    }
    if (isNonNegInt(g.release_start_s) && isNonNegInt(g.release_end_s) && (g.release_start_s as number) > (g.release_end_s as number)) {
      issues.push(err("SCN_RELEASE_RANGE", `${p}.release_start_s`, "release_start_s 不能晚于 release_end_s"));
    }
    if (typeof g.needs_step_free !== "boolean") issues.push(err("SCN_FIELD_INVALID", `${p}.needs_step_free`, "needs_step_free 必须为布尔值"));
    if (!isPosNum(g.walk_time_factor)) issues.push(err("SCN_VALUE_NONPOSITIVE", `${p}.walk_time_factor`, "walk_time_factor 必须为正数"));
    const d = g.board_deadline_s;
    if (d !== null && d !== undefined) {
      if (!isNonNegInt(d) || d > horizon) {
        issues.push(err("SCN_TIME_OUT_OF_WINDOW", `${p}.board_deadline_s`, "board_deadline_s 不能晚于窗口结束"));
      } else if (!alignedTo(d, step)) {
        issues.push(err("SCN_TIME_NOT_ALIGNED", `${p}.board_deadline_s`, "board_deadline_s 必须离散到 step_s"));
      }
    } else if (d === undefined) {
      issues.push(err("SCN_FIELD_INVALID", `${p}.board_deadline_s`, "board_deadline_s 缺失（无期限请显式填 null）"));
    }
  });

  const totalCount = groups.reduce((a, g) => a + (isNonNegInt(g.count) ? (g.count as number) : 0), 0);
  if (totalCount > MAX_PERSONS) {
    issues.push(err("SCN_DEMAND_TOO_LARGE", "groups", `总需求 ${totalCount} 人超过第一版合成规模护栏 ${MAX_PERSONS} 人`));
  }

  /* fleet */
  const fleet: Record<string, unknown>[] = Array.isArray(s.fleet) ? (s.fleet as Record<string, unknown>[]) : [];
  if (!Array.isArray(s.fleet)) issues.push(err("SCN_FLEET_INVALID", "fleet", "fleet 必须为数组"));
  const vehicleIds = new Set<string>();
  fleet.forEach((v, i) => {
    const p = `fleet[${i}]`;
    if (!isObj(v)) { issues.push(err("SCN_VEHICLE_INVALID", p, "车辆必须为对象")); return; }
    warnUnknownKeys(v, KNOWN_VEHICLE_KEYS, p, issues);
    if (!isNonEmptyStr(v.vehicle_id)) issues.push(err("SCN_ID_INVALID", `${p}.vehicle_id`, "vehicle_id 必须为非空字符串"));
    else if (vehicleIds.has(v.vehicle_id)) issues.push(err("SCN_ID_DUPLICATE", `${p}.vehicle_id`, `vehicle_id "${v.vehicle_id}" 重复`));
    else vehicleIds.add(v.vehicle_id);
    if (!isPosInt(v.capacity)) issues.push(err("SCN_VALUE_NONPOSITIVE", `${p}.capacity`, "capacity 必须为正整数"));
    if (!isNonNegInt(v.available_from_s)) {
      issues.push(err("SCN_VALUE_NONPOSITIVE", `${p}.available_from_s`, "available_from_s 必须为非负整数"));
    } else if (!alignedTo(v.available_from_s, step)) {
      issues.push(err("SCN_TIME_NOT_ALIGNED", `${p}.available_from_s`, "available_from_s 必须离散到 step_s"));
    }
    if (!isPosNum(v.round_trip_s)) issues.push(err("SCN_VALUE_NONPOSITIVE", `${p}.round_trip_s`, "round_trip_s 必须为正数"));
  });

  if (Array.isArray(s.fleet) && fleet.length === 0 && totalCount > 0) {
    issues.push(warn("SCN_NO_FLEET", "fleet", "fleet 为空：全部旅客将无法登车（资源不足场景，属合法输入）"));
  }

  return issues;
}

export function validatePlan(scenario: Scenario, plan: Plan): ValidationIssue[] {
  // 独立调用防御：scenario 本身非法时，引用类检查没有意义，直接拒绝
  if (validateScenario(scenario).some((i) => i.severity === "error")) {
    return [err("PLAN_SCENARIO_INVALID", "scenario", "scenario 未通过校验，请先修复场景再校验方案")];
  }
  const issues: ValidationIssue[] = [];
  const sc = scenario as unknown as Record<string, unknown>;
  const p = plan as unknown as Record<string, unknown>;
  if (!isObj(p)) {
    return [err("SCHEMA_NOT_OBJECT", "plan", "plan 必须是对象")];
  }
  if (p.schema_version !== SCHEMA_VERSION) {
    issues.push(err("SCHEMA_VERSION_UNSUPPORTED", "schema_version", `schema_version 必须为 "${SCHEMA_VERSION}"`));
    return issues;
  }
  for (const k of Object.keys(p)) {
    if (!KNOWN_PLAN_KEYS.has(k)) issues.push(warn("SCHEMA_UNKNOWN_FIELD", k, `未知字段 "${k}" 将被忽略，不影响计算`));
  }

  if (!isNonEmptyStr(p.plan_id)) issues.push(err("PLAN_ID_INVALID", "plan_id", "plan_id 必须为非空字符串"));
  if (p.strategy !== "baseline" && p.strategy !== "independent" && p.strategy !== "coordinated") {
    issues.push(err("PLAN_STRATEGY_INVALID", "strategy", "strategy 必须为 baseline | independent | coordinated"));
  }
  if (p.scenario_id !== sc.scenario_id) {
    issues.push(err("PLAN_SCENARIO_MISMATCH", "scenario_id", `plan 指向场景 "${String(p.scenario_id)}"，与输入场景 "${String(sc.scenario_id)}" 不一致`));
  }
  if (p.scenario_revision !== sc.revision) {
    issues.push(err("PLAN_STALE_REVISION", "scenario_revision", `plan 基于 revision ${String(p.scenario_revision)}，当前场景 revision 为 ${String(sc.revision)}；旧 revision 方案拒绝执行`));
  }

  const routes = (Array.isArray(sc.routes) ? sc.routes : []) as ScenarioRoute[];
  const groups = (Array.isArray(sc.groups) ? sc.groups : []) as Scenario["groups"];
  const fleet = (Array.isArray(sc.fleet) ? sc.fleet : []) as Scenario["fleet"];
  const nodes = (Array.isArray(sc.nodes) ? sc.nodes : []) as Scenario["nodes"];
  const routeById = new Map(routes.map((r) => [r.route_id, r]));
  const groupById = new Map(groups.map((g) => [g.group_id, g]));
  const vehicleById = new Map(fleet.map((v) => [v.vehicle_id, v]));
  const nodeById = new Map(nodes.map((n) => [n.node_id, n]));
  const step = isPosInt(sc.step_s) ? sc.step_s : 1;
  const horizon = isPosInt(sc.horizon_s) ? sc.horizon_s : Number.POSITIVE_INFINITY;

  /* allocations */
  const allocations = Array.isArray(p.allocations) ? (p.allocations as Record<string, unknown>[]) : [];
  if (!Array.isArray(p.allocations)) issues.push(err("PLAN_ALLOCATIONS_INVALID", "allocations", "allocations 必须为数组"));
  const seenGroups = new Set<string>();
  allocations.forEach((a, i) => {
    const path = `allocations[${i}]`;
    if (!isObj(a)) { issues.push(err("PLAN_ALLOCATION_INVALID", path, "分配项必须为对象")); return; }
    warnUnknownKeys(a, KNOWN_ALLOC_KEYS, path, issues);
    const gid = a.group_id;
    if (!isNonEmptyStr(gid) || !groupById.has(gid)) {
      issues.push(err("PLAN_GROUP_UNKNOWN", `${path}.group_id`, `分配项引用了不存在的旅客组 "${String(gid)}"`));
    } else if (seenGroups.has(gid)) {
      issues.push(err("PLAN_ALLOCATION_DUPLICATE", `${path}.group_id`, `旅客组 "${gid}" 有重复分配项`));
    } else {
      seenGroups.add(gid);
    }
    const group = isNonEmptyStr(gid) ? groupById.get(gid) : undefined;
    const shares = Array.isArray(a.routes) ? (a.routes as Record<string, unknown>[]) : null;
    if (shares === null) {
      issues.push(err("PLAN_ALLOCATION_INVALID", `${path}.routes`, "routes 必须为数组（可为空数组）"));
    } else {
      let sum = 0;
      shares.forEach((rs, j) => {
        const rp = `${path}.routes[${j}]`;
        if (!isObj(rs)) { issues.push(err("PLAN_ALLOCATION_INVALID", rp, "路线份额必须为对象")); return; }
        warnUnknownKeys(rs, KNOWN_ROUTE_SHARE_KEYS, rp, issues);
        const rid = rs.route_id;
        const route = isNonEmptyStr(rid) ? routeById.get(rid) : undefined;
        if (!route) {
          issues.push(err("PLAN_ROUTE_UNKNOWN", `${rp}.route_id`, `分配了不存在的路线 "${String(rid)}"`));
        } else {
          if (routeIsClosed(scenario, route)) {
            issues.push(err("PLAN_ROUTE_CLOSED", `${rp}.route_id`, `路线 "${rid}" 经过已关闭的边，不能分配`));
          }
          if (group?.needs_step_free && !routeIsStepFree(scenario, route)) {
            issues.push(err("PLAN_STEP_FREE_VIOLATION", `${rp}.route_id`, `需要避开台阶的组 "${String(gid)}" 不能分配含台阶的路线 "${rid}"`));
          }
        }
        if (!isNum(rs.share) || rs.share < 0 || rs.share > 1) {
          issues.push(err("PLAN_SHARE_INVALID", `${rp}.share`, "share 必须在 [0,1] 内"));
        } else {
          sum += rs.share;
        }
      });
      if (shares.length > 0 && Math.abs(sum - 1) > 1e-6) {
        issues.push(err("PLAN_SHARE_INVALID", `${path}.routes`, `非空 routes 的 share 之和必须为 1（当前 ${sum}）`));
      }
      if (shares.length === 0 && group && group.count > 0) {
        issues.push(warn("PLAN_UNMET_GROUP", `${path}.routes`, `组 "${String(gid)}"（${group.count} 人）未分配路线，将留在 S 等待，属未满足服务`));
      }
    }
  });
  for (const g of groups) {
    if (!seenGroups.has(g.group_id)) {
      issues.push(err("PLAN_ALLOCATION_MISSING", "allocations", `旅客组 "${g.group_id}" 缺少分配项（每组恰好一项）`));
    }
  }

  /* departures */
  const departures = Array.isArray(p.departures) ? (p.departures as Record<string, unknown>[]) : [];
  if (!Array.isArray(p.departures)) issues.push(err("PLAN_DEPARTURES_INVALID", "departures", "departures 必须为数组"));
  interface Dep { vehicle_id: string; stop_id: string; depart_s: number }
  const validDeps: Dep[] = [];
  departures.forEach((d, i) => {
    const path = `departures[${i}]`;
    if (!isObj(d)) { issues.push(err("PLAN_DEPARTURE_INVALID", path, "班次必须为对象")); return; }
    warnUnknownKeys(d, KNOWN_DEPARTURE_KEYS, path, issues);
    const vid = d.vehicle_id;
    if (!isNonEmptyStr(vid) || !vehicleById.has(vid)) {
      issues.push(err("PLAN_VEHICLE_UNKNOWN", `${path}.vehicle_id`, `班次引用了不存在（或已移除）的车辆 "${String(vid)}"`));
    }
    const sid = d.stop_id;
    if (!isNonEmptyStr(sid) || !nodeById.has(sid)) {
      issues.push(err("PLAN_STOP_UNKNOWN", `${path}.stop_id`, `班次引用了不存在的站点 "${String(sid)}"`));
    } else if (nodeById.get(sid)!.kind !== "stop") {
      issues.push(err("PLAN_STOP_UNKNOWN", `${path}.stop_id`, `节点 "${sid}" 不是 stop`));
    }
    const t = d.depart_s;
    if (!isNonNegInt(t) || t > horizon) {
      issues.push(err("PLAN_DEPART_OUT_OF_WINDOW", `${path}.depart_s`, "depart_s 必须在 [0, horizon_s] 内"));
    } else if (!alignedTo(t, step)) {
      issues.push(err("PLAN_DEPART_NOT_ALIGNED", `${path}.depart_s`, "depart_s 必须离散到 step_s"));
    }
    if (isNonEmptyStr(vid) && vehicleById.has(vid) && isNonEmptyStr(sid) && nodeById.has(sid) && isNonNegInt(t) && t <= horizon) {
      validDeps.push({ vehicle_id: vid, stop_id: sid, depart_s: t });
    }
  });

  /* 同一车辆：首班不早于 available_from_s，相邻班次间隔 ≥ round_trip_s */
  const byVehicle = new Map<string, number[]>();
  for (const d of validDeps) {
    if (!byVehicle.has(d.vehicle_id)) byVehicle.set(d.vehicle_id, []);
    byVehicle.get(d.vehicle_id)!.push(d.depart_s);
  }
  for (const [vid, times] of byVehicle) {
    times.sort((a, b) => a - b);
    const v = vehicleById.get(vid)!;
    if (times[0] < v.available_from_s) {
      issues.push(err("PLAN_VEHICLE_NOT_AVAILABLE", "departures", `车辆 "${vid}" 首班 ${times[0]}s 早于 available_from_s ${v.available_from_s}s`));
    }
    for (let i = 1; i < times.length; i++) {
      if (times[i] - times[i - 1] < v.round_trip_s) {
        issues.push(err("PLAN_VEHICLE_OVERLAP", "departures", `车辆 "${vid}" 在 ${times[i - 1]}s 与 ${times[i]}s 的班次间隔小于 round_trip_s ${v.round_trip_s}s（重复占用）`));
      }
    }
  }

  /* 同一站点：相邻班次间隔 ≥ boarding_gap_s */
  const byStop = new Map<string, number[]>();
  for (const d of validDeps) {
    if (!byStop.has(d.stop_id)) byStop.set(d.stop_id, []);
    byStop.get(d.stop_id)!.push(d.depart_s);
  }
  for (const [sid, times] of byStop) {
    times.sort((a, b) => a - b);
    const gap = nodeById.get(sid)?.boarding_gap_s;
    if (!isPosNum(gap)) continue;
    for (let i = 1; i < times.length; i++) {
      if (times[i] - times[i - 1] < gap) {
        issues.push(err("PLAN_STOP_GAP", "departures", `站点 "${sid}" 在 ${times[i - 1]}s 与 ${times[i]}s 的班次间隔小于 boarding_gap_s ${gap}s`));
      }
    }
  }

  /* 信息性 warning：班次站点没有任何“有需求的组”的路线到达，将持续空车 */
  const totalDemand = groups.reduce((a, g) => a + g.count, 0);
  if (totalDemand > 0) {
    const servedStops = new Set<string>();
    for (const a of allocations) {
      if (!isObj(a)) continue;
      const group = isNonEmptyStr(a.group_id) ? groupById.get(a.group_id) : undefined;
      if (!group || group.count === 0) continue;
      const shares = Array.isArray(a.routes) ? (a.routes as Record<string, unknown>[]) : [];
      for (const rs of shares) {
        if (!isObj(rs) || !isNum(rs.share) || rs.share <= 0) continue;
        const route = isNonEmptyStr(rs.route_id) ? routeById.get(rs.route_id) : undefined;
        if (route) servedStops.add(route.stop_id);
      }
    }
    const plannedStops = [...new Set(validDeps.map((d) => d.stop_id))].sort();
    for (const sid of plannedStops) {
      if (!servedStops.has(sid)) {
        issues.push(warn("PLAN_STOP_NO_DEMAND", "departures", `站点 "${sid}" 没有任何被分配路线到达，相关班次将持续空车`));
      }
    }
  }

  /* 信息性 warning：存在未排班的车辆 */
  for (const v of fleet) {
    if (!byVehicle.has(v.vehicle_id)) {
      issues.push(warn("PLAN_UNUSED_VEHICLE", "departures", `车辆 "${v.vehicle_id}" 未排任何班次`));
    }
  }

  return issues;
}
