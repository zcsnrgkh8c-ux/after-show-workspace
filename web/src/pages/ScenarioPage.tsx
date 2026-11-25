import React, { useState } from "react";
import type { Objective, ParsePatch } from "../contract/types";
import ScenarioEditor from "../components/ScenarioEditor";
import DiffPreview from "../components/DiffPreview";
import { useActions, useApp } from "../state/store";
import "../features/review/review.css";

const OBJECTIVE_LABELS: Record<Objective, string> = {
  efficiency: "效率优先",
  inclusion: "包容优先",
  balanced: "平衡",
};

const OBJECTIVE_RULES: Record<Objective, string> = {
  efficiency: "效率优先：剩余人数 → 全部已释放人均等待 → 错过末班人数（越小越好）",
  inclusion: "包容优先：优先需求组未登车人数 → 错过末班人数 → 剩余人数 → 人均等待",
  balanced: "平衡：剩余人数 → 错过末班人数 → 人均等待",
};

/**
 * 演示控制页（次级页面）：修改的是“模拟输入”——演示情境、场景参数、随机 seed 与优化目标。
 * 保留既有编辑流程：自然语言变更 / 手动编辑 / 情境预设，均需 预览 → 确认 → revision+1 → 旧结果过期；
 * 不新增绕过白名单的写入口，不重写业务计算。
 * 页面加载时不自动封路、不自动应用补丁、不自动发请求；预设只生成待确认的预览。
 */
