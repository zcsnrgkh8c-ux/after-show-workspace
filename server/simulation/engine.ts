/**
 * engine.ts — 离散时间步推演引擎。
 *
 * 每个时间步严格按 05 的顺序处理：
 *   ① 完成步行并加入下一节点队列
 *   ② 释放新旅客
 *   ③ 计划班次发车并按 FIFO 登车
 *   ④ 按边容量放行进入下一段步行（credit 小数余额跨步累计）
 *   ⑤ 统计队列、轨迹和等待（等待按 [t, t+step) 累计，窗口终点不累加）
 *
 * 每一帧强制人数守恒：released = boarded + walking + queued；
 * 守恒被破坏属于引擎自身缺陷，向上抛异常 → status "error"。
 */

import type {
  DepartureLogEntry,
  GroupFrameCounts,
  GroupMetrics,
  Metrics,
  Plan,
  Scenario,
  SimulationResult,
  TimelineFrame,
  ValidationIssue,
} from "../../shared/types.ts";
import { SCHEMA_VERSION } from "../../shared/types.ts";
import { assignRoutes, generateDemand } from "./demand.ts";
import type { PersonSpec } from "./demand.ts";
import { computeMetrics } from "./metrics.ts";
import { validatePlan, validateScenario } from "./validate.ts";

export const ENGINE_VERSION = "1.0.0";

interface Runner extends PersonSpec {
  status: "pending" | "queued" | "walking" | "boarded";
  node_id: string | null;
  edge_id: string | null;
  next_edge_idx: number;
  exit_t: number;
  queue_wait_s: number;
  boarded_s: number | null;
}

interface RunOutput {
  metrics: Metrics;
  group_metrics: GroupMetrics[];
  timeline: TimelineFrame[];
  departures_log: DepartureLogEntry[];
}

const byPersonId = (a: { person_id: string }, b: { person_id: string }): number =>
  a.person_id < b.person_id ? -1 : a.person_id > b.person_id ? 1 : 0;

