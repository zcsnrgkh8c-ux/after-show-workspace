import React from "react";
import type { Metrics } from "../contract/types";

export function fmtSeconds(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const s = Math.round(v);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}分${s % 60}秒`;
}

function MetricItem({ label, value, note, isNull, nullText }: {
  label: string;
  value: string;
  note?: string;
  isNull?: boolean;
  nullText?: string;
}) {
  return (
    <div className="metric-item">
      <div className="metric-label">{label}</div>
      {isNull ? (
        <div className="metric-value null">{nullText ?? "—"}</div>
      ) : (
        <div className="metric-value">{value}</div>
      )}
      {note && <div className="metric-note">{note}</div>}
    </div>
  );
}

/**
 * 指标展示（05 §5 口径）：
 * - null 绝不显示为 0；未清空时清空时刻显示“未清空”，不用窗口终点冒充；
 * - remaining_count 与 P95（仅已登车样本）同屏相邻展示。
 */
export default function MetricsView({ metrics }: { metrics: Metrics | null }) {
  if (!metrics) {
    return <p className="dim">无有效指标（方案未通过校验或推演失败）。</p>;
  }
  const m = metrics;
  return (
    <div className="metric-list">
      <MetricItem label="已释放 / 已登车" value={`${m.released_count} / ${m.boarded_count}`} />
      <MetricItem label="剩余未离场 remaining" value={String(m.remaining_count)} note="窗口结束仍在区域内" />
      <MetricItem
        label="人均排队（全部已释放）"
        value={m.mean_queue_wait_all_released_s === null ? "" : fmtSeconds(m.mean_queue_wait_all_released_s)}
        isNull={m.mean_queue_wait_all_released_s === null}
        nullText="—（零释放）"
        note="含仍等待者；须与剩余人数同看"
      />
      <MetricItem
        label="P95 排队（仅已登车样本）"
        value={m.p95_queue_wait_boarded_s === null ? "" : fmtSeconds(m.p95_queue_wait_boarded_s)}
        isNull={m.p95_queue_wait_boarded_s === null}
        nullText="—（无人登车）"
        note="nearest-rank；不统计未登车者"
      />
      <MetricItem label="错过末班人数" value={String(m.missed_deadline_count)} note="逾期登车 + 截止仍未登车" />
      <MetricItem
        label="清空时刻"
        value={m.clearance_time_s === null ? "" : fmtSeconds(m.clearance_time_s)}
        isNull={m.clearance_time_s === null}
        nullText="未清空"
        note={m.clearance_time_s === null ? "窗口内未全部离场" : "全部旅客已释放并登车"}
      />
    </div>
  );
}
