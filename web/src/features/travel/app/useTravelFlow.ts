/**
 * useTravelFlow —— 「我的出行」编排 hook（遵守 app/CONTRACT.md 编排红线）：
 * 1. 编辑输入文本 → 立即失效已确认坐标、旧路线、旧建议（防"新文字+旧坐标"）；
 * 2. 关键词搜索防抖 300ms，request_seq 丢弃旧响应；手选/编辑后迟到的定位不得覆盖（locateSeq）；
 * 3. 路线/建议各自独立身份；旧 candidate_set_id 的建议响应一律丢弃；陌生 routeId 拒绝；
 * 4. 先显示高德路线，再非阻塞请求建议；建议失败保留路线，不转圈致死；
 * 5. 精确位置/住址不进 localStorage/URL/日志；本阶段不持久化行程。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AdviceResponse,
  GeoPlace,
  PlaceSuggestion,
  RouteSearchResult,
  TravelPreference,
} from "../../../contract/travel";
import { postTravelAdvice, TravelApiError } from "../../../api/travelAdvice";
import { matchesAdviceIdentity } from "./adviceIdentity";
import { locateOnce } from "../geo/geolocation";
import { searchPlaces } from "../geo/places";
import { planWalking } from "../geo/walking";
import { planTransit, type TransitSearchResult } from "../geo/transit";
import { PlanGate } from "./planGate";

/** 本页可选的出行方式；公交仅展示真实路线，不接服务端建议 */
export type TravelModeChoice = "walking" | "transit";

/** 定位状态徽标（UI 层据此渲染） */
export type LocateBadge =
  | { kind: "idle" }
  | { kind: "locating" }
  | { kind: "ok"; text: string }
  | { kind: "denied" }
  | { kind: "timeout" }
  | { kind: "unavailable" }
  | { kind: "error"; message: string };

/** 地图聚焦信号（token 保证同坐标重复聚焦也触发） */
export interface MapFocus {
  lng: number;
  lat: number;
  token: number;
}

export interface UseTravelFlowOptions {
  /** 外部阻塞规划的原因（如高德凭据未配置）；非 null 时规划按钮禁用 */
  planBlockedReason?: string | null;
}

