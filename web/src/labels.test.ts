import { describe, expect, it } from "vitest";
import { cloneDefaultScenario } from "./contract/defaultScenario";
import type { Plan, SimulationResult } from "./contract/types";
import {
  fmtClock,
  fmtSimTime,
  groupKeyMetrics,
  groupNeedType,
  humanizeReason,
  needOptionsFromScenario,
  nodeDisplayName,
  planDisplayName,
  recommendationHeadline,
  routeSequenceText,
  serveStatusForGroup,
} from "./labels";

const scenario = cloneDefaultScenario();

/* ---------- 节点 / 路线可读名 ---------- */

describe("nodeDisplayName / routeSequenceText", () => {
  it("节点可读名来自 kind 与 node_id 编号", () => {
    const byId = (id: string) => scenario.nodes.find((n) => n.node_id === id)!;
    expect(nodeDisplayName(byId("S"))).toBe("场馆");
    expect(nodeDisplayName(byId("E1"))).toBe("1号出口");
    expect(nodeDisplayName(byId("E3"))).toBe("3号出口");
    expect(nodeDisplayName(byId("P1"))).toBe("接驳点 P1");
  });

  it("路线序列由当前 Scenario 推导，不写死", () => {
    expect(routeSequenceText(scenario, "R1")).toBe("场馆 → 1号出口 → 接驳点 P1");
    expect(routeSequenceText(scenario, "R2")).toBe("场馆 → 2号出口 → 接驳点 P2");
    expect(routeSequenceText(scenario, "R3")).toBe("场馆 → 3号出口 → 接驳点 P2");
    expect(routeSequenceText(scenario, "RX")).toBe("RX"); // 未知路线回退 id，不编造
  });
});

/* ---------- 需求类型 ---------- */

describe("needOptionsFromScenario", () => {
  it("按属性把组映射为需求选项，人数为该类组合计", () => {
    const options = needOptionsFromScenario(scenario);
    expect(options.map((o) => o.type)).toEqual(["regular", "step_free", "deadline"]);
    expect(options.map((o) => o.peopleCount)).toEqual([180, 40, 80]);
    expect(options[1].groupIds).toEqual(["step_free"]);
  });

  it("groupNeedType：避台阶优先于截止期限", () => {
    expect(groupNeedType({ needs_step_free: true, board_deadline_s: 900 })).toBe("step_free");
    expect(groupNeedType({ needs_step_free: false, board_deadline_s: 900 })).toBe("deadline");
    expect(groupNeedType({ needs_step_free: false, board_deadline_s: null })).toBe("regular");
  });
});

/* ---------- 方案名 ---------- */

describe("planDisplayName", () => {
  it("按策略映射为中文方案名", () => {
    expect(planDisplayName({ strategy: "coordinated" })).toBe("协调接驳方案");
    expect(planDisplayName({ strategy: "baseline" })).toBe("固定班次方案");
    expect(planDisplayName({ strategy: "independent" })).toBe("分组独立方案");
  });
});

/* ---------- 服务状态 ---------- */

function mkPlan(stepFreeRoutes: string[], regularRoutes: string[] = ["R1"]): Plan {
  return {
    allocations: [
      { group_id: "regular", routes: regularRoutes.map((r) => ({ route_id: r, share: 1 })) },
      { group_id: "step_free", routes: stepFreeRoutes.map((r) => ({ route_id: r, share: 1 })) },
      { group_id: "deadline", routes: regularRoutes.map((r) => ({ route_id: r, share: 1 })) },
    ],
  } as unknown as Plan;
}

function mkResult(opts: {
  status?: SimulationResult["status"];
  remaining?: number;
  missed?: number;
  codes?: string[];
}): SimulationResult {
  const status = opts.status ?? "valid";
  return {
    status,
    metrics: status === "valid" ? { remaining_count: opts.remaining ?? 0 } : null,
    group_metrics: [
      {
        group_id: "step_free",
        remaining_count: opts.remaining ?? 0,
        missed_deadline_count: 0,
        boarded_count: 0,
        released_count: 40,
        mean_queue_wait_all_released_s: null,
        p95_queue_wait_boarded_s: null,
        clearance_time_s: null,
      },
      {
        group_id: "deadline",
        remaining_count: 0,
        missed_deadline_count: opts.missed ?? 0,
        boarded_count: 80,
        released_count: 80,
        mean_queue_wait_all_released_s: 100,
        p95_queue_wait_boarded_s: 120,
        clearance_time_s: 600,
      },
      {
        group_id: "regular",
        remaining_count: 0,
        missed_deadline_count: 0,
        boarded_count: 180,
        released_count: 180,
        mean_queue_wait_all_released_s: 50,
        p95_queue_wait_boarded_s: 60,
        clearance_time_s: 500,
      },
    ],
    violations: (opts.codes ?? []).map((code) => ({
      code,
      path: "plans[0]",
      message: `mock ${code}`,
      severity: "error" as const,
    })),
  } as unknown as SimulationResult;
}

