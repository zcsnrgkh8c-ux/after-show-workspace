import React, { useEffect, useMemo, useState } from "react";
import type { Scenario } from "../contract/types";
import { useActions, useApp } from "../state/store";

/** 客户端即时校验（04 §2-1：所有输入都要有即时校验和可读错误提示） */
function validateDraft(draft: Scenario): string[] {
  const errors: string[] = [];
  for (const e of draft.edges) {
    if (!(e.travel_s > 0)) errors.push(`通道 ${e.edge_id}：通行耗时必须为正数`);
    if (!(e.capacity_per_min > 0)) errors.push(`通道 ${e.edge_id}：通行能力必须为正数`);
  }
  for (const g of draft.groups) {
    if (!Number.isInteger(g.count) || g.count < 0) errors.push(`旅客组 ${g.group_id}：人数必须为非负整数`);
    if (!(g.walk_time_factor > 0)) errors.push(`旅客组 ${g.group_id}：步行耗时系数必须为正数`);
    if (g.board_deadline_s !== null && (!(g.board_deadline_s > 0) || g.board_deadline_s > draft.horizon_s))
      errors.push(`旅客组 ${g.group_id}：登车截止必须在 (0, ${draft.horizon_s}] 内或为“无期限”`);
    if (g.release_start_s < 0 || g.release_end_s > draft.horizon_s || g.release_start_s >= g.release_end_s)
      errors.push(`旅客组 ${g.group_id}：释放区间必须在模拟窗口内且起点早于终点`);
  }
  for (const v of draft.fleet) {
    if (!Number.isInteger(v.capacity) || v.capacity <= 0) errors.push(`车辆 ${v.vehicle_id}：容量必须为正整数`);
    if (!(v.available_from_s >= 0)) errors.push(`车辆 ${v.vehicle_id}：可用时刻不能为负`);
    if (!(v.round_trip_s > 0)) errors.push(`车辆 ${v.vehicle_id}：周转时间必须为正数`);
  }
  return errors;
}

function num(v: string): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