function genPlaceId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return `poi-${c.randomUUID()}`;
  return `poi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const CJK_NUM = ["一", "二", "三", "四", "五", "六"];

export function useTravelFlow(options?: UseTravelFlowOptions) {
  const planBlockedReason = options?.planBlockedReason ?? null;

  const [originDraft, setOriginDraft] = useState("");
  const [destDraft, setDestDraft] = useState("");
  const [confirmedOrigin, setConfirmedOriginState] = useState<GeoPlace | null>(null);
  const [confirmedDestination, setConfirmedDestinationState] = useState<GeoPlace | null>(null);
  const [originSuggestions, setOriginSuggestions] = useState<PlaceSuggestion[]>([]);
  const [destSuggestions, setDestSuggestions] = useState<PlaceSuggestion[]>([]);
  const [originSearching, setOriginSearching] = useState(false);
  const [destSearching, setDestSearching] = useState(false);
  /** 搜索失败/超时的可见出口（否则超时后只剩空列表，用户不知道发生了什么） */
  const [originSearchError, setOriginSearchError] = useState<string | null>(null);
  const [destSearchError, setDestSearchError] = useState<string | null>(null);
  const [locateBadge, setLocateBadge] = useState<LocateBadge>({ kind: "idle" });
  const [preference, setPreferenceState] = useState<TravelPreference>({
    preference: "balanced",
    needs_step_free: false,
    note: null,
  });
  const [routeResult, setRouteResultState] = useState<RouteSearchResult | null>(null);
  const [transitResult, setTransitResultState] = useState<TransitSearchResult | null>(null);
  const [travelMode, setTravelModeState] = useState<TravelModeChoice>("walking");
  const [planning, setPlanning] = useState(false);
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);
  const [advice, setAdvice] = useState<AdviceResponse | null>(null);
  const [advising, setAdvising] = useState(false);
  const [adviceError, setAdviceError] = useState<TravelApiError | null>(null);
  const [adviceWarning, setAdviceWarning] = useState<string | null>(null);
  const [mapFocus, setMapFocus] = useState<MapFocus | null>(null);

  // ---- refs：异步回调内读取最新值 / 失效计数 ----
  const originDraftRef = useRef("");
  const destDraftRef = useRef("");
  const confirmedOriginRef = useRef<GeoPlace | null>(null);
  const confirmedDestRef = useRef<GeoPlace | null>(null);
  const routeResultRef = useRef<RouteSearchResult | null>(null);
  const transitResultRef = useRef<TransitSearchResult | null>(null);
  const preferenceRef = useRef<TravelPreference>(preference);
  const planningRef = useRef(false);
  const travelModeRef = useRef<TravelModeChoice>("walking");

  const originSeqRef = useRef(0);
  const destSeqRef = useRef(0);
  const locateSeqRef = useRef(0);
  /** 规划等待态：旧请求晚到不得提前解除新请求的 loading */
  const planGateRef = useRef(new PlanGate());
  const adviceSeqRef = useRef(0);
  const focusTokenRef = useRef(0);
  const originTimerRef = useRef<number | null>(null);
  const destTimerRef = useRef<number | null>(null);
  const prefTimerRef = useRef<number | null>(null);

  const setConfirmedOriginBoth = useCallback((p: GeoPlace | null) => {
    confirmedOriginRef.current = p;
    setConfirmedOriginState(p);
  }, []);
  const setConfirmedDestBoth = useCallback((p: GeoPlace | null) => {
    confirmedDestRef.current = p;
    setConfirmedDestinationState(p);
  }, []);
  const setRouteResultBoth = useCallback((r: RouteSearchResult | null) => {
    routeResultRef.current = r;
    setRouteResultState(r);
  }, []);
  const setTransitResultBoth = useCallback((r: TransitSearchResult | null) => {
    transitResultRef.current = r;
    setTransitResultState(r);
  }, []);

  /** 路线 + 建议整体失效（输入变化 / 重新确认地点 / 交换 / 清除 / 定位成功覆盖起点时调用） */
  const invalidateRouteAndAdvice = useCallback(() => {
    planGateRef.current.invalidate(); // 在途规划结果作废
    adviceSeqRef.current += 1; // 在途建议响应作废
    setRouteResultBoth(null);
    setTransitResultBoth(null);
    setSelectedRouteId(null);
    // 作废后不会再有人负责解除等待：这里立即复位，避免 spinner 永久停留；
    // 若随后有新请求，它会在 begin() 时重新置为 waiting
    planningRef.current = false;
    setPlanning(false);
    setAdvising(false);
    setAdvice(null);
    setAdviceError(null);
    setAdviceWarning(null);
  }, [setRouteResultBoth, setTransitResultBoth]);

  const resetLocateBadgeUnlessBusy = useCallback(() => {
    setLocateBadge((prev) => (prev.kind === "locating" ? prev : { kind: "idle" }));
  }, []);

  /** 切换步行/公交：清除旧结果（含建议），由用户再点规划；在途结果作废 */
  const setTravelMode = useCallback(
    (mode: TravelModeChoice) => {
      if (travelModeRef.current === mode) return;
      travelModeRef.current = mode;
      setTravelModeState(mode);
      invalidateRouteAndAdvice();
    },
    [invalidateRouteAndAdvice],
  );

  /** 文本变化（红线1+2）：更新 draft、清除 confirmed、失效旧结果，防抖 300ms 搜索 */
  const handleTextChange = useCallback(
    (field: "origin" | "dest", value: string) => {
      const seqRef = field === "origin" ? originSeqRef : destSeqRef;
      const setSugs = field === "origin" ? setOriginSuggestions : setDestSuggestions;
      const setSearching = field === "origin" ? setOriginSearching : setDestSearching;
      const setSearchError = field === "origin" ? setOriginSearchError : setDestSearchError;
      const timerRef = field === "origin" ? originTimerRef : destTimerRef;

      if (field === "origin") {
        originDraftRef.current = value;
        setOriginDraft(value);
        setConfirmedOriginBoth(null);
        locateSeqRef.current += 1; // 编辑后迟到定位不得覆盖
        resetLocateBadgeUnlessBusy();
      } else {
        destDraftRef.current = value;
        setDestDraft(value);
        setConfirmedDestBoth(null);
      }
      invalidateRouteAndAdvice();

      const seq = ++seqRef.current;
      setSugs([]);
      setSearchError(null);
      setSearching(true);
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(async () => {
        try {
          const keyword = value.trim();
          if (keyword === "") {
            setSugs([]);
            return;
          }
          const city = confirmedOriginRef.current?.city ?? null;
          const outcome = await searchPlaces({ keyword, city, request_seq: seq });
          if (seqRef.current !== seq) return; // 旧 seq 响应丢弃
          if (outcome.status === "ok") {
            setSugs(outcome.suggestions);
            setSearchError(null);
          } else {
            setSugs([]);
            setSearchError(outcome.message);
          }
        } finally {
          if (seqRef.current === seq) setSearching(false);
        }
      }, 300);
    },
    [invalidateRouteAndAdvice, resetLocateBadgeUnlessBusy, setConfirmedOriginBoth, setConfirmedDestBoth],
  );

  const handleOriginChange = useCallback((v: string) => handleTextChange("origin", v), [handleTextChange]);
  const handleDestChange = useCallback((v: string) => handleTextChange("dest", v), [handleTextChange]);

  /** 点选候选（仅 location 非 null 才确认） */
  const pickSuggestion = useCallback(
    (field: "origin" | "dest", s: PlaceSuggestion) => {
      if (s.location === null) return;
      const place: GeoPlace = {
        place_id: genPlaceId(),
        label: s.label,
        lng: s.location.lng,
        lat: s.location.lat,
        coord_system: "GCJ-02",
        source: "poi",
        accuracy_m: null,
        source_note: "POI",
        city: s.district ?? null,
        address: s.address ?? null,
      };
      if (field === "origin") {
        originDraftRef.current = s.label;
        setOriginDraft(s.label);
        setOriginSuggestions([]);
        setOriginSearching(false);
        setOriginSearchError(null);
        originSeqRef.current += 1; // 迟到搜索响应丢弃
        locateSeqRef.current += 1; // 手选后迟到定位不得覆盖
        setConfirmedOriginBoth(place);
      } else {
        destDraftRef.current = s.label;
        setDestDraft(s.label);
        setDestSuggestions([]);
        setDestSearching(false);
        setDestSearchError(null);
        destSeqRef.current += 1;
        setConfirmedDestBoth(place);
      }
      invalidateRouteAndAdvice();
      focusTokenRef.current += 1;
      setMapFocus({ lng: place.lng, lat: place.lat, token: focusTokenRef.current });
    },
    [invalidateRouteAndAdvice, setConfirmedOriginBoth, setConfirmedDestBoth],
  );

  const pickOrigin = useCallback((s: PlaceSuggestion) => pickSuggestion("origin", s), [pickSuggestion]);
  const pickDest = useCallback((s: PlaceSuggestion) => pickSuggestion("dest", s), [pickSuggestion]);

  /** 单次定位；成功且未被取代 → confirmedOrigin + mapFocus */
  const locate = useCallback(async () => {
    const seq = ++locateSeqRef.current;
    setLocateBadge({ kind: "locating" });
    const outcome = await locateOnce({ timeout_ms: 10_000 });
    if (locateSeqRef.current !== seq) {
      // 已被编辑/手选取代：复位徽标，绝不覆盖已确认起点
      setLocateBadge((prev) => (prev.kind === "locating" ? { kind: "idle" } : prev));
      return;
    }
    if (outcome.status === "ok") {
      const acc = outcome.place.accuracy_m;
      setLocateBadge({ kind: "ok", text: `已定位${acc !== null ? `（约${Math.round(acc)}米）` : ""}` });
      originDraftRef.current = outcome.place.label;
      setOriginDraft(outcome.place.label);
      setOriginSuggestions([]);
      setOriginSearching(false);
      setOriginSearchError(null);
      originSeqRef.current += 1;
      setConfirmedOriginBoth(outcome.place);
      invalidateRouteAndAdvice();
      focusTokenRef.current += 1;
      setMapFocus({
        lng: outcome.place.lng,
        lat: outcome.place.lat,
        token: focusTokenRef.current,
      });
    } else if (outcome.status === "error") {
      setLocateBadge({ kind: "error", message: outcome.message });
    } else {
      setLocateBadge({ kind: outcome.status });
    }
  }, [invalidateRouteAndAdvice, setConfirmedOriginBoth]);

  /** 交换起终点（草稿/确认/建议全部互换，旧结果失效） */
  const swap = useCallback(() => {
    const oDraft = originDraftRef.current;
    const dDraft = destDraftRef.current;
    const o = confirmedOriginRef.current;
    const d = confirmedDestRef.current;
    originDraftRef.current = dDraft;
    destDraftRef.current = oDraft;
    setOriginDraft(dDraft);
    setDestDraft(oDraft);
    setConfirmedOriginBoth(d);
    setConfirmedDestBoth(o);
    originSeqRef.current += 1;
    destSeqRef.current += 1;
    locateSeqRef.current += 1;
    setOriginSuggestions([]);
    setDestSuggestions([]);
    setOriginSearching(false);
    setDestSearching(false);
    setOriginSearchError(null);
    setDestSearchError(null);
    invalidateRouteAndAdvice();
  }, [invalidateRouteAndAdvice, setConfirmedOriginBoth, setConfirmedDestBoth]);

  const clearOrigin = useCallback(() => {
    originDraftRef.current = "";
    setOriginDraft("");
    setConfirmedOriginBoth(null);
    setOriginSuggestions([]);
    setOriginSearching(false);
    originSeqRef.current += 1;
    locateSeqRef.current += 1;
    resetLocateBadgeUnlessBusy();
    invalidateRouteAndAdvice();
  }, [invalidateRouteAndAdvice, resetLocateBadgeUnlessBusy, setConfirmedOriginBoth]);

  const clearDest = useCallback(() => {
    destDraftRef.current = "";
    setDestDraft("");
    setConfirmedDestBoth(null);
    setDestSuggestions([]);
    setDestSearching(false);
    destSeqRef.current += 1;
    invalidateRouteAndAdvice();
  }, [invalidateRouteAndAdvice, setConfirmedDestBoth]);

  /** 非阻塞请求建议（红线3/4）：独立身份校验；失败保留路线 */
  const requestAdvice = useCallback(async (result: RouteSearchResult, pref: TravelPreference) => {
    if (result.status !== "ok" || result.routes.length === 0) return;
    const seq = ++adviceSeqRef.current;
    setAdvising(true);
    setAdviceError(null);
    setAdviceWarning(null);
    const candidates = result.routes.map((r) => ({
      route_id: r.route_id,
      mode: r.mode,
      distance_m: r.distance_m,
      estimated_duration_s: r.estimated_duration_s,
      walking_distance_m: r.walking_distance_m,
      transfer_count: r.transfer_count,
      step_free_evidence: r.step_free_evidence,
    }));
    try {
      const resp = await postTravelAdvice({
        request_id: result.request_id,
        candidate_set_id: result.candidate_set_id,
        preference: pref,
        candidates,
      });
      if (adviceSeqRef.current !== seq) return; // 旧请求响应丢弃
      // 身份匹配：当前路线结果必须仍是这次查询（旧 candidate_set_id 一律丢弃）
      const current = routeResultRef.current;
      if (
        current === null ||
        current.request_id !== result.request_id ||
        current.candidate_set_id !== result.candidate_set_id
      ) {
        return;
      }
      // 响应身份必须与本次请求一致（结构合法但属于其他请求的响应也必须拒绝）
      if (!matchesAdviceIdentity(resp, result)) {
        setAdvising(false);
        setAdvice(null);
        setAdviceWarning("建议响应的请求身份不匹配，已忽略（路线结果仍可查看）");
        return;
      }
      // 陌生 routeId 必须拒绝
      if (
        resp.selected_route_id !== null &&
        !result.routes.some((r) => r.route_id === resp.selected_route_id)
      ) {
        setAdvising(false);
        setAdvice(null);
        setAdviceWarning("建议返回了未知路线，已忽略");
        return;
      }
      setAdvice(resp);
      setAdvising(false);
    } catch (err) {
      if (adviceSeqRef.current !== seq) return;
      setAdvising(false);
      setAdviceError(
        err instanceof TravelApiError
          ? err
          : new TravelApiError("unknown", err instanceof Error ? err.message : String(err)),
      );
    }
  }, []);

  /** 规划路线：步行→显示高德结果并请求建议；公交→仅显示高德真实方案，不请求建议 */
  const planRoutes = useCallback(async () => {
    if (planBlockedReason !== null) return;
    const o = confirmedOriginRef.current;
    const d = confirmedDestRef.current;
    if (o === null || d === null || planningRef.current) return;
    planningRef.current = true;
    setPlanning(true);
    setSelectedRouteId(null);
    setAdvice(null);
    setAdviceError(null);
    setAdviceWarning(null);
    setAdvising(false);
    const seq = planGateRef.current.begin();
    const mode = travelModeRef.current;

    if (mode === "transit") {
      const pref = preferenceRef.current;
      const result = await planTransit({
        origin: o,
        destination: d,
        city: o.city ?? d.city ?? null,
        preference: pref.preference,
        needs_step_free: pref.needs_step_free,
      });
      // 旧请求晚到：不得写结果，也不得解除当前新请求的等待态
      if (!planGateRef.current.isActive(seq)) return;
      setTransitResultBoth(result);
      planGateRef.current.settle(seq);
      planningRef.current = false;
      setPlanning(false);
      if (result.status === "ok" && result.routes.length > 0) {
        setSelectedRouteId(result.routes[0].route_id);
      }
      return;
    }

    const result = await planWalking({ origin: o, destination: d });
    // 期间输入/模式已变化：旧结果作废，且不触碰当前请求的等待态
    if (!planGateRef.current.isActive(seq)) return;
    setRouteResultBoth(result);
    planGateRef.current.settle(seq);
    planningRef.current = false;
    setPlanning(false);
    if (result.status === "ok" && result.routes.length > 0) {
      setSelectedRouteId(result.routes[0].route_id);
      void requestAdvice(result, preferenceRef.current);
    }
  }, [planBlockedReason, requestAdvice, setRouteResultBoth, setTransitResultBoth]);

  /** 偏好变化：旧建议失效，防抖后自动重发一次（仍守身份匹配） */
  const updatePreference = useCallback(
    (p: TravelPreference) => {
      const note = p.note !== null && p.note.length > 200 ? p.note.slice(0, 200) : p.note;
      const next: TravelPreference = { ...p, note };
      preferenceRef.current = next;
      setPreferenceState(next);
      // 关键：偏好改变瞬间使**在途**建议请求失效。
      // 否则 400ms 防抖窗口内旧偏好的响应仍会被接收（新请求若随后失败，旧建议会留在新偏好下）。
      adviceSeqRef.current += 1;
      setAdvice(null);
      setAdviceError(null);
      setAdviceWarning(null);
      if (travelModeRef.current === "transit") {
        // 公交策略在请求时传给高德：偏好变化后旧方案不再代表当前选择，清空待重新规划
        planGateRef.current.invalidate();
        planningRef.current = false;
        setPlanning(false);
        setTransitResultBoth(null);
        setSelectedRouteId(null);
        return;
      }
      if (prefTimerRef.current !== null) clearTimeout(prefTimerRef.current);
      prefTimerRef.current = window.setTimeout(() => {
        if (travelModeRef.current !== "walking") return;
        const current = routeResultRef.current;
        if (current !== null && current.status === "ok" && current.routes.length > 0) {
          void requestAdvice(current, next);
        }
      }, 400);
    },
    [requestAdvice],
  );

  /** 仅切换高亮，不重新请求（红线：多路线 tab 只回调选择） */
  const selectRoute = useCallback((routeId: string) => {
    setSelectedRouteId(routeId);
  }, []);

  /** route_id → "方案一" 等展示名 */
  const routeLabel = useCallback((routeId: string): string | null => {
    const routes = routeResultRef.current?.routes ?? [];
    const idx = routes.findIndex((r) => r.route_id === routeId);
    if (idx === -1) return null;
    return `方案${CJK_NUM[idx] ?? idx + 1}`;
  }, []);

  // 卸载清理计时器
  useEffect(
    () => () => {
      if (originTimerRef.current !== null) clearTimeout(originTimerRef.current);
      if (destTimerRef.current !== null) clearTimeout(destTimerRef.current);
      if (prefTimerRef.current !== null) clearTimeout(prefTimerRef.current);
    },
    [],
  );

  /** needs_step_free=true 且证据 unknown → 常显警告 */
  const stepFreeWarning = useMemo(() => {
    if (!preference.needs_step_free) return null;
    if (routeResult === null || routeResult.status !== "ok") return null;
    return routeResult.routes.some((r) => r.step_free_evidence === "unknown")
      ? "无台阶通行情况尚未核实"
      : null;
  }, [preference.needs_step_free, routeResult]);

  const planDisabledReason = useMemo(() => {
    if (planBlockedReason !== null) return planBlockedReason;
    if (confirmedOrigin === null || confirmedDestination === null) {
      return "请先确认起点与终点：输入后点选候选，或使用当前位置定位";
    }
    return null;
  }, [planBlockedReason, confirmedOrigin, confirmedDestination]);

  return {
    // 草稿与确认
    originDraft,
    destDraft,
    confirmedOrigin,
    confirmedDestination,
    // 搜索
    originSuggestions,
    destSuggestions,
    originSearching,
    destSearching,
    originSearchError,
    destSearchError,
    // 定位
    locate: locateBadge,
    // 偏好
    preference,
    // 出行方式
    travelMode,
    setTravelMode,
    // 路线
    routeResult,
    transitResult,
    planning,
    selectedRouteId,
    // 建议
    advice,
    advising,
    adviceError,
    adviceWarning,
    stepFreeWarning,
    // 地图聚焦
    mapFocus,
    // 派生
    canPlan: planDisabledReason === null,
    planDisabledReason,
    // 回调
    handleOriginChange,
    handleDestChange,
    pickOrigin,
    pickDest,
    onLocate: locate,
    onSwap: swap,
    onClearOrigin: clearOrigin,
    onClearDest: clearDest,
    planRoutes,
    updatePreference,
    selectRoute,
    routeLabel,
  };
}

export type TravelFlow = ReturnType<typeof useTravelFlow>;
