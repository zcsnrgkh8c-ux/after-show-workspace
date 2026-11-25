/**
 * 方案依据推导（窗口3 · review 域）：把服务端返回的 Plan / SimulationResult
 * 整理成“能服务谁、谁没完成、为什么推荐/拒绝”的可读行，供方案对比页使用。
 *
 * 约束：只做展示层整理——不重新排序、不生成新指标、不推断服务端未返回的结论。
 * null 一律保持 null（未知≠0）；无效结果不当作“已完成”。
 */
import type { Plan, Scenario, SimulationResult } from "../../contract/types";
import { groupDisplayName, groupKeyMetrics, serveStatusForGroup, type ServeStatus } from "../../labels";

export interface NeedEvidenceRow {
  groupId: string;
  /** 需求类型可读名（普通出行 / 需要无台阶通行 / 希望赶上末班） */
  label: string;
  /** 当前场景中该组人数（分母），来自 Scenario */
  people: number;
  /** 路线安排与校验状态；未知时不猜测 */
  status: ServeStatus;
  /** 组级剩余人数；无有效结果时为 null（不冒充 0） */
  remaining: number | null;
  /** 组级错过截止人数；无截止约束或无有效结果时为 null */
  missedDeadline: number | null;
  hasDeadline: boolean;
  hasMetrics: boolean;
}

/** 逐需求整理“是否已安排路线 + 组级完成情况”，全部取自同一份 Scenario/Plan/Result */
export function needEvidenceRows(
  scenario: Scenario,
  plan: Plan | null,
  result: SimulationResult | null | undefined
): NeedEvidenceRow[] {
  return scenario.groups.map((g) => {
    const k = groupKeyMetrics(scenario, result, g.group_id);
    return {
      groupId: g.group_id,
      label: groupDisplayName(g),
      people: g.count,
      status: serveStatusForGroup(scenario, plan, result, g.group_id),
      remaining: k ? k.remaining : null,
      missedDeadline: k ? k.missedDeadline : null,
      hasDeadline: g.board_deadline_s !== null,
      hasMetrics: k !== null,
    };
  });
}

/** 已安排路线（可服务）的需求数；仅统计 status.level==="ok" */
export function servedNeedCount(rows: NeedEvidenceRow[]): number {
  return rows.filter((r) => r.status.level === "ok").length;
}

/**
 * 未完成 = 有效指标下仍有未登车，或（有截止约束的组）有人错过截止。
 * 无有效指标的行不进入结果——未知不能写成“已完成”，也不能写成“未完成人数”。
 */
export function unfinishedNeedRows(rows: NeedEvidenceRow[]): NeedEvidenceRow[] {
  return rows.filter(
    (r) =>
      (r.remaining !== null && r.remaining > 0) || (r.missedDeadline !== null && r.missedDeadline > 0)
  );
}

/** 服务状态的悬停/展开全文：直接拼接服务端推导文案，不新增判断 */
export function serveStatusTitle(status: ServeStatus): string {
  if (status.level === "ok") return status.warning ? `${status.text}；${status.warning}` : status.text;
  if (status.level === "blocked") return status.hint ? `${status.text}（${status.hint}）` : status.text;
  return status.text;
}
