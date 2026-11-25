import {
  GroupMetrics,
  Metrics,
  Objective,
  Recommendation,
  Scenario,
  SimulationResult,
} from "../../shared/types";

const EPS = 1e-9;

export interface ScoredResult {
  result: SimulationResult;
  key: number[];
  priority_unboarded: number;
}

function waitOf(metrics: Metrics): number {
  return metrics.mean_queue_wait_all_released_s === null
    ? 0
    : metrics.mean_queue_wait_all_released_s;
}

function isPriorityGroup(scenario: Scenario, groupId: string): boolean {
  const group = scenario.groups.find((item) => item.group_id === groupId);
  if (!group) return false;
  return group.needs_step_free || group.board_deadline_s !== null;
}

/**
 * 优先需求组未登车人数：needs_step_free=true 或 board_deadline_s 非空的组，
 * 按 released-boarded 求和；同一组同时满足两个条件只计一次。
 */
export function priorityUnboarded(scenario: Scenario, groupMetrics: GroupMetrics[]): number {
  return groupMetrics
    .filter((item) => isPriorityGroup(scenario, item.group_id))
    .reduce((sum, item) => sum + Math.max(0, item.released_count - item.boarded_count), 0);
}

/** 05 第 6 节的公开字典序，字段依次越小越好；null 等待按 0 处理，但不改写展示值。 */
export function rankingKey(
  scenario: Scenario,
  result: SimulationResult,
  objective: Objective,
): number[] {
  const metrics = result.metrics;
  if (!metrics) return [];
  const remaining = metrics.remaining_count;
  const missed = metrics.missed_deadline_count;
  const wait = waitOf(metrics);
  if (objective === "efficiency") return [remaining, wait, missed];
  if (objective === "inclusion") {
    return [
      priorityUnboarded(scenario, result.group_metrics),
      missed,
      remaining,
      wait,
    ];
  }
  return [remaining, missed, wait];
}

function compareKey(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    if (Math.abs(a[i] - b[i]) > EPS) return a[i] < b[i] ? -1 : 1;
  }
  return a.length - b.length;
}

function sameKey(a: number[], b: number[]): boolean {
  return compareKey(a, b) === 0;
}

export function scoreResults(
  scenario: Scenario,
  results: SimulationResult[],
  objective: Objective,
): ScoredResult[] {
  return results
    .filter((result) => result.status === "valid" && result.metrics !== null)
    .map((result) => ({
      result,
      key: rankingKey(scenario, result, objective),
      priority_unboarded: priorityUnboarded(scenario, result.group_metrics),
    }))
    .sort(
      (a, b) =>
        compareKey(a.key, b.key) ||
        (a.result.plan_id ?? "").localeCompare(b.result.plan_id ?? ""),
    );
}

function fmt(value: number | null, unit = ""): string {
  if (value === null) return "null（无样本）";
  const rounded = Math.round(value * 1000) / 1000;
  return `${rounded}${unit}`;
}

function keyDescription(scored: ScoredResult, objective: Objective, scenario: Scenario): string {
  const metrics = scored.result.metrics!;
  const base =
    `remaining_count=${metrics.remaining_count}、` +
    `mean_queue_wait_all_released_s=${fmt(metrics.mean_queue_wait_all_released_s, "s")}、` +
    `missed_deadline_count=${metrics.missed_deadline_count}`;
  if (objective === "inclusion") {
    return `优先需求组未登车 ${scored.priority_unboarded} 人、${base}`;
  }
  return base;
}

function tradeoffLine(chosen: SimulationResult, other: ScoredResult): string {
  const base = chosen.metrics!;
  const metrics = other.result.metrics!;
  const parts = [
    `remaining_count=${metrics.remaining_count}（${metrics.remaining_count - base.remaining_count >= 0 ? "+" : ""}${metrics.remaining_count - base.remaining_count}）`,
    `missed_deadline_count=${metrics.missed_deadline_count}（${metrics.missed_deadline_count - base.missed_deadline_count >= 0 ? "+" : ""}${metrics.missed_deadline_count - base.missed_deadline_count}）`,
  ];
  if (
    metrics.mean_queue_wait_all_released_s !== null &&
    base.mean_queue_wait_all_released_s !== null
  ) {
    const diff = Math.round(
      (metrics.mean_queue_wait_all_released_s - base.mean_queue_wait_all_released_s) * 1000,
    ) / 1000;
    parts.push(
      `mean_queue_wait_all_released_s=${fmt(metrics.mean_queue_wait_all_released_s, "s")}（${diff >= 0 ? "+" : ""}${diff}s）`,
    );
  } else {
    parts.push(
      `mean_queue_wait_all_released_s=${fmt(metrics.mean_queue_wait_all_released_s, "s")}`,
    );
  }
  return `${other.result.plan_id}：${parts.join("，")}`;
}

/**
 * 只对 valid 结果排名；invalid/error 不参与推荐。
 * 无合法候选时明确说明“当前候选未找到”，不宣称场景数学上无解。
 */
export function selectRecommendation(
  scenario: Scenario,
  results: SimulationResult[],
  objective: Objective,
): Recommendation {
  const scored = scoreResults(scenario, results, objective);
  const invalid = results.filter((result) => result.status !== "valid");

  if (scored.length === 0) {
    const reasons = invalid.slice(0, 4).map((result) => {
      const first = result.violations.find((item) => item.severity === "error") || result.violations[0];
      return `${result.plan_id}（${result.status}${first ? `：${first.code}` : ""}）`;
    });
    return {
      plan_id: null,
      status: "no_valid_candidate",
      reason:
        "当前候选集中没有通过校验的可执行方案。这是本次候选搜索的结果，不等于该场景在现实中无解；" +
        "可调整路线、车辆或旅客需求后重新生成候选。",
      tradeoffs: reasons.length > 0 ? [`未通过校验：${reasons.join("；")}`] : [],
    };
  }

  const best = scored[0];
  const ties = scored.filter((item) => sameKey(item.key, best.key));
  const bestResult = best.result;
  const tradeoffs: string[] = [];

  if (bestResult.metrics && bestResult.metrics.remaining_count > 0) {
    tradeoffs.push(
      `推荐方案本身仍有 ${bestResult.metrics.remaining_count} 名已释放旅客未登车，推荐不等于全部旅客完成出行。`,
    );
  }
  for (const other of scored) {
    if (other.result.plan_id === bestResult.plan_id) continue;
    tradeoffs.push(tradeoffLine(bestResult, other));
  }
  for (const result of invalid.slice(0, 3)) {
    const first = result.violations.find((item) => item.severity === "error") || result.violations[0];
    tradeoffs.push(
      `${result.plan_id} 未通过校验，未参与排名${first ? `（${first.code}：${first.message}）` : ""}。`,
    );
  }

  if (ties.length > 1) {
    const ids = ties.map((item) => item.result.plan_id).join("、");
    return {
      plan_id: bestResult.plan_id,
      status: "tradeoff",
      reason:
        `在 ${objective} 字典序下 ${ids} 的关键指标并列（${keyDescription(best, objective, scenario)}），` +
        "该规则无法区分优劣，请结合取舍与现场目标人工选择。",
      tradeoffs: tradeoffs.slice(0, 6),
    };
  }

  return {
    plan_id: bestResult.plan_id,
    status: "recommended",
    reason:
      `在 ${objective} 字典序下推荐 ${bestResult.plan_id}：${keyDescription(best, objective, scenario)}；` +
      `其余 ${scored.length - 1} 个合法方案在该规则下不更优。`,
    tradeoffs: tradeoffs.slice(0, 6),
  };
}
