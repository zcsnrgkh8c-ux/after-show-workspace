import React, { useEffect, useState } from "react";
import { useActions, useViewingBundle } from "./state/store";
import MoreMenu from "./features/shell/MoreMenu";
import StatusBanners from "./features/shell/StatusBanners";
import { useSelectedRoute } from "./features/shell/useSelectedRoute";
import { pageTitle, surfaceScope } from "./features/shell/scopes";
import { SIMPLE_UI } from "./features/shell/clientMode";
// 三窗口整合接线（见 features/shell/HANDOFF.md §0/§9）：
// 窗口1 features/journey/JourneyPage（mapSlot=窗口2 MapExperience）；窗口3 ScenarioPage / ComparePage / ReplayPage；
// 窗口2 本轮 features/travel/TravelPage（可选 onBackToJourney）。
import JourneyPage from "./features/journey/JourneyPage";
import MapExperience from "./features/map/MapExperience";
import ComparePage from "./pages/ComparePage";
import ScenarioPage from "./pages/ScenarioPage";
import ReplayPage from "./pages/ReplayPage";
import { TravelPage } from "./features/travel/TravelPage";

type Tab = "journey" | "travel" | "compare" | "demo" | "replay";

/**
 * 应用外壳（窗口4）：
 * 主导航 = 散场建议（默认）/ 我的出行 / 方案依据·对比；更多 = 情境调整 / 已保存结果 / 数据说明。
 * 来源标识按页面作用域区分：群体推演页“模拟演示”，真实出行页“高德路线 · 真实地图”；
 * 散场过期/回放/引擎与错误只在群体推演页显示（见 features/shell/scopes.ts）。
 * 页面切换是纯视图操作：不改场景、不触发 generate/compare、不改 revision、不清回放。
 */
export default function App() {
  const { checkHealth } = useActions();
  const [tab, setTab] = useState<Tab>("journey");
  /** 首次进入“我的出行”后才挂载，之后切页保持挂载：起终点与路线不被清空 */
  const [travelMounted, setTravelMounted] = useState(false);
  const { selectedRouteId, onSelectRoute } = useSelectedRoute();
  const { inReplay } = useViewingBundle();

  const scope = surfaceScope(tab);
  const isTravel = scope === "travel";

  useEffect(() => {
    void checkHealth();
  }, [checkHealth]);

  useEffect(() => {
    document.title = pageTitle(tab);
  }, [tab]);

  useEffect(() => {
    if (tab === "travel") setTravelMounted(true);
  }, [tab]);

  const openDataNote = () => {
    document.getElementById("shell-data-note")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="app shell-app">
      <header className="shell-header">
        <div className="shell-brand">
          <div className="shell-brand-row">
            <span className="shell-logo" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 19 19 5" />
                <path d="M10 5h9v9" />
              </svg>
            </span>
            <h1>散场之后</h1>
            {isTravel ? (
              <span className="shell-demo-tag shell-tag-live">高德路线 · 真实地图</span>
            ) : (
              <span className="shell-demo-tag">模拟演示</span>
            )}
            {inReplay && !isTravel && <span className="badge badge-replay">已保存结果 · 非本次计算</span>}
          </div>
          <p className="shell-brand-sub">让离场方案，也考虑需要避台阶和赶末班车的人。</p>
        </div>

        <nav className="shell-nav" aria-label="主导航">
          <button className={`shell-nav-btn ${tab === "journey" ? "active" : ""}`} onClick={() => setTab("journey")}>
            散场建议
          </button>
          <button className={`shell-nav-btn ${tab === "travel" ? "active" : ""}`} onClick={() => setTab("travel")}>
            我的出行
          </button>
          <button className={`shell-nav-btn ${tab === "compare" ? "active" : ""}`} onClick={() => setTab("compare")}>
            方案依据·对比
          </button>
          {/* 回放是评委可随时查看的兜底入口：常驻主导航，不依赖断线横幅或折叠菜单 */}
          <button
            className={`shell-nav-btn ${tab === "replay" ? "active" : ""}`}
            title="查看已保存结果（离线可用）"
            aria-label="回放已保存结果"
            onClick={() => setTab("replay")}
          >
            回放
          </button>
          {!SIMPLE_UI && (
            <MoreMenu
              active={tab === "demo"}
              onOpenDemo={() => setTab("demo")}
              onOpenReplay={() => setTab("replay")}
              onOpenDataNote={openDataNote}
            />
          )}
        </nav>
      </header>

      <StatusBanners scope={scope} onOpenReplay={() => setTab("replay")} />

      <main className="app-main">
        {tab === "journey" && (
          <JourneyPage
            mapSlot={<MapExperience selectedRouteId={selectedRouteId} />}
            selectedRouteId={selectedRouteId}
            onSelectRoute={onSelectRoute}
            onOpenCompare={() => setTab("compare")}
            onOpenDemo={() => setTab("demo")}
            onOpenReplay={() => setTab("replay")}
            onOpenTravel={() => setTab("travel")}
          />
        )}
        {/* 保持挂载而非条件卸载：去对比页再回来时起点/终点/路线仍在 */}
        {travelMounted && (
          <div hidden={tab !== "travel"}>
            <TravelPage active={tab === "travel"} onBackToJourney={() => setTab("journey")} />
          </div>
        )}
        {tab === "compare" && <ComparePage onViewJourney={() => setTab("journey")} />}
        {tab === "demo" && <ScenarioPage />}
        {tab === "replay" && <ReplayPage />}
      </main>

      <footer id="shell-data-note" className="shell-footer">
        {SIMPLE_UI ? (
          <p className="dim">
            {isTravel
              ? "真实地图与路线来自高德；建议由服务端给出。"
              : "本页为模拟演示，非实时导航；结果来自服务端仿真。"}
          </p>
        ) : isTravel ? (
          <details>
            <summary>数据说明（我的出行）</summary>
            <p>
              本页接入<b>真实高德地图</b>：地点来自高德 POI 检索，步行路线来自高德 Walking 的真实返回，
              距离与耗时为高德估算，不是实测步行时间，也不代表已到店门口。定位精度按实际来源标注
              （浏览器定位 / IP 近似）；未获得精确坐标时不冒充精准定位，也没有真机与公网 HTTPS 定位验收。
              出行建议由服务端给出：规则模式显示“基础路线建议”，只有真实返回 mode=llm 才显示模型分析；
              模型配置存在不等于模型已执行。展示坐标与路线<b>不进入</b>散场群体推演的 0~100 示意场景。
            </p>
          </details>
        ) : (
          <details>
            <summary>数据说明（散场建议）</summary>
            <p>
              本页为模拟演示：示意图为 0~100 示意坐标，不代表经纬度或真实地理；全部输入为合成场景（demand_source=synthetic）；
              指标仅来自服务端真实仿真，前端不另行计算；“无台阶”仅表示模型中的台阶约束，不等于已验证的现实无障碍条件；
              组级模拟结果不代表个人行程时间或实时导航；缓存回放与实时运行严格区分。
              运行详情（服务状态 / 工具轨迹 / 请求日志）见“更多 → 已保存结果”。
            </p>
          </details>
        )}
      </footer>
    </div>
  );
}
