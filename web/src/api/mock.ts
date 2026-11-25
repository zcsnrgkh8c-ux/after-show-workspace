import type {
  CompareRequest,
  CompareResponse,
  GenerateRequest,
  GenerateResponse,
  GroupMetric,
  HealthResponse,
  Metrics,
  Mode,
  ParseRequest,
  ParseResponse,
  PatchItem,
  Plan,
  PlanDeparture,
  Scenario,
  SimulateRequest,
  SimulationResult,
  TimelineFrame,
  TraceEntry,
  ValidationIssue,
} from "../contract/types";

/**
 * 【开发占位 mock】仅在 VITE_API_MODE=mock 时启用（见 api/config.ts），UI 常驻显著标识。
 * 用于无服务端时校对布局与流程；engine_version 明确标注非 A 引擎。
 * 真实接口失败时绝不静默切换到本实现。
 */

const MOCK_ENGINE = "dev-mock-0.1（占位·非A引擎）";
const MODE: Mode = "rules";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ---------------- parse（关键词规则，mode=rules） ---------------- */

const EXIT_OF_NO: Record<string, string> = { "1": "E1", "2": "E2", "3": "E3" };

function mockParse(req: ParseRequest): ParseResponse {
  const { scenario, instruction } = req;
  const patch: PatchItem[] = [];
  const warnings: string[] = [];
  const summaryParts: string[] = [];
  const text = instruction;

  const closeEdgesOfExit = (exitId: string) => {
    for (const e of scenario.edges) {
      if ((e.from === exitId || e.to === exitId) && !e.closed) {
        patch.push({ target: "edge", id: e.edge_id, field: "closed", value: true });
      }
    }
    summaryParts.push(`关闭出口 ${exitId} 相关通道`);
  };

  if (/关闭|封闭|封路/.test(text)) {
    const noMatch = text.match(/([123])\s*号\s*(出口|通道)?/);
    const eMatch = text.match(/[Ee]\s*([123])/);
    if (noMatch) closeEdgesOfExit(EXIT_OF_NO[noMatch[1]]);
    else if (eMatch) closeEdgesOfExit(EXIT_OF_NO[eMatch[1]]);
    else if (/西/.test(text)) closeEdgesOfExit("E1");
    else if (/东/.test(text)) closeEdgesOfExit("E3");
    else warnings.push("检测到“关闭”但未识别具体出口/通道，请指明如“2号出口”");
  }

  if (/减少一辆车|少一辆车|一辆车不可用|减一辆车|去掉一辆/.test(text)) {
    const last = scenario.fleet[scenario.fleet.length - 1];
    if (last) {
      patch.push({ target: "vehicle", id: last.vehicle_id, field: "enabled", value: false });
      summaryParts.push(`移除车辆 ${last.vehicle_id}`);
    } else warnings.push("当前已无在役车辆");
  }

  const deadlineMatch = text.match(/(末班|截止|期限)[^0-9]{0,6}(提前|推迟)(\d+)\s*(分钟|分|秒)?/);
  if (deadlineMatch) {
    const delta = Number(deadlineMatch[3]) * (deadlineMatch[4] === "秒" ? 1 : 60);
    const sign = deadlineMatch[2] === "提前" ? -1 : 1;
    const g = scenario.groups.find((x) => x.board_deadline_s !== null);
    if (g) {
      const next = (g.board_deadline_s as number) + sign * delta;
      if (next > 0 && next <= scenario.horizon_s) {
        patch.push({ target: "group", id: g.group_id, field: "board_deadline_s", value: next });
        summaryParts.push(`旅客组 ${g.group_id} 登车截止${deadlineMatch[2]}${deadlineMatch[3]}${deadlineMatch[4] ?? "分钟"}`);
      } else warnings.push(`调整后期限 ${next}s 超出窗口，未生成该项`);
    } else warnings.push("当前没有设置登车期限的旅客组");
  }

  if (patch.length === 0 && warnings.length === 0) {
    warnings.push("未能从指令中识别出可应用的修改（支持：关闭N号出口 / 减少一辆车 / 末班提前N分钟）");
  }

  return {
    patch,
    summary: summaryParts.length > 0 ? `规则解析（mock）：${summaryParts.join("；")}` : "规则解析（mock）：未产生修改",
    warnings,
    mode: MODE,
  };
}

