/**
 * 窗口3（review 域）局部展示推导：仅做展示层分组与可读短句，不生成新指标、不做排序。
 * 所有数字与状态都来自服务端返回字段；缺失返回 null/空，不编造。
 */
import type { DecisionMode, Metrics, SimulationResult, ValidationIssue } from "../../contract/types";

export interface ViolationGroup {
  code: string;
  count: number;
  errors: number;
  warnings: number;
  /** 原始条目，展开时保留 severity/path/原文 */
  items: ValidationIssue[];
}

/** 校验问题按 code 归类，计数真实；warning 不丢弃 */
export function groupViolationsByCode(violations: ValidationIssue[]): ViolationGroup[] {
  const byCode = new Map<string, ViolationGroup>();
  for (const v of violations) {
    const g = byCode.get(v.code) ?? { code: v.code, count: 0, errors: 0, warnings: 0, items: [] };
    g.count += 1;
    if (v.severity === "warning") g.warnings += 1;
    else g.errors += 1;
    g.items.push(v);
    byCode.set(v.code, g);
  }
  return [...byCode.values()];
}

/** 决策模式可读文案；未知值原样返回，不猜测 */
export function decisionModeText(mode: DecisionMode | undefined): string {
  if (mode === "llm") return "LLM 模式";
  if (mode === "rules") return "规则模式";
  return mode ?? "—";
}

/**
 * 推荐方案的“事实提醒”短句：仍有人未登车 / 错过登车截止。
 * 数字全部来自该方案真实 metrics；无有效指标返回空数组，绝不编造。
 * 300/300 登车不等于全部按时赶上截止——错过人数不能在“全部成功”叙事中消失。
 */
export function recommendationFactWarnings(metrics: Metrics | null): string[] {
  if (!metrics) return [];
  const lines: string[] = [];
  if (metrics.remaining_count > 0) {
    lines.push(`模拟结束仍有 ${metrics.remaining_count} 人未登车（窗口结束仍在区域内），需调整方案或资源`);
  }
  if (metrics.missed_deadline_count > 0) {
    lines.push(`有 ${metrics.missed_deadline_count} 人错过登车截止——登车完成不等于全部按时赶上末班`);
  }
  return lines;
}

/** 单方案是否仍有滞留/错过截止（用于卡片提示），来自真实 metrics；无效结果返回 false */
export function resultHasUnfinished(result: SimulationResult | null | undefined): boolean {
  if (!result || result.status !== "valid" || !result.metrics) return false;
  return result.metrics.remaining_count > 0 || result.metrics.missed_deadline_count > 0;
}
