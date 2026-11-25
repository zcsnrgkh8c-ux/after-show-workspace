/**
 * 「我的出行」页面组装（窗口2本轮整理）：
 * - 流程：使用当前位置或手选起点 → 选择终点 → 规划路线 → 查看路线事实与建议；
 *   主操作随当前步骤变化（TravelSteps），授权拒绝/超时/低精度/无坐标候选均有手选回退；
 * - 分层：上方“路线事实”来自高德；下方“出行建议”来自服务端；建议慢/失败不抹去路线；
 * - 地图与输入结果复用现有 useTravelFlow + RouteOverlay，不新增路线缓存、定位请求或 SDK loader；
 * - 与散场推演相互独立：本页地点/路线/建议不写入 Scenario/Plan，不把模拟班次当真实公交。
 *
 * 凭据未配置 → 顶部诚实提示，表单可用、规划禁用并说明原因，绝不画假地图；
 * 凭据就绪 → 加载 JSAPI + 插件并创建地图；失败/超时显示占位提示，输入与结果卡继续可用。
 */
import { useEffect, useRef, useState } from "react";
import { getMapCredentials, isLoadError } from "./vendor/config";
import { loadAmapWithPlugins } from "./vendor/amapLoader";
import type { AMapNamespace } from "./vendor/types";
import { useTravelFlow } from "./app/useTravelFlow";
import { RouteOverlay } from "./geo/routeOverlay";
import { OriginDestForm } from "./ui/OriginDestForm";
import { RouteCard } from "./ui/RouteCard";
import { TransitCard } from "./ui/TransitCard";
import { AdviceSection } from "./ui/AdviceSection";
import { TravelSteps, type TravelPrimaryAction } from "./ui/TravelSteps";
import { stepForInputs } from "./ui/display";
import "./ui/travel.css";

export interface TravelPageProps {
  /** 可选：返回“散场建议”页（由窗口4接线；不传则不显示返回入口） */
  onBackToJourney?: () => void;
  /** 是否当前可见：切页时组件保持挂载以保留起终点，重新可见时让地图重算尺寸 */
  active?: boolean;
}

type MapState =
  | { kind: "idle" } // 未配置凭据，不加载
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "failed"; message: string };

const REQUIRED_PLUGINS = ["AMap.Geolocation", "AMap.AutoComplete", "AMap.PlaceSearch", "AMap.Walking"];

const MISSING_CREDITS_NOTICE =
  "高德凭据未配置：请在 web/demo-config.js 填写 amapKey（或用 VITE_AMAP_KEY 构建）后刷新，否则无法加载地图与获取真实路线";