/** 手动场景编辑器：编辑草稿，校验通过才允许保存；保存后 revision+1、旧结果过期 */
export default function ScenarioEditor() {
  const { state } = useApp();
  const { applyManualScenario, resetScenario } = useActions();
  const scenario = state.scenario;

  const [draft, setDraft] = useState<Scenario>(() => structuredClone(scenario));
  useEffect(() => {
    setDraft(structuredClone(scenario));
  }, [scenario]);

  const errors = useMemo(() => validateDraft(draft), [draft]);
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(scenario), [draft, scenario]);

  const patchEdge = (edgeId: string, field: "closed" | "travel_s" | "capacity_per_min", value: number | boolean) =>
    setDraft((d) => ({ ...d, edges: d.edges.map((e) => (e.edge_id === edgeId ? { ...e, [field]: value } : e)) }));

  const patchGroup = (groupId: string, field: "count" | "walk_time_factor" | "board_deadline_s", value: number | null) =>
    setDraft((d) => ({ ...d, groups: d.groups.map((g) => (g.group_id === groupId ? { ...g, [field]: value } : g)) }));

  const patchVehicle = (vehicleId: string, field: "capacity" | "available_from_s" | "round_trip_s", value: number) =>
    setDraft((d) => ({ ...d, fleet: d.fleet.map((v) => (v.vehicle_id === vehicleId ? { ...v, [field]: value } : v)) }));

  const removeVehicle = (vehicleId: string) =>
    setDraft((d) => ({ ...d, fleet: d.fleet.filter((v) => v.vehicle_id !== vehicleId) }));

  return (
    <div className="panel">
      <h2>场景参数（Scenario）</h2>
      <p className="panel-desc">
        编辑通道 / 旅客组 / 车辆参数。发车班次属于 Plan 由服务端生成，不在此处编辑。保存后 revision+1，旧结果立即过期。
        当前：<b>{scenario.scenario_id}@rev{scenario.revision}</b>（{scenario.demand_source} 合成输入）
      </p>

      <h3>步行通道（{draft.edges.length} 条）</h3>
      <table className="table">
        <thead>
          <tr>
            <th>ID</th><th>走向</th><th>通行耗时(s)</th><th>能力(人/min)</th><th>无台阶</th><th>状态</th>
          </tr>
        </thead>
        <tbody>
          {draft.edges.map((e) => (
            <tr key={e.edge_id}>
              <td className="mono">{e.edge_id}</td>
              <td className="mono">{e.from} → {e.to}</td>
              <td>
                <input
                  type="number" min={1} value={Number.isNaN(e.travel_s) ? "" : e.travel_s}
                  className={e.travel_s > 0 ? "" : "input-error"}
                  onChange={(ev) => patchEdge(e.edge_id, "travel_s", num(ev.target.value))}
                />
              </td>
              <td>
                <input
                  type="number" min={1} value={Number.isNaN(e.capacity_per_min) ? "" : e.capacity_per_min}
                  className={e.capacity_per_min > 0 ? "" : "input-error"}
                  onChange={(ev) => patchEdge(e.edge_id, "capacity_per_min", num(ev.target.value))}
                />
              </td>
              <td>{e.step_free ? "是" : "否（有台阶）"}</td>
              <td>
                <button
                  className={`btn btn-small ${e.closed ? "btn-danger" : ""}`}
                  onClick={() => patchEdge(e.edge_id, "closed", !e.closed)}
                >
                  {e.closed ? "已关闭" : "开放中"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>旅客组（{draft.groups.length} 组）</h3>
      <table className="table">
        <thead>
          <tr>
            <th>组</th><th>人数</th><th>避台阶</th><th>步行系数</th><th>登车截止(s)</th><th>释放窗口</th>
          </tr>
        </thead>
        <tbody>
          {draft.groups.map((g) => (
            <tr key={g.group_id}>
              <td className="mono">{g.group_id}</td>
              <td>
                <input
                  type="number" min={0} step={1} value={Number.isNaN(g.count) ? "" : g.count}
                  className={Number.isInteger(g.count) && g.count >= 0 ? "" : "input-error"}
                  onChange={(ev) => patchGroup(g.group_id, "count", num(ev.target.value))}
                />
              </td>
              <td>{g.needs_step_free ? "是" : "否"}</td>
              <td>
                <input
                  type="number" min={0.1} step={0.1} value={Number.isNaN(g.walk_time_factor) ? "" : g.walk_time_factor}
                  className={g.walk_time_factor > 0 ? "" : "input-error"}
                  onChange={(ev) => patchGroup(g.group_id, "walk_time_factor", num(ev.target.value))}
                />
              </td>
              <td>
                <input
                  type="number" min={1} max={draft.horizon_s}
                  value={g.board_deadline_s === null || Number.isNaN(g.board_deadline_s) ? "" : g.board_deadline_s}
                  placeholder="无期限"
                  className={g.board_deadline_s === null || (g.board_deadline_s > 0 && g.board_deadline_s <= draft.horizon_s) ? "" : "input-error"}
                  onChange={(ev) => patchGroup(g.group_id, "board_deadline_s", ev.target.value === "" ? null : num(ev.target.value))}
                />
              </td>
              <td className="mono dim">{g.release_start_s}~{g.release_end_s}s</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>接驳车辆（{draft.fleet.length} 辆）</h3>
      <table className="table">
        <thead>
          <tr>
            <th>车辆</th><th>容量(人)</th><th>可用时刻(s)</th><th>周转(s)</th><th></th>
          </tr>
        </thead>
        <tbody>
          {draft.fleet.map((v) => (
            <tr key={v.vehicle_id}>
              <td className="mono">{v.vehicle_id}</td>
              <td>
                <input
                  type="number" min={1} step={1} value={Number.isNaN(v.capacity) ? "" : v.capacity}
                  className={Number.isInteger(v.capacity) && v.capacity > 0 ? "" : "input-error"}
                  onChange={(ev) => patchVehicle(v.vehicle_id, "capacity", num(ev.target.value))}
                />
              </td>
              <td>
                <input
                  type="number" min={0} value={Number.isNaN(v.available_from_s) ? "" : v.available_from_s}
                  className={v.available_from_s >= 0 ? "" : "input-error"}
                  onChange={(ev) => patchVehicle(v.vehicle_id, "available_from_s", num(ev.target.value))}
                />
              </td>
              <td>
                <input
                  type="number" min={1} value={Number.isNaN(v.round_trip_s) ? "" : v.round_trip_s}
                  className={v.round_trip_s > 0 ? "" : "input-error"}
                  onChange={(ev) => patchVehicle(v.vehicle_id, "round_trip_s", num(ev.target.value))}
                />
              </td>
              <td>
                <button className="btn btn-small btn-danger" onClick={() => removeVehicle(v.vehicle_id)}>移除</button>
              </td>
            </tr>
          ))}
          {draft.fleet.length === 0 && (
            <tr><td colSpan={5} className="dim">已无可用车辆（合法状态：将无人能登车；重置场景可恢复车辆）</td></tr>
          )}
        </tbody>
      </table>

      {errors.length > 0 && (
        <ul className="field-errors">
          {errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}

      <div className="nl-actions">
        <button
          className="btn btn-primary"
          disabled={!dirty || errors.length > 0}
          onClick={() => applyManualScenario(draft)}
        >
          保存修改（revision +1）
        </button>
        <button className="btn" disabled={!dirty} onClick={() => setDraft(structuredClone(scenario))}>放弃修改</button>
        <button className="btn" onClick={resetScenario}>重置为默认场景</button>
        {dirty && <span className="badge badge-warn">有未保存修改</span>}
        {errors.length > 0 && <span className="badge badge-danger">{errors.length} 项校验未通过</span>}
      </div>
    </div>
  );
}
