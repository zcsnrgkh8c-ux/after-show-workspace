/**
 * 首页地图体验（固定交付接口，窗口2）：
 * - 组合既有 AmapView / Sandbox / TimelinePlayer，不另写地图引擎；
 * - 读取现有 store/useViewingBundle，按当前所选方案、需求组、回放状态取数；
 * - selectedRouteId 为单向展示输入（窗口1点击路线 → App 传入）：仅该路线加粗，其余淡化；
 * - 无结果/过期/无可行路线时展示场地示意与准确状态，不把旧路线、旧指标当有效建议；
 * - 本组件只做展示与局部状态：不发业务请求、不改 revision、不写 Scenario/Plan。
 */
import React, { useEffect, useMemo, useState } from "react";
import { useActions, useApp, useViewingBundle } from "../../state/store";
import TimelinePlayer, { frameAt } from "../../components/TimelinePlayer";
import AmapView from "../../map/AmapView";
import Sandbox, { type SandboxPick } from "../../components/Sandbox";
import { getMapConfig } from "../../map/config";
import { nodeDisplayName } from "../../labels";
import { mapExperienceStatus, mapServeView, planRoutesForMap, playableTimeline } from "./experience";
import { SIMPLE_UI } from "../shell/clientMode";
import styles from "./mapExperience.module.css";

export interface MapExperienceProps {
  selectedRouteId: string | null;
}

const KIND_LABELS = { source: "场馆", exit: "出口", stop: "接驳点" } as const;