/* ---------------- plan 生成（确定性规则） ---------------- */

function routeEdges(scenario: Scenario, routeId: string) {
  const route = scenario.routes.find((r) => r.route_id === routeId);
  return route ? route.edge_ids.map((id) => scenario.edges.find((e) => e.edge_id === id)!) : [];
}
function routeOpen(scenario: Scenario, routeId: string): boolean {
  return routeEdges(scenario, routeId).every((e) => e && !e.closed);
}
function routeStepFree(scenario: Scenario, routeId: string): boolean {
  return routeEdges(scenario, routeId).every((e) => e && e.step_free);
}
function routeTravel(scenario: Scenario, routeId: string): number {
  return routeEdges(scenario, routeId).reduce((s, e) => s + (e?.travel_s ?? 0), 0);
}

function legalDepartures(scenario: Scenario, stops: string[], perVehicle: number): PlanDeparture[] {
  const out: PlanDeparture[] = [];
  const vehicleNext = new Map<string, number>();
  const stopLast = new Map<string, number>();
  const gapOf = (stop: string) => scenario.nodes.find((n) => n.node_id === stop)?.boarding_gap_s ?? 0;
  for (let round = 0; round < perVehicle; round++) {
    scenario.fleet.forEach((v, vi) => {
      const stop = stops[(round + vi) % stops.length];
      const earliest = Math.max(
        round === 0 ? v.available_from_s : (vehicleNext.get(v.vehicle_id) ?? v.available_from_s),
        (stopLast.get(stop) ?? -Infinity) + gapOf(stop)
      );
      if (earliest > scenario.horizon_s) return;
      out.push({ vehicle_id: v.vehicle_id, stop_id: stop, depart_s: earliest });
      vehicleNext.set(v.vehicle_id, earliest + v.round_trip_s);
      stopLast.set(stop, earliest);
    });
  }
  return out.sort((a, b) => a.depart_s - b.depart_s || a.vehicle_id.localeCompare(b.vehicle_id));
}

function mockGenerate(req: GenerateRequest): GenerateResponse {
  const { scenario } = req;
  const trace: TraceEntry[] = [];
  const open = scenario.routes.filter((r) => routeOpen(scenario, r.route_id)).map((r) => r.route_id);
  const openStepFree = open.filter((id) => routeStepFree(scenario, id));
  const fastest = [...open].sort((a, b) => routeTravel(scenario, a) - routeTravel(scenario, b));
  const stops = scenario.nodes.filter((n) => n.kind === "stop").map((n) => n.node_id);

  const allocFor = (groupId: string, routeIds: string[]) => ({
    group_id: groupId,
    routes: routeIds.map((id) => ({ route_id: id, share: Math.round((1 / routeIds.length) * 100) / 100 })),
  });

  const mkAlloc = (regularR: string[], stepR: string[], deadlineR: string[]) =>
    scenario.groups.map((g) =>
      g.group_id === "step_free" || g.needs_step_free
        ? allocFor(g.group_id, stepR)
        : g.group_id === "deadline" || g.board_deadline_s !== null
          ? allocFor(g.group_id, deadlineR)
          : allocFor(g.group_id, regularR)
    );

  trace.push({
    step: 1,
    actor: "出口角色",
    action: "propose_allocations",
    source: "rules",
    summary: `开放路线 ${open.join("/") || "无"}；无台阶路线 ${openStepFree.join("/") || "无"}`,
    input_ref: "mock:scenario.routes+edges",
    output_ref: "mock:allocations(exit-role)",
    status: "ok",
  });

  const plans: Plan[] = [];
  const base: Plan = {
    schema_version: "1.0", plan_id: "mock_baseline", scenario_id: scenario.scenario_id,
    scenario_revision: scenario.revision, strategy: "baseline", name: "固定规则基线（mock）",
    allocations: mkAlloc(open, openStepFree, open),
    departures: legalDepartures(scenario, stops, 3),
    notes: ["开发 mock 生成的固定规则方案"],
  };
  plans.push(base);

  // 独立：出口角色只压最快路线；公交角色只发 P1 且间隔过密 → 合并后校验冲突
  const indep: Plan = {
    schema_version: "1.0", plan_id: "mock_independent", scenario_id: scenario.scenario_id,
    scenario_revision: scenario.revision, strategy: "independent", name: "双角色独立安排（mock）",
    allocations: mkAlloc(fastest.slice(0, 1), fastest.filter((id) => openStepFree.includes(id)).slice(0, 1), fastest.slice(0, 1)),
    departures:
      stops.length > 0
        ? scenario.fleet.flatMap((v) => [0, 1, 2].map((k) => ({ vehicle_id: v.vehicle_id, stop_id: stops[0], depart_s: v.available_from_s + k * 10 })))
        : [],
    notes: ["合并后存在站点间隔/车辆周转冲突，预期被校验拦截"],
  };
  plans.push(indep);
  trace.push({
    step: 2,
    actor: "公交角色",
    action: "propose_departures",
    source: "rules",
    summary: `独立方案集中在 ${stops[0] ?? "—"} 发车`,
    input_ref: "mock:scenario.fleet+nodes(stop)",
    output_ref: "mock:departures(bus-role)",
    status: "ok",
  });

  const coord: Plan = {
    schema_version: "1.0", plan_id: "mock_coordinated", scenario_id: scenario.scenario_id,
    scenario_revision: scenario.revision, strategy: "coordinated", name: "协调修订方案（mock）",
    allocations: mkAlloc(open, openStepFree, open.length > 1 ? open : open),
    departures: legalDepartures(scenario, stops, 3),
    notes: ["按站点间隔与车辆周转修订发车时序"],
  };
  plans.push(coord);
  trace.push({
    step: 3,
    actor: "协调器",
    action: "revise",
    source: "validator",
    summary: "修订独立方案的班次冲突（mock 确定性规则）",
    input_ref: "mock:merged-plans",
    output_ref: "mock:coordinated-plan",
    status: "ok",
  });

  return { plans, trace, mode: MODE };
}