export default function ScenarioPage() {
  const { state, dispatch } = useApp();
  const { parseInstruction, setObjective, setSeed } = useActions();
  const [instruction, setInstruction] = useState("");

  const canParse = instruction.trim().length > 0 && !state.nl.busy && state.health.state === "ok";

  /* 情境预设：只针对当前场景实际存在的边构造受限 patch，走既有“预览 → 确认”流程；不假定所有场景都有特定边 */
  const stepFreeEdges = state.scenario.edges.filter((e) => e.step_free);
  const openStepFree = stepFreeEdges.filter((e) => !e.closed);
  const closedEdges = state.scenario.edges.filter((e) => e.closed);

  const openStepFreeIds = openStepFree.map((e) => e.edge_id).join("、");
  const closedEdgeIds = closedEdges.map((e) => e.edge_id).join("、");

  const presetBlocked = () => {
    if (openStepFree.length === 0) return;
    const patch: ParsePatch[] = openStepFree.map((e) => ({ target: "edge", id: e.edge_id, field: "closed", value: true }));
    dispatch({
      type: "nlPending",
      pending: {
        instruction: "预设情境：无台阶通道全部受阻",
        response: {
          patch,
          summary: `关闭全部 ${openStepFree.length} 条无台阶通道（${openStepFreeIds}），用于演示无台阶出行需求受阻`,
          warnings: ["预设情境仅修改当前场景中实际存在的通道开闭状态；确认后 revision+1，旧结果过期"],
          mode: "rules",
        },
        scenario_id: state.scenario.scenario_id,
        base_revision: state.scenario.revision,
      },
    });
  };

  const presetRestore = () => {
    if (closedEdges.length === 0) return;
    const patch: ParsePatch[] = closedEdges.map((e) => ({ target: "edge", id: e.edge_id, field: "closed", value: false }));
    dispatch({
      type: "nlPending",
      pending: {
        instruction: "预设情境：恢复全部已关闭通道",
        response: {
          patch,
          summary: `重新开放 ${closedEdges.length} 条已关闭通道（${closedEdgeIds}）`,
          warnings: [
            "只恢复当前已关闭的通道，不改动车辆、旅客人数、seed 或已保存回放",
            "确认后 revision+1，旧结果过期；需重新计算才会更新指标",
          ],
          mode: "rules",
        },
        scenario_id: state.scenario.scenario_id,
        base_revision: state.scenario.revision,
      },
    });
  };

  return (
    <div className="page review-page">
      <section className="review-page-head">
        <h2 className="review-page-title">演示控制 · 情境调整</h2>
        <p className="review-page-sub">
          这里修改的是<b>模拟输入</b>，用于复现“改变通道条件 → 谁受阻 → 恢复后重算”的演示线。
          所有变更都要 预览 → 确认（revision+1）→ 重新计算；页面打开时不会自动封路、自动改场景或自动发请求。
        </p>
      </section>

      <section className="panel">
        <h3>当前模拟输入（只读汇总）</h3>
        <div className="review-status-grid">
          <div className="review-status-item">
            <span className="review-key-label">场景版本</span>
            <b className="mono">{state.scenario.scenario_id}@rev{state.scenario.revision}</b>
          </div>
          <div className="review-status-item">
            <span className="review-key-label">已关闭通道</span>
            <b>{closedEdges.length === 0 ? "无" : `${closedEdges.length} 条：${closedEdgeIds}`}</b>
          </div>
          <div className="review-status-item">
            <span className="review-key-label">无台阶通道</span>
            <b>
              开放 {openStepFree.length} / {stepFreeEdges.length} 条
              {stepFreeEdges.length > 0 && `（开放：${openStepFreeIds || "无"}）`}
            </b>
          </div>
          <div className="review-status-item">
            <span className="review-key-label">seed / 优化目标</span>
            <b className="mono">{state.seed} · {OBJECTIVE_LABELS[state.objective]}</b>
          </div>
        </div>
        <p className="review-table-note">
          不同输入会得到不同结果：例如“减少车辆 + 关闭不同出口”是两组不同输入，历史数字不能直接套用。
          恢复后必须重新计算，指标才会更新。
        </p>

        <div className="review-preset-row section-gap">
          <b>情境预设：</b>
          <button
            className="btn"
            disabled={openStepFree.length === 0}
            title={
              openStepFree.length === 0
                ? "当前没有开放的无台阶通道"
                : `将关闭：${openStepFreeIds}（仅生成预览，确认后才应用）`
            }
            onClick={presetBlocked}
          >
            无台阶通道全部受阻（{openStepFree.length} 条）
          </button>
          <button
            className="btn"
            disabled={closedEdges.length === 0}
            title={
              closedEdges.length === 0
                ? "当前没有已关闭通道"
                : `将恢复：${closedEdgeIds}（仅恢复通道开闭，不改其他输入）`
            }
            onClick={presetRestore}
          >
            恢复已关闭通道（{closedEdges.length} 条）
          </button>
          <span className="review-table-note">点击后只生成变更预览，确认才应用；不会清空回放或重置其他设置。</span>
        </div>

        <p className="review-table-note">
          路演复现顺序：先选需求并生成建议 → 在本页应用一次输入变更并重新计算 → 回到“方案对比”看依据 → 再恢复通道并重算。
        </p>
      </section>

      <section className="panel">
        <h3>自然语言改场景</h3>
        <p className="panel-desc">
          例如：“关闭2号出口，末班提前5分钟”“减少一辆车”。系统只生成受限的结构化变更预览，
          <b>确认应用前不会改动正式场景</b>；模糊之处会以警告形式提示，不会猜测编造。
        </p>
        <div className="nl-box">
          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder="输入变更指令…"
          />
          <div className="nl-actions">
            <button className="btn btn-primary" disabled={!canParse} onClick={() => void parseInstruction(instruction.trim())}>
              {state.nl.busy ? "解析中…" : "解析变更"}
            </button>
            {state.health.state !== "ok" && <span className="badge badge-danger">服务不可达，无法解析</span>}
            {state.nl.error && <span className="badge badge-danger">解析失败：{state.nl.error}</span>}
          </div>
        </div>

        <DiffPreview />

        <details className="review-collapse section-gap">
          <summary>手动编辑场景参数（高级）</summary>
          <div className="review-collapse-body">
            <ScenarioEditor />
          </div>
        </details>

        <details className="review-collapse section-gap">
          <summary>高级设置（随机 seed / 优化目标）</summary>
          <div className="review-collapse-body">
            <div className="row">
              <label className="field">
                随机种子 seed
                <input
                  type="number" min={0} step={1} value={state.seed}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (Number.isInteger(n) && n >= 0) setSeed(n);
                  }}
                />
              </label>
              <span>
                优化目标：
                <span className="review-objective-group">
                  {(Object.keys(OBJECTIVE_LABELS) as Objective[]).map((o) => (
                    <button key={o} className={state.objective === o ? "review-active" : ""} onClick={() => setObjective(o)}>
                      {OBJECTIVE_LABELS[o]}
                    </button>
                  ))}
                </span>
              </span>
            </div>
            <p className="review-table-note" style={{ marginTop: 8 }}>
              {OBJECTIVE_RULES[state.objective]}。修改 seed 或目标后，已有结果将标记为“情况已变化”，需重新生成后才会更新。
            </p>
          </div>
        </details>
      </section>
    </div>
  );
}
