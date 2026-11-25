/**
 * 外壳作用域与横幅可见性（窗口4纯函数，可单测）：
 * 群体推演（散场建议 / 方案依据·对比 / 情境调整 / 已保存结果）与
 * 真实出行（我的出行）是两套业务语义，状态横幅必须按作用域隔离——
 * 散场结果过期、模拟引擎未就绪、散场回放及其操作不得套到真实路线页。
 */
import type { Objective } from "../../contract/types";
import { objectiveDisplayName } from "../../labels";

export type SurfaceScope = "group" | "travel";

export function surfaceScope(tab: string): SurfaceScope {
  return tab === "travel" ? "travel" : "group";
}

export interface BannerInputs {
  /** /api/health 不可达 */
  healthDown: boolean;
  /** 模拟引擎未就绪（engine_ready=false） */
  engineDown: boolean;
  /** 散场结果处于回放视图 */
  inReplay: boolean;
  /** 散场结果过期 */
  outdated: boolean;
  /** 开发 MOCK 占位 */
  mock: boolean;
}

export interface BannerVisibility {
  mock: boolean;
  /** 共享服务故障：两个作用域都显示，但文案按作用域不同 */
  serviceDown: boolean;
  /** 模拟引擎未就绪（仅群体推演） */
  engineDown: boolean;
  /** 散场回放（仅群体推演） */
  replay: boolean;
  /** 散场结果过期 + 更新建议按钮（仅群体推演） */
  outdated: boolean;
}

/**
 * 按作用域计算横幅可见性。
 * - travel：只保留共享服务故障提示；MOCK / 引擎 / 回放 / 散场过期一律不显示
 *   （MOCK 是散场 mock 模式占位，travel 的路线与建议不经过该 mock 通道）；
 * - group：全部按输入显示。
 */
export function bannerVisibility(scope: SurfaceScope, inputs: BannerInputs): BannerVisibility {
  if (scope === "travel") {
    return {
      mock: false,
      serviceDown: inputs.healthDown,
      engineDown: false,
      replay: false,
      outdated: false,
    };
  }
  return {
    mock: inputs.mock,
    serviceDown: inputs.healthDown,
    engineDown: inputs.engineDown,
    replay: inputs.inReplay,
    outdated: inputs.outdated,
  };
}

export interface RunIdentityLike {
  scenario_revision: number;
  seed: number;
  objective: Objective;
}

/**
 * 过期原因文案：过期可能来自场景 revision、seed 或优化目标，
 * 只改 seed 时 revision 相同——不能暗示“版本已变更”。
 * 列出实际变化的项；三项都相同（理论上不会判过期）时给通用说明。
 */
export function staleReasonText(run: RunIdentityLike, current: RunIdentityLike): string {
  const reasons: string[] = [];
  if (run.scenario_revision !== current.scenario_revision) {
    reasons.push(`场景版本 rev${run.scenario_revision} → rev${current.scenario_revision}`);
  }
  if (run.seed !== current.seed) {
    reasons.push(`随机种子 ${run.seed} → ${current.seed}`);
  }
  if (run.objective !== current.objective) {
    reasons.push(`优化目标 ${objectiveDisplayName(run.objective)} → ${objectiveDisplayName(current.objective)}`);
  }
  return reasons.length > 0 ? reasons.join("；") : "输入已修改";
}

/** 浏览器标题：按当前页面区分，避免真实路线页被“模拟演示”标题覆盖 */
export const PAGE_TITLES: Record<string, string> = {
  journey: "散场之后 — 让离场方案也照顾不同需求",
  travel: "我的出行 — 高德步行路线",
  compare: "方案依据 · 三策略对比 — 散场之后",
  demo: "情境调整 — 散场之后",
  replay: "已保存结果 — 散场之后",
};

export function pageTitle(tab: string): string {
  return PAGE_TITLES[tab] ?? PAGE_TITLES.journey;
}
