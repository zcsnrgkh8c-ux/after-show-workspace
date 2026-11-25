/**
 * 作用域隔离回归（窗口4）：
 * 复现核查报告中的跨域问题——散场过期/回放/引擎未就绪曾套到真实出行页。
 * 这里在纯函数层锁定“我的出行不显示这些横幅，也不提供散场更新按钮”。
 */
import { describe, expect, it } from "vitest";
import { bannerVisibility, pageTitle, staleReasonText, surfaceScope } from "./scopes";

const allOn = { healthDown: true, engineDown: true, inReplay: true, outdated: true, mock: true };
const allOff = { healthDown: false, engineDown: false, inReplay: false, outdated: false, mock: false };

describe("surfaceScope", () => {
  it("travel 页为独立作用域，其余群体推演页为 group", () => {
    expect(surfaceScope("travel")).toBe("travel");
    for (const t of ["journey", "compare", "demo", "replay"]) {
      expect(surfaceScope(t)).toBe("group");
    }
  });
});

describe("bannerVisibility：作用域隔离", () => {
  it("我的出行：散场过期不出现（因此没有“更新建议”按钮），回放/引擎/MOCK 也不覆盖", () => {
    const v = bannerVisibility("travel", allOn);
    expect(v.outdated).toBe(false);
    expect(v.replay).toBe(false);
    expect(v.engineDown).toBe(false);
    expect(v.mock).toBe(false);
  });

  it("我的出行：共享服务故障仍如实提示（不隐藏真实错误）", () => {
    expect(bannerVisibility("travel", allOn).serviceDown).toBe(true);
    expect(bannerVisibility("travel", allOff).serviceDown).toBe(false);
  });

  it("群体推演页：全部状态按输入显示", () => {
    expect(bannerVisibility("group", allOn)).toEqual({
      mock: true,
      serviceDown: true,
      engineDown: true,
      replay: true,
      outdated: true,
    });
  });

  it("群体推演页无状态时不显示任何横幅", () => {
    expect(bannerVisibility("group", allOff)).toEqual({
      mock: false,
      serviceDown: false,
      engineDown: false,
      replay: false,
      outdated: false,
    });
  });
});

describe("staleReasonText：只列出真实变化项", () => {
  const current = { scenario_revision: 2, seed: 20261114, objective: "balanced" as const };

  it("仅 revision 变化：说明场景版本", () => {
    expect(staleReasonText({ ...current, scenario_revision: 1 }, current)).toBe("场景版本 rev1 → rev2");
  });

  it("仅 seed 变化：revision 相同也不暗示版本变更", () => {
    const text = staleReasonText({ ...current, seed: 20261113 }, current);
    expect(text).toBe("随机种子 20261113 → 20261114");
    expect(text).not.toContain("版本");
    expect(text).not.toContain("rev");
  });

  it("仅目标变化：说明优化目标", () => {
    expect(staleReasonText({ ...current, objective: "efficiency" }, current)).toBe("优化目标 效率优先 → 平衡");
  });

  it("多项变化：按版本/种子/目标顺序列出", () => {
    expect(
      staleReasonText({ scenario_revision: 1, seed: 1, objective: "inclusion" }, current)
    ).toBe("场景版本 rev1 → rev2；随机种子 1 → 20261114；优化目标 包容优先 → 平衡");
  });
});

describe("pageTitle", () => {
  it("真实出行页标题不含“模拟演示”", () => {
    expect(pageTitle("travel")).not.toContain("模拟");
    expect(pageTitle("travel")).toContain("高德");
  });

  it("散场页标题保持产品名，未知 tab 回退首页标题", () => {
    expect(pageTitle("journey")).toContain("散场之后");
    expect(pageTitle("unknown")).toBe(pageTitle("journey"));
  });
});