/* ---------------- simulate：校验 + 逐人确定性占位推演 ---------------- */

function mockValidatePlan(scenario: Scenario, plan: Plan): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const err = (code: string, path: string, message: string) => issues.push({ code, path, message, severity: "error" });

  if (plan.scenario_id !== scenario.scenario_id || plan.scenario_revision !== scenario.revision) {
    err("STALE_REVISION", "scenario_revision", `方案对应 rev${plan.scenario_revision}，当前 rev${scenario.revision}，拒绝执行`);
    return issues;
  }
  for (const g of scenario.groups) {
    const a = plan.allocations.find((x) => x.group_id === g.group_id);
    if (!a) {
      err("ALLOC_MISSING", `allocations.${g.group_id}`, `旅客组 ${g.group_id} 缺少分配项`);
      continue;
    }
    if (a.routes.length > 0) {
      const sum = a.routes.reduce((s, r) => s + r.share, 0);
      if (Math.abs(sum - 1) > 0.011) err("SHARE_SUM", `allocations.${g.group_id}`, `share 之和 ${sum.toFixed(3)} ≠ 1`);
      for (const r of a.routes) {
        if (!scenario.routes.some((x) => x.route_id === r.route_id)) err("ROUTE_UNKNOWN", `allocations.${g.group_id}`, `路线 ${r.route_id} 不存在`);
        else if (!routeOpen(scenario, r.route_id)) err("ROUTE_CLOSED", `allocations.${g.group_id}`, `路线 ${r.route_id} 含已关闭通道`);
        else if (g.needs_step_free && !routeStepFree(scenario, r.route_id)) err("STEP_FREE_VIOLATION", `allocations.${g.group_id}`, `避台阶组被分配含台阶路线 ${r.route_id}`);
      }
    }
  }
  const gapOf = (stop: string) => scenario.nodes.find((n) => n.node_id === stop)?.boarding_gap_s ?? 0;
  const byVehicle = new Map<string, PlanDeparture[]>();
  const byStop = new Map<string, PlanDeparture[]>();
  for (const d of plan.departures) {
    const v = scenario.fleet.find((x) => x.vehicle_id === d.vehicle_id);
    if (!v) {
      err("VEHICLE_UNKNOWN", "departures", `班次引用不存在/已移除车辆 ${d.vehicle_id}`);
      continue;
    }
    if (d.depart_s < v.available_from_s) err("VEHICLE_NOT_AVAILABLE", "departures", `${d.vehicle_id} 首班 ${d.depart_s}s 早于可用时刻 ${v.available_from_s}s`);
    if (!byVehicle.has(d.vehicle_id)) byVehicle.set(d.vehicle_id, []);
    byVehicle.get(d.vehicle_id)!.push(d);
    if (!byStop.has(d.stop_id)) byStop.set(d.stop_id, []);
    byStop.get(d.stop_id)!.push(d);
  }
  for (const [vid, list] of byVehicle) {
    const v = scenario.fleet.find((x) => x.vehicle_id === vid)!;
    const sorted = [...list].sort((a, b) => a.depart_s - b.depart_s);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].depart_s - sorted[i - 1].depart_s < v.round_trip_s)
        err("VEHICLE_OVERLAP", "departures", `${vid} 相邻班车间隔 ${sorted[i].depart_s - sorted[i - 1].depart_s}s < 周转 ${v.round_trip_s}s`);
    }
  }
  for (const [stop, list] of byStop) {
    const sorted = [...list].sort((a, b) => a.depart_s - b.depart_s);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].depart_s - sorted[i - 1].depart_s < gapOf(stop))
        err("STOP_GAP", "departures", `${stop} 相邻班车间隔 ${sorted[i].depart_s - sorted[i - 1].depart_s}s < 站点间隔 ${gapOf(stop)}s`);
    }
  }
  return issues;
}

