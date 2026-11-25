/**
 * 首页顶部“当前场景与数据模式”推导单测（本轮新增状态）：
 * 只验证数据来源与事实边界文案，不逐行镜像组件结构。
 */
import { describe, expect, it } from "vitest";
import { cloneDefaultScenario } from "../../contract/defaultScenario";
import { journeyContextFor } from "./display";

describe("journeyContextFor", () => {
  const scenario = cloneDefaultScenario();

  it("实时模拟：标明合成场景的群体推演，不称实时导航", () => {
    const ctx = journeyContextFor(scenario, { inReplay: false });
    expect(ctx.sceneTitle).toBe("散场接驳合成场景");
    expect(ctx.modeLabel).toBe("模拟推演");
    expect(ctx.modeNote).toContain("群体推演");
    expect(ctx.modeNote).toContain("不是实时导航");
    expect(ctx.tone).toBe("sim");
  });

  it("回放：显示已保存结果回放与快照标签，明确非本次计算", () => {
    const ctx = journeyContextFor(scenario, { inReplay: true, replayLabel: "整合验收·正常散场" });
    expect(ctx.modeLabel).toBe("已保存结果回放");
    expect(ctx.modeNote).toContain("整合验收·正常散场");
    expect(ctx.modeNote).toContain("非本次计算");
    expect(ctx.tone).toBe("replay");
  });

  it("回放标签为空时仍明确历史快照，不编造名称", () => {
    const ctx = journeyContextFor(scenario, { inReplay: true, replayLabel: "  " });
    expect(ctx.modeNote).toBe("历史计算快照，非本次计算");
  });

  it("开发 MOCK 优先：明确占位数据，不冒充真实引擎计算", () => {
    const ctx = journeyContextFor(scenario, { inReplay: false, mock: true });
    expect(ctx.modeLabel).toBe("开发占位数据");
    expect(ctx.modeNote).toContain("非真实引擎计算");
    expect(ctx.tone).toBe("mock");
  });

  it("场景标题为空时回退为“当前场景”，不显示空白标题", () => {
    const ctx = journeyContextFor({ title: "   " }, { inReplay: false });
    expect(ctx.sceneTitle).toBe("当前场景");
  });
});
