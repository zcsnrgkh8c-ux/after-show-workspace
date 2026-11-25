import { describe, expect, it } from "vitest";
import { DEFAULT_SCENARIO, cloneDefaultScenario } from "../contract/defaultScenario";
import type { ParsePatch } from "../contract/types";
import {
  allValidStranded,
  applyPatchToScenario,
  canApplyPending,
  runMatchesCurrent,
  scenarioIdentity,
} from "./scenarioOps";

const metricsOf = (released: number, boarded: number) => ({
  released_count: released,
  boarded_count: boarded,
  remaining_count: released - boarded,
  mean_queue_wait_all_released_s: released > 0 ? 10 : null,
  p95_queue_wait_boarded_s: boarded > 0 ? 10 : null,
  missed_deadline_count: 0,
  clearance_time_s: null,
});

describe("allValidStranded：全员滞留判定（不误报无合法候选）", () => {
  it("全部有效候选均 released>0 且 boarded=0 → true", () => {
    expect(
      allValidStranded([
        { status: "valid", metrics: metricsOf(300, 0) },
        { status: "valid", metrics: metricsOf(300, 0) },
      ])
    ).toBe(true);
  });

  it("任一有效候选有人登车 → false", () => {
    expect(
      allValidStranded([
        { status: "valid", metrics: metricsOf(300, 0) },
        { status: "valid", metrics: metricsOf(300, 240) },
      ])
    ).toBe(false);
  });

  it("零需求（released=0）不触发 → false", () => {
    expect(allValidStranded([{ status: "valid", metrics: metricsOf(0, 0) }])).toBe(false);
  });

  it("无有效候选 → false（此时才允许显示无合法候选）", () => {
    expect(allValidStranded([{ status: "invalid", metrics: null }])).toBe(false);
    expect(allValidStranded([])).toBe(false);
  });

  it("valid 滞留 + invalid 混合 → true（只看有效候选）", () => {
    expect(
      allValidStranded([
        { status: "valid", metrics: metricsOf(300, 0) },
        { status: "invalid", metrics: null },
      ])
    ).toBe(true);
  });
});

describe("applyPatchToScenario：受限 patch 应用", () => {
  it("合法 patch 生效且 revision+1，原场景不被改动", () => {
    const s = cloneDefaultScenario();
    const { next, applied, skipped } = applyPatchToScenario(s, [
      { target: "edge", id: "b1", field: "closed", value: true },
      { target: "group", id: "deadline", field: "board_deadline_s", value: 600 },
    ]);
    expect(applied.length).toBe(2);
    expect(skipped.length).toBe(0);
    expect(next.revision).toBe(s.revision + 1);
    expect(next.edges.find((e) => e.edge_id === "b1")!.closed).toBe(true);
    expect(next.groups.find((g) => g.group_id === "deadline")!.board_deadline_s).toBe(600);
    // 原对象不可变
    expect(s.edges.find((e) => e.edge_id === "b1")!.closed).toBe(false);
    expect(s.revision).toBe(1);
  });

  it("车辆移除 = 从 fleet 删除；不存在的字段/目标被跳过并给出原因", () => {
    const s = cloneDefaultScenario();
    // 未经校验的运行时输入边界：共享 ParsePatch 不允许这些值，此处显式绕过类型以验证运行时拒绝
    const untrusted = [
      { target: "vehicle", id: "B3", field: "enabled", value: false },
      { target: "vehicle", id: "B1", field: "enabled", value: true }, // 契约只允许 false
      { target: "edge", id: "a1", field: "step_free", value: true }, // 不在白名单
      { target: "edge", id: "zz", field: "closed", value: true }, // 目标不存在
    ] as unknown as ParsePatch[];
    const { next, applied, skipped } = applyPatchToScenario(s, untrusted);
    expect(applied.length).toBe(1);
    expect(skipped.length).toBe(3);
    expect(next.fleet.some((v) => v.vehicle_id === "B3")).toBe(false);
    expect(next.fleet.length).toBe(DEFAULT_SCENARIO.fleet.length - 1);
    expect(next.edges.find((e) => e.edge_id === "a1")!.step_free).toBe(true); // 未被改动
  });

  it("非法值被拒绝：负人数、非正系数、超窗口期限", () => {
    const s = cloneDefaultScenario();
    const untrusted = [
      { target: "group", id: "regular", field: "count", value: -5 },
      { target: "group", id: "regular", field: "walk_time_factor", value: 0 },
      { target: "edge", id: "a1", field: "travel_s", value: -10 },
    ] as unknown as ParsePatch[];
    const { applied, skipped } = applyPatchToScenario(s, untrusted);
    expect(applied.length).toBe(0);
    expect(skipped.length).toBe(3);
  });
});

describe("canApplyPending：旧 patch 不得应用到新场景", () => {
  it("base_revision 与当前一致才允许应用", () => {
    const s = cloneDefaultScenario(); // rev 1
    expect(canApplyPending({ scenario_id: "concert_demo", base_revision: 1 }, s)).toBe(true);
    const newer = { ...s, revision: 2 };
    expect(canApplyPending({ scenario_id: "concert_demo", base_revision: 1 }, newer)).toBe(false);
    expect(canApplyPending({ scenario_id: "other", base_revision: 2 }, newer)).toBe(false);
  });
});

describe("runMatchesCurrent / scenarioIdentity：过期判定", () => {
  const run = { scenario_id: "concert_demo", scenario_revision: 1, objective: "balanced" as const, seed: 20261114 };

  it("完全匹配才为最新", () => {
    const s = cloneDefaultScenario();
    expect(runMatchesCurrent(run, s, "balanced", 20261114)).toBe(true);
  });

  it("revision / objective / seed 任一变化即过期", () => {
    const s = cloneDefaultScenario();
    const s2 = { ...s, revision: 2 };
    expect(runMatchesCurrent(run, s2, "balanced", 20261114)).toBe(false);
    expect(runMatchesCurrent(run, s, "efficiency", 20261114)).toBe(false);
    expect(runMatchesCurrent(run, s, "balanced", 42)).toBe(false);
  });

  it("scenarioIdentity 格式稳定", () => {
    expect(scenarioIdentity(cloneDefaultScenario())).toBe("concert_demo@1");
  });
});