describe("serveStatusForGroup", () => {
  const allRoutesClosed = cloneDefaultScenario();
  for (const e of allRoutesClosed.edges) if (e.step_free) e.closed = true;

  it("有开放路线且无人滞留 → ok", () => {
    const s = serveStatusForGroup(scenario, mkPlan(["R1", "R2"]), mkResult({}), "step_free");
    expect(s.level).toBe("ok");
    if (s.level === "ok") expect(s.warning).toBeUndefined();
  });

  it("有开放路线但仍有滞留 → ok 级 + 运力警示（不解释成断路）", () => {
    const s = serveStatusForGroup(scenario, mkPlan(["R1", "R2"]), mkResult({ remaining: 40 }), "step_free");
    expect(s.level).toBe("ok");
    if (s.level === "ok") expect(s.warning).toContain("40 人未登车");
  });

  it("方案未给该组分配路线 → blocked(no_route)", () => {
    const s = serveStatusForGroup(scenario, mkPlan([]), mkResult({}), "step_free");
    expect(s).toMatchObject({ level: "blocked", reason: "no_route" });
  });

  it("分配路线全部含关闭通道 → blocked(no_open_route)，即没有符合条件的路线", () => {
    const s = serveStatusForGroup(allRoutesClosed, mkPlan(["R1", "R2"]), mkResult({}), "step_free");
    expect(s).toMatchObject({ level: "blocked", reason: "no_open_route" });
  });

  it("invalid 结果 → blocked(invalid_plan)，PLAN_STOP_GAP 转为可读短语", () => {
    const s = serveStatusForGroup(scenario, mkPlan(["R1"]), mkResult({ status: "invalid", codes: ["PLAN_STOP_GAP"] }), "step_free");
    expect(s.level).toBe("blocked");
    if (s.level === "blocked") expect(s.text).toContain("班次安排冲突");
  });

  it("无方案 → unknown，不猜测", () => {
    expect(serveStatusForGroup(scenario, null, null, "step_free").level).toBe("unknown");
  });

  it("截止组全部登车但有人迟到 → ok + 迟到警示", () => {
    const s = serveStatusForGroup(scenario, mkPlan(["R1"]), mkResult({ missed: 24 }), "deadline");
    expect(s.level).toBe("ok");
    if (s.level === "ok") expect(s.warning).toContain("24 人晚于截止");
  });
});

/* ---------- 组级关键指标 ---------- */

describe("groupKeyMetrics", () => {
  it("从组级指标取数，截止组带 missedDeadline，非截止组为 null", () => {
    const m = groupKeyMetrics(scenario, mkResult({ remaining: 40, missed: 24 }), "step_free");
    expect(m).toEqual({ total: 40, boarded: 0, released: 40, remaining: 40, meanWait: null, missedDeadline: null });
    const d = groupKeyMetrics(scenario, mkResult({ missed: 24 }), "deadline");
    expect(d?.missedDeadline).toBe(24);
    expect(d?.total).toBe(80);
    expect(d?.boarded).toBe(80);
  });

  it("结果无效时返回 null，绝不编造 0", () => {
    expect(groupKeyMetrics(scenario, mkResult({ status: "invalid" }), "step_free")).toBeNull();
    expect(groupKeyMetrics(scenario, null, "step_free")).toBeNull();
    expect(groupKeyMetrics(scenario, mkResult({}), "nope")).toBeNull();
  });
});

/* ---------- 推荐理由 ---------- */

describe("humanizeReason", () => {
  it("替换已知技术词与 plan_id 前缀，其余原样保留", () => {
    expect(humanizeReason("remaining_count 最小且按字典序回退")).toBe(
      "模拟结束仍未登车人数 最小且按同分时的固定先后顺序回退"
    );
    expect(humanizeReason("plan_coordinated_concert_demo_r1_balanced 的 boarded_count 最高")).toBe(
      "协调接驳方案 的 已登车人数 最高"
    );
    expect(humanizeReason("无已知术语")).toBe("无已知术语");
  });
});

describe("recommendationHeadline / 时间格式", () => {
  it("推荐状态短语", () => {
    expect(recommendationHeadline({ status: "recommended" })).toBe("系统当前推荐");
    expect(recommendationHeadline({ status: "tradeoff" })).toBe("系统当前推荐（存在取舍）");
    expect(recommendationHeadline({ status: "no_valid_candidate" })).toBe("暂无可计算结果");
  });

  it("模拟时间用 mm:ss", () => {
    expect(fmtClock(0)).toBe("00:00");
    expect(fmtClock(65)).toBe("01:05");
    expect(fmtClock(900)).toBe("15:00");
    expect(fmtSimTime(300)).toBe("模拟第 05:00");
  });
});
