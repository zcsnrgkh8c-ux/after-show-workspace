import React, { useState } from "react";
import { applyPatchToScenario, patchOldValue, useActions, useApp, useViewingBundle, type PatchApplyResult } from "../state/store";
import type { UntrustedPatchItem } from "../state/scenarioOps";

function fmtNewValue(item: UntrustedPatchItem): string {
  if (item.target === "vehicle" && item.field === "enabled" && item.value === false) return "移除该车辆";
  if (item.field === "closed") return item.value === true ? "关闭" : "开放";
  if (item.field === "board_deadline_s") return item.value === null ? "无期限" : `${String(item.value)}s`;
  if (item.field === "travel_s") return `${String(item.value)}s`;
  if (item.field === "capacity_per_min") return `${String(item.value)}/min`;
  return String(item.value);
}

function targetLabel(item: UntrustedPatchItem): string {
  if (item.target === "edge") return `通道 ${item.id}`;
  if (item.target === "group") return `旅客组 ${item.id}`;
  if (item.target === "vehicle") return `车辆 ${item.id}`;
  // 运行时防御：未知目标仍可展示，不因类型穷尽而丢失提示
  return `未知目标 ${String(item.target)}·${item.id}`;
}

const FIELD_LABELS: Record<string, string> = {
  closed: "开闭状态",
  travel_s: "通行耗时",
  capacity_per_min: "通行能力",
  count: "人数",
  walk_time_factor: "步行耗时系数",
  board_deadline_s: "登车截止",
  enabled: "是否在役",
};

/**
 * 自然语言变更的结构化差异预览（04 §2-1）：
 * 只展示 patch 差异并高亮受影响参数；用户点击“确认应用”前绝不改动正式场景。
 * 确认后只做 apply（revision+1、旧结果过期），不与重新生成合并在同一事件回调；
 * 由用户再点击“更新出行建议”（或可选 onGoHome 回首页）触发新一轮计算。
 * onGoHome 为可选导航回调，由窗口4接线；未提供时仅显示就地按钮。
 */
export default function DiffPreview({ onGoHome }: { onGoHome?: () => void } = {}) {
  const { state } = useApp();
  const { applyPendingPatch, discardPendingPatch, generateAndCompare } = useActions();
  const { engineBlocked, engineBlockReason } = useViewingBundle();
  const [appliedResult, setAppliedResult] = useState<PatchApplyResult | null>(null);

  const pending = state.nl.pending;
  if (!pending && !appliedResult) return null;

  if (appliedResult) {
    return (
      <div className="panel">
        <h3>变更已应用</h3>
        <p>
          已应用 {appliedResult.applied.length} 项修改，场景 revision 已提升为 <b>rev{appliedResult.next.revision}</b>；
          旧的方案与仿真结果已全部标记过期，需重新生成并从相同初始条件重跑。
        </p>
        {appliedResult.skipped.length > 0 && (
          <div className="diff-warnings">
            <b>以下修改项未应用（不在允许范围或目标不存在）：</b>
            <ul>
              {appliedResult.skipped.map((s, i) => (
                <li key={i}>
                  {targetLabel(s.item)} · {FIELD_LABELS[s.item.field] ?? s.item.field}：{s.reason}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="nl-actions section-gap">
          <button
            className="btn btn-primary"
            disabled={state.busyGenerate || engineBlocked}
            title={engineBlockReason ?? (state.busyGenerate ? "正在重新计算…" : undefined)}
            onClick={() => void generateAndCompare()}
          >
            {state.busyGenerate ? "正在重新计算…" : "更新出行建议（按新场景重新生成）"}
          </button>
          {onGoHome && (
            <button className="btn" onClick={onGoHome}>回首页查看建议</button>
          )}
          <button className="btn" onClick={() => setAppliedResult(null)}>关闭</button>
        </div>
        <p className="review-table-note">
          重新计算完成后，方案与指标才会更新为按新场景计算的结果；也可以稍后再自行生成。
        </p>
      </div>
    );
  }

  if (!pending) return null;
  const { response } = pending;
  const preview = applyPatchToScenario(state.scenario, response.patch);

  return (
    <div className="panel">
      <h3>
        变更预览（尚未应用）
        <span className={`badge ${response.mode === "llm" ? "badge-ok" : "badge-warn"}`} style={{ marginLeft: 8 }}>
          {response.mode === "llm" ? "LLM 解析" : "规则解析"}
        </span>
      </h3>
      <p className="panel-desc">
        指令：“{pending.instruction}” —— 以下为解析出的结构化差异，确认后才应用到正式场景；拒绝则保持原值。
      </p>
      <p>{response.summary}</p>

      {response.warnings.length > 0 && (
        <div className="diff-warnings">
          <b>解析警告：</b>
          <ul>
            {response.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {response.patch.length === 0 ? (
        <p className="dim">未解析出任何可应用的修改。</p>
      ) : (
        <table className="table diff-table">
          <thead>
            <tr>
              <th>目标</th>
              <th>参数</th>
              <th>当前值</th>
              <th>变更为</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {response.patch.map((item, i) => {
              const skip = preview.skipped.find((s) => s.item === item);
              return (
                <tr key={i} className="row-changed">
                  <td>{targetLabel(item)}</td>
                  <td>{FIELD_LABELS[item.field] ?? item.field}</td>
                  <td className="diff-old">{patchOldValue(state.scenario, item)}</td>
                  <td className="diff-new">{fmtNewValue(item)}</td>
                  <td>{skip ? <span className="badge badge-danger">将被跳过：{skip.reason}</span> : <span className="badge badge-warn">待确认</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <div className="nl-actions section-gap">
        <button
          className="btn btn-primary"
          disabled={response.patch.length === 0 || preview.applied.length === 0}
          onClick={() => {
            const result = applyPendingPatch();
            if (result) setAppliedResult(result);
          }}
        >
          确认应用（revision +1）
        </button>
        <button className="btn btn-danger" onClick={discardPendingPatch}>放弃变更</button>
        <span className="dim">应用后旧方案与旧仿真立即过期，将从相同初始条件重跑。</span>
      </div>
    </div>
  );
}
