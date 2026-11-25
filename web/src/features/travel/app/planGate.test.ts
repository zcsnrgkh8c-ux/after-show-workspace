import { describe, expect, it } from "vitest";

import { PlanGate } from "./planGate";

describe("PlanGate：旧规划请求不得干扰新请求的等待态", () => {
  it("切换步行/公交后，旧请求完成不能解除新请求的 waiting", () => {
    const gate = new PlanGate();
    const walking = gate.begin();
    gate.invalidate(); // 切换模式：步行请求作废
    const transit = gate.begin();

    // 旧步行请求晚到：既不能写结果，也不能 settle
    expect(gate.isActive(walking)).toBe(false);
    expect(gate.settle(walking)).toBe(false);
    expect(gate.isActive(transit)).toBe(true);

    // 新公交请求完成后才允许解除等待
    expect(gate.settle(transit)).toBe(true);
    expect(gate.isActive(transit)).toBe(false);
  });

  it("改起终点作废在途请求后，旧请求不会重新激活", () => {
    const gate = new PlanGate();
    const first = gate.begin();
    gate.invalidate();
    expect(gate.isActive(first)).toBe(false);
    expect(gate.settle(first)).toBe(false);

    // 没有新请求时活动令牌保持为空，旧请求反复完成也不改变状态
    expect(gate.isActive(0)).toBe(false);
    expect(gate.settle(0)).toBe(false);
  });

  it("同一请求只能 settle 一次", () => {
    const gate = new PlanGate();
    const seq = gate.begin();
    expect(gate.settle(seq)).toBe(true);
    expect(gate.settle(seq)).toBe(false);
    expect(gate.isActive(seq)).toBe(false);
  });
});