function runEngine(scenario: Scenario, plan: Plan, seed: number): RunOutput {
  const step = scenario.step_s;
  const horizon = scenario.horizon_s;

  const persons: Runner[] = generateDemand(scenario, seed).map((p) => ({
    ...p,
    status: "pending",
    node_id: null,
    edge_id: null,
    next_edge_idx: 0,
    exit_t: 0,
    queue_wait_s: 0,
    boarded_s: null,
  }));
  assignRoutes(scenario, plan, persons);

  const sourceId = scenario.nodes.find((n) => n.kind === "source")!.node_id;
  const vehicleById = new Map(scenario.fleet.map((v) => [v.vehicle_id, v]));
  const edgeById = new Map(scenario.edges.map((e) => [e.edge_id, e]));

  // 班次按时刻索引；同时刻按 (stop_id, vehicle_id) 排序保证确定性
  const departuresByT = new Map<number, { vehicle_id: string; stop_id: string; depart_s: number }[]>();
  for (const d of plan.departures) {
    if (!departuresByT.has(d.depart_s)) departuresByT.set(d.depart_s, []);
    departuresByT.get(d.depart_s)!.push(d);
  }
  for (const list of departuresByT.values()) {
    list.sort((a, b) => (a.stop_id < b.stop_id ? -1 : a.stop_id > b.stop_id ? 1 : a.vehicle_id < b.vehicle_id ? -1 : 1));
  }

  const nodeQueues = new Map<string, Runner[]>(scenario.nodes.map((n) => [n.node_id, []]));
  const walking: Runner[] = [];
  const edgeCredit = new Map<string, number>(scenario.edges.map((e) => [e.edge_id, 0]));
  const departures_log: DepartureLogEntry[] = [];
  const timeline: TimelineFrame[] = [];

  let releasePtr = 0; // persons 已按 (release_s, person_id) 排序
  let releasedCount = 0;
  let boardedCount = 0;

  const nextEdgeOf = (p: Runner): string | null =>
    p.next_edge_idx < p.route_edge_ids.length ? p.route_edge_ids[p.next_edge_idx] : null;

  for (let t = 0; t <= horizon; t += step) {
    /* ① 完成步行：同一时刻完成者按 person_id 入队 */
    if (walking.length > 0) {
      const arrivals = walking.filter((p) => p.exit_t === t).sort(byPersonId);
      if (arrivals.length > 0) {
        for (const p of arrivals) {
          p.status = "queued";
          p.node_id = edgeById.get(p.edge_id!)!.to;
          p.edge_id = null;
          p.next_edge_idx += 1;
          nodeQueues.get(p.node_id)!.push(p);
        }
        for (let i = walking.length - 1; i >= 0; i--) {
          if (walking[i].exit_t === t) walking.splice(i, 1);
        }
      }
    }

    /* ② 释放新旅客：按 (release_s, person_id) 顺序进入 S 队列 */
    while (releasePtr < persons.length && persons[releasePtr].release_s === t) {
      const p = persons[releasePtr];
      p.status = "queued";
      p.node_id = sourceId;
      nodeQueues.get(sourceId)!.push(p);
      releasedCount += 1;
      releasePtr += 1;
    }

    /* ③ 计划班次发车并按 FIFO 登车；空车班次保留记录 */
    const deps = departuresByT.get(t);
    if (deps) {
      for (const d of deps) {
        const cap = vehicleById.get(d.vehicle_id)!.capacity;
        const queue = nodeQueues.get(d.stop_id)!;
        const n = Math.min(cap, queue.length);
        for (let i = 0; i < n; i++) {
          const p = queue[i];
          p.status = "boarded";
          p.node_id = null;
          p.boarded_s = t;
        }
        queue.splice(0, n);
        boardedCount += n;
        departures_log.push({ vehicle_id: d.vehicle_id, stop_id: d.stop_id, depart_s: t, boarded_count: n });
      }
    }

    /* ④ 按边容量放行：credit += q; slots = floor(credit); credit -= slots。
         整数名额本步不用则丢弃，小数余额跨步保留（不封顶，低流量边不会停摆）。*/
    for (const edge of scenario.edges) {
      const q = (edge.capacity_per_min * step) / 60;
      let credit = (edgeCredit.get(edge.edge_id) ?? 0) + q;
      let slots = Math.floor(credit + 1e-9);
      credit -= slots;
      if (credit < 1e-9) credit = 0;
      edgeCredit.set(edge.edge_id, credit);
      if (slots <= 0) continue;
      const queue = nodeQueues.get(edge.from)!;
      if (queue.length === 0) continue;
      const admitted: Runner[] = [];
      const remaining: Runner[] = [];
      for (const p of queue) {
        if (admitted.length < slots && nextEdgeOf(p) === edge.edge_id) admitted.push(p);
        else remaining.push(p);
      }
      if (admitted.length === 0) continue;
      nodeQueues.set(edge.from, remaining);
      for (const p of admitted) {
        const travelSteps = Math.max(1, Math.ceil((edge.travel_s * p.walk_time_factor) / step - 1e-9));
        p.status = "walking";
        p.node_id = null;
        p.edge_id = edge.edge_id;
        p.exit_t = t + travelSteps * step; // 至少 1 步，新进入者不可能同一步完成
        walking.push(p);
      }
    }

    /* ⑤ 统计：等待按 [t, t+step) 累计；窗口终点不再额外累加一帧 */
    if (t < horizon) {
      for (const queue of nodeQueues.values()) {
        for (const p of queue) p.queue_wait_s += step;
      }
    }

    let queuedTotal = 0;
    const node_queues: Record<string, number> = {};
    for (const [id, queue] of nodeQueues) {
      node_queues[id] = queue.length;
      queuedTotal += queue.length;
    }
    const edge_counts: Record<string, number> = {};
    for (const e of scenario.edges) edge_counts[e.edge_id] = 0;
    for (const p of walking) edge_counts[p.edge_id!] += 1;

    const group_counts: Record<string, GroupFrameCounts> = {};
    for (const g of scenario.groups) {
      group_counts[g.group_id] = { released_count: 0, boarded_count: 0, queued_count: 0, walking_count: 0 };
    }
    for (const p of persons) {
      if (p.status === "pending") continue;
      const gc = group_counts[p.group_id];
      gc.released_count += 1;
      if (p.status === "boarded") gc.boarded_count += 1;
      else if (p.status === "walking") gc.walking_count += 1;
      else gc.queued_count += 1;
    }

    /* 人数守恒：released = boarded + walking + queued（未释放者单独计数） */
    if (releasedCount !== boardedCount + walking.length + queuedTotal) {
      throw new Error(
        `人数守恒失败 t=${t}s: released=${releasedCount}, boarded=${boardedCount}, walking=${walking.length}, queued=${queuedTotal}`,
      );
    }

    timeline.push({
      t_s: t,
      released_count: releasedCount,
      boarded_count: boardedCount,
      queued_count: queuedTotal,
      walking_count: walking.length,
      node_queues,
      edge_counts,
      group_counts,
    });
  }

  /* 汇总指标：终帧与汇总必须一致（守恒在帧级已强制） */
  const metrics = computeMetrics(persons);
  const group_metrics: GroupMetrics[] = scenario.groups.map((g) => ({
    group_id: g.group_id,
    ...computeMetrics(persons.filter((p) => p.group_id === g.group_id)),
  }));

  return { metrics, group_metrics, timeline, departures_log };
}

