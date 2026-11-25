/**
 * 用户首页（窗口1交付接口）——围绕“散场后，这一类旅客从哪个出口走、坐哪条接驳？”
 *
 * 页面顺序（同时是移动端阅读顺序）：
 * 当前场景与数据模式 → 出行需求 → 当前安排/受阻原因 → 路线地图 → 必要指标 → 查看依据与调整。
 * 宽屏沿用地图与建议并排（地图约 60%，建议列约 40%）。
 *
 * 地图由窗口4注入 mapSlot；selectedRouteId 仅为展示状态（地图突出），由窗口4在 App 管理。
 * 切需求 / 切路线只改查看视角，不发业务请求；生成按钮复用现有 generateAndCompare 与守卫状态。
 */
import React, { useEffect } from "react";
import type { ReactNode } from "react";
import { useActions, useApp, useViewingBundle } from "../../state/store";
import { needOptionsFromScenario } from "../../labels";
import { IS_DEV_MOCK } from "../../api/config";
import { journeyCardState, journeyContextFor, routeSummaryForCard } from "./display";
import { JourneyNeedChips } from "./JourneyNeedChips";
import { JourneyDetailCard, JourneyMetricsCard, JourneySummaryCard } from "./JourneyAdviceCard";
import "./journey.css";

export interface JourneyPageProps {
  mapSlot: ReactNode;
  selectedRouteId: string | null;
  onSelectRoute: (routeId: string | null) => void;
  onOpenCompare: () => void;
  onOpenDemo: () => void;
  onOpenReplay: () => void;
  /**
   * 可选：窗口4提供的“我的出行”入口。
   * 未传入时不渲染该链接（避免出现点了没反应的死链），旧调用不受影响。
   */
  onOpenTravel?: () => void;
}

export default function JourneyPage(props: JourneyPageProps) {
  const { state } = useApp();
  const { selectGroup, generateAndCompare } = useActions();
  const { inReplay, bundle, outdated, scenarioForView, engineBlocked, engineBlockReason } = useViewingBundle();

  const needOptions = needOptionsFromScenario(scenarioForView);

  // 首次进入尚未选择需求时默认选第一项（仅改查看视角，不发请求）
  useEffect(() => {
    if (state.selectedGroupId === null && needOptions.length > 0) {
      selectGroup(needOptions[0].groupIds[0]);
    }
  }, [state.selectedGroupId, needOptions, selectGroup]);

  // 当前查看的组；selectedGroupId 不在场景时不悄悄替换成其他组
  const group = state.selectedGroupId
    ? scenarioForView.groups.find((g) => g.group_id === state.selectedGroupId) ?? null
    : null;

  const card = journeyCardState(scenarioForView, bundle, state.selectedPlanId, state.selectedGroupId, outdated);

  // 顶部“当前场景与数据模式”：MOCK > 回放 > 实时模拟（不判断结果新鲜度）
  const context = journeyContextFor(scenarioForView, {
    inReplay,
    replayLabel: state.viewing.kind === "replay" ? state.viewing.replay.label : null,
    mock: IS_DEV_MOCK,
  });
  const modeBadgeClass =
    context.tone === "replay"
      ? "journey-badge-replay"
      : context.tone === "mock"
        ? "journey-badge-danger"
        : "";

  // 摘要卡路线速览：与 selectedRouteId 联动（点选哪条显示哪条；未点选为首条，按组级分流表达）
  const routeSummary =
    card.kind === "ready" ? routeSummaryForCard(card.view.routes, props.selectedRouteId) : null;

  // 选择路线回调：移动端（≤900px）选中后滚动到地图，让“在地图中查看”直接看到高亮结果；纯视图行为，不发请求
  const handleSelectRoute = (routeId: string | null) => {
    props.onSelectRoute(routeId);
    if (routeId !== null && typeof window !== "undefined" && window.matchMedia("(max-width: 900px)").matches) {
      requestAnimationFrame(() => {
        document.querySelector(".journey-map-area")?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
  };

  // 需求/方案切换后，若已选路线不属于当前组的路线列表，清除地图突出（仅展示状态回调，不写业务状态）
  const routeIds = card.kind === "ready" ? card.view.routes.map((r) => r.routeId) : [];
  const routeKey = routeIds.join("|");
  useEffect(() => {
    if (props.selectedRouteId !== null && !routeIds.includes(props.selectedRouteId)) {
      props.onSelectRoute(null);
    }
    // routeIds 由 routeKey 代表参与依赖比较
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey, props.selectedRouteId, props.onSelectRoute]);

  return (
    <div className="journey-page">
      <section className="journey-context" aria-label="当前场景与数据模式">
        <span className="journey-context-title">当前场景：{context.sceneTitle}</span>
        <span className={`journey-badge ${modeBadgeClass}`}>{context.modeLabel}</span>
        <span className="journey-dim journey-context-note">{context.modeNote}</span>
      </section>

      <section className="journey-head">
        <h2 className="journey-title">散场后，从哪个出口走？</h2>
        <p className="journey-sub">让离场方案，也考虑需要避台阶和赶末班车的人。</p>
      </section>

      <div className="journey-grid">
        <div className="journey-needs-area" aria-label="选择出行需求">
          <JourneyNeedChips
            options={needOptions}
            groups={scenarioForView.groups}
            selectedGroupId={state.selectedGroupId}
            onSelect={selectGroup}
          />
          <p className="journey-dim journey-scope-note">
            以下查看这一类旅客的群体模拟安排：切换需求只改变查看视角，不会重新计算，也不改场景人数。
          </p>
        </div>

        <JourneySummaryCard
          card={card}
          group={group}
          inReplay={inReplay}
          outdated={outdated}
          busy={state.busyGenerate}
          engineBlocked={engineBlocked}
          engineBlockReason={engineBlockReason}
          onGenerate={() => void generateAndCompare()}
          routeSummary={routeSummary}
          selectedRouteId={props.selectedRouteId}
          onSelectRoute={handleSelectRoute}
          onOpenCompare={props.onOpenCompare}
          onOpenDemo={props.onOpenDemo}
        />

        <div className="journey-map-area" aria-label="路线地图">
          {/* 移动端地图区顶部的返回入口（桌面隐藏）；放在地图上方，滚到地图后立即可见 */}
          {props.selectedRouteId !== null && (
            <button
              type="button"
              className="journey-back-to-advice"
              onClick={() => {
                document.querySelector(".journey-summary")?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
            >
              返回建议 ↑
            </button>
          )}
          {props.mapSlot ?? <div className="journey-map-fallback">地图模块尚未接入</div>}
        </div>

        <JourneyMetricsCard card={card} horizonS={scenarioForView.horizon_s} />

        <JourneyDetailCard
          card={card}
          selectedRouteId={props.selectedRouteId}
          onSelectRoute={handleSelectRoute}
          onOpenCompare={props.onOpenCompare}
          onOpenDemo={props.onOpenDemo}
          onOpenReplay={props.onOpenReplay}
          onOpenTravel={props.onOpenTravel}
        />
      </div>
    </div>
  );
}