export default function MapExperience({ selectedRouteId }: MapExperienceProps) {
  const { state } = useApp();
  const { setPlaying } = useActions();
  const { inReplay, bundle, outdated, scenarioForView } = useViewingBundle();

  const config = useMemo(() => getMapConfig(scenarioForView), [scenarioForView]);
  const [mode, setMode] = useState<"map" | "schematic">(() => (config.ok ? "map" : "schematic"));
  const [processOpen, setProcessOpen] = useState(false);
  const [pick, setPick] = useState<SandboxPick | null>(null);

  const selectedPlan = bundle?.plans.find((p) => p.plan_id === state.selectedPlanId) ?? null;
  const selectedResult =
    selectedPlan && bundle ? bundle.results.find((r) => r.plan_id === selectedPlan.plan_id) ?? null : null;
  const groupId = state.selectedGroupId;

  const status = useMemo(
    () => mapExperienceStatus({ bundle, outdated, inReplay, health: state.health }),
    [bundle, outdated, inReplay, state.health]
  );
  const serve = useMemo(
    () => mapServeView(scenarioForView, selectedPlan, selectedResult, groupId),
    [scenarioForView, selectedPlan, selectedResult, groupId]
  );

  // 路线高亮是单向输入：仅当路线存在于当前场景时生效，否则回落到组视角高亮
  const effectiveRouteId =
    selectedRouteId !== null && scenarioForView.routes.some((r) => r.route_id === selectedRouteId)
      ? selectedRouteId
      : null;

  // 过期 / 无结果 / 当前需求无可行路线：不把方案画成有效路线（基础场地仍如实展示）
  const planForMap = planRoutesForMap(status, serve, selectedPlan);

  const playable = playableTimeline(selectedResult) && status.kind === "ready";
  // 播放帧仅在“查看散场过程”展开时联动地图；折叠时地图只显示路线，不带时刻数据
  const frame = processOpen && playable && selectedResult ? frameAt(selectedResult, state.playT) : null;

  // 折叠/卸载时暂停：同一时刻只保留一个实际播放计时器，避免隐藏播放器推进全局 playT
  useEffect(() => {
    if (!processOpen) setPlaying(false);
  }, [processOpen, setPlaying]);
  useEffect(() => {
    return () => setPlaying(false);
  }, [setPlaying]);

  const pickedEdge = pick?.kind === "edge" ? scenarioForView.edges.find((e) => e.edge_id === pick.id) ?? null : null;
  const pickedNode = pick?.kind === "node" ? scenarioForView.nodes.find((n) => n.node_id === pick.id) ?? null : null;
  const nodeById = new Map(scenarioForView.nodes.map((n) => [n.node_id, n]));

  return (
    <div className={styles.card}>
      <div className={styles.toolbar}>
        <span className={styles.title}>路线地图</span>
        <span className={styles.spacer} />
        {/* 地图/示意图切换是故障退路：任何模式下都必须可达，不能只在开发界面显示 */}
        <span className={styles.switch} role="group" aria-label="地图视图切换">
          <button
            type="button"
            className={mode === "map" ? `${styles.switchBtn} ${styles.switchActive}` : styles.switchBtn}
            onClick={() => setMode("map")}
          >
            地图
          </button>
          <button
            type="button"
            className={mode === "schematic" ? `${styles.switchBtn} ${styles.switchActive}` : styles.switchBtn}
            onClick={() => setMode("schematic")}
          >
            示意图
          </button>
        </span>
      </div>

      {/* 准确状态：过期 / 无结果 / 回放说明 —— 不继续显示旧动态指标或旧路线为有效建议 */}
      {status.kind !== "ready" && <div className={status.kind === "outdated" ? styles.noteWarn : styles.noteDim}>{status.note}</div>}
      {status.kind === "ready" && status.note && <div className={styles.noteDim}>{status.note}</div>}
      {status.kind === "ready" && serve.level === "blocked" && (
        <div className={styles.noteWarn}>
          <b>{serve.title}</b>
          {serve.hint && <span>　{serve.hint}</span>}
        </div>
      )}
      {status.kind === "ready" && serve.level === "ok" && serve.warning && (
        <div className={styles.noteWarnSmall}>{serve.warning}</div>
      )}
      {status.kind === "ready" && serve.level === "unknown" && <div className={styles.noteDim}>{serve.title}</div>}

      <div className={styles.body}>
        {mode === "map" ? (
          <AmapView
            scenario={scenarioForView}
            frame={frame}
            plan={planForMap}
            result={selectedResult}
            selectedGroupId={planForMap ? groupId : null}
            selectedRouteId={planForMap ? effectiveRouteId : null}
            variant="compact"
            onRequestSvg={() => setMode("schematic")}
          />
        ) : (
          <Sandbox
            scenario={scenarioForView}
            frame={frame}
            plan={planForMap}
            selectedGroupId={planForMap ? groupId : null}
            selectedRouteId={planForMap ? effectiveRouteId : null}
            onPick={setPick}
          />
        )}
      </div>

      <div className={styles.noteLine}>
        {SIMPLE_UI
          ? "模拟演示 · 非实时导航；场地坐标未核实。"
          : "模拟演示 · 场地位置未核实 · 非实时导航 —— 聚合模拟数据，不代表真实客流；示意图内点击通道/节点可查看技术详情。"}
      </div>

      {/* 点选详情：容量、边 ID、间隔等技术信息只在这里展示，不平铺在地图主视图 */}
      {pickedEdge && (
        <div className={styles.detailBar}>
          <b className={styles.mono}>{pickedEdge.edge_id}</b>
          <span>
            {nodeDisplayName(nodeById.get(pickedEdge.from)!)} → {nodeDisplayName(nodeById.get(pickedEdge.to)!)} · 通行{" "}
            {pickedEdge.travel_s}s · 能力 {pickedEdge.capacity_per_min}人/min · {pickedEdge.step_free ? "无台阶" : "含台阶"} ·{" "}
            {pickedEdge.closed ? "已关闭" : "开放"}
          </span>
          <span className={styles.spacer} />
          <button type="button" className={styles.closeBtn} onClick={() => setPick(null)}>关闭</button>
        </div>
      )}
      {pickedNode && (
        <div className={styles.detailBar}>
          <b>{nodeDisplayName(pickedNode)}</b>
          <span className={`${styles.mono} ${styles.dim}`}>（{pickedNode.node_id}）</span>
          <span>
            {KIND_LABELS[pickedNode.kind]} · 当前帧排队 {frame?.node_queues[pickedNode.node_id] ?? 0} 人
            {pickedNode.kind === "stop" && pickedNode.boarding_gap_s !== undefined
              ? ` · 站点发车间隔 ${pickedNode.boarding_gap_s}s`
              : ""}
          </span>
          <span className={styles.spacer} />
          <button type="button" className={styles.closeBtn} onClick={() => setPick(null)}>关闭</button>
        </div>
      )}

      {/* “查看散场过程”默认折叠；展开后只有一个实际播放器（TimelinePlayer），按返回 timeline 播放 */}
      {playable && (
        <div className={styles.process}>
          <button
            type="button"
            className={styles.processToggle}
            aria-expanded={processOpen}
            onClick={() => setProcessOpen((o) => !o)}
          >
            {processOpen ? "收起散场过程" : "查看散场过程"}
            <span className={styles.processSub}>按时刻回放整体与各组人数（模拟聚合数据）</span>
          </button>
          {processOpen && selectedResult && (
            <div className={styles.processBody}>
              <TimelinePlayer result={selectedResult} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