interface Person {
  id: number;
  group: string;
  routeId: string | null;
  releaseT: number;
  edgeIdx: number; // 当前所在边序号；-1=在站点队列
  state: "unreleased" | "edgeQueue" | "walking" | "stopQueue" | "boarded";
  walkDoneT: number;
  wait: number;
  boardT: number | null;
}

function mockSimulate(req: SimulateRequest): SimulationResult {
  const { scenario, plan, seed } = req;
  const base: Omit<SimulationResult, "status" | "violations" | "metrics" | "group_metrics" | "timeline" | "departures_log"> = {
    schema_version: "1.0",
    engine_version: MOCK_ENGINE,
    scenario_id: scenario.scenario_id,
    scenario_revision: scenario.revision,
    plan_id: plan.plan_id,
    seed,
  };

  const issues = mockValidatePlan(scenario, plan);
  if (issues.some((i) => i.severity === "error")) {
    return { ...base, status: "invalid", violations: issues, metrics: null, group_metrics: [], timeline: [], departures_log: [] };
  }

  // 需求展开（确定性均匀释放；最大余数法分摊到路线）
  const persons: Person[] = [];
  let pid = 1;
  for (const g of scenario.groups) {
    const alloc = plan.allocations.find((a) => a.group_id === g.group_id);
    const shares = alloc?.routes ?? [];
    // 最大余数法
    const raw = shares.map((r) => ({ route_id: r.route_id, exact: g.count * r.share }));
    const floors = raw.map((r) => Math.floor(r.exact));
    let rem = g.count - floors.reduce((s, x) => s + x, 0);
    const order = raw.map((r, i) => ({ i, frac: r.exact - floors[i], route_id: r.route_id })).sort((a, b) => b.frac - a.frac || a.route_id.localeCompare(b.route_id));
    const counts = [...floors];
    for (let k = 0; k < order.length && rem > 0; k++, rem--) counts[order[k].i]++;
    let local = 0;
    shares.forEach((r, i) => {
      for (let k = 0; k < counts[i]; k++) {
        const t = g.release_end_s > g.release_start_s ? g.release_start_s + ((g.release_end_s - g.release_start_s) * local) / Math.max(1, g.count) : g.release_start_s;
        persons.push({ id: pid++, group: g.group_id, routeId: r.route_id, releaseT: Math.round(t / scenario.step_s) * scenario.step_s, edgeIdx: 0, state: "unreleased", walkDoneT: 0, wait: 0, boardT: null });
        local++;
      }
    });
    // routes: [] → 留在 S（无路线人员）
    const assigned = shares.length > 0 ? g.count : 0;
    void assigned;
    if (shares.length === 0) {
      for (let k = 0; k < g.count; k++) {
        const t = g.release_end_s > g.release_start_s ? g.release_start_s + ((g.release_end_s - g.release_start_s) * k) / Math.max(1, g.count) : g.release_start_s;
        persons.push({ id: pid++, group: g.group_id, routeId: null, releaseT: Math.round(t / scenario.step_s) * scenario.step_s, edgeIdx: -1, state: "unreleased", walkDoneT: 0, wait: 0, boardT: null });
      }
    }
  }

  const step = scenario.step_s;
  const horizon = scenario.horizon_s;
  const edgeById = new Map(scenario.edges.map((e) => [e.edge_id, e]));
  const routeOf = (p: Person) => scenario.routes.find((r) => r.route_id === p.routeId)!;
  const groupOf = (p: Person) => scenario.groups.find((g) => g.group_id === p.group)!;
  const edgeCredit = new Map<string, number>();
  const departuresByT = new Map<number, PlanDeparture[]>();
  for (const d of plan.departures) {
    if (!departuresByT.has(d.depart_s)) departuresByT.set(d.depart_s, []);
    departuresByT.get(d.depart_s)!.push(d);
  }
  const stopQueueOrder: Person[] = []; // FIFO
  const departuresLog: { vehicle_id: string; stop_id: string; depart_s: number; boarded_count: number }[] = [];
  const timeline: TimelineFrame[] = [];

  for (let t = 0; t <= horizon; t += step) {
    // ① 完成步行
    for (const p of persons) {
      if (p.state === "walking" && p.walkDoneT <= t) {
        const route = routeOf(p);
        if (p.edgeIdx + 1 < route.edge_ids.length) {
          p.edgeIdx++;
          p.state = "edgeQueue";
        } else {
          p.state = "stopQueue";
          stopQueueOrder.push(p);
        }
      }
    }
    // ② 释放
    for (const p of persons) {
      if (p.state === "unreleased" && p.releaseT <= t) {
        p.state = p.routeId === null ? "edgeQueue" : "edgeQueue"; // 无路线者计入 S 队列（routeId=null 永远在 edgeQueue）
      }
    }
    // ③ 发车 FIFO 登车
    for (const d of (departuresByT.get(t) ?? []).sort((a, b) => a.vehicle_id.localeCompare(b.vehicle_id))) {
      const v = scenario.fleet.find((x) => x.vehicle_id === d.vehicle_id)!;
      let boarded = 0;
      for (let i = 0; i < stopQueueOrder.length && boarded < v.capacity; ) {
        const p = stopQueueOrder[i];
        if (routeOf(p).stop_id === d.stop_id) {
          p.state = "boarded";
          p.boardT = t;
          stopQueueOrder.splice(i, 1);
          boarded++;
        } else i++;
      }
      departuresLog.push({ vehicle_id: d.vehicle_id, stop_id: d.stop_id, depart_s: t, boarded_count: boarded });
    }
    // ④ 边放行（credit 累积）
    for (const e of scenario.edges) {
      if (e.closed) continue;
      const q = (e.capacity_per_min * step) / 60;
      const credit = (edgeCredit.get(e.edge_id) ?? 0) + q;
      const slots = Math.floor(credit);
      edgeCredit.set(e.edge_id, credit - slots);
      if (slots <= 0) continue;
      // 该边入口队列：state=edgeQueue 且 route 当前边为 e（按 person id 顺序 = 到达顺序近似）
      let remaining = slots;
      for (const p of persons) {
        if (remaining <= 0) break;
        if (p.state !== "edgeQueue" || p.routeId === null) continue;
        const route = routeOf(p);
        if (route.edge_ids[p.edgeIdx] !== e.edge_id) continue;
        const g = groupOf(p);
        p.state = "walking";
        p.walkDoneT = t + Math.ceil((e.travel_s * g.walk_time_factor) / step) * step;
        remaining--;
      }
    }
    // ⑤ 统计（队列等待累计）
    const nodeQueues: Record<string, number> = {};
    const edgeCounts: Record<string, number> = {};
    const groupCounts: TimelineFrame["group_counts"] = {};
    for (const g of scenario.groups) groupCounts[g.group_id] = { released_count: 0, boarded_count: 0, queued_count: 0, walking_count: 0 };
    let released = 0;
    let boardedCnt = 0;
    let queued = 0;
    let walking = 0;
    for (const p of persons) {
      if (p.state === "unreleased") continue;
      const gc = groupCounts[p.group];
      gc.released_count++;
      released++;
      if (p.state === "boarded") {
        boardedCnt++;
        gc.boarded_count++;
      } else if (p.state === "walking") {
        walking++;
        gc.walking_count++;
        const eid = routeOf(p).edge_ids[p.edgeIdx];
        edgeCounts[eid] = (edgeCounts[eid] ?? 0) + 1;
      } else {
        // edgeQueue / stopQueue
        queued++;
        gc.queued_count++;
        p.wait += step;
        const nodeId = p.state === "stopQueue" ? routeOf(p).stop_id : p.routeId === null ? "S" : edgeById.get(routeOf(p).edge_ids[p.edgeIdx])!.from;
        nodeQueues[nodeId] = (nodeQueues[nodeId] ?? 0) + 1;
      }
    }
    timeline.push({ t_s: t, released_count: released, boarded_count: boardedCnt, queued_count: queued, walking_count: walking, node_queues: nodeQueues, edge_counts: edgeCounts, group_counts: groupCounts });
  }

  // 指标
  const boardedPersons = persons.filter((p) => p.state === "boarded");
  const releasedPersons = persons.filter((p) => p.state !== "unreleased");
  const waitsOf = (list: Person[]) => list.reduce((s, p) => s + p.wait, 0);
  const p95Of = (list: Person[]): number | null => {
    if (list.length === 0) return null;
    const sorted = list.map((p) => p.wait).sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)];
  };
  const clearance = (() => {
    if (persons.length === 0) return 0;
    if (boardedPersons.length < persons.length) return null;
    return Math.max(...persons.map((p) => p.boardT ?? Infinity));
  })();
  const metrics: Metrics = {
    released_count: releasedPersons.length,
    boarded_count: boardedPersons.length,
    remaining_count: releasedPersons.length - boardedPersons.length,
    mean_queue_wait_all_released_s: releasedPersons.length === 0 ? null : Math.round((waitsOf(releasedPersons) / releasedPersons.length) * 10) / 10,
    p95_queue_wait_boarded_s: p95Of(boardedPersons),
    missed_deadline_count: persons.filter((p) => {
      const g = groupOf(p);
      return g.board_deadline_s !== null && (p.boardT === null || p.boardT > g.board_deadline_s);
    }).length,
    clearance_time_s: clearance === null ? null : clearance === Infinity ? null : clearance,
  };
  const groupMetrics: GroupMetric[] = scenario.groups.map((g) => {
    const gp = persons.filter((p) => p.group === g.group_id);
    const gb = gp.filter((p) => p.state === "boarded");
    const gr = gp.filter((p) => p.state !== "unreleased");
    return {
      group_id: g.group_id,
      released_count: gr.length,
      boarded_count: gb.length,
      remaining_count: gr.length - gb.length,
      mean_queue_wait_all_released_s: gr.length === 0 ? null : Math.round((waitsOf(gr) / gr.length) * 10) / 10,
      p95_queue_wait_boarded_s: p95Of(gb),
      missed_deadline_count:
        g.board_deadline_s === null ? 0 : gp.filter((p) => p.boardT === null || p.boardT > (g.board_deadline_s as number)).length,
      clearance_time_s: gp.length === 0 ? 0 : gb.length === gp.length ? Math.max(...gp.map((p) => p.boardT ?? 0)) : null,
    };
  });

  return {
    ...base,
    status: "valid",
    violations: issues,
    metrics,
    group_metrics: groupMetrics,
    timeline,
    departures_log: departuresLog,
  };
}

