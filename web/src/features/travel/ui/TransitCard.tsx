/**
 * 公交 / 地铁路线结果卡（展示层）：
 * - 距离、耗时、换乘、步行距离与折线均来自高德 AMap.Transfer 真实返回；缺失如实写“未返回”；
 * - 不接服务端出行建议（现有建议契约仅覆盖步行），卡片内明确说明；
 * - 无台阶/电梯、实时到站与票价高德未提供，一律“尚未核实”，不冒充无障碍可达。
 */
import type { TransitSearchResult } from "../geo/transit";

const POLICY_TEXT: Record<TransitSearchResult["policy"], string | null> = {
  default: null,
  least_transfer: "本次已按高德「最少换乘」策略请求",
  least_walk: "本次已按高德「最少步行」策略请求",
};

export interface TransitCardProps {
  result: TransitSearchResult | null;
  planning: boolean;
  selectedRouteId: string | null;
  onSelectRoute: (routeId: string) => void;
}

const ERROR_CODE_TEXT: Record<string, string> = {
  invalid_key: "高德 Key 无效，请检查 VITE_AMAP_KEY 配置",
  quota_exceeded: "高德配额超限，请稍后重试",
  timeout: "请求超时，请重试",
  network: "网络异常，请检查网络后重试",
  plugin_missing: "公交规划插件不可用",
  missing_city: "无法确定城市，请把起点或终点改为带城市的地点",
  provider_error: "高德服务返回错误",
};

function formatDistance(m: number | null): string {
  if (m === null) return "未返回";
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} 米`;
}

function formatDuration(s: number | null): string {
  if (s === null) return "未返回";
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

const CJK_NUM = ["一", "二", "三", "四", "五", "六"];

export function TransitCard({ result, planning, selectedRouteId, onSelectRoute }: TransitCardProps) {
  if (planning && result === null) {
    return (
      <section className="travel-card route-card" aria-label="公交路线结果">
        <div className="route-head">
          <span className="route-kicker">路线事实</span>
          <span className="route-badge route-badge--busy" role="status">
            规划中…
          </span>
        </div>
        <p className="route-wait-note">正在请求高德公交/地铁规划；返回后只展示路线事实，不请求服务端建议。</p>
      </section>
    );
  }
  if (result === null) return null;

  const queriedAt = result.status === "ok" && result.routes.length > 0 ? result.routes[0].queried_at : null;
  const footer = `路线事实来源：高德地图 JS API（AMap.Transfer）${
    queriedAt !== null ? ` · 查询时间 ${formatClock(queriedAt)}` : ""
  } · 服务端不参与路线计算`;

  if (result.status === "provider_error") {
    const explain =
      result.error_code !== null && ERROR_CODE_TEXT[result.error_code] !== undefined
        ? ERROR_CODE_TEXT[result.error_code]
        : `未知错误（${result.error_code ?? "无错误码"}）`;
    return (
      <section className="travel-card route-card route-card--error" aria-label="公交路线结果">
        <div className="route-head">
          <span className="route-kicker">路线事实</span>
          <span className="route-badge route-badge--error" role="status">
            服务错误
          </span>
        </div>
        <p className="route-error-code">{explain}</p>
        {result.message !== null && <p className="route-error-msg">{result.message}</p>}
        <p className="route-hint">未获取到公交/地铁方案，也不会显示估算距离或直线替代。可修改起终点后重试。</p>
        <p className="route-footer">{footer}</p>
      </section>
    );
  }

  if (result.status === "no_route") {
    return (
      <section className="travel-card route-card route-card--empty" aria-label="公交路线结果">
        <div className="route-head">
          <span className="route-kicker">路线事实</span>
          <span className="route-badge route-badge--warn" role="status">
            无路线
          </span>
        </div>
        <p>{result.message ?? "高德未返回可行公交/地铁方案"}</p>
        <p className="route-hint">可修改起终点、交换起终点，或切换为步行路线后重试。</p>
        <p className="route-footer">{footer}</p>
      </section>
    );
  }

  const routes = result.routes;
  const selected = routes.find((r) => r.route_id === selectedRouteId) ?? null;

  return (
    <section className="travel-card route-card" aria-label="公交路线结果">
      <div className="route-head">
        <span className="route-kicker">路线事实</span>
        <span className="route-badge route-badge--ok" role="status">
          {planning ? "重新规划中…" : "规划成功"}
        </span>
        <span className="route-source-chip">高德公交</span>
        <span className="route-count">共 {routes.length} 条候选</span>
      </div>

      {POLICY_TEXT[result.policy] !== null && (
        <p className="route-single-note" role="note">
          {POLICY_TEXT[result.policy]}。
        </p>
      )}

      {result.step_free_unverified && (
        <p className="route-warn-note" role="note">
          已勾选“无台阶通行硬需求”，但高德公交规划不提供无台阶/电梯参数，本方案未按该需求筛选，无障碍情况尚未核实。
        </p>
      )}

      {routes.length === 1 && (
        <p className="route-single-note" role="note">
          仅 1 条公交/地铁候选：以下为这一条候选的路线事实，不涉及多方案择优。
        </p>
      )}

      {routes.length > 1 && (
        <div className="route-tabs" role="tablist" aria-label="公交候选路线">
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
            <span className="route-metric-label">总距离（高德）</span>
            <span className="route-metric-value">{formatDistance(selected.distance_m)}</span>
          </div>
          <div className="route-metric">
            <span className="route-metric-label">预计耗时（高德估算）</span>
            <span className="route-metric-value">{formatDuration(selected.estimated_duration_s)}</span>
          </div>
          <div className="route-metric">
            <span className="route-metric-label">换乘次数</span>
            <span className="route-metric-value">
              {selected.transfer_count === null ? "未返回" : `${selected.transfer_count} 次`}
            </span>
          </div>
          <div className="route-metric">
            <span className="route-metric-label">步行距离</span>
            <span className="route-metric-value">{formatDistance(selected.walking_distance_m)}</span>
          </div>
        </div>
      )}

      {selected !== null && selected.polyline === null && (
        <p className="route-warn-note">高德未返回该方案的完整折线，地图不绘制（不用直线冒充路径）。</p>
      )}

      {selected !== null && selected.legs.length > 0 && (
        <details className="route-steps" open>
          <summary>行程分段（{selected.legs.length} 段）</summary>
          <ol className="transit-legs">
            {selected.legs.map((leg, i) => (
              <li key={i}>
                <span className={`transit-leg-tag transit-leg-tag--${leg.kind}`}>{leg.label}</span>
                <span className="transit-leg-detail">{leg.detail ?? "高德未返回线路说明"}</span>
                <span className="step-meta">
                  {leg.distance_m !== null ? formatDistance(leg.distance_m) : ""}
                  {leg.duration_s !== null ? ` · ${formatDuration(leg.duration_s)}` : ""}
                </span>
              </li>
            ))}
          </ol>
        </details>
      )}

      <p className="route-data-note">
        公交/地铁方案仅展示高德返回的路线、换乘与时间事实；无台阶/电梯、实时到站与票价信息高德未提供，尚未核实。
        本页暂不提供服务端出行建议，不把规则或模型结论套到公交方案上。
      </p>
      <p className="route-footer">{footer}</p>
    </section>
  );
}
