/**
 * 回放进入/退出的视图选择校正单测（纯函数层）。
 * 行为链路（live→回放→退出恢复、连续切换、跨版本回退）由窗口4在浏览器回归；
 * 这里覆盖 reconcileSelection 的归属校验与回退规则——它是退出恢复语义的唯一来源。
 */
import { describe, expect, it } from "vitest";
import { reconcileSelection } from "./scenarioOps";

const plans = [{ plan_id: "p_base" }, { plan_id: "p_coord" }];
const groups = [{ group_id: "regular" }, { group_id: "step_free" }];

describe("reconcileSelection", () => {
  it("保存的有效选择原样恢复", () => {
    expect(reconcileSelection({ planId: "p_base", groupId: "step_free" }, plans, "p_coord", groups)).toEqual({
      planId: "p_base",
      groupId: "step_free",
    });
  });

  it("plan 失效但推荐有效 → 回退到推荐方案", () => {
    expect(reconcileSelection({ planId: "p_gone", groupId: "regular" }, plans, "p_coord", groups)).toEqual({
      planId: "p_coord",
      groupId: "regular",
    });
  });

  it("plan 失效且无推荐 → 回退第一个候选", () => {
    expect(reconcileSelection({ planId: "p_gone", groupId: "regular" }, plans, null, groups)).toEqual({
      planId: "p_base",
      groupId: "regular",
    });
  });

  it("推荐也不在候选中 → 忽略推荐，回退第一个候选", () => {
    expect(reconcileSelection({ planId: null, groupId: "regular" }, plans, "p_ghost", groups)).toEqual({
      planId: "p_base",
      groupId: "regular",
    });
  });

  it("无候选（run 为空）→ plan 为 null，由页面呈现真实空状态", () => {
    expect(reconcileSelection({ planId: "p_base", groupId: "step_free" }, [], null, groups)).toEqual({
      planId: null,
      groupId: "step_free",
    });
  });

  it("groupId 跨版本不存在（非 null 但目标场景没有该组）→ 回退第一个组", () => {
    const otherGroups = [{ group_id: "vip_a" }, { group_id: "vip_b" }];
    expect(reconcileSelection({ planId: "p_base", groupId: "step_free" }, plans, null, otherGroups)).toEqual({
      planId: "p_base",
      groupId: "vip_a",
    });
  });

  it("groupId 为 null → 回退第一个组（需求 chips 默认视角）", () => {
    expect(reconcileSelection({ planId: "p_base", groupId: null }, plans, null, groups)).toEqual({
      planId: "p_base",
      groupId: "regular",
    });
  });

  it("场景没有任何组 → groupId 为 null", () => {
    expect(reconcileSelection({ planId: "p_base", groupId: "regular" }, plans, null, [])).toEqual({
      planId: "p_base",
      groupId: null,
    });
  });
});