type ResultIdentity = Pick<
  SimulationResult,
  "schema_version" | "engine_version" | "scenario_id" | "scenario_revision" | "plan_id" | "seed"
>;

function identityOf(scenario: Scenario, plan: Plan, seed: number): ResultIdentity {
  const s = scenario as unknown as Record<string, unknown> | null;
  const p = plan as unknown as Record<string, unknown> | null;
  return {
    schema_version: SCHEMA_VERSION,
    engine_version: ENGINE_VERSION,
    scenario_id: typeof s?.scenario_id === "string" ? s.scenario_id : null,
    scenario_revision: typeof s?.revision === "number" ? s.revision : null,
    plan_id: typeof p?.plan_id === "string" ? p.plan_id : null,
    seed: typeof seed === "number" ? seed : null,
  };
}

function emptyResult(id: ResultIdentity, status: SimulationResult["status"], violations: ValidationIssue[]): SimulationResult {
  return { ...id, status, violations, metrics: null, group_metrics: [], timeline: [], departures_log: [] };
}

/**
 * 统一入口。相同 (scenario, plan, seed) 必得相同结果。
 * 业务规则违反 → "invalid"（violations 说明原因）；程序异常 → "error"。
 */
export function simulate(scenario: Scenario, plan: Plan, seed: number): SimulationResult {
  const id = identityOf(scenario, plan, seed);
  try {
    if (!Number.isInteger(seed) || seed < 0) {
      return emptyResult(id, "invalid", [
        { code: "SEED_INVALID", path: "seed", message: "seed 必须为非负整数", severity: "error" },
      ]);
    }
    const scenarioIssues = validateScenario(scenario);
    if (scenarioIssues.some((i) => i.severity === "error")) {
      return emptyResult(id, "invalid", scenarioIssues);
    }
    const planIssues = validatePlan(scenario, plan);
    const issues = [...scenarioIssues, ...planIssues];
    if (issues.some((i) => i.severity === "error")) {
      return emptyResult(id, "invalid", issues);
    }
    const run = runEngine(scenario, plan, seed);
    return {
      ...id,
      status: "valid",
      violations: issues, // warning 级证据照常透出
      metrics: run.metrics,
      group_metrics: run.group_metrics,
      timeline: run.timeline,
      departures_log: run.departures_log,
    };
  } catch (e) {
    return emptyResult(id, "error", [
      { code: "ENGINE_INTERNAL", path: "", message: e instanceof Error ? e.message : String(e), severity: "error" },
    ]);
  }
}
