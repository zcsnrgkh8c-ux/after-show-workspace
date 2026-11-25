import { describe, expect, it } from "vitest";
import { beginRequest, isLatest, resetRequestGate } from "./requestGate";

describe("requestGate：延迟/乱序响应防护", () => {
  it("后发请求使先发响应失效（乱序到达时旧响应被丢弃）", () => {
    resetRequestGate();
    // 模拟：请求A发出后响应延迟，期间用户又发了请求B；A 的响应后到
    const a = beginRequest("parse");
    const b = beginRequest("parse");
    expect(isLatest("parse", a)).toBe(false); // A 的延迟响应到达 → 丢弃
    expect(isLatest("parse", b)).toBe(true); // B 的响应 → 接受
  });

  it("同类操作三次连发，只有最后一次被接受", () => {
    resetRequestGate();
    const r1 = beginRequest("generate");
    const r2 = beginRequest("generate");
    const r3 = beginRequest("generate");
    expect(isLatest("generate", r1)).toBe(false);
    expect(isLatest("generate", r2)).toBe(false);
    expect(isLatest("generate", r3)).toBe(true);
  });

  it("不同操作类型互不影响（parse 不干扰 generate）", () => {
    resetRequestGate();
    const p1 = beginRequest("parse");
    const g1 = beginRequest("generate");
    const p2 = beginRequest("parse");
    expect(isLatest("parse", p1)).toBe(false);
    expect(isLatest("parse", p2)).toBe(true);
    expect(isLatest("generate", g1)).toBe(true); // generate 未被 parse 顶掉
  });
});
