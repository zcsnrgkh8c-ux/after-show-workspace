import React, { useState } from "react";
import type { Objective, Plan, SimulationResult, Strategy } from "../contract/types";
import MetricsView from "../components/MetricsView";
import MapPanel from "../components/MapPanel";
import TimelinePlayer, { frameAt } from "../components/TimelinePlayer";
import GroupPanel from "../components/GroupPanel";
import { useActions, useApp, useViewingBundle, type RunBundle } from "../state/store";
import { allValidStranded } from "../state/scenarioOps";
import {
  STRATEGY_LABELS,
  groupDisplayName,
  humanizeReason,
  planDisplayName,
  recommendationHeadline,
  routeSequenceText,
  violationShortText,
} from "../labels";
import { decisionModeText, recommendationFactWarnings } from "../features/review/display";
import { SIMPLE_UI, clientReasonText } from "../features/shell/clientMode";
import {
  needEvidenceRows,
  servedNeedCount,
  serveStatusTitle,
  unfinishedNeedRows,
  type NeedEvidenceRow,
} from "../features/review/planEvidence";
import ViolationGroupList from "../features/review/ViolationGroupList";
import DeparturesTable from "../features/review/DeparturesTable";
import { TraceStepList } from "../features/review/TracePanel";
import "../features/review/review.css";

const OBJECTIVE_LABELS: Record<Objective, string> = {
  efficiency: "效率优先",
  inclusion: "包容优先",
  balanced: "平衡",
};

/** 只读目标说明：目标与 seed 的修改入口在“演示控制”页 → 高级设置 */
const OBJECTIVE_RULES: Record<Objective, string> = {
  efficiency: "效率优先：剩余人数 → 全部已释放人均等待 → 错过末班人数（越小越好）",
  inclusion: "包容优先：优先需求组未登车人数 → 错过末班人数 → 剩余人数 → 人均等待",
  balanced: "平衡：剩余人数 → 错过末班人数 → 人均等待",
};

const STRATEGY_ORDER: Strategy[] = ["baseline", "independent", "coordinated"];

function resultOf(bundle: RunBundle, plan: Plan | undefined): SimulationResult | undefined {
  return plan ? bundle.results.find((r) => r.plan_id === plan.plan_id) : undefined;
}

/** 需求服务状态徽标：ok=已安排路线、blocked=受阻、unknown=未知（不猜测） */
function serveBadge(row: NeedEvidenceRow): { text: string; cls: string } {
  if (row.status.level === "ok") return { text: "已安排路线", cls: "badge-ok" };
  if (row.status.level === "blocked") return { text: "受阻", cls: "badge-danger" };
  return { text: "未知", cls: "" };
}

