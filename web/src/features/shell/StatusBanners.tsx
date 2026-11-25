import React from "react";
import { useActions, useApp, useViewingBundle } from "../../state/store";
import { API_BASE_URL, IS_DEV_MOCK } from "../../api/config";
import { bannerVisibility, staleReasonText, type SurfaceScope } from "./scopes";

export interface StatusBannersProps {
  /** 当前业务页面作用域：group=群体推演，travel=真实出行 */
  scope: SurfaceScope;
  /** 跳到“已保存结果”入口（仅群体推演页使用） */
  onOpenReplay: () => void;
}

/**
 * 顶部状态区：每类状态一条短句，技术细节折叠。
 * 覆盖：MOCK 占位、服务断线、引擎未就绪、已保存回放、结果过期、运行错误。
 * **按作用域隔离**：散场过期/回放/引擎未就绪/散场错误只在群体推演页显示，
 * 不套到“我的出行”；共享服务故障在两处都如实提示，但说明受影响的具体能力。
 * 不吞错误：错误横幅保留 area 与原始 message/详情。
 */
export default function StatusBanners({ scope, onOpenReplay }: StatusBannersProps) {
  const { state } = useApp();
  const { checkHealth, dismissError, generateAndCompare, exitReplay } = useActions();
  const { inReplay, outdated } = useViewingBundle();

  const visibility = bannerVisibility(scope, {
    healthDown: state.health.state === "down" && !IS_DEV_MOCK,
    engineDown: state.health.state === "ok" && state.health.engine_ready === false,
    inReplay,
    outdated,
    mock: IS_DEV_MOCK,
  });

  const canUpdate =
    !state.busyGenerate && !inReplay && state.health.state === "ok" && state.health.engine_ready !== false;

  const run = state.run;
  const staleReason =
    run !== null
      ? staleReasonText(
          { scenario_revision: run.scenario_revision, seed: run.seed, objective: run.objective },
          { scenario_revision: state.scenario.revision, seed: state.seed, objective: state.objective }
        )
      : null;

  return (
    <div className="shell-banners">
      {visibility.mock && (
        <div className="shell-banner shell-banner-mock">
          开发 MOCK 占位已启用：散场指标全部来自前端占位数据，<b>非真实引擎计算</b>，仅用于布局/流程校对。
        </div>
      )}

      {visibility.serviceDown && (
        <div className="shell-banner shell-banner-danger">
          {scope === "travel" ? (
            <>
              <b>服务端连接失败</b>：出行建议暂不可用；高德地图与步行路线若已加载，仍可查看路线事实。
              散场推演同样不可用。
            </>
          ) : (
            <>
              <b>暂时无法生成新建议</b>，可重试连接或查看已保存结果。
            </>
          )}
          <details className="shell-banner-detail">
            <summary>技术详情</summary>
            接口 {API_BASE_URL}：{state.health.message ?? "网络错误或服务未启动"}
          </details>
          <button className="btn btn-small" onClick={() => void checkHealth()}>重试连接</button>
          {scope === "group" && (
            <button className="btn btn-small" onClick={onOpenReplay}>查看已保存结果</button>
          )}
        </div>
      )}

      {visibility.engineDown && (
        <div className="shell-banner shell-banner-warn">
          服务端模拟引擎未就绪：可浏览界面与已保存结果，但生成 / 比较 / 单方案推演暂不可用。
        </div>
      )}

      {visibility.replay && (
        <div className="shell-banner shell-banner-replay">
          正在查看<b>已保存结果</b>（{state.viewing.kind === "replay" ? state.viewing.replay.label : ""}）· 非本次计算，不随当前场景变化。
          <button className="btn btn-small" onClick={exitReplay}>退出回放</button>
        </div>
      )}

      {visibility.outdated && (
        <div className="shell-banner shell-banner-warn">
          <b>情况已变化，请更新建议</b>
          {staleReason !== null ? `（${staleReason}）` : ""}
          <button
            className="btn btn-small"
            disabled={!canUpdate}
            title={canUpdate ? undefined : inReplay ? "回放中不可实时运行" : "服务不可用"}
            onClick={() => void generateAndCompare()}
          >
            {state.busyGenerate ? "正在计算…" : "更新建议"}
          </button>
        </div>
      )}

      {/* 散场动作错误（生成/单方案/解析）只属于群体推演作用域，不串到真实出行页 */}
      {scope === "group" &&
        state.errors.map((e) => (
          <div key={e.id} className="shell-banner shell-banner-danger">
            <b>[{e.area}]</b> {e.message}
            {e.detail && (
              <details className="shell-banner-detail">
                <summary>技术详情</summary>
                <span className="shell-error-detail">{e.detail}</span>
              </details>
            )}
            <button className="btn btn-small" onClick={() => dismissError(e.id)}>知道了</button>
          </div>
        ))}
    </div>
  );
}
