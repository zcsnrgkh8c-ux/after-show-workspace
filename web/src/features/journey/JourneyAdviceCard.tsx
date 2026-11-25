/**
 * 首页建议区（窗口1局部实现，journey- 前缀），拆成三段以适配任务阅读顺序：
 * - JourneySummaryCard（当前安排）：需求组、方案名与推荐标记、受阻/限度状态、主操作；
 * - JourneyMetricsCard（必要指标）：该需求组的组级模拟结果与口径说明；
 * - JourneyDetailCard（依据与调整）：同类旅客分流路线与通行条件、推荐理由、次级入口。
 * 事实边界：分流份额是组级安排不是个人分配；null 指标显示“—”；
 * 受阻（无可用路线 / 通道限制 / 校验失败）显眼展示并给真实下一步入口，
 * 不把剩余人数一律说成断路，也不提供“一键解决”。
 */
import React from "react";
import type { ScenarioGroup } from "../../contract/types";
import { fmtClock, groupDisplayName, type GroupKeyMetrics } from "../../labels";
import { formatWaitSeconds, type JourneyCardState, type ReadyView } from "./display";
import { SIMPLE_UI } from "../shell/clientMode";

/* ================= 当前安排 ================= */

export interface JourneySummaryCardProps {
  card: JourneyCardState;
  group: ScenarioGroup | null;
  inReplay: boolean;
  outdated: boolean;
  busy: boolean;
  engineBlocked: boolean;
  engineBlockReason?: string;
  onGenerate: () => void;
  /** 摘要卡路线速览（可选；与 selectedRouteId 联动，isSelected 表示正显示用户点选的路线） */
  routeSummary?: { routeId: string; sequenceText: string; total: number; isSelected: boolean } | null;
  selectedRouteId?: string | null;
  onSelectRoute?: (routeId: string | null) => void;
  /** 受阻时的真实下一步入口（窗口4回调；未提供则不渲染死链） */
  onOpenCompare?: () => void;
  onOpenDemo?: () => void;
}