/** 紧凑摘要卡：中文名 + 状态 + 关键结果；分流/班次/完整指标/校验问题/技术信息按需展开 */
function CompactPlanCard({ bundle, strategy, stale, inReplay, recommended, onSelect, onView, expanded, onToggle }: {
  bundle: RunBundle;
  strategy: Strategy;
  stale: boolean;
  inReplay: boolean;
  recommended: boolean;
  onSelect: (planId: string) => void;
  onView: (planId: string) => void;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { state } = useApp();
  const { resimulatePlan } = useActions();
  const plan = bundle.plans.find((p) => p.strategy === strategy);
  const result = resultOf(bundle, plan);

  if (!plan) {
    return (
      <div className="review-card">
        <h4 className="review-card-head">
          <span className="review-card-name">{STRATEGY_LABELS[strategy]}</span>
        </h4>
        <p className="dim">服务端本轮未返回此策略的方案。</p>
      </div>
    );
  }

  const m = result && result.status === "valid" ? result.metrics : null;
  const invalid = result?.status === "invalid";
  const firstError = invalid ? result.violations.find((v) => v.severity === "error") : undefined;
  const busySim = state.busySimulatePlanId === plan.plan_id;
  const selected = state.selectedPlanId === plan.plan_id;
  const scenario = state.viewing.kind === "replay" ? state.viewing.replay.scenario : state.scenario;
  const needRows = needEvidenceRows(scenario, plan, result ?? null);

  return (
    <div className={`review-card ${selected ? "review-selected" : ""} ${stale ? "review-stale" : ""} ${recommended ? "review-recommended" : ""}`}>
      <h4 className="review-card-head">
        <span className="review-card-name">{planDisplayName(plan)}</span>
        <span className="review-card-badges">
          {recommended && <span className="badge badge-ok">当前推荐</span>}
          {stale ? (
            <span className="badge badge-warn">已过期</span>
          ) : invalid ? (
            <span className="badge badge-danger">未参与推荐</span>
          ) : m ? (
            <span className="badge badge-ok">可用</span>
          ) : (
            <span className="badge">无结果</span>
          )}
        </span>
      </h4>

      {invalid && firstError && (
        <p className="review-invalid-line">
          {violationShortText(firstError)}，未参与推荐。<button className="review-btn-link" onClick={onToggle}>查看原因</button>
        </p>
      )}

      {m ? (
        <>
          <div className="review-key">
            <div className="review-key-item">
              <span className="review-key-label">已登车 / 已释放</span>
              <div className="review-key-value">
                <span className={m.boarded_count === m.released_count ? "" : "review-bad"}>{m.boarded_count}</span>
                <span className="review-key-sub"> / {m.released_count} 人</span>
              </div>
            </div>
            <div className="review-key-item">
              <span className="review-key-label">仍未登车</span>
              <div className={`review-key-value ${m.remaining_count > 0 ? "review-bad" : ""}`}>{m.remaining_count}</div>
            </div>
            <div className="review-key-item">
              <span className="review-key-label">错过截止</span>
              <div className={`review-key-value ${m.missed_deadline_count > 0 ? "review-bad" : ""}`}>{m.missed_deadline_count}</div>
            </div>
          </div>
          {m.remaining_count > 0 && (
            <p className="review-card-warn">模拟结束仍有 {m.remaining_count} 人未登车，需调整方案或资源。</p>
          )}
          {m.remaining_count === 0 && m.missed_deadline_count > 0 && (
            <p className="review-card-warn">
              登车已完成，但有 {m.missed_deadline_count} 人错过截止——登车完成不等于全部按时赶上末班。
            </p>
          )}
        </>
      ) : invalid ? (
        <p className="dim">该方案未通过校验，无有效模拟指标。</p>
      ) : (
        <p className="dim">尚无推演结果。</p>
      )}

      <div className="review-card-needs" aria-label="本方案对各需求的安排">
        {needRows.map((row) => (
          <span
            key={row.groupId}
            className={`review-need review-need-${row.status.level}`}
            title={serveStatusTitle(row.status)}
          >
            {row.label}
          </span>
        ))}
      </div>

      {stale && <p className="dim">{SIMPLE_UI ? "结果对应旧场景，仅供参考，不能作为当前推荐。" : `结果对应旧场景 rev${bundle.scenario_revision}，仅供参考，不能作为当前推荐。`}</p>}

      <div className="review-card-actions">
        <button className="btn btn-small" onClick={onToggle}>{expanded ? "收起明细" : "展开明细"}</button>
        <button className="btn btn-small" onClick={() => onSelect(plan.plan_id)}>
          {selected ? "✓ 正在查看" : "作为查看方案"}
        </button>
        {/* 过期结果仅作旧结果参考：跳转无法取得当前推荐身份，也不与当前场景拼接渲染，故不再提供入口 */}
        {!stale && <button className="btn btn-small" onClick={() => onView(plan.plan_id)}>在路线图中查看</button>}
      </div>

      {expanded && (
        <div className="review-card-detail">
          {!SIMPLE_UI && (
            <>
              <div className="review-techline">
                plan_id: {plan.plan_id} · rev{plan.scenario_revision} · 引擎结果 {result?.engine_version ?? "—"}
              </div>
              <div className="review-techline">
                生成 {decisionModeText(bundle.generate_mode)} · 比较 {decisionModeText(bundle.compare_mode)}（页面展示以服务端实际返回为准）
              </div>
            </>
          )}

          <h3>客流分配（分流）</h3>
          <table className="table">
            <tbody>
              {plan.allocations.map((a) => {
                const g = scenario.groups.find((x) => x.group_id === a.group_id);
                return (
                  <tr key={a.group_id}>
                    <td>{g ? groupDisplayName(g) : a.group_id}</td>
                    <td>
                      {a.routes.length === 0 ? (
                        <span className="badge badge-warn">暂不分配（留在场馆等待）</span>
                      ) : (
                        a.routes.map((r) => (
                          <div key={r.route_id}>
                            {routeSequenceText(scenario, r.route_id)} · {(r.share * 100).toFixed(0)}%
                          </div>
                        ))
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <h3>发车班次</h3>
          <DeparturesTable plan={plan} />

          {plan.notes && plan.notes.length > 0 && (
            <div className="review-departures-note">算法备注：{plan.notes.join("；")}</div>
          )}

          {result && result.violations.length > 0 && (
            <div>
              <h3>校验问题（{result.violations.length} 条，warning 不丢弃）</h3>
              <ViolationGroupList violations={result.violations} />
            </div>
          )}

          {result && result.status === "valid" && (
            <>
              <h3>完整指标（含平均排队 / P95 / 清空时刻）</h3>
              <MetricsView metrics={result.metrics} />
            </>
          )}

          <div className="review-card-actions">
            <button
              className="btn btn-small"
              disabled={stale || inReplay || busySim || state.health.state !== "ok" || state.health.engine_ready === false}
              title={stale ? "结果已过期，请重新生成" : state.health.state !== "ok" ? "服务不可达" : state.health.engine_ready === false ? "引擎未就绪" : undefined}
              onClick={() => void resimulatePlan(plan)}
            >
              {busySim ? "推演中…" : "单方案重跑"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 方案对比页（次级页面）：不重复首页建议，优先回答三个问题——
 * ① 当前能服务哪些需求；② 还有谁未完成或未赶上截止；③ 这个方案为什么被推荐或拒绝。
 * 推荐身份/并列/取舍/无合法候选全部按服务端结果展示，前端不重新排序；
 * 三策略卡保留真实状态与全部旧明细（分流/班次/指标/校验/单方案重跑/过程回放）。
 */
export default function ComparePage({ onViewJourney }: { onViewJourney?: () => void }) {
  const { state } = useApp();
  const { generateAndCompare, selectPlan } = useActions();
  const { inReplay, bundle, outdated, scenarioForView, engineBlocked, engineBlockReason } = useViewingBundle();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [advOpen, setAdvOpen] = useState(false);

  const rec = bundle?.recommendation ?? null;
  const showRecommendation = rec !== null && !outdated;
  const recPlanId = showRecommendation && rec.status !== "no_valid_candidate" ? rec.plan_id : null;

  const validResultCount = bundle?.results.filter((r) => r.status === "valid" && r.metrics !== null).length ?? 0;
  const stranded = bundle !== null && !outdated && allValidStranded(bundle.results);
  const recIsNoCandidate = bundle?.recommendation?.status === "no_valid_candidate" && validResultCount === 0;

  const selectedPlan = bundle?.plans.find((p) => p.plan_id === state.selectedPlanId) ?? null;
  const selectedResult = selectedPlan ? bundle?.results.find((r) => r.plan_id === selectedPlan.plan_id) ?? null : null;
  const selectedFrame = selectedResult ? frameAt(selectedResult, state.playT) : null;

  // 三问结论的“这个方案”：优先系统推荐；无推荐时退到当前查看方案，并明示来源
  const recPlan = recPlanId ? bundle?.plans.find((p) => p.plan_id === recPlanId) ?? null : null;
  const focusPlan = recPlan ?? selectedPlan ?? bundle?.plans[0] ?? null;
  const focusSource = recPlan ? "系统推荐方案" : selectedPlan ? "当前查看方案（本轮无系统推荐）" : "本轮首个方案（本轮无系统推荐）";
  const focusResult = focusPlan ? bundle?.results.find((r) => r.plan_id === focusPlan.plan_id) ?? null : null;
  const focusMetrics = focusResult && focusResult.status === "valid" ? focusResult.metrics : null;
  const focusRows = bundle ? needEvidenceRows(scenarioForView, focusPlan, focusResult) : [];
  const focusUnfinished = unfinishedNeedRows(focusRows);
  const focusServed = servedNeedCount(focusRows);
  const focusFacts = recommendationFactWarnings(focusMetrics);

  const invalidPlans =
    bundle?.results
      .filter((r) => r.status === "invalid")
      .map((r) => ({ result: r, plan: bundle.plans.find((p) => p.plan_id === r.plan_id) ?? null })) ?? [];

  /** 卡内“在路线图中查看”：先按原语义 selectPlan，再交由外壳回调回首页；无回调时就地展开高级详情 */
  const viewInJourney = (planId: string) => {
    selectPlan(planId);
    if (onViewJourney) onViewJourney();
    else setAdvOpen(true);
  };

  return (
    <div className="page review-page">
      <section className="review-page-head">
        <h2 className="review-page-title">方案依据 · 三策略对比</h2>
        <p className="review-page-sub">
          这一页不重复首页建议，而是回答三件事：当前能服务哪些需求、还有谁未完成或未赶上截止、这个方案为什么被推荐或拒绝。
          推荐身份与取舍按服务端返回，前端不重新排序。
        </p>
      </section>

      <div className="panel">
        <div className="row">
          <button
            className="btn btn-primary"
            disabled={state.busyGenerate || inReplay || engineBlocked}
            title={inReplay ? "缓存回放中，退出后才可实时运行" : engineBlockReason}
            onClick={() => void generateAndCompare()}
          >
            {state.busyGenerate ? "生成并比较中…" : "重新生成并比较"}
          </button>
          {inReplay && <span className="badge badge-replay">已保存结果 · 非本次计算</span>}
          {!SIMPLE_UI && <span className="review-lead">优化目标与 seed 的修改入口在“演示控制”页 → 高级设置。</span>}
        </div>
        {!SIMPLE_UI && (
          <div className="review-lead" style={{ marginTop: 6 }}>
            当前目标说明（只读）：{OBJECTIVE_RULES[state.objective]}。三类策略使用同一场景版本、初始条件与 seed；指标全部来自服务端真实仿真。
          </div>
        )}
      </div>

      {bundle === null && (
        <div className="panel">
          <p className="dim">
            尚未生成任何方案。请先在“出行建议”页生成，或点击上方“重新生成并比较”。
          </p>
        </div>
      )}

      {bundle !== null && bundle.plans.length === 0 && (
        <div className="panel">
          <h3>未生成任何候选方案</h3>
          <p className="dim">服务端本轮未返回候选（可能是资源不足或无可行安排）。可调整演示情境后重试。</p>
          <button className="btn" disabled={state.busyGenerate || engineBlocked} title={engineBlockReason} onClick={() => void generateAndCompare()}>
            重试生成
          </button>
        </div>
      )}

      {stranded && (
        <div className="recommend-box no-candidate" role="alert">
          <h3>仍有旅客滞留，需调整方案或资源</h3>
          <p>
            本轮 {validResultCount} 个有效候选均已释放旅客但<b>无人登车</b>（剩余人数 = 已释放人数）。
            方案<b>合法</b>但服务目标未满足——这不是“无合法候选”。请调整演示情境（恢复出口 / 增加车辆）后重新计算。
          </p>
        </div>
      )}

      {bundle !== null && bundle.plans.length > 0 && outdated && (
        <div className="panel review-stale-answers" role="status">
          <h3>结论暂不可用：情况已变化</h3>
          <p>
            场景 / 目标已修改（本页结果对应旧场景）。下方策略卡仅为旧结果参考，
            <b>不能</b>回答当前输入能服务谁、还有谁未完成。请更新建议后再做对比陈述。
          </p>
          <button
            className="btn btn-primary"
            disabled={state.busyGenerate || inReplay || engineBlocked}
            title={inReplay ? "缓存回放中，退出后才可实时运行" : engineBlockReason}
            onClick={() => void generateAndCompare()}
          >
            {state.busyGenerate ? "正在重新计算…" : "按当前输入更新建议"}
          </button>
        </div>
      )}

      {bundle !== null && bundle.plans.length > 0 && !outdated && focusPlan && (
        <section className="panel review-answers" aria-label="方案依据三问">
          <div className="review-answers-head">
            <h3>
              {rec && rec.status !== "no_valid_candidate" ? (
                <>
                  系统当前推荐：<b>{planDisplayName(focusPlan)}</b>
                  {rec.status === "tradeoff" && <span className="badge badge-warn">存在取舍</span>}
                </>
              ) : (
                <>本轮暂无系统推荐</>
              )}
            </h3>
            <p className="review-table-note">
              三问结论基于 <b>{planDisplayName(focusPlan)}</b>（{focusSource}）；数字来自服务端仿真结果，前端只做展示整理。
            </p>
          </div>

          <div className="review-answer-grid">
            <article className="review-answer">
              <h4>① 当前能服务哪些需求？</h4>
              {focusMetrics ? (
                <p className="review-answer-line">
                  本方案为 <b>{focusServed}</b> / {focusRows.length} 个需求组安排了可用路线。
                </p>
              ) : (
                <p className="review-answer-line">
                  该方案没有有效模拟结果，无法确认可服务需求数；下方为路线分配与校验状态。
                </p>
              )}
              <div className="review-need-list">
                {focusRows.map((row) => {
                  const badge = serveBadge(row);
                  return (
                    <div key={row.groupId} className="review-need-row">
                      <div className="review-need-head">
                        <b>{row.label}</b>
                        <span className="review-need-people">{row.people} 人</span>
                        <span className={`badge ${badge.cls}`}>{badge.text}</span>
                      </div>
                      <div className="review-need-detail">
                        {row.status.text}
                        {row.status.level === "blocked" && row.status.hint ? `（${row.status.hint}）` : ""}
                        {row.status.level === "ok" && row.status.warning ? `；${row.status.warning}` : ""}
                      </div>
                    </div>
                  );
                })}
              </div>
              <p className="review-table-note">
                “已安排路线”指本方案为该需求分配了可用通道，不等于该组所有人都已登车；受阻原因来自当前场景通道与方案校验。
              </p>
            </article>

            <article className="review-answer">
              <h4>② 还有谁未完成或未赶上截止？</h4>
              {!focusMetrics ? (
                <p className="review-answer-line">
                  {focusResult?.status === "invalid"
                    ? "该方案未通过校验，没有有效模拟指标，无法给出完成情况（也不参与推荐）。"
                    : "该方案尚无有效模拟结果，无法判断谁未完成。"}
                </p>
              ) : (
                <>
                  <p className="review-answer-line">
                    已登车 <b>{focusMetrics.boarded_count}</b> / 已释放 <b>{focusMetrics.released_count}</b>
                    · 仍未登车 <b className={focusMetrics.remaining_count > 0 ? "review-bad" : ""}>{focusMetrics.remaining_count}</b>
                    · 错过截止 <b className={focusMetrics.missed_deadline_count > 0 ? "review-bad" : ""}>{focusMetrics.missed_deadline_count}</b>
                  </p>
                  {focusUnfinished.length === 0 ? (
                    <p className="review-table-note">该方案的有效结果中，各需求组均无未登车、无错过截止（组级汇总，不代表个人）。</p>
                  ) : (
                    <div className="review-need-list">
                      {focusUnfinished.map((row) => (
                        <div key={row.groupId} className="review-unfinished-row">
                          <b>{row.label}</b>
                          {row.remaining !== null && row.remaining > 0 && (
                            <> 仍有 <b>{row.remaining}</b> 人未登车</>
                          )}
                          {row.missedDeadline !== null && row.missedDeadline > 0 && (
                            <>{(row.remaining ?? 0) > 0 ? "；" : ""}<b>{row.missedDeadline}</b> 人错过登车截止</>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  {focusFacts.length > 0 && (
                    <div className="review-rec-warn" role="status">
                      {focusFacts.map((line, i) => (
                        <p key={i}>{line}</p>
                      ))}
                    </div>
                  )}
                </>
              )}
            </article>

            <article className="review-answer">
              <h4>③ 这个方案为什么被推荐 / 被拒绝？</h4>
              {rec ? (
                <>
                  <p className="review-answer-line">
                    <b>{recommendationHeadline(rec)}</b>
                    {!SIMPLE_UI && <span className="review-need-people">状态：{rec.status}</span>}
                  </p>
                  {rec.reason.trim().length > 0 && (
                    <p>{SIMPLE_UI ? clientReasonText(humanizeReason(rec.reason)) : humanizeReason(rec.reason)}</p>
                  )}
                  {!SIMPLE_UI && rec.status === "no_valid_candidate" && !recIsNoCandidate && (
                    <p className="dim">
                      注意：服务端返回 no_valid_candidate，但本轮存在 {validResultCount} 个有效结果。以前端核对的实际结果为准，
                      请检查 compare 推荐逻辑。
                    </p>
                  )}
                  {rec.tradeoffs.length > 0 && (
                    <ul className="review-answer-list">
                      {rec.tradeoffs.map((t, i) => (
                        <li key={i}>{SIMPLE_UI ? clientReasonText(humanizeReason(t)) : humanizeReason(t)}</li>
                      ))}
                    </ul>
                  )}
                  {!SIMPLE_UI && (
                    <details className="rec-raw">
                      <summary>查看服务端原始理由（技术原文）</summary>
                      <pre className="mono">{rec.reason}</pre>
                    </details>
                  )}
                </>
              ) : (
                <p className="review-answer-line">服务端本轮未返回推荐结论；不推断、不补造推荐理由。</p>
              )}

              {invalidPlans.length > 0 && (
                <div className="review-rejected">
                  <b>未参与推荐的方案（校验未通过）：</b>
                  <ul className="review-answer-list">
                    {invalidPlans.map(({ result, plan }) => {
                      const firstError = result.violations.find((v) => v.severity === "error");
                      return (
                        <li key={result.plan_id ?? plan?.plan_id ?? "unknown"}>
                          {plan ? planDisplayName(plan) : result.plan_id ?? "未知方案"}
                          {SIMPLE_UI
                            ? "：校验未通过"
                            : firstError
                              ? `：${violationShortText(firstError)}`
                              : "：校验未通过"}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
              {invalidPlans.length === 0 && <p className="review-table-note">本轮没有校验未通过的候选。</p>}

              <p className="review-table-note">
                {SIMPLE_UI
                  ? "推荐与指标均来自服务端仿真，不代表真实场馆成效。"
                  : `判定依据：服务端仿真引擎 ${focusResult?.engine_version ?? "—"} · 生成 ${decisionModeText(bundle.generate_mode)} · 比较 ${decisionModeText(bundle.compare_mode)}。推荐身份、并列与取舍均按服务端返回；指标是同一场景、同一 seed 下的模拟结果，不代表真实场馆成效。`}
              </p>
            </article>
          </div>
        </section>
      )}

      {bundle !== null && bundle.plans.length > 0 && (
        <>
          {(!SIMPLE_UI || outdated) && (
            <div className="row" style={{ marginBottom: 8 }}>
              {!SIMPLE_UI && (
                <span className="review-lead">
                  本轮：{bundle.scenario_id}@rev{bundle.scenario_revision} · seed {bundle.seed} · 目标 {OBJECTIVE_LABELS[bundle.objective]}
                  {inReplay && " · 已保存结果"}
                </span>
              )}
              {outdated && <span className="badge badge-warn">结果已过期：情况已变化，请更新建议</span>}
            </div>
          )}
          <div className="review-strategy-grid">
            {STRATEGY_ORDER.map((strategy) => (
              <CompactPlanCard
                key={strategy}
                bundle={bundle}
                strategy={strategy}
                stale={outdated}
                inReplay={inReplay}
                recommended={recPlanId === bundle.plans.find((p) => p.strategy === strategy)?.plan_id}
                onSelect={selectPlan}
                onView={viewInJourney}
                expanded={!!expanded[strategy]}
                onToggle={() => setExpanded((e) => ({ ...e, [strategy]: !e[strategy] }))}
              />
            ))}
          </div>

          {!SIMPLE_UI && (
            <details className="review-collapse section-gap">
              <summary>
                这一页结论从哪来：本轮工具轨迹
                <span className="review-table-note">generate {bundle.generate_trace.length} 步 · compare {bundle.compare_trace.length} 步</span>
              </summary>
              <div className="review-collapse-body">
                <p className="review-table-note">
                  轨迹原样来自本轮计算（回放时为保存快照）。来源可能为规则 / 推演引擎 / 校验器；模型配置状态不等于模型实际执行。
                </p>
                <TraceStepList title={`plan/generate 工具轨迹（mode=${bundle.generate_mode}）`} trace={bundle.generate_trace} />
                <div className="section-gap">
                  <TraceStepList title={`compare 工具轨迹（mode=${bundle.compare_mode}）`} trace={bundle.compare_trace} />
                </div>
              </div>
            </details>
          )}

          {!SIMPLE_UI && (
            <section className="panel section-gap">
            <div className="row">
              <button className="btn" aria-expanded={advOpen} onClick={() => setAdvOpen((o) => !o)}>
                {advOpen ? "收起过程回放与组视角（高级详情）" : "展开过程回放与组视角（高级详情）"}
              </button>
              <span className="review-table-note">
                选中方案的完整时间线、示意图与分组数据在展开后才会加载；日常查看路线请回到首页“出行建议”。
              </span>
            </div>
            {advOpen && (
              <div className="section-gap">
                {!selectedPlan && <p className="dim">点击方案卡“作为查看方案”后，这里显示该方案的散场过程与各组状态。</p>}
                {selectedPlan && selectedResult?.status !== "valid" && (
                  <p className="dim">
                    {planDisplayName(selectedPlan)}：{selectedResult ? `状态 ${selectedResult.status}，无可播放的时间线` : "尚无结果"}。
                  </p>
                )}
                {selectedPlan && selectedResult?.status === "valid" && (
                  <>
                    <p className="panel-desc">
                      正在查看 <b>{planDisplayName(selectedPlan)}</b>（{selectedResult.plan_id} · rev
                      {selectedResult.scenario_revision} · seed {selectedResult.seed}）
                      {outdated && <span className="badge badge-warn">已过期结果</span>}
                    </p>
                    <TimelinePlayer result={selectedResult} />
                    <div className="sandbox-wrap section-gap">
                      <MapPanel
                        scenario={scenarioForView}
                        frame={selectedFrame}
                        plan={selectedPlan}
                        result={selectedResult}
                        selectedGroupId={state.selectedGroupId}
                      />
                      <GroupPanel
                        scenario={scenarioForView}
                        plan={selectedPlan}
                        result={selectedResult}
                        frame={selectedFrame}
                      />
                    </div>
                  </>
                )}
              </div>
            )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
