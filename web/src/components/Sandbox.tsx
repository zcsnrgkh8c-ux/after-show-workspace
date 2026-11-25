import React from "react";
import type { Plan, Scenario, ScenarioEdge, ScenarioNode, TimelineFrame } from "../contract/types";
import { nodeDisplayName } from "../labels";

export type SandboxPick = { kind: "edge"; id: string } | { kind: "node"; id: string };

interface SandboxProps {
  scenario: Scenario;
  /** 聚合时间线帧；不传则为静态场景视图 */
  frame?: TimelineFrame | null;
  /** 当前查看的方案（用于高亮选中需求组的路线） */
  plan?: Plan | null;
  /** 当前选中的需求组 id */
  selectedGroupId?: string | null;
  /** 可选：用户点选的路线（单向展示输入）。设置时仅该路线加粗，其余淡化；优先于组高亮 */
  selectedRouteId?: string | null;
  /** 点击通道/节点时回传（详情在面板层展示，容量等技术信息不放地图主视图） */
  onPick?: (pick: SandboxPick) => void;
}

function mid(a: ScenarioNode, b: ScenarioNode, t: number): { x: number; y: number } {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/**
 * 散场接驳示意图（纯 SVG，0~100 示意坐标，非地理实况）：
 * - 主视图只保留可读短标签与当前需求路线；容量、边 ID 等技术信息放点选详情；
 * - 选中路线加粗（主色），关闭/含台阶用线型 + 文字双重编码，不只靠颜色；
 * - 仅绘制聚合计数（node_queues / edge_counts），不绘制任何个体轨迹。
 */
export default function Sandbox({ scenario, frame, plan, selectedGroupId, selectedRouteId, onPick }: SandboxProps) {
  const nodeById = new Map(scenario.nodes.map((n) => [n.node_id, n]));

  // 选中路线优先（单向展示输入），否则按选中需求组的分配；切组只是视角切换，不发请求、不改场景
  const highlightEdges = new Set<string>();
  const highlightRoutes = new Set<string>();
  if (plan && selectedRouteId) {
    highlightRoutes.add(selectedRouteId);
    const route = scenario.routes.find((x) => x.route_id === selectedRouteId);
    for (const eid of route?.edge_ids ?? []) highlightEdges.add(eid);
  } else if (plan && selectedGroupId) {
    const alloc = plan.allocations.find((a) => a.group_id === selectedGroupId);
    for (const r of alloc?.routes ?? []) {
      highlightRoutes.add(r.route_id);
      const route = scenario.routes.find((x) => x.route_id === r.route_id);
      for (const eid of route?.edge_ids ?? []) highlightEdges.add(eid);
    }
  }
  const hasHighlight = highlightEdges.size > 0;

  const edgeStyle = (e: ScenarioEdge): { stroke: string; dash?: string; width: number; opacity: number } => {
    const highlighted = highlightEdges.has(e.edge_id);
    if (e.closed) return { stroke: "#b91c1c", dash: "5 3", width: highlighted ? 3 : 1.6, opacity: highlighted ? 1 : 0.55 };
    if (!e.step_free) return { stroke: "#b45309", dash: "2 2", width: highlighted ? 2.6 : 1.4, opacity: highlighted ? 1 : 0.55 };
    if (highlighted) return { stroke: "#315CE7", width: 3, opacity: 1 };
    return { stroke: "#8ea0b8", width: 1.2, opacity: hasHighlight ? 0.4 : 0.8 };
  };

  return (
    <div>
      <svg className="sandbox-svg" viewBox="-6 -10 112 116" role="img" aria-label="散场接驳示意图">
        <defs>
          <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="4" markerHeight="4" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
            <path d="M0,0 L8,4 L0,8 z" fill="#8ea0b8" />
          </marker>
        </defs>

        {/* 通道：无文字标签的通道不贴容量/编号；关闭与台阶以线型+短文字编码 */}
        {scenario.edges.map((e, edgeIndex) => {
          const a = nodeById.get(e.from);
          const b = nodeById.get(e.to);
          if (!a || !b) return null;
          const { stroke, dash, width, opacity } = edgeStyle(e);
          const m = mid(a, b, 0.55);
          const labelDy = edgeIndex % 2 === 0 ? -2.4 : 3.0;
          const walking = frame?.edge_counts[e.edge_id] ?? 0;
          const statusText = e.closed ? "已关闭" : !e.step_free ? "台阶" : "";
          return (
            <g key={e.edge_id}>
              <line
                x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                stroke={stroke} strokeWidth={width} strokeDasharray={dash}
                markerEnd={e.closed ? undefined : "url(#arrow)"}
                opacity={opacity}
              />
              {/* 加宽透明命中区：便于点选查看技术详情 */}
              <line
                x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                stroke="transparent" strokeWidth={4}
                style={{ cursor: onPick ? "pointer" : "default" }}
                onClick={onPick ? () => onPick({ kind: "edge", id: e.edge_id }) : undefined}
              />
              {statusText && (
                <text x={m.x} y={m.y + labelDy} fontSize="2.4" textAnchor="middle" fill={stroke} fontWeight={700}>
                  {statusText}
                </text>
              )}
              {frame && walking > 0 && (
                <g>
                  <rect x={m.x - 5} y={m.y + 3.2} width={10} height={4.4} rx={1.2} fill="#315CE7" />
                  <text x={m.x} y={m.y + 6.4} fontSize="2.9" textAnchor="middle" fill="#fff" fontWeight={700}>
                    {walking}人步行
                  </text>
                </g>
              )}
            </g>
          );
        })}

        {/* 节点：可读名称 */}
        {scenario.nodes.map((n) => {
          const queue = frame?.node_queues[n.node_id] ?? 0;
          const onRoute = scenario.routes
            .filter((r) => highlightRoutes.has(r.route_id))
            .some((r) => r.stop_id === n.node_id || r.edge_ids.some((eid) => {
              const e = scenario.edges.find((x) => x.edge_id === eid);
              return e !== undefined && (e.from === n.node_id || e.to === n.node_id);
            }));
          return (
            <g key={n.node_id}
               style={{ cursor: onPick ? "pointer" : "default" }}
               onClick={onPick ? () => onPick({ kind: "node", id: n.node_id }) : undefined}>
              {n.kind === "source" && (
                <rect x={n.x - 7.5} y={n.y - 4.5} width={15} height={9} rx={2} fill="#315CE7" stroke={onRoute ? "#182238" : "#25409f"} strokeWidth={onRoute ? 0.7 : 0.4} />
              )}
              {n.kind === "exit" && (
                <rect x={n.x - 4} y={n.y - 4} width={8} height={8} rx={1} fill="#0e7490" stroke={onRoute ? "#182238" : "#164e63"} strokeWidth={onRoute ? 0.7 : 0.4} />
              )}
              {n.kind === "stop" && (
                <circle cx={n.x} cy={n.y} r={4.6} fill="#7c3aed" stroke={onRoute ? "#182238" : "#4c1d95"} strokeWidth={onRoute ? 0.7 : 0.4} />
              )}
              <text x={n.x} y={n.y + 1.1} fontSize="2.9" textAnchor="middle" fill="#fff" fontWeight={700}>
                {n.node_id}
              </text>
              <text x={n.x} y={n.y - 6.2} fontSize="2.7" textAnchor="middle" fill="#334155" fontWeight={600}>
                {nodeDisplayName(n)}
              </text>
              {frame && queue > 0 && (
                <g>
                  <rect x={n.x - 6} y={n.y + 5.8} width={12} height={4.8} rx={1.2} fill="#b45309" />
                  <text x={n.x} y={n.y + 9.3} fontSize="3" textAnchor="middle" fill="#fff" fontWeight={700}>
                    排队{queue}
                  </text>
                </g>
              )}
            </g>
          );
        })}

        <text x={-4} y={108} fontSize="2.4" fill="#94a3b8">
          合成场景示意（0~100 坐标）· 点击通道或节点可查看详情
        </text>
      </svg>

      <div className="sandbox-legend">
        <span>— 可用通道</span>
        <span style={{ color: "#b45309" }}>┄ 含台阶</span>
        <span style={{ color: "#b91c1c" }}>╌ 已关闭</span>
        <span style={{ color: "#315CE7", fontWeight: 600 }}>加粗=当前选中路线</span>
        <span>■场馆 ■出口 ●接驳点</span>
      </div>
    </div>
  );
}