export function JourneySummaryCard(props: JourneySummaryCardProps) {
  const { card, group, inReplay, outdated, busy, engineBlocked, engineBlockReason } = props;
  const hasResult = card.kind === "ready";
  // 有有效结果但结果无效/受阻时，“重新计算”不是解决方案，保持次级操作；主入口见受阻块
  const primaryLabel = busy
    ? "正在计算…"
    : outdated
      ? "更新建议"
      : card.kind === "no_candidates" || hasResult
        ? "重新计算"
        : "生成出行建议";
  const disabled = busy || inReplay || engineBlocked;
  const disabledNote = inReplay
    ? "正在查看已保存结果，退出回放后可重新计算"
    : engineBlocked
      ? engineBlockReason ?? "服务暂不可用，无法生成新建议"
      : null;

  // 只在路线真实可用（未受阻）时把“在地图中查看”作为主操作
  const showRouteQuick =
    card.kind === "ready" && props.routeSummary !== undefined && props.routeSummary !== null &&
    card.view.serve?.level !== "blocked";

  return (
    <section className="journey-card journey-summary" aria-label="当前安排">
      <div className="journey-summary-head">
        <h3 className="journey-card-title">当前安排</h3>
        {inReplay && <span className="journey-badge journey-badge-replay">已保存结果 · 非本次计算</span>}
        {outdated && <span className="journey-badge journey-badge-warn">情况已变化</span>}
      </div>

      {group ? (
        <p className="journey-group-line">
          所选需求：<b>{groupDisplayName(group)}（{group.count} 人）</b>
          {group.needs_step_free && <span className="journey-badge journey-badge-warn">需避开台阶</span>}
          {group.board_deadline_s !== null && (
            <span className="journey-badge journey-badge-warn">须在模拟第 {fmtClock(group.board_deadline_s)} 前登车</span>
          )}
        </p>
      ) : (
        <p className="journey-dim journey-group-line">请先在上方选择出行需求。</p>
      )}

      {card.kind === "no_bundle" && (
        <div className="journey-empty">
          <p className="journey-empty-lead">还没有计算过这一类旅客的接驳安排。</p>
          <p className="journey-dim journey-empty-note">
            点击下方“生成出行建议”，系统会按当前场馆与接驳安排计算多种方案并给出推荐；结果为模拟推演，不是实时导航。
          </p>
        </div>
      )}

      {card.kind === "no_candidates" && (
        <div className="journey-empty">
          <p className="journey-empty-lead">本轮未生成任何候选方案</p>
          <p className="journey-dim journey-empty-note">
            服务端未返回可行安排（这不等于数学上无解）。可调整演示情境后重试。
          </p>
          {props.onOpenDemo && (
            <div className="journey-next">
              <button type="button" className="journey-next-btn" onClick={props.onOpenDemo}>
                调整演示情境
              </button>
            </div>
          )}
        </div>
      )}

      {card.kind === "group_missing" && (
        <p className="journey-dim journey-empty-note">当前所选需求组不在场景中，请重新选择。</p>
      )}

      {card.kind === "plan_missing" && (
        <div className="journey-empty">
          <p className="journey-empty-lead">当前未选中有效方案</p>
          <p className="journey-dim journey-empty-note">可查看其他候选方案，或重新计算。</p>
          {props.onOpenCompare && (
            <div className="journey-next">
              <button type="button" className="journey-next-btn" onClick={props.onOpenCompare}>
                查看方案依据·对比
              </button>
            </div>
          )}
        </div>
      )}

      {card.kind === "outdated" && (
        <div className="journey-outdated" role="alert">
          <b>情况已变化，原建议已过期</b>
          <p className="journey-outdated-note">
            场景、随机种子或优化目标已修改：当前为 rev{card.currentRevision}，已有结果对应旧版本 rev
            {card.bundleRevision}。旧方案与指标不再与当前场地对应，已停止展示；请更新建议后查看最新安排。
          </p>
        </div>
      )}

      {/* 路线速览 = 有效且未受阻时的主操作（先回答“从哪走”，移动端先于统计）；与 selectedRouteId 联动 */}
      {showRouteQuick && props.routeSummary && (
        <div className="journey-route-quick">
          <div className="journey-route-quick-main">
            <span className="journey-route-quick-seq">{props.routeSummary.sequenceText}</span>
            {props.routeSummary.isSelected ? (
              <span className="journey-badge journey-badge-ok">当前查看</span>
            ) : props.routeSummary.total > 1 ? (
              <span className="journey-dim journey-route-quick-note">
                该组共 {props.routeSummary.total} 条分流路线（组级安排，详见下方明细）
              </span>
            ) : null}
          </div>
          {props.onSelectRoute && (
            <button
              type="button"
              className="journey-route-quick-btn"
              aria-pressed={props.routeSummary.isSelected}
              onClick={() =>
                props.onSelectRoute?.(props.routeSummary!.isSelected ? null : props.routeSummary!.routeId)
              }
            >
              {props.routeSummary.isSelected ? "取消查看" : "在地图中查看"}
            </button>
          )}
        </div>
      )}

      {card.kind === "ready" && (
        <ReadySummary view={card.view} onOpenCompare={props.onOpenCompare} onOpenDemo={props.onOpenDemo} />
      )}

      <div className="journey-actions">
        <button
          type="button"
          className={card.kind === "ready" ? "journey-btn-secondary" : "journey-btn-primary"}
          disabled={disabled}
          title={disabledNote ?? undefined}
          onClick={props.onGenerate}
        >
          {primaryLabel}
        </button>
        {card.kind === "ready" && !busy && !disabledNote && (
          <span className="journey-dim journey-action-note">如场馆安排有变化，可重新计算。</span>
        )}
        {busy && <span className="journey-dim journey-action-note">正在调用生成与比较，请稍候…</span>}
        {!busy && disabledNote && <span className="journey-dim journey-action-note">{disabledNote}</span>}
      </div>
    </section>
  );
}

