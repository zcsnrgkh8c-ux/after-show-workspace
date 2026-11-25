/**
 * 路线结果主卡（受控展示，无自身副作用）——本卡只承载“路线事实”：
 * - 距离 / 预计步行时间 / 无台阶证据 / 折线均来自高德真实返回，缺字段如实“未知”；
 * - 状态徽标：规划中 / 规划成功 / 无路线 / 服务错误；
 * - 多路线 tab 仅回调 onSelectRoute（父级改高亮，不重新请求）；
 * - 单候选时明确“仅解释这一条”，不宣称多路线择优；
 * - 页脚标明路线事实来源与查询时间；服务端建议在下方独立卡片分层展示。
 */
import type { RouteSearchResult } from "../../../contract/travel";

export interface RouteCardProps {
  result: RouteSearchResult | null;
  planning: boolean;
  selectedRouteId: string | null;
  onSelectRoute: (routeId: string) => void;
}

/** provider_error 错误码中文解释（缺省兜底如实显示原始码） */
const ERROR_CODE_TEXT: Record<string, string> = {
  invalid_key: "高德 Key 无效，请检查 VITE_AMAP_KEY 配置",
  quota_exceeded: "高德配额超限，请稍后重试",
  timeout: "请求超时，请重试",
  network: "网络异常，请检查网络后重试",
  plugin_missing: "路线规划插件不可用",
  provider_error: "高德服务返回错误",
};

function formatDistance(m: number | null): string {
  if (m === null) return "距离未知";
  return `${(m / 1000).toFixed(1)} km`;
}

function formatDuration(s: number | null): string {
  if (s === null) return "时长未知";
  const min = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return min > 0 ? `${min} 分 ${sec} 秒` : `${sec} 秒`;
}

function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function stepFreeText(evidence: "unknown" | "satisfied" | "unsatisfied"): string {
  if (evidence === "satisfied") return "满足（高德字段）";
  if (evidence === "unsatisfied") return "不满足（高德字段）";
  return "尚未核实（高德未提供）";
}

const CJK_NUM = ["一", "二", "三", "四", "五", "六"];

