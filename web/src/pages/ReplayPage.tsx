import React, { useState } from "react";
import { runMatchesCurrent, useActions, useApp, useViewingBundle } from "../state/store";
import TracePanel from "../features/review/TracePanel";
import "../features/review/review.css";

/**
 * 已保存结果与技术详情页（次级页面）：
 * 先展示历史回放记录与保存/查看/退出操作，空状态真实；
 * 运行详情（服务状态/工具轨迹/请求日志）默认折叠，展开后完整可达。
 * 回放数据保存在本浏览器 localStorage，本页不清理由、不改 replayStorage；
 * “已保存结果 · 非本次计算”标识的全局持续展示由外壳（窗口4）负责。
 */
export default function ReplayPage() {
  const { state } = useApp();
  const { saveCurrentAsReplay, loadReplay, exitReplay } = useActions();
  const { inReplay } = useViewingBundle();
  const [label, setLabel] = useState("");

  const viewing = state.viewing;
  const outdated =
    !inReplay && state.run !== null && !runMatchesCurrent(state.run, state.scenario, state.objective, state.seed);
  const canSave = !inReplay && state.run !== null && !outdated;

  return (
    <div className="page review-page">
      <section className="panel">
        <h2>已保存结果</h2>
        <p className="panel-desc">
          回放保存<b>真实计算成功/完成的结果与场景快照</b>，加载后全程显示“已保存结果 · 非本次计算”标识（全局横幅持续展示），与实时运行严格区分；
          断网时仅可查看回放，不会把旧指标冒充为新结果。
        </p>
        {inReplay && viewing.kind === "replay" ? (
          <div className="review-mode-banner" role="status">
            <b>回放模式：{viewing.replay.label}</b>
            <span>
              保存于 {new Date(viewing.replay.saved_at).toLocaleString()} · 场景 {viewing.replay.scenario.scenario_id}@rev
              {viewing.replay.scenario.revision} · 非本次计算。实时生成 / 比较 / 单方案重跑已禁用，退出回放后恢复。
            </span>
          </div>
        ) : (
          <p className="review-table-note">当前为实时视角：下方为本浏览器已保存的历史结果，点击“查看回放”进入回放模式。</p>
        )}
        <p className="review-table-note">
          回放数据保存在本浏览器 localStorage 中：仅在同一浏览器配置（同协议/主机/端口）下可用；清除浏览器站点数据会删除回放，不同地址/端口之间不共享。
        </p>

        <div className="row section-gap">
          <input
            type="text"
            placeholder="回放名称，如：正常散场·协调方案"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            style={{ width: 280 }}
          />
          <button
            className="btn btn-primary"
            disabled={!canSave}
            title={
              inReplay ? "回放模式下不能再保存回放" : !state.run ? "尚无运行结果" : outdated ? "当前结果已过期，请先重新生成" : undefined
            }
            onClick={() => {
              saveCurrentAsReplay(label.trim() || `回放 ${new Date().toLocaleTimeString()}`);
              setLabel("");
            }}
          >
            保存当前结果为回放
          </button>
          {!canSave && !inReplay && (
            <span className="dim review-table-note">
              {!state.run ? "先在“出行建议”生成结果" : outdated ? "结果已过期，需重新生成后再保存" : ""}
            </span>
          )}
        </div>

        {state.replays.length === 0 ? (
          <p className="dim section-gap">尚无已保存回放。生成并确认一轮结果后，可在上方保存为回放。</p>
        ) : (
          <div className="table-scroll section-gap">
            <table className="table">
              <thead>
                <tr><th>名称</th><th>保存时间</th><th>场景</th><th>seed</th><th>目标</th><th>方案数</th><th></th></tr>
              </thead>
              <tbody>
                {state.replays.map((r) => {
                  const active = inReplay && viewing.kind === "replay" && viewing.replay.replay_id === r.replay_id;
                  return (
                    <tr key={r.replay_id} className={active ? "row-changed" : ""}>
                      <td>
                        {r.label} {active && <span className="badge badge-replay">回放中</span>}
                      </td>
                      <td className="mono">{new Date(r.saved_at).toLocaleTimeString()}</td>
                      <td className="mono">{r.scenario.scenario_id}@rev{r.scenario.revision}</td>
                      <td className="mono">{r.bundle.seed}</td>
                      <td>{r.bundle.objective}</td>
                      <td>{r.bundle.plans.length}</td>
                      <td>
                        {active ? (
                          <button className="btn btn-small" onClick={exitReplay}>退出回放</button>
                        ) : (
                          <button className="btn btn-small" onClick={() => loadReplay(r.replay_id)}>查看回放</button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {inReplay && (
          <button className="btn section-gap" onClick={exitReplay}>退出回放，回到实时视角</button>
        )}
      </section>

      <TracePanel />
    </div>
  );
}