function ReadySummary({
  view,
  onOpenCompare,
  onOpenDemo,
}: {
  view: ReadyView;
  onOpenCompare?: () => void;
  onOpenDemo?: () => void;
}) {
  return (
    <>
      <div className="journey-plan-line">
        <b className="journey-plan-name">{view.planName}</b>
        {view.isRecommended && <span className="journey-badge journey-badge-ok">系统当前推荐</span>}
        {view.recTradeoff && <span className="journey-badge journey-badge-warn">存在取舍</span>}
        <span className="journey-dim journey-plan-status">
          {view.resultStatus === "valid"
            ? "推演已完成"
            : view.resultStatus === "invalid"
              ? "未通过校验"
              : view.resultStatus === "error"
                ? "推演失败"
                : "暂无模拟结果"}
        </span>
      </div>

      {view.recNoValid && (
        <p className="journey-dim journey-rec-none">
          服务端本轮未给出可用推荐；以下为其中一个候选方案的情况，可调整演示情境后重新计算。
        </p>
      )}

      {view.recPlanName !== null && (
        <p className="journey-dim journey-rec-none">
          系统当前推荐的是「{view.recPlanName}」；以下为当前查看方案的情况，可在方案依据·对比中切换查看。
        </p>
      )}

      {view.serve?.level === "blocked" && (
        <div className="journey-serve journey-serve-blocked" role="alert">
          <b>{view.serve.text}</b>
          {view.serve.hint && <p className="journey-serve-note">{view.serve.hint}</p>}
          {(onOpenCompare || onOpenDemo) && (
            <div className="journey-next">
              {onOpenCompare && (
                <button type="button" className="journey-next-btn" onClick={onOpenCompare}>
                  查看其他方案
                </button>
              )}
              {onOpenDemo && !SIMPLE_UI && (
                <button type="button" className="journey-next-btn" onClick={onOpenDemo}>
                  调整演示情境
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {view.serve?.level === "ok" && (
        <div className="journey-serve journey-serve-ok">
          <b>{view.serve.text}</b>
          {/* 路线可达与按时登车分开表达：截止逾期风险升级为下方黄色主提示，这里不再重复 */}
          {view.serve.warning &&
            !(view.metrics && view.metrics.remaining === 0 && (view.metrics.missedDeadline ?? 0) > 0) && (
              <p className="journey-serve-note">{view.serve.warning}</p>
            )}
        </div>
      )}
      {view.serve?.level === "unknown" && (
        <div className="journey-serve journey-serve-unknown">{view.serve.text}</div>
      )}

      {/* 赶末班组存在逾期：风险升为黄色主提示（不改结果与排序，口径与指标一致） */}
      {view.metrics && view.metrics.missedDeadline !== null && view.metrics.missedDeadline > 0 && (
        <div className="journey-serve journey-serve-deadline" role="status">
          <b>有 {view.metrics.missedDeadline} 人未赶在截止前登车</b>
          <p className="journey-serve-note">
            路线可达不等于按时赶上：此为登车时间风险（模拟口径：逾期登车 + 截止仍未登车，见下方“未赶在截止前登车”）。
          </p>
        </div>
      )}
    </>
  );
}

/* ================= 必要指标 ================= */

export interface JourneyMetricsCardProps {
  card: JourneyCardState;
  /** 模拟窗口时长（秒），用于口径说明 */
  horizonS: number;
}

/**
 * 该需求组的必要指标：已登车 / 仍未登车 / 未赶在截止前登车 / 模拟平均排队。
 * 全部来自匹配结果；null 显示“—”，不冒充 0；不把已登车写成“全部按时赶上”。
 */
export function JourneyMetricsCard({ card, horizonS }: JourneyMetricsCardProps) {
  if (card.kind !== "ready" || card.view.metrics === null) return null;
  const m = card.view.metrics;
  const missed = m.missedDeadline;
  return (
    <section className="journey-card journey-metrics-card" aria-label="这一类旅客的模拟结果">
      <h3 className="journey-card-title">这一类旅客的模拟结果</h3>
      <MetricRow metrics={m} />
      <p className="journey-dim journey-metric-note">
        模拟窗口 {horizonS}s 内的组级结果（该组已释放 {m.released === null ? "—" : m.released} 人）；
        平均排队包含仍在等待的旅客，不是个人预计等待时间；
        “未赶在截止前登车”按“逾期登车 + 截止仍未登车”统计。
        {missed !== null && missed > 0 ? "已登车不等于按时赶上截止。" : ""}
        模拟推演不代表真实站点实时情况。
      </p>
    </section>
  );
}

/** 组级关键指标：已登车/该组人数、仍未登车、平均排队；末班组显示错过截止。null 一律“—” */
function MetricRow({ metrics }: { metrics: GroupKeyMetrics }) {
  return (
    <div className="journey-metrics">
      <div className="journey-metric">
        <span className="journey-metric-label">已登车 / 该组人数</span>
        <span className="journey-metric-value">
          {metrics.boarded === null ? "—" : `${metrics.boarded} / ${metrics.total}`}
        </span>
      </div>
      <div className="journey-metric">
        <span className="journey-metric-label">模拟结束仍未登车</span>
        <span
          className={`journey-metric-value ${metrics.remaining !== null && metrics.remaining > 0 ? "journey-metric-bad" : ""}`}
        >
          {metrics.remaining === null ? "—" : metrics.remaining}
        </span>
      </div>
      {metrics.missedDeadline !== null && (
        <div className="journey-metric">
          <span className="journey-metric-label">未赶在截止前登车</span>
          <span className={`journey-metric-value ${metrics.missedDeadline > 0 ? "journey-metric-bad" : ""}`}>
            {metrics.missedDeadline}
          </span>
        </div>
      )}
      <div className="journey-metric">
        <span className="journey-metric-label">模拟平均排队</span>
        <span className="journey-metric-value">
          {metrics.meanWait === null ? "—" : formatWaitSeconds(metrics.meanWait)}
        </span>
      </div>
    </div>
  );
}

/* ================= 依据与调整 ================= */

export interface JourneyDetailCardProps {
  card: JourneyCardState;
  selectedRouteId: string | null;
  onSelectRoute: (routeId: string | null) => void;
  onOpenCompare: () => void;
  onOpenDemo: () => void;
  onOpenReplay: () => void;
  /** 可选：窗口4提供的“我的出行”入口；未提供时不渲染死链 */
  onOpenTravel?: () => void;
}

export function JourneyDetailCard(props: JourneyDetailCardProps) {
  if (props.card.kind !== "ready") return null;
  const { view } = props.card;
  return (
    <section className="journey-card journey-detail" aria-label="路线明细与依据">
      <h3 className="journey-card-title">
        {view.routes.length > 1 ? "同类旅客分流建议" : view.routes.length === 1 ? "建议路线" : "路线安排"}
      </h3>
      {view.routes.length > 1 && (
        <p className="journey-dim journey-route-note">
          同需求的旅客将按比例分流到以下路线；这是组级的整体安排，不代表已给某个个人分配路线或名额。
        </p>
      )}

      {view.routes.length === 0 && (
        <p className="journey-dim journey-route-note">本方案未为该需求安排接驳路线（对应旅客留在场馆等待）。</p>
      )}

      <ul className="journey-route-list">
        {view.routes.map((r) => {
          const selected = props.selectedRouteId === r.routeId;
          return (
            <li key={r.routeId} className={`journey-route ${selected ? "journey-route-selected" : ""}`}>
              <div className="journey-route-info">
                <span className="journey-route-seq">
                  {r.missing ? "该路线信息缺失，无法显示途经位置" : r.sequenceText}
                </span>
                <span className="journey-dim journey-route-meta">
                  {r.sharePct !== null ? `约 ${r.sharePct}% 的该组旅客` : "分流比例缺失"}
                  {r.stepFree === false && <span className="journey-badge journey-badge-warn">含台阶</span>}
                  {r.closed === true && <span className="journey-badge journey-badge-danger">含已关闭通道</span>}
                </span>
              </div>
              {!r.missing && (
                <button
                  type="button"
                  className="journey-route-btn"
                  aria-pressed={selected}
                  onClick={() => props.onSelectRoute(selected ? null : r.routeId)}
                >
                  {selected ? "取消查看" : "查看路线"}
                </button>
              )}
            </li>
          );
        })}
      </ul>

      {view.recReason !== null && (
        <details className="journey-why">
          <summary>为什么推荐这个方案</summary>
          <p>{view.recReason}</p>
          {view.recTradeoffItems.length > 0 && (
            <ul>
              {view.recTradeoffItems.map((t, i) => (
                <li key={i}>{t}</li>
              ))}
            </ul>
          )}
        </details>
      )}

      <div className="journey-links">
        <span className="journey-dim">查看依据与调整</span>
        <button type="button" className="journey-link" onClick={props.onOpenCompare}>
          方案依据·对比
        </button>
        {!SIMPLE_UI && (
          <button type="button" className="journey-link" onClick={props.onOpenDemo}>
            情境调整
          </button>
        )}
        {/* 回放进线是离线兜底入口，不能只在开发界面显示 */}
        <button type="button" className="journey-link" onClick={props.onOpenReplay}>
          已保存结果
        </button>
        {props.onOpenTravel && (
          <button type="button" className="journey-link" onClick={props.onOpenTravel}>
            我的出行
          </button>
        )}
      </div>
    </section>
  );
}
