/**
 * metrics.ts — 指标计算。口径严格按 05：
 * null 不伪装成 0；P95 仅统计已登车者；清空失败为 null；零需求清空时间为 0。
 */

import type { Metrics } from "../../shared/types.ts";

/** 指标计算所需的最小旅客终态 */
export interface PersonFinal {
  release_s: number;
  status: "pending" | "queued" | "walking" | "boarded";
  queue_wait_s: number;
  boarded_s: number | null;
  board_deadline_s: number | null;
}

/** nearest-rank 第 95 百分位；空样本为 null */
export function nearestRankP95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(0.95 * sorted.length);
  return sorted[rank - 1];
}

/**
 * 对一组旅客计算同口径指标（整体指标 = 对全部旅客调用；组指标 = 对该组旅客调用）。
 * persons 为该口径下的全部旅客（含未登车者，未登车者绝不从统计中删除）。
 */
export function computeMetrics(persons: PersonFinal[]): Metrics {
  const released = persons.filter((p) => p.status !== "pending");
  const boarded = released.filter((p) => p.status === "boarded");

  const released_count = released.length;
  const boarded_count = boarded.length;

  const mean =
    released_count === 0
      ? null
      : released.reduce((a, p) => a + p.queue_wait_s, 0) / released_count;

  const p95 = nearestRankP95(boarded.map((p) => p.queue_wait_s));

  const missed = released.filter(
    (p) => p.board_deadline_s !== null && (p.boarded_s === null || p.boarded_s > p.board_deadline_s),
  ).length;

  let clearance: number | null;
  if (persons.length === 0) {
    clearance = 0; // 零需求
  } else if (boarded_count === persons.length) {
    // 全部旅客均已释放并登车：最后一次登车时刻即清空时刻
    clearance = boarded.reduce((a, p) => Math.max(a, p.boarded_s ?? 0), 0);
  } else {
    clearance = null; // 窗口内未清空
  }

  return {
    released_count,
    boarded_count,
    remaining_count: released_count - boarded_count,
    mean_queue_wait_all_released_s: mean,
    p95_queue_wait_boarded_s: p95,
    missed_deadline_count: missed,
    clearance_time_s: clearance,
  };
}