export function RouteCard({ result, planning, selectedRouteId, onSelectRoute }: RouteCardProps) {
  if (planning && result === null) {
    return (
      <section className="travel-card route-card" aria-label="路线结果">
        <div className="route-head">
          <span className="route-kicker">路线事实</span>
          <span className="route-badge route-badge--busy" role="status">
            规划中…
          </span>
        </div>
        <p className="route-wait-note">正在请求高德步行路线；路线返回后会先展示事实，再请求服务端建议。</p>
      </section>
    );
  }
  if (result === null) return null;

  // queried_at 在 TravelRoute 上；ok 时取首条路线的查询时间，无路线/错误时如实省略时间
  const queriedAt =
    result.status === "ok" && result.routes.length > 0 ? result.routes[0].queried_at : null;
  const footer = `路线事实来源：高德地图 JS API（AMap.Walking）${
    queriedAt !== null ? ` · 查询时间 ${formatClock(queriedAt)}` : ""
  } · 服务端不参与路线计算`;

  if (result.status === "provider_error") {
    const explain =
      result.error_code !== null && ERROR_CODE_TEXT[result.error_code] !== undefined
        ? ERROR_CODE_TEXT[result.error_code]
        : `未知错误（${result.error_code ?? "无错误码"}）`;
    return (
      <section className="travel-card route-card route-card--error" aria-label="路线结果">
        <div className="route-head">
          <span className="route-kicker">路线事实</span>
          <span className="route-badge route-badge--error" role="status">
            服务错误
          </span>
        </div>
        <p className="route-error-code">{explain}</p>
        {result.message !== null && <p className="route-error-msg">{result.message}</p>}
        <p className="route-hint">
          未获取到路线，因此没有请求出行建议；也不会显示估算距离或直线替代。可修改起终点后重试。
        </p>
        <p className="route-footer">{footer}</p>
      </section>
    );
  }

  if (result.status === "no_route") {
    return (
      <section className="travel-card route-card route-card--empty" aria-label="路线结果">
        <div className="route-head">
          <span className="route-kicker">路线事实</span>
          <span className="route-badge route-badge--warn" role="status">
            无路线
          </span>
        </div>
        <p>{result.message ?? "高德未返回可行步行路线"}</p>
        <p className="route-hint">
          未获取到路线，因此没有请求出行建议；可修改起终点、交换起终点或调整偏好后重试（上方表单始终可用）。
        </p>
        <p className="route-footer">{footer}</p>
      </section>
    );
  }

  const routes = result.routes;
  const selected = routes.find((r) => r.route_id === selectedRouteId) ?? null;

  return (
    <section className="travel-card route-card" aria-label="路线结果">
      <div className="route-head">
        <span className="route-kicker">路线事实</span>
        <span className="route-badge route-badge--ok" role="status">
          {planning ? "重新规划中…" : "规划成功"}
        </span>
        <span className="route-source-chip">高德地图</span>
        <span className="route-count">共 {routes.length} 条候选</span>
      </div>

      {routes.length === 1 && (
        <p className="route-single-note" role="note">
          仅 1 条候选：以下为这一条候选的路线事实，不涉及多路线择优。
        </p>
      )}
      {planning && (
        <p className="route-wait-note">正在重新规划；在结果返回前，下方仍为上一次高德返回的路线。</p>
      )}

      {routes.length > 1 && (
        <div className="route-tabs" role="tablist" aria-label="候选路线">
          {routes.map((r, i) => (
            <button
              key={r.route_id}
              type="button"
              role="tab"
              aria-selected={r.route_id === selectedRouteId}
              className={`route-tab${r.route_id === selectedRouteId ? " route-tab--active" : ""}`}
              onClick={() => onSelectRoute(r.route_id)}
            >
              方案{CJK_NUM[i] ?? i + 1}
            </button>
          ))}
        </div>
      )}

      {selected !== null && (
        <div className="route-summary">
          <div className="route-metric">
            <span className="route-metric-label">距离（高德）</span>
            <span className="route-metric-value">{formatDistance(selected.distance_m)}</span>
          </div>
          <div className="route-metric">
            <span className="route-metric-label">预计步行时间（高德估算）</span>
            <span className="route-metric-value">
              {formatDuration(selected.estimated_duration_s)}
            </span>
          </div>
          <div className="route-metric">
            <span className="route-metric-label">无台阶证据</span>
            <span className="route-metric-value route-metric-value--small">
              {stepFreeText(selected.step_free_evidence)}
            </span>
          </div>
        </div>
      )}

      {selected !== null && (
        <p className="route-data-note">
          距离与预计时间均取自高德步行规划返回；预计时间为服务估算，非实际用时。无台阶证据缺失时如实显示“尚未核实”，不代表无障碍可达，也不代表已到店门口。
        </p>
      )}

      {selected !== null && selected.polyline === null && (
        <p className="route-warn-note">高德未返回该路线的折线数据，地图不绘制（不用直线冒充路径）。</p>
      )}

      {selected !== null && selected.steps.length > 0 && (
        <details className="route-steps">
          <summary>步行步骤（{selected.steps.length} 步）</summary>
          <ol>
            {selected.steps.map((s, i) => (
              <li key={i}>
                <span className="step-instruction">{s.instruction !== "" ? s.instruction : "（高德未返回指引文字）"}</span>
                <span className="step-meta">
                  {s.distance_m !== null ? `${formatDistance(s.distance_m)}` : ""}
                  {s.duration_s !== null ? ` · ${formatDuration(s.duration_s)}` : ""}
                </span>
              </li>
            ))}
          </ol>
        </details>
      )}

      <p className="route-footer">{footer}</p>
    </section>
  );
}
