import React, { useState } from "react";
import type { TraceEntry } from "../../contract/types";
import { useActions, useApp, useViewingBundle } from "../../state/store";
import { API_BASE_URL, IS_DEV_MOCK } from "../../api/config";

const SOURCE_LABELS: Record<TraceEntry["source"], string> = {
  llm: "LLM",
  rules: "规则",
  simulator: "推演引擎",
  validator: "校验器",
  cache: "缓存",
};

/**
 * 工具轨迹列表：来源 / 状态 / 耗时 / 摘要 / 输入输出引用原样展示。
 * 导出供方案对比页的“计算依据”折叠区复用；不新增或改写任何轨迹步骤。
 */
export function TraceStepList({ title, trace }: { title: string; trace: TraceEntry[] }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div>
      <h3>{title}</h3>
      {trace.length === 0 && <p className="dim">无记录。</p>}
      <div className="trace-list">
        {trace.map((t, i) => (
          <div key={i} className={`trace-item status-${t.status}`}>
            <div className="trace-head">
              <span className="badge">#{t.step}</span>
              <b>{t.actor}</b>
              <span className="mono">{t.action}</span>
              <span className={`badge ${t.source === "llm" ? "badge-ok" : ""}`}>{SOURCE_LABELS[t.source]}</span>
              <span className={`badge ${t.status === "ok" ? "badge-ok" : "badge-danger"}`}>{t.status}</span>
              {typeof t.duration_ms === "number" && <span className="dim mono">{t.duration_ms}ms</span>}
              <span className="spacer" />
              <button className="btn btn-small" onClick={() => setOpen(open === i ? null : i)}>
                {open === i ? "收起" : "摘要"}
              </button>
            </div>
            {open === i && (
              <div className="trace-summary">
                {t.summary}
                {(t.input_ref || t.output_ref) && (
                  <div className="mono dim" style={{ fontSize: 11, marginTop: 4 }}>
                    {t.input_ref && <div>input_ref: {t.input_ref}</div>}
                    {t.output_ref && <div>output_ref: {t.output_ref}</div>}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * 运行详情（工程验收）：服务状态、生成/比较工具轨迹、前端请求日志。
 * 默认折叠；展开后完整可达，实际来源/模式/耗时/失败原样保留。
 * 不把 llm_configured 配置状态当作模型执行成功——本轮模式以服务端返回的 mode 为准。
 */
export default function TracePanel() {
  const { state } = useApp();
  const { checkHealth } = useActions();
  const { inReplay, bundle } = useViewingBundle();

  return (
    <details className="review-collapse">
      <summary>
        运行详情（工程验收）
        <span className="review-table-note">服务状态 · 工具轨迹 · 请求日志；默认收起，展开后完整可达</span>
      </summary>
      <div className="review-collapse-body">
        <p className="panel-desc">
          此处信息不代表首页结果的能力标签。{inReplay ? "当前为已保存结果回放：以下工具轨迹与日志来自保存时的快照。" : "当前为实时运行。"}
        </p>

        <div className="review-status-grid">
          <div className="review-status-item">
            <span className="review-key-label">服务连接</span>
            <b>
              {state.health.state === "checking" && "检测中…"}
              {state.health.state === "ok" && "已连接"}
              {state.health.state === "down" && "不可达"}
            </b>
          </div>
          <div className="review-status-item">
            <span className="review-key-label">接口地址</span>
            <b className="mono">{API_BASE_URL}</b>
          </div>
          <div className="review-status-item">
            <span className="review-key-label">契约版本</span>
            <b className="mono">{state.health.schema_version ?? "—"}</b>
          </div>
          <div className="review-status-item">
            <span className="review-key-label">引擎就绪</span>
            <b>{state.health.engine_ready === undefined ? "—" : state.health.engine_ready ? "是" : "否（生成/比较禁用）"}</b>
          </div>
          <div className="review-status-item">
            <span className="review-key-label">模型配置状态</span>
            <b>
              {state.health.llm_configured === undefined
                ? "—"
                : state.health.llm_configured
                  ? "服务端已配置（不代表本次结果由模型生成）"
                  : "未配置（解析按规则模式返回）"}
            </b>
          </div>
          <div className="review-status-item">
            <span className="review-key-label">当前场景</span>
            <b className="mono">{state.scenario.scenario_id}@rev{state.scenario.revision} · seed {state.seed}</b>
          </div>
          {bundle && (
            <div className="review-status-item">
              <span className="review-key-label">本轮模式</span>
              <b>生成 {bundle.generate_mode} · 比较 {bundle.compare_mode}（页面展示以实际 mode 为准）</b>
            </div>
          )}
          {IS_DEV_MOCK && (
            <div className="review-status-item">
              <span className="review-key-label">开发 mock</span>
              <b className="badge badge-mock">已启用：指标全部为前端占位数据</b>
            </div>
          )}
        </div>

        <div className="section-gap">
          <TraceStepList title={`plan/generate 工具轨迹（mode=${bundle?.generate_mode ?? "—"}）`} trace={bundle?.generate_trace ?? []} />
        </div>
        <div className="section-gap">
          <TraceStepList title={`compare 工具轨迹（mode=${bundle?.compare_mode ?? "—"}）`} trace={bundle?.compare_trace ?? []} />
        </div>

        <h3 className="section-gap">前端请求日志</h3>
        <p className="panel-desc">
          浏览器实际发出的每一次 HTTP 请求（含失败与超时），按时间顺序排列。
          {IS_DEV_MOCK && "（当前为开发 mock 模式：请求在前端内部处理，不产生真实 HTTP 记录，属预期行为。）"}
        </p>
        {state.clientLog.length === 0 ? (
          <p className="dim">尚无请求记录。</p>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr><th>#</th><th>时间</th><th>请求</th><th>状态</th><th>HTTP</th><th>耗时</th><th>摘要</th></tr>
              </thead>
              <tbody>
                {state.clientLog.map((e) => (
                  <tr key={e.id}>
                    <td className="mono">{e.id}</td>
                    <td className="mono">{new Date(e.at).toLocaleTimeString()}</td>
                    <td className="mono">{e.method} {e.path}</td>
                    <td>
                      <span className={`badge ${e.status === "ok" ? "badge-ok" : "badge-danger"}`}>{e.status}</span>
                    </td>
                    <td className="mono">{e.http_status ?? "—"}</td>
                    <td className="mono">{e.duration_ms}ms</td>
                    <td>{e.summary}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="section-gap">
          <button className="btn btn-small" onClick={() => void checkHealth()}>重新检测服务</button>
        </div>
      </div>
    </details>
  );
}
