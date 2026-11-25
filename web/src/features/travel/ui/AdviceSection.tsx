/**
 * 出行建议次级卡（受控展示，无自身副作用）——与上方“路线事实”严格分层：
 * - 收到响应前只显示“正在获取出行建议…”，不出现“AI/模型”字样；
 * - mode=llm → “模型分析建议”（仅真实模型调用成功并通过校验时服务端才会返回该 mode）；
 *   mode=rules → “基础路线建议”（不出现 AI 字样）；degraded_from=llm → 注明模型失败降级；
 *   mode=unavailable → “出行建议不可用”，不伪装成基础建议；
 * - 单候选时明确“建议只解释这一条”；
 * - 建议失败只影响本卡，路线事实保留（不转圈致死）。
 */
import type { AdviceMetricField, AdviceReasonCode, AdviceResponse } from "../../../contract/travel";
import type { TravelApiError } from "../../../api/travelAdvice";
import { adviceErrorText, adviceModeView } from "./display";

export interface AdviceSectionProps {
  advice: AdviceResponse | null;
  advising: boolean;
  adviceError: TravelApiError | null;
  /** 身份不符等被丢弃时的提示（如"建议返回了未知路线，已忽略"） */
  adviceWarning: string | null;
  /** 无台阶证据 unknown 的常显警告 */
  stepFreeWarning: string | null;
  /** route_id → 展示名（"方案一"）；未知 id 返回 null */
  routeLabel: (routeId: string) => string | null;
  /** 可选：当前高德候选数（用于单候选口径说明；默认未知） */
  candidateCount?: number | null;
}

const REASON_TEXT: Record<AdviceReasonCode, string> = {
  single_candidate: "仅一条候选",
  shorter_duration: "耗时更短",
  less_walking: "步行更少",
  fewer_transfers: "换乘更少",
  balanced_default: "均衡默认",
  step_free_satisfied: "满足无台阶需求",
  no_candidate_meets_preference: "无候选满足偏好",
};

const METRIC_TEXT: Record<AdviceMetricField, string> = {
  distance_m: "总距离",
  estimated_duration_s: "预计时长",
  walking_distance_m: "步行距离",
  transfer_count: "换乘次数",
  step_free_evidence: "无台阶证据",
};

export function AdviceSection(props: AdviceSectionProps) {
  const { advice, advising, adviceError, adviceWarning, stepFreeWarning, routeLabel } = props;
  const candidateCount = props.candidateCount ?? null;

  const idle =
    advice === null && !advising && adviceError === null && adviceWarning === null && stepFreeWarning === null;
  if (idle) return null;

  const modeView = advice !== null ? adviceModeView(advice) : null;

  return (
    <section className="travel-card advice-section" aria-label="出行建议">
      <div className="advice-head">
        <span className="advice-kicker">出行建议</span>
        {modeView !== null && (
          <span
            className={`advice-mode-chip advice-mode-chip--${modeView.mode}${
              modeView.isModel ? " advice-mode-chip--model" : ""
            }`}
          >
            {modeView.badge}
          </span>
        )}
        <span className="advice-source-chip">服务端</span>
      </div>

      {stepFreeWarning !== null && (
        <p className="advice-warning advice-warning--prominent" role="alert">
          {stepFreeWarning}
        </p>
      )}

      {advising && (
        <p className="advice-loading" role="status">
          正在获取出行建议…（不阻塞路线查看）
        </p>
      )}

      {adviceWarning !== null && (
        <p className="advice-warning" role="alert">
          {adviceWarning}
        </p>
      )}

      {adviceError !== null && (
        <p className="advice-error" role="alert">
          基础路线建议不可用：{adviceErrorText(adviceError)}（路线事实保留，可继续查看）
        </p>
      )}

      {advice !== null && modeView !== null && (
        <>
          <h3 className="advice-title">
            {modeView.title}
            {modeView.degraded && <span className="advice-degraded">模型调用失败，已降级</span>}
          </h3>

          {advice.mode === "unavailable" && (
            <p className="advice-error" role="alert">
              服务端本次未生成可用建议（mode=unavailable）；路线事实不受影响。
            </p>
          )}

          {candidateCount === 1 && (
            <p className="advice-single-note" role="note">
              当前仅 1 条候选：以下建议只解释这一条路线，不进行多路线择优。
            </p>
          )}

          {advice.selected_route_id !== null && (
            <p className="advice-pick">
              建议选择：
              <strong>{routeLabel(advice.selected_route_id) ?? advice.selected_route_id}</strong>
            </p>
          )}

          {advice.reason_codes.length > 0 && (
            <div className="advice-reasons" aria-label="推荐理由">
              {advice.reason_codes.map((c) => (
                <span key={c} className="chip chip--reason">
                  {REASON_TEXT[c] ?? c}
                </span>
              ))}
            </div>
          )}

          <p className="advice-explanation">{advice.explanation}</p>

          {advice.evidence.length > 0 && (
            <ul className="advice-evidence">
              {advice.evidence.map((e, i) => {
                const label = routeLabel(e.route_id) ?? e.route_id;
                return (
                  <li key={`${e.route_id}-${e.metric}-${i}`}>
                    依据：{label} · {METRIC_TEXT[e.metric]}
                  </li>
                );
              })}
            </ul>
          )}

          {advice.warnings.length > 0 && (
            <ul className="advice-warning-list" role="alert">
              {advice.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}

          <p className="advice-source-line">
            建议来源：服务端出行建议接口 · 本次响应 mode={advice.mode}
            {modeView.degraded ? "（模型调用失败后降级）" : ""}；建议不改写上方高德路线事实。
          </p>
        </>
      )}

      {advice !== null && modeView !== null && (
        <details className="advice-mode-details">
          <summary>模式与来源说明</summary>
          <p>{modeView.modeNote}</p>
          <p>
            收到响应前不标注“模型分析”；服务端配置存在不等于模型调用成功。未显示“模型分析”时，表示本次响应不是
            mode=llm（可能未配置模型、调用失败后降级，或只返回规则建议）；模型分析只在响应 mode=llm 时展示。
          </p>
        </details>
      )}
    </section>
  );
}
