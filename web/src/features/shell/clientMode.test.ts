import { describe, expect, it } from "vitest";
import { clientReasonText } from "./clientMode";

describe("clientReasonText（简洁版推荐理由）", () => {
  it("去掉 plan_id 与原始校验码，保留中文事实", () => {
    const text =
      '在 balanced 同分时的固定先后顺序下推荐 协调接驳方案：模拟结束仍未登车人数=0；baseline_concert_demo_rev1：模拟结束仍未登车人数=110（+110），分组独立方案 未通过校验，未参与排名（PLAN_STOP_GAP：站点 "P2" 在 180s 与 180s 的班次间隔小于 boarding_gap_s 30s）。';
    const out = clientReasonText(text);
    expect(out).not.toContain("concert_demo");
    expect(out).not.toContain("PLAN_STOP_GAP");
    expect(out).not.toContain("boarding_gap_s");
    expect(out).not.toContain("balanced");
    expect(out).toContain("平衡目标");
    expect(out).toContain("协调接驳方案");
    expect(out).toContain("未登车人数=110");
  });

  it("不删除普通中文括号和指标", () => {
    expect(clientReasonText("模拟平均排队时长=926.7s（+505.05s）")).toBe("模拟平均排队时长=926.7s（+505.05s）");
  });
});
