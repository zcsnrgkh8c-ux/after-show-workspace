/**
 * 起终点表单（受控展示组件，无自身副作用）：
 * - 起点/终点输入 + 候选下拉（名称 + 区县 + 地址）；
 * - 起点区"使用当前位置"/"手动输入地点"常驻；定位状态徽标；
 * - 拒绝后突出手输框、提示手输，不反复要求授权；
 * - 偏好 chips（均衡/少步行/少换乘 + 无台阶硬需求 + 补充说明）。
 */
import { useRef } from "react";
import type {
  GeoPlace,
  PlaceSuggestion,
  PreferenceKind,
  TravelPreference,
} from "../../../contract/travel";
import type { LocateBadge, TravelModeChoice } from "../app/useTravelFlow";
import { accuracyText, placeSourceView } from "./display";

export interface OriginDestFormProps {
  originDraft: string;
  destDraft: string;
  originSuggestions: PlaceSuggestion[];
  destSuggestions: PlaceSuggestion[];
  originSearching: boolean;
  destSearching: boolean;
  /** 可选：搜索失败/超时的可见提示（旧调用不传则不展示） */
  originSearchError?: string | null;
  destSearchError?: string | null;
  locate: LocateBadge;
  preference: TravelPreference;
  canPlan: boolean;
  planning: boolean;
  planDisabledReason: string | null;
  /** 可选：已确认起点（展示来源/精度，不影响旧调用） */
  originPlace?: GeoPlace | null;
  /** 可选：已确认终点（展示来源） */
  destPlace?: GeoPlace | null;
  /** 可选：是否在表单内显示规划按钮（默认 true；首页步骤流由外部主操作承担时传 false） */
  showPlanButton?: boolean;
  /** 可选：当前出行方式；公共交通下提示“无台阶”无法用于公交规划 */
  travelMode?: TravelModeChoice;
  onOriginChange: (v: string) => void;
  onDestChange: (v: string) => void;
  onPickOrigin: (s: PlaceSuggestion) => void;
  onPickDest: (s: PlaceSuggestion) => void;
  onLocate: () => void;
  onSwap: () => void;
  onClearOrigin: () => void;
  onClearDest: () => void;
  onPlan: () => void;
  onPreferenceChange: (p: TravelPreference) => void;
}

const PREF_OPTIONS: Array<{ value: PreferenceKind; label: string }> = [
  { value: "balanced", label: "均衡" },
  { value: "less_walking", label: "少步行" },
  { value: "less_transfer", label: "少换乘" },
];

function LocateBadgeView({ locate }: { locate: LocateBadge }) {
  let cls = "locate-badge";
  let text = "";
  switch (locate.kind) {
    case "idle":
      text = "未定位";
      break;
    case "locating":
      cls += " locate-badge--busy";
      text = "定位中…";
      break;
    case "ok":
      cls += " locate-badge--ok";
      text = locate.text;
      break;
    case "denied":
      cls += " locate-badge--warn";
      text = "定位被拒绝";
      break;
    case "timeout":
      cls += " locate-badge--warn";
      text = "定位超时";
      break;
    case "unavailable":
      cls += " locate-badge--warn";
      text = "位置不可用";
      break;
    case "error":
      cls += " locate-badge--warn";
      text = "定位失败";
      break;
  }
  return (
    <span className={cls} role="status">
      {text}
    </span>
  );
}

/** 已确认地点的来源与精度（只展示真实字段；POI 无精度、IP 近似明确标注） */
function PlaceSourceLine({ place, field }: { place: GeoPlace | null; field: "起点" | "终点" }) {
  const view = placeSourceView(place);
  if (view === null) return null;
  const acc = accuracyText(place);
  return (
    <>
      <p className={`place-source${view.lowAccuracy ? " place-source--warn" : ""}`}>
        {field}来源：{view.text}
        {acc !== null ? ` · ${acc}` : ""} · 坐标 GCJ-02
      </p>
      {view.lowAccuracy && (
        <p className="place-warn" role="note">
          {view.approximate
            ? "当前为 IP 近似定位（非精确 GPS），起点可能偏差较大，建议手动选择起点核对。"
            : "定位精度较低，建议手动核对起点；路线将以此定位点计算。"}
        </p>
      )}
    </>
  );
}

interface FieldSuggestionProps {
  suggestions: PlaceSuggestion[];
  searching: boolean;
  error?: string | null;
  onPick: (s: PlaceSuggestion) => void;
}

