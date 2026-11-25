import React, { useEffect, useMemo, useRef } from "react";
import type { SimulationResult, TimelineFrame } from "../contract/types";
import { useActions, useApp } from "../state/store";
import { fmtClock, fmtSimTime } from "../labels";
import { fmtSeconds } from "./MetricsView";

/** 取 playT 时刻对应的聚合帧（最后一个 t_s <= playT 的帧） */
export function frameAt(result: SimulationResult, t: number): TimelineFrame | null {
  const frames = result.timeline;
  if (frames.length === 0) return null;
  let lo = 0;
  let hi = frames.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const midIdx = (lo + hi) >> 1;
    if (frames[midIdx].t_s <= t) {
      ans = midIdx;
      lo = midIdx + 1;
    } else hi = midIdx - 1;
  }
  return frames[ans];
}

/**
 * 散场过程播放器：只播放引擎输出的聚合组数据（节点队列 / 通道人数 / 各组计数）。
 * “全程结果”（模拟结束口径）与“当前播放时刻”严格分区，不把 t=0 的 0 人当成全程结果。
 * 卸载时自动暂停（若仍在播放），避免隐藏的播放器继续推进全局 playT。
 */
export default function TimelinePlayer({ result }: { result: SimulationResult }) {
  const { state } = useApp();
  const { setPlayT, setPlaying } = useActions();

  const frames = result.timeline;
  const maxT = frames.length > 0 ? frames[frames.length - 1].t_s : 0;
  const step = frames.length > 1 ? frames[1].t_s - frames[0].t_s : 5;

  // 卸载清理：若卸载时仍在播放则暂停，防止隐藏播放器推进同一 playT
  const playingRef = useRef(state.playing);
  playingRef.current = state.playing;
  useEffect(() => {
    return () => {
      if (playingRef.current) setPlaying(false);
    };
  }, [setPlaying]);

  useEffect(() => {
    if (!state.playing) return;
    const timer = setInterval(() => {
      const next = state.playT + step;
      if (next >= maxT) {
        setPlayT(maxT);
        setPlaying(false);
      } else setPlayT(next);
    }, 120);
    return () => clearInterval(timer);
  }, [state.playing, state.playT, maxT, step, setPlayT, setPlaying]);

  const frame = useMemo(() => frameAt(result, state.playT), [result, state.playT]);

  if (frames.length === 0) {
    return <p className="dim">该结果没有时间线（无有效运行）。</p>;
  }

  const m = result.metrics;
  const playedDep = result.departures_log.filter((d) => d.depart_s <= Math.min(state.playT, maxT)).length;

  return (
    <div>
      {/* 全程结果（模拟结束口径），与下方播放时刻严格分区 */}
      {m && (
        <div className="process-total">
          <b>全程结果（模拟结束）：</b>
          已登车 {m.boarded_count} / 已释放 {m.released_count} 人 · 仍未登车 {m.remaining_count} 人 ·
          错过末班 {m.missed_deadline_count} 人 · 清空时刻 {m.clearance_time_s === null ? "未清空" : fmtSeconds(m.clearance_time_s)}
        </div>
      )}

      <div className="player-bar">
        <button
          className="btn btn-small"
          onClick={() => {
            if (state.playT >= maxT) setPlayT(0);
            setPlaying(!state.playing);
          }}
        >
          {state.playing ? "⏸ 暂停" : "▶ 播放"}
        </button>
        <button className="btn btn-small" onClick={() => { setPlaying(false); setPlayT(0); }}>⏮ 回起点</button>
        <input
          type="range" min={0} max={maxT} step={step} value={Math.min(state.playT, maxT)}
          aria-label="模拟时刻"
          onChange={(e) => { setPlaying(false); setPlayT(Number(e.target.value)); }}
        />
        <span className="player-clock">{fmtSimTime(Math.min(state.playT, maxT))} / {fmtClock(maxT)}</span>
      </div>

      {/* 当前播放时刻状态 */}
      {frame && (
        <div className="process-frame">
          <b>{fmtSimTime(frame.t_s)} 时刻：</b>
          已释放 {frame.released_count} · 已登车 {frame.boarded_count} · 排队中 {frame.queued_count} · 步行中 {frame.walking_count}
          <span className="dim" style={{ marginLeft: 8, fontSize: 12 }}>
            （当前时刻人数，非全程结果）
          </span>
        </div>
      )}
      <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>
        仅绘制聚合组数据；班次记录 {result.departures_log.length} 班
        {state.playT > 0 && <>，至 {fmtSimTime(Math.min(state.playT, maxT))} 已发车 {playedDep} 班</>}。
      </div>
      {/* 口径详情：守恒公式与语义边界，折叠展示不占主视图 */}
      <details className="dim" style={{ fontSize: 12, marginTop: 4 }}>
        <summary>人数口径说明</summary>
        <p style={{ margin: "4px 0 0" }}>
          每帧守恒：已释放 = 已登车 + 排队中 + 步行中（全部为聚合计数，不含个体轨迹）。
          全程口径：已释放 = 已登车 + 仍未登车；仍未登车表示模拟窗口结束尚未登车，不等于全部赶上截止时间。
        </p>
      </details>
    </div>
  );
}
