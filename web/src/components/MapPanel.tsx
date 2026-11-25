import React, { useMemo, useState } from "react";
import type { Plan, Scenario, SimulationResult, TimelineFrame } from "../contract/types";
import { getMapConfig } from "../map/config";
import AmapView from "../map/AmapView";
import Sandbox, { type SandboxPick } from "./Sandbox";
import { nodeDisplayName } from "../labels";

interface MapPanelProps {
  scenario: Scenario;
  frame: TimelineFrame | null;
  plan: Plan | null;
  result: SimulationResult | null;
  selectedGroupId: string | null;
}

const KIND_LABELS = { source: "场馆", exit: "出口", stop: "接驳点" } as const;

/**
 * 首页地图面板：默认“地图”（有有效凭据时）/“示意图”双视图，切换放角落不抢主任务。
 * 切换是纯本地展示状态：不触发业务请求、不改变 revision、不重新计算。
 * 底部常驻“示意位置 · 非实时导航”说明；技术信息（容量/边 ID/间隔）放点选详情。
 */
export default function MapPanel({ scenario, frame, plan, result, selectedGroupId }: MapPanelProps) {
  const configOk = useMemo(() => getMapConfig(scenario).ok, [scenario]);
  const [mode, setMode] = useState<"map" | "schematic">(configOk ? "map" : "schematic");
  const [pick, setPick] = useState<SandboxPick | null>(null);

  const pickedEdge = pick?.kind === "edge" ? scenario.edges.find((e) => e.edge_id === pick.id) ?? null : null;
  const pickedNode = pick?.kind === "node" ? scenario.nodes.find((n) => n.node_id === pick.id) ?? null : null;
  const nodeById = new Map(scenario.nodes.map((n) => [n.node_id, n]));

  return (
    <div className="map-panel">
      <div className="map-panel-toolbar">
        <b>路线地图</b>
        <span className="spacer" />
        <span className="view-switch" role="group" aria-label="地图视图切换">
          <button className={mode === "map" ? "active" : ""} onClick={() => setMode("map")}>
            地图
          </button>
          <button className={mode === "schematic" ? "active" : ""} onClick={() => setMode("schematic")}>
            示意图
          </button>
        </span>
      </div>

      <div className="map-panel-body">
        {mode === "map" ? (
          <AmapView
            scenario={scenario}
            frame={frame}
            plan={plan}
            result={result}
            selectedGroupId={selectedGroupId}
            onRequestSvg={() => setMode("schematic")}
          />
        ) : (
          <Sandbox
            scenario={scenario}
            frame={frame}
            plan={plan}
            selectedGroupId={selectedGroupId}
            onPick={setPick}
          />
        )}
      </div>

      <div className="map-panel-note">
        示意位置 · 非实时导航 —— 本图为合成场景示意，不提供真实导航；坐标未经核实时以示意布局为准。
      </div>

      {pickedEdge && (
        <div className="map-detail-bar">
          <b className="mono">{pickedEdge.edge_id}</b>
          <span>
            {nodeDisplayName(nodeById.get(pickedEdge.from)!)} → {nodeDisplayName(nodeById.get(pickedEdge.to)!)} · 通行{" "}
            {pickedEdge.travel_s}s · 能力 {pickedEdge.capacity_per_min}人/min ·{" "}
            {pickedEdge.step_free ? "无台阶" : "含台阶"} · {pickedEdge.closed ? "已关闭" : "开放"}
          </span>
          <span className="spacer" />
          <button className="btn btn-small" onClick={() => setPick(null)}>关闭</button>
        </div>
      )}
      {pickedNode && (
        <div className="map-detail-bar">
          <b>{nodeDisplayName(pickedNode)}</b>
          <span className="mono dim">（{pickedNode.node_id}）</span>
          <span>
            {KIND_LABELS[pickedNode.kind]} · 当前帧排队 {frame?.node_queues[pickedNode.node_id] ?? 0} 人
            {pickedNode.kind === "stop" && pickedNode.boarding_gap_s !== undefined
              ? ` · 站点发车间隔 ${pickedNode.boarding_gap_s}s`
              : ""}
          </span>
          <span className="spacer" />
          <button className="btn btn-small" onClick={() => setPick(null)}>关闭</button>
        </div>
      )}
    </div>
  );
}
