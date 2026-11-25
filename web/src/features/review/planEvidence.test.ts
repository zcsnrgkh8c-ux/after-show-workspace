import { describe, expect, it } from "vitest";
import { cloneDefaultScenario } from "../../contract/defaultScenario";
import type { Plan, SimulationResult } from "../../contract/types";
import { needEvidenceRows, servedNeedCount, serveStatusTitle, unfinishedNeedRows } from "./planEvidence";

const scenario = cloneDefaultScenario();

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
  stepFreeRemaining?: number;
  deadlineMissed?: number;
}): SimulationResult {
  const status = opts.status ?? "valid";
  return {
    status,
    metrics: status === "valid" ? { remaining_count: opts.stepFreeRemaining ?? 0 } : null,
    group_metrics:
      status === "valid"
        ? [
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
            {
              group_id: "step_free",
              remaining_count: opts.stepFreeRemaining ?? 0,
              missed_deadline_count: 0,
              boarded_count: 40 - (opts.stepFreeRemaining ?? 0),
              released_count: 40,
              mean_queue_wait_all_released_s: null,
              p95_queue_wait_boarded_s: null,
              clearance_time_s: null,
            },
            {
              group_id: "deadline",
              remaining_count: 0,
              missed_deadline_count: opts.deadlineMissed ?? 0,
              boarded_count: 80,
              released_count: 80,
              mean_queue_wait_all_released_s: 100,
              p95_queue_wait_boarded_s: 120,
              clearance_time_s: 600,
            },
          ]
        : [],
    violations: [],
  } as unknown as SimulationResult;
}

describe("needEvidenceRows", () => {
  it("逐需求给出可读名、人数与服务状态，来自真实 Scenario/Plan/Result", () => {
    const rows = needEvidenceRows(scenario, mkPlan(["R1", "R2"]), mkResult({}));
    expect(rows.map((r) => r.label)).toEqual(["普通出行", "需要无台阶通行", "希望赶上末班"]);
    expect(rows.map((r) => r.people)).toEqual([180, 40, 80]);
    expect(rows.every((r) => r.status.level === "ok")).toBe(true);
    expect(servedNeedCount(rows)).toBe(3);
  });

  it("方案未给无台阶组分配路线 → 该需求受阻，其余不受影响", () => {
    const rows = needEvidenceRows(scenario, mkPlan([]), mkResult({}));
    const stepFree = rows.find((r) => r.groupId === "step_free")!;
    expect(stepFree.status).toMatchObject({ level: "blocked", reason: "no_route" });
    expect(servedNeedCount(rows)).toBe(2);
  });

  it("关闭全部无台阶通道 → 分配路线含关闭通道，受阻原因是实际通道状态", () => {
    const closed = cloneDefaultScenario();
    for (const e of closed.edges) if (e.step_free) e.closed = true;
    const rows = needEvidenceRows(closed, mkPlan(["R1", "R2"]), mkResult({}));
    const stepFree = rows.find((r) => r.groupId === "step_free")!;
    expect(stepFree.status).toMatchObject({ level: "blocked", reason: "no_open_route" });
  });

  it("invalid 结果 → 所有需求标记为方案未通过校验，不编造指标", () => {
    const rows = needEvidenceRows(scenario, mkPlan(["R1"]), mkResult({ status: "invalid" }));
    expect(rows.every((r) => r.status.level === "blocked")).toBe(true);
    expect(rows.every((r) => r.remaining === null)).toBe(true);
    expect(rows.every((r) => r.hasMetrics === false)).toBe(true);
  });

  it("无方案/无结果 → 状态未知，指标为 null 而非 0", () => {
    const rows = needEvidenceRows(scenario, null, null);
    expect(rows.every((r) => r.status.level === "unknown")).toBe(true);
    expect(rows.every((r) => r.remaining === null && r.missedDeadline === null)).toBe(true);
    expect(servedNeedCount(rows)).toBe(0);
  });
});

describe("unfinishedNeedRows", () => {
  it("仍有未登车 → 进入未完成列表，数字真实", () => {
    const rows = needEvidenceRows(scenario, mkPlan(["R1", "R2"]), mkResult({ stepFreeRemaining: 40 }));
    const unfinished = unfinishedNeedRows(rows);
    expect(unfinished).toHaveLength(1);
    expect(unfinished[0].groupId).toBe("step_free");
    expect(unfinished[0].remaining).toBe(40);
  });

  it("全部登车但有人错过截止 → 仍算未完成（按时完成口径）", () => {
    const rows = needEvidenceRows(scenario, mkPlan(["R1"]), mkResult({ deadlineMissed: 24 }));
    const unfinished = unfinishedNeedRows(rows);
    expect(unfinished).toHaveLength(1);
    expect(unfinished[0].groupId).toBe("deadline");
    expect(unfinished[0].remaining).toBe(0);
    expect(unfinished[0].missedDeadline).toBe(24);
  });

  it("无有效结果不算未完成（未知≠完成）", () => {
    const rows = needEvidenceRows(scenario, mkPlan(["R1"]), mkResult({ status: "invalid" }));
    expect(unfinishedNeedRows(rows)).toEqual([]);
  });

  it("全部按时完成 → 空列表", () => {
    const rows = needEvidenceRows(scenario, mkPlan(["R1", "R2"]), mkResult({}));
    expect(unfinishedNeedRows(rows)).toEqual([]);
  });

  it("非截止组 missedDeadline 恒为 null，不伪造截止口径", () => {
    const rows = needEvidenceRows(scenario, mkPlan(["R1"]), mkResult({}));
    const regular = rows.find((r) => r.groupId === "regular")!;
    expect(regular.hasDeadline).toBe(false);
    expect(regular.missedDeadline).toBeNull();
  });
});

describe("serveStatusTitle", () => {
  it("ok 带滞留警示时拼接警示，不把风险藏起来", () => {
    const rows = needEvidenceRows(scenario, mkPlan(["R1", "R2"]), mkResult({ stepFreeRemaining: 40 }));
    const stepFree = rows.find((r) => r.groupId === "step_free")!;
    expect(stepFree.status.level).toBe("ok");
    expect(serveStatusTitle(stepFree.status)).toContain("40 人未登车");
  });

  it("blocked 拼接实际原因与提示；unknown 原样返回", () => {
    const blocked = needEvidenceRows(scenario, mkPlan([]), mkResult({})).find((r) => r.groupId === "step_free")!;
    expect(serveStatusTitle(blocked.status)).toContain("未为该需求安排接驳路线");
    expect(serveStatusTitle({ level: "unknown", text: "尚未生成接驳方案" })).toBe("尚未生成接驳方案");
  });
});
