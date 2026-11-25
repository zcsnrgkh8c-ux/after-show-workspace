import { describe, expect, it } from "vitest";
import type { Metrics, SimulationResult, ValidationIssue } from "../../contract/types";
import {
  decisionModeText,
  groupViolationsByCode,
  recommendationFactWarnings,
  resultHasUnfinished,
} from "./display";

const issue = (code: string, severity: "error" | "warning", path: string, message: string): ValidationIssue => ({
  code,
  severity,
  path,
  message,
});

const baseMetrics: Metrics = {
  released_count: 300,
  boarded_count: 300,
  remaining_count: 0,
  mean_queue_wait_all_released_s: null,
  p95_queue_wait_boarded_s: null,
  missed_deadline_count: 0,
  clearance_time_s: null,
};

const makeResult = (status: SimulationResult["status"], metrics: Metrics | null): SimulationResult => ({
  schema_version: "1.0",
  engine_version: "test",
  scenario_id: "s",
  scenario_revision: 1,
  plan_id: "p",
  seed: 1,
  status,
  violations: [],
  metrics,
  group_metrics: [],
  timeline: [],
  departures_log: [],
});

describe("groupViolationsByCode", () => {
  it("按 code 归类并保持真实计数，warning 不丢失", () => {
    const groups = groupViolationsByCode([
      issue("PLAN_STOP_GAP", "error", "departures[2]", "班次间隔不足"),
      issue("PLAN_STOP_GAP", "warning", "departures[0]", "间隔接近下限"),
      issue("OTHER_CODE", "warning", "x", "y"),
    ]);
    expect(groups).toHaveLength(2);
    const g = groups.find((x) => x.code === "PLAN_STOP_GAP")!;
    expect(g.count).toBe(2);
    expect(g.errors).toBe(1);
    expect(g.warnings).toBe(1);
    expect(g.items).toHaveLength(2);
    expect(g.items[0].path).toBe("departures[2]");
  });

  it("空列表返回空数组", () => {
    expect(groupViolationsByCode([])).toEqual([]);
  });
});

describe("decisionModeText", () => {
  it("llm/rules 映射中文；缺失显示 —；未知值原样保留不猜测", () => {
    expect(decisionModeText("llm")).toBe("LLM 模式");
    expect(decisionModeText("rules")).toBe("规则模式");
    expect(decisionModeText(undefined)).toBe("—");
    expect(decisionModeText("weird" as never)).toBe("weird");
  });
});

describe("recommendationFactWarnings", () => {
  it("无有效指标返回空数组，不编造提醒", () => {
    expect(recommendationFactWarnings(null)).toEqual([]);
  });

  it("300/300 全部登车但错过截止 → 明确提示登车完成不等于按时赶上末班", () => {
    const lines = recommendationFactWarnings({ ...baseMetrics, missed_deadline_count: 24 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("24");
    expect(lines[0]).toContain("错过");
  });

  it("仍有剩余未登车 → 提示未登车人数", () => {
    const lines = recommendationFactWarnings({ ...baseMetrics, remaining_count: 40 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("40");
  });

  it("两项同时存在时各一条，数字不混用", () => {
    const lines = recommendationFactWarnings({ ...baseMetrics, remaining_count: 3, missed_deadline_count: 5 });
    expect(lines).toHaveLength(2);
  });

  it("全部按时完成时无提醒", () => {
    expect(recommendationFactWarnings({ ...baseMetrics })).toEqual([]);
  });
});

describe("resultHasUnfinished", () => {
  it("无效结果或无指标返回 false", () => {
    expect(resultHasUnfinished(null)).toBe(false);
    expect(resultHasUnfinished(undefined)).toBe(false);
    expect(resultHasUnfinished(makeResult("invalid", null))).toBe(false);
  });

  it("剩余或错过截止任一存在即为 true", () => {
    expect(resultHasUnfinished(makeResult("valid", { ...baseMetrics }))).toBe(false);
    expect(resultHasUnfinished(makeResult("valid", { ...baseMetrics, remaining_count: 1 }))).toBe(true);
    expect(resultHasUnfinished(makeResult("valid", { ...baseMetrics, missed_deadline_count: 2 }))).toBe(true);
  });
});
