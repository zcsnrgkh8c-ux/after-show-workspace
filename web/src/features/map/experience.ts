/**
 * 首页地图体验的数据状态推导（纯函数，可单测）：
 * 只做展示层推导与文案映射，不做业务计算、不发请求、不改场景/方案。
 * 数据来源统一为 useViewingBundle 已区分实时/回放、已做过期判定的结果。
 */
import type { Plan, Scenario, SimulationResult } from "../../contract/types";
import type { HealthState, RunBundle } from "../../state/store";
import { serveStatusForGroup, type ServeStatus } from "../../labels";

/** 地图区整体数据状态：过期 / 无结果 / 就绪（含回放）。过期与无结果时不显示旧路线与旧指标为有效建议 */
export type MapExperienceStatus =
  | { kind: "outdated"; note: string }
  | { kind: "no_result"; note: string }
  | { kind: "ready"; note: string | null };

export function mapExperienceStatus(args: {
  bundle: RunBundle | null;
  outdated: boolean;
  inReplay: boolean;
  health: HealthState;
}): MapExperienceStatus {
  if (args.outdated) {
    return {
      kind: "outdated",
      note: "情况已变化：以下为旧结果对应的场地示意，不再作为有效建议；请更新建议后查看路线。",
    };
  }
  if (args.bundle === null) {
    const h = args.health;
    const note =
      h.state === "down"
        ? "服务暂不可达，暂时无法生成接驳方案；可稍后重试，或查看已保存结果。"
        : h.state === "ok" && h.engine_ready === false
          ? "服务端引擎未就绪，暂时无法生成接驳方案。"
          : h.state === "checking"
            ? "正在连接服务，尚未生成接驳方案。"
            : "尚未生成接驳方案：选择出行需求后由系统计算。";
    return { kind: "no_result", note };
  }
  return {
    kind: "ready",
    note: args.inReplay ? "当前为已保存结果回放：内容来自历史计算快照，不随当前场景变化。" : null,
  };
}

/** 当前需求组在地图区的服务状态视图（复用 labels.serveStatusForGroup，不重新解释指标） */
export interface MapServeView {
  level: "ok" | "blocked" | "unknown";
  title: string;
  hint?: string;
  warning?: string;
}

export function mapServeView(
  scenario: Scenario,
  plan: Plan | null,
  result: SimulationResult | null | undefined,
  groupId: string | null
): MapServeView {
  if (groupId === null) return { level: "unknown", title: "尚未选择出行需求" };
  const s: ServeStatus = serveStatusForGroup(scenario, plan, result, groupId);
  if (s.level === "blocked") return { level: "blocked", title: s.text, hint: s.hint };
  if (s.level === "ok") return { level: "ok", title: s.text, warning: s.warning };
  return { level: "unknown", title: s.text };
}

/** 是否存在可回放的真实时间线：仅合法结果且引擎确实返回了帧；无合法结果不播放伪造帧 */
export function playableTimeline(result: SimulationResult | null | undefined): boolean {
  return !!result && result.status === "valid" && result.timeline.length > 0;
}

/** 地图应展示的方案路线：整体数据就绪且当前需求未被判阻断时才画；其余情况一律不画路线 */
export function planRoutesForMap(
  status: MapExperienceStatus,
  serve: MapServeView,
  plan: Plan | null
): Plan | null {
  if (status.kind !== "ready") return null;
  if (serve.level === "blocked") return null;
  return plan;
}
