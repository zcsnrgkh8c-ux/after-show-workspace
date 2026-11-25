import React from "react";
import type { Plan, Scenario, SimulationResult, TimelineFrame } from "../contract/types";
import { useActions, useApp } from "../state/store";
import MetricsView from "./MetricsView";
import { groupDisplayName, routeSequenceText } from "../labels";

interface GroupPanelProps {
  scenario: Scenario;
  plan: Plan | null;
  result: SimulationResult | null;
  frame: TimelineFrame | null;
}

/**
 * 旅客组视角（04 §2-3）：点击旅客组查看其约束、路线分配与组级结果。
 * 仅展示组级聚合结果，明确标注“不代表某位真实旅客”；不编造个体轨迹。
 */
export default function GroupPanel({ scenario, plan, result, frame }: GroupPanelProps) {
  const { state } = useApp();
  const { selectGroup } = useActions();

  const selectedId = state.selectedGroupId ?? scenario.groups[0]?.group_id ?? null;
  const group = scenario.groups.find((g) => g.group_id === selectedId) ?? null;
  const allocation = plan?.allocations.find((a) => a.group_id === selectedId) ?? null;
  const groupMetric = result?.group_metrics.find((m) => m.group_id === selectedId) ?? null;
  const groupCounts = frame && selectedId ? frame.group_counts[selectedId] ?? null : null;

  const routeStepFree = (routeId: string): boolean => {
    const route = scenario.routes.find((r) => r.route_id === routeId);
    if (!route) return false;
    return route.edge_ids.every((eid) => scenario.edges.find((e) => e.edge_id === eid)?.step_free ?? false);
  };
  const routeClosed = (routeId: string): boolean => {
    const route = scenario.routes.find((r) => r.route_id === routeId);
    if (!route) return true;
    return route.edge_ids.some((eid) => scenario.edges.find((e) => e.edge_id === eid)?.closed ?? true);
  };

  return (
    <div>
      <div className="group-panel-note">
        以下为<b>组级模拟结果，不代表某位真实旅客</b>；数据来自同一份 SimulationResult 的 group_metrics 与 group_counts。
      </div>
      <div className="group-chips">
        {scenario.groups.map((g) => (
          <button
            key={g.group_id}
            className={`group-chip ${selectedId === g.group_id ? "active" : ""}`}
            onClick={() => selectGroup(g.group_id)}
          >
            {groupDisplayName(g)}（{g.count}人）
          </button>
        ))}
      </div>

      {group && (
        <div>
          <table className="table">
            <tbody>
              <tr>
                <th style={{ width: 110 }}>约束</th>
                <td>
                  {group.needs_step_free && <span className="badge badge-warn" style={{ marginRight: 4 }}>需避开台阶</span>}
                  {group.board_deadline_s !== null && (
                    <span className="badge badge-warn" style={{ marginRight: 4 }}>须在 {group.board_deadline_s}s 前登车</span>
                  )}
                  {group.walk_time_factor !== 1 && (
                    <span className="badge" style={{ marginRight: 4 }}>步行耗时 ×{group.walk_time_factor}</span>
                  )}
                  {!group.needs_step_free && group.board_deadline_s === null && group.walk_time_factor === 1 && (
                    <span className="dim">无附加约束</span>
                  )}
                </td>
              </tr>
              <tr>
                <th>路线分配</th>
                <td>
                  {!plan ? (
                    <span className="dim">尚未选择方案</span>
                  ) : !allocation || allocation.routes.length === 0 ? (
                    <span className="badge badge-warn">本方案未给该组分配路线（留在 S 等待，仍计入统计）</span>
                  ) : (
                    allocation.routes.map((r) => (
                      <span key={r.route_id} className="badge" style={{ marginRight: 4 }}>
                        {routeSequenceText(scenario, r.route_id)} · {(r.share * 100).toFixed(0)}%
                        <span className="mono dim">（{r.route_id}）</span>
                        {!routeStepFree(r.route_id) && " · 含台阶"}
                        {routeClosed(r.route_id) && " · 含已关闭通道"}
                      </span>
                    ))
                  )}
                  {plan && group.needs_step_free && allocation && allocation.routes.length > 0 && (
                    <div className="dim" style={{ fontSize: 12, marginTop: 2 }}>
                      该组需避开台阶：合规方案只能分配全程无台阶的路线
                      {allocation.routes.every((r) => routeStepFree(r.route_id)) ? "（当前分配满足）" : "（当前分配不满足！）"}
                    </div>
                  )}
                </td>
              </tr>
              {groupCounts && (
                <tr>
                  <th>当前帧状态</th>
                  <td>
                    已释放 {groupCounts.released_count} · 已登车 {groupCounts.boarded_count} · 排队 {groupCounts.queued_count} · 步行 {groupCounts.walking_count}
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          {result && result.status === "valid" && (
            <div className="section-gap">
              <h3 style={{ margin: "8px 0 6px" }}>该组窗口汇总（与总体同口径）</h3>
              {groupMetric ? <MetricsView metrics={groupMetric} /> : <p className="dim">结果中无该组的组级指标。</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