export function TravelPage({ onBackToJourney, active = true }: TravelPageProps) {
  const credentials = getMapCredentials();
  const flow = useTravelFlow({
    planBlockedReason: credentials === null ? "高德凭据未配置，无法规划真实路线" : null,
  });

  const [mapState, setMapState] = useState<MapState>(() =>
    credentials === null ? { kind: "idle" } : { kind: "loading" },
  );
  const mapDivRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<InstanceType<AMapNamespace["Map"]> | null>(null);
  const overlayRef = useRef<RouteOverlay | null>(null);
  const resultColRef = useRef<HTMLDivElement | null>(null);

  // 地图生命周期：仅在凭据就绪时加载一次
  useEffect(() => {
    if (credentials === null) return;
    let cancelled = false;
    setMapState({ kind: "loading" });
    loadAmapWithPlugins(REQUIRED_PLUGINS)
      .then((AMap) => {
        if (cancelled || mapDivRef.current === null) return;
        const map = new AMap.Map(mapDivRef.current, {
          zoom: 11,
          viewMode: "2D",
        });
        mapRef.current = map;
        overlayRef.current = new RouteOverlay(map, AMap);
        setMapState({ kind: "ready" });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = isLoadError(err)
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
        setMapState({
          kind: "failed",
          message: `地图加载失败，可继续使用输入与结果卡（${message}）`,
        });
      });
    return () => {
      cancelled = true;
      overlayRef.current?.destroy();
      overlayRef.current = null;
      const map = mapRef.current;
      mapRef.current = null;
      try {
        map?.destroy?.();
      } catch {
        // 地图实例销毁失败不阻塞卸载
      }
    };
    // credentials 由环境变量决定，稳定；仅挂载/卸载执行
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 切页返回时容器尺寸从 0 恢复：显式重算地图尺寸，避免瓦片与覆盖物错位
  useEffect(() => {
    if (!active || mapState.kind !== "ready") return;
    const map = mapRef.current as
      | (InstanceType<AMapNamespace["Map"]> & { resize?: () => void })
      | null;
    try {
      map?.resize?.();
    } catch {
      // 地图实例不可用时忽略
    }
  }, [active, mapState.kind]);

  // 路线结果/选中路线变化 → 覆盖物重绘（步行与公交共用同一 overlay）
  useEffect(() => {
    const overlay = overlayRef.current;
    if (overlay === null) return;
    const result = flow.travelMode === "walking" ? flow.routeResult : flow.transitResult;
    if (result === null || result.status !== "ok") {
      overlay.clear();
      return;
    }
    overlay.render(result.routes, flow.selectedRouteId);
  }, [flow.travelMode, flow.routeResult, flow.transitResult, flow.selectedRouteId, mapState]);

  // 地图聚焦信号 → setZoomAndCenter
  useEffect(() => {
    const map = mapRef.current;
    if (map === null || flow.mapFocus === null) return;
    try {
      map.setZoomAndCenter(15, [flow.mapFocus.lng, flow.mapFocus.lat]);
    } catch {
      // 地图未就绪时忽略
    }
  }, [flow.mapFocus, mapState]);

  const showMapPlaceholder = mapState.kind !== "ready";
  const placeholderWarn = mapState.kind === "failed" || mapState.kind === "idle";
  const placeholderText =
    mapState.kind === "idle"
      ? "未加载地图（高德凭据未配置），可继续使用输入与结果卡"
      : mapState.kind === "loading"
        ? "地图加载中…"
        : mapState.kind === "failed"
          ? mapState.message
          : "";

  /* ---------- 步骤与主操作（随当前步骤变化，同一时刻只有一个主操作） ---------- */

  const isWalking = flow.travelMode === "walking";
  const activeResult = isWalking ? flow.routeResult : flow.transitResult;

  const step = stepForInputs({
    hasOrigin: flow.confirmedOrigin !== null,
    hasDestination: flow.confirmedDestination !== null,
    hasRouteResult: activeResult !== null,
  });

  const focusField = (id: "travel-origin" | "travel-dest") => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el === null) return;
    el.focus();
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const scrollToResults = () => {
    resultColRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const routeOk = activeResult !== null && activeResult.status === "ok";
  const candidateCount = routeOk && activeResult !== null ? activeResult.routes.length : null;
  const drawn =
    routeOk && activeResult !== null
      ? activeResult.routes.filter((r) => Array.isArray(r.polyline) && r.polyline.length >= 2).length
      : 0;

  let action: TravelPrimaryAction;
  let secondary: { label: string; onClick: () => void } | null = null;

  if (flow.planning) {
    action = {
      label: "规划中…",
      busy: true,
      busyLabel: "规划中…",
      onClick: () => undefined,
      hint: isWalking
        ? "正在请求高德步行路线；路线事实返回后才会请求服务端建议。"
        : "正在请求高德公交/地铁方案；返回后只展示路线事实，不请求服务端建议。",
    };
  } else if (step === "origin") {
    const locating = flow.locate.kind === "locating";
    action = {
      label: "使用当前位置",
      onClick: flow.onLocate,
      busy: locating,
      busyLabel: "定位中…",
      hint: "也可直接在下方输入起点；定位被拒绝、超时或精度较低时可随时手动选择。",
    };
    secondary = { label: "手动输入起点", onClick: () => focusField("travel-origin") };
  } else if (step === "destination") {
    action = {
      label: "输入并选择终点",
      onClick: () => focusField("travel-dest"),
      hint: `起点已确认：${flow.confirmedOrigin?.label ?? ""}；请输入终点并从候选点选中（无坐标候选不可选）。`,
    };
    secondary = { label: "重新定位起点", onClick: flow.onLocate };
  } else if (step === "plan") {
    action = {
      label: isWalking ? "规划步行路线" : "规划公交路线",
      onClick: flow.planRoutes,
      disabled: !flow.canPlan,
      hint:
        flow.planDisabledReason ??
        (isWalking
          ? "将请求高德步行规划；路线返回后先显示路线事实，再请求服务端建议。"
          : "将请求高德公交/地铁规划；“少换乘/少步行”会作为高德策略传入；只展示真实路线与换乘，不请求服务端建议。"),
    };
    secondary = { label: "调整起终点", onClick: () => focusField("travel-origin") };
  } else if (routeOk) {
    action = {
      label: "查看路线结果",
      onClick: scrollToResults,
      hint: `共 ${candidateCount ?? 0} 条高德候选；点选候选会在上方地图高亮。`,
    };
    secondary = { label: "重新规划", onClick: flow.planRoutes };
  } else {
    action = {
      label: "重新规划",
      onClick: flow.planRoutes,
      disabled: !flow.canPlan,
      hint: "上次未获取到路线；可修改起终点或偏好后重试，路线失败不会显示估算距离。",
    };
    secondary = { label: "调整起终点", onClick: () => focusField("travel-origin") };
  }

  return (
    <div className="travel-page">
      <div className="travel-page-head">
        <div className="travel-page-heading">
          <h2 className="travel-title">我的出行</h2>
          <p className="travel-subtitle">真实地点步行 / 公交路线 · 与“散场建议”相互独立</p>
        </div>
        {onBackToJourney !== undefined && (
          <button type="button" className="travel-back-btn" onClick={onBackToJourney}>
            ← 返回散场建议
          </button>
        )}
      </div>

      <div className="travel-boundary" role="note">
        <b>真实地点出行</b>：定位、地点候选与步行/公交路线来自高德；出行建议来自服务端（仅步行方案）。
        本页的地点、路线与建议不会写入散场推演的 Scenario / Plan，也不把模拟接驳班次当作真实公交。
      </div>

      {credentials === null && (
        <p className="travel-notice" role="alert">
          {MISSING_CREDITS_NOTICE}
        </p>
      )}

      {/* 已确认起终点摘要（只用确认后的真实地点） */}
      <p className="travel-confirmed" aria-label="已确认起终点">
        {flow.confirmedOrigin === null && flow.confirmedDestination === null
          ? "尚未确认起终点"
          : `起点：${flow.confirmedOrigin?.label ?? "未确认"} → 终点：${flow.confirmedDestination?.label ?? "未确认"}`}
      </p>

      <div className="travel-layout">
        <div className="travel-form-col">
          <div className="travel-mode-switch" role="group" aria-label="出行方式">
            <button
              type="button"
              aria-pressed={isWalking}
              className={`travel-mode-btn${isWalking ? " travel-mode-btn--active" : ""}`}
              onClick={() => flow.setTravelMode("walking")}
            >
              步行
            </button>
            <button
              type="button"
              aria-pressed={!isWalking}
              className={`travel-mode-btn${!isWalking ? " travel-mode-btn--active" : ""}`}
              onClick={() => flow.setTravelMode("transit")}
            >
              公交 / 地铁
            </button>
          </div>

          <OriginDestForm
            originDraft={flow.originDraft}
            destDraft={flow.destDraft}
            originSuggestions={flow.originSuggestions}
            destSuggestions={flow.destSuggestions}
            originSearching={flow.originSearching}
            destSearching={flow.destSearching}
            originSearchError={flow.originSearchError}
            destSearchError={flow.destSearchError}
            locate={flow.locate}
            preference={flow.preference}
            canPlan={flow.canPlan}
            planning={flow.planning}
            planDisabledReason={flow.planDisabledReason}
            originPlace={flow.confirmedOrigin}
            destPlace={flow.confirmedDestination}
            showPlanButton={false}
            travelMode={flow.travelMode}
            onOriginChange={flow.handleOriginChange}
            onDestChange={flow.handleDestChange}
            onPickOrigin={flow.pickOrigin}
            onPickDest={flow.pickDest}
            onLocate={flow.onLocate}
            onSwap={flow.onSwap}
            onClearOrigin={flow.onClearOrigin}
            onClearDest={flow.onClearDest}
            onPlan={flow.planRoutes}
            onPreferenceChange={flow.updatePreference}
          />

          <TravelSteps step={step} action={action} secondary={secondary} mode={flow.travelMode} />
        </div>

        <div className="travel-map-col">
          <div className="travel-map">
            <div ref={mapDivRef} className="travel-map-canvas" aria-label="路线地图" />
            {showMapPlaceholder && (
              <div
                className={`travel-map-placeholder${placeholderWarn ? " travel-map-placeholder--warn" : ""}`}
                role="note"
              >
                {placeholderText}
              </div>
            )}
          </div>
          <p className="travel-map-caption">
            地图与路线来源：高德地图 JS API 2.0 · 坐标 GCJ-02
            {candidateCount !== null && candidateCount > 0
              ? ` · 已绘制 ${drawn}/${candidateCount} 条返回折线`
              : ""}
            {" · "}仅展示路线，不含实时路况或导航
          </p>
          <p className="travel-map-caption travel-map-caption--dim">
            路线折线来自{isWalking ? "高德步行规划" : "高德公交/地铁规划"}；未返回折线的候选不绘制，不用直线替代。
          </p>
        </div>

        <div className="travel-result-col" ref={resultColRef}>
          {isWalking ? (
            <>
              <RouteCard
                result={flow.routeResult}
                planning={flow.planning}
                selectedRouteId={flow.selectedRouteId}
                onSelectRoute={flow.selectRoute}
              />

              {flow.routeResult !== null && (
                <AdviceSection
                  advice={flow.advice}
                  advising={flow.advising}
                  adviceError={flow.adviceError}
                  adviceWarning={flow.adviceWarning}
                  stepFreeWarning={flow.stepFreeWarning}
                  routeLabel={flow.routeLabel}
                  candidateCount={candidateCount}
                />
              )}
            </>
          ) : (
            <>
              <TransitCard
                result={flow.transitResult}
                planning={flow.planning}
                selectedRouteId={flow.selectedRouteId}
                onSelectRoute={flow.selectRoute}
              />
              {flow.transitResult !== null && flow.transitResult.status === "ok" && (
                <p className="travel-transit-note" role="note">
                  公交/地铁方案暂不提供服务端出行建议：现有建议契约只覆盖步行，不把规则或模型结论套到公交方案上。
                </p>
              )}
            </>
          )}
        </div>
      </div>

      <details className="travel-sources">
        <summary>数据来源与能力边界</summary>
        <ul>
          <li>
            <b>定位</b>：优先浏览器定位（navigator.geolocation 单次定位，WGS-84 已转 GCJ-02，显示返回精度）；
            失败后尝试高德定位，IP 近似会明确标注“非精确 GPS”，不会当成精确定位。
          </li>
          <li>
            <b>地点候选</b>：高德 AutoComplete；无坐标候选不可选，需改选其他候选或手动输入。
          </li>
          <li>
            <b>路线事实</b>：高德 Walking / Transfer 返回的距离、预计耗时、步骤或换乘与折线；预计时间为高德服务估算，
            非实际用时，也不代表个人行程保证。
          </li>
          <li>
            <b>公交 / 地铁</b>：仅展示高德返回的线路、换乘次数、步行距离与时间；不含实时到站、票价保证与无障碍电梯核实，
            也不提供服务端出行建议。
          </li>
          <li>
            <b>出行建议</b>：服务端出行建议接口；模式以本次响应 mode 为准（rules=基础规则，
            llm=模型分析，unavailable=未生成）。服务端配置存在不等于模型调用成功。
          </li>
          <li>
            <b>无台阶</b>：高德步行规划未提供该字段时一律显示“尚未核实”，不代表无障碍可达，
            也不自动解释为无台阶路线；本页不含室内图与店铺门口可达性数据。
          </li>
          <li>
            <b>未提供</b>：室内导航、实时路况与导航、同行会合；公交方案的无台阶/电梯与实时到站信息未核实。
          </li>
          <li>
            <b>与推演的关系</b>：本页真实经纬度、路线距离/耗时与建议不会写入散场推演的 Scenario / Plan；
            散场建议仍使用独立的 0~100 示意场景与模拟结果。
          </li>
        </ul>
      </details>
    </div>
  );
}