function SuggestionList({ suggestions, searching, error, onPick }: FieldSuggestionProps) {
  if (suggestions.length === 0) {
    if (searching) return <p className="searching-hint">搜索中…</p>;
    if (error) {
      return (
        <p className="plan-reason" role="note">
          {error}
        </p>
      );
    }
    return null;
  }
  return (
    <ul className="suggestions" role="listbox" aria-label="地点候选">
      {suggestions.map((s) => {
        const noCoord = s.location === null;
        const meta = [s.district, s.address].filter(Boolean).join(" · ");
        return (
          <li key={s.suggestion_id}>
            <button
              type="button"
              className={`suggestion${noCoord ? " suggestion--no-coord" : ""}`}
              onClick={() => onPick(s)}
              disabled={noCoord}
              title={noCoord ? "该候选无坐标，请改选其他候选" : undefined}
            >
              <span className="suggestion-label">{s.label}</span>
              {meta !== "" && <span className="suggestion-meta">{meta}</span>}
              {noCoord && <span className="suggestion-nocoord">无坐标，请改选</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function OriginDestForm(props: OriginDestFormProps) {
  const originInputRef = useRef<HTMLInputElement | null>(null);
  const denied = props.locate.kind === "denied";

  const focusOrigin = () => originInputRef.current?.focus();

  return (
    <section className="travel-card origin-dest-form" aria-label="起终点与偏好">
      {/* 起点 */}
      <div className={`field${denied ? " field--denied" : ""}`}>
        <div className="field-head">
          <label htmlFor="travel-origin">起点</label>
          <LocateBadgeView locate={props.locate} />
        </div>
        <div className="field-row">
          <input
            id="travel-origin"
            ref={originInputRef}
            type="text"
            value={props.originDraft}
            placeholder="输入起点地点"
            autoComplete="off"
            onChange={(e) => props.onOriginChange(e.target.value)}
          />
          <button
            type="button"
            className="ghost-btn"
            onClick={props.onClearOrigin}
            disabled={props.originDraft === ""}
          >
            清除
          </button>
        </div>
        <div className="field-tools">
          <button
            type="button"
            className="tool-btn"
            onClick={props.onLocate}
            disabled={props.locate.kind === "locating"}
          >
            使用当前位置
          </button>
          <button type="button" className="tool-btn" onClick={focusOrigin}>
            手动输入地点
          </button>
        </div>
        {denied && (
          <p className="field-denied-hint">定位权限被拒绝，请直接输入起点地点（不会再次请求授权）</p>
        )}
        <PlaceSourceLine place={props.originPlace ?? null} field="起点" />
        <SuggestionList
          suggestions={props.originSuggestions}
          searching={props.originSearching}
          error={props.originSearchError ?? null}
          onPick={props.onPickOrigin}
        />
      </div>

      <button
        type="button"
        className="swap-btn"
        onClick={props.onSwap}
        aria-label="交换起点与终点"
      >
        ⇅ 交换起终点
      </button>

      {/* 终点 */}
      <div className="field">
        <div className="field-head">
          <label htmlFor="travel-dest">终点</label>
        </div>
        <div className="field-row">
          <input
            id="travel-dest"
            type="text"
            value={props.destDraft}
            placeholder="输入终点地点"
            autoComplete="off"
            onChange={(e) => props.onDestChange(e.target.value)}
          />
          <button
            type="button"
            className="ghost-btn"
            onClick={props.onClearDest}
            disabled={props.destDraft === ""}
          >
            清除
          </button>
        </div>
        <PlaceSourceLine place={props.destPlace ?? null} field="终点" />
        <SuggestionList
          suggestions={props.destSuggestions}
          searching={props.destSearching}
          error={props.destSearchError ?? null}
          onPick={props.onPickDest}
        />
      </div>

      {/* 偏好 */}
      <fieldset className="pref">
        <legend>路线偏好</legend>
        <div className="pref-chips" role="group" aria-label="路线偏好">
          {PREF_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              className={`chip${props.preference.preference === o.value ? " chip--active" : ""}`}
              aria-pressed={props.preference.preference === o.value}
              onClick={() => props.onPreferenceChange({ ...props.preference, preference: o.value })}
            >
              {o.label}
            </button>
          ))}
        </div>
        <label className="pref-check">
          <input
            type="checkbox"
            checked={props.preference.needs_step_free}
            onChange={(e) =>
              props.onPreferenceChange({ ...props.preference, needs_step_free: e.target.checked })
            }
          />
          无台阶通行硬需求
        </label>
        {props.travelMode === "transit" && props.preference.needs_step_free && (
          <p className="plan-reason" role="note">
            当前为公交 / 地铁模式：高德公交规划不提供无台阶或电梯参数，此需求不会参与公交方案筛选；结果中的无障碍情况仍为“尚未核实”。
          </p>
        )}
        <input
          className="pref-note"
          type="text"
          maxLength={200}
          value={props.preference.note ?? ""}
          placeholder="补充说明（可选，≤200字）"
          onChange={(e) =>
            props.onPreferenceChange({
              ...props.preference,
              note: e.target.value.trim() === "" ? null : e.target.value,
            })
          }
        />
      </fieldset>

      {props.showPlanButton !== false && (
        <>
          <button
            type="button"
            className="plan-btn"
            onClick={props.onPlan}
            disabled={!props.canPlan || props.planning}
          >
            {props.planning ? "规划中…" : "规划步行路线"}
          </button>
          {props.planDisabledReason !== null && (
            <p className="plan-reason" role="note">
              {props.planDisabledReason}
            </p>
          )}
        </>
      )}
    </section>
  );
}