/* ---------------- compare ---------------- */

function metricKey(m: Metrics, objective: "efficiency" | "inclusion" | "balanced", priorityUnboarded: number): number[] {
  const mean = m.mean_queue_wait_all_released_s ?? Number.MAX_SAFE_INTEGER;
  if (objective === "efficiency") return [m.remaining_count, mean, m.missed_deadline_count];
  if (objective === "inclusion") return [priorityUnboarded, m.missed_deadline_count, m.remaining_count, mean];
  return [m.remaining_count, m.missed_deadline_count, mean];
}

function mockCompare(req: CompareRequest): CompareResponse {
  const results = req.plans.map((plan) => mockSimulate({ scenario: req.scenario, plan, seed: req.seed }));
  const trace: TraceEntry[] = results.map((r, i) => ({
    step: i + 1,
    actor: "推演引擎(mock)",
    action: `simulate(${r.plan_id})`,
    source: r.status === "valid" ? "simulator" : "validator",
    summary: r.status === "valid" ? `valid：剩余 ${r.metrics?.remaining_count}，登车 ${r.metrics?.boarded_count}` : `invalid：${r.violations[0]?.message ?? "校验未通过"}`,
    input_ref: `mock:plan(${r.plan_id})`,
    output_ref: `mock:result(${r.plan_id})`,
    status: r.status === "valid" ? "ok" : "rejected",
  }));

  const priorityGroups = new Set(req.scenario.groups.filter((g) => g.needs_step_free || g.board_deadline_s !== null).map((g) => g.group_id));
  const valid = results.filter((r) => r.status === "valid" && r.metrics);
  let recommendation: CompareResponse["recommendation"];
  if (valid.length === 0) {
    recommendation = {
      plan_id: null,
      status: "no_valid_candidate",
      reason: `本轮 ${results.length} 个候选均未通过校验：${results.map((r) => `${r.plan_id}(${r.violations[0]?.code ?? "?"})`).join("、")}。候选失败不等于数学上无解，可修正场景后重试。`,
      tradeoffs: [],
    };
  } else {
    const ranked = [...valid].sort((a, b) => {
      const ka = metricKey(a.metrics!, req.objective, a.group_metrics.filter((g) => priorityGroups.has(g.group_id)).reduce((s, g) => s + g.remaining_count, 0));
      const kb = metricKey(b.metrics!, req.objective, b.group_metrics.filter((g) => priorityGroups.has(g.group_id)).reduce((s, g) => s + g.remaining_count, 0));
      for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
      return 0;
    });
    const best = ranked[0];
    const tied = ranked.length > 1 && metricKey(best.metrics!, req.objective, 0).every((v, i) => {
      const kb = metricKey(ranked[1].metrics!, req.objective, 0);
      return kb[i] === v;
    });
    recommendation = {
      plan_id: best.plan_id,
      status: tied ? "tradeoff" : "recommended",
      reason: tied
        ? `${best.plan_id} 与 ${ranked[1].plan_id} 在 ${req.objective} 目标下排序键相同，允许并列，不借 plan_id 宣称胜出。`
        : `${best.plan_id} 在 ${req.objective} 目标下排序最优：剩余 ${best.metrics!.remaining_count} 人、错过末班 ${best.metrics!.missed_deadline_count} 人、已登车 ${best.metrics!.boarded_count} 人（mock 计算）。`,
      tradeoffs: [
        `已登车 P95 排队 ${best.metrics!.p95_queue_wait_boarded_s ?? "—（无人登车）"}s（仅已登车样本），剩余 ${best.metrics!.remaining_count} 人需同屏查看。`,
        `清空时刻：${best.metrics!.clearance_time_s === null ? "窗口内未清空" : best.metrics!.clearance_time_s + "s"}`,
      ],
    };
  }
  return { results, recommendation, trace, mode: MODE };
}

/* ---------------- 导出 ---------------- */

export const mockApi = {
  async health(): Promise<HealthResponse> {
    await delay(80);
    return { status: "ok", schema_version: "1.0", engine_ready: true, llm_configured: false };
  },
  async parseScenario(req: ParseRequest): Promise<ParseResponse> {
    await delay(150);
    return mockParse(req);
  },
  async generatePlans(req: GenerateRequest): Promise<GenerateResponse> {
    await delay(200);
    return mockGenerate(req);
  },
  async simulate(req: SimulateRequest): Promise<SimulationResult> {
    await delay(200);
    return mockSimulate(req);
  },
  async compare(req: CompareRequest): Promise<CompareResponse> {
    await delay(250);
    return mockCompare(req);
  },
};
