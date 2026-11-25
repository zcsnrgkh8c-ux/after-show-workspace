/**
 * 「我的出行」展示层纯推导（窗口2本轮）：
 * 只做状态到文案/样式的映射，不发请求、不改路线与建议数据。
 * 用途：步骤主操作、来源与精度说明、建议模式表达、地图绘制计数。
 */
import type {
  AdviceMode,
  AdviceResponse,
  GeoPlace,
  RouteSearchResult,
} from "../../../contract/travel";

/* ---------------- 步骤 ---------------- */

export type TravelStepKey = "origin" | "destination" | "plan" | "result";

/** 按已确认起终点与是否已有路线结果推导当前步骤（主操作随之变化） */
export function stepForInputs(args: {
  hasOrigin: boolean;
  hasDestination: boolean;
  hasRouteResult: boolean;
}): TravelStepKey {
  if (args.hasRouteResult) return "result";
  if (!args.hasOrigin) return "origin";
  if (!args.hasDestination) return "destination";
  return "plan";
}

/* ---------------- 定位 / 地点来源 ---------------- */

export interface PlaceSourceView {
  /** 来源短句（直接展示） */
  text: string;
  /** IP 近似（非精确定位） */
  approximate: boolean;
  /** 精度偏低，需要提示用户核对起点 */
  lowAccuracy: boolean;
}

/** 地点来源按真实字段映射；不把 IP 近似说成精确定位，不把浏览器定位说成实地核实 */
export function placeSourceView(place: GeoPlace | null): PlaceSourceView | null {
  if (place === null) return null;
  if (place.source === "poi") {
    return { text: "高德地点检索（POI）", approximate: false, lowAccuracy: false };
  }
  const note = place.source_note ?? "";
  const approximate = note.includes("IP");
  const lowAccuracy =
    approximate || (place.accuracy_m !== null && place.accuracy_m > 100);
  return {
    text: approximate ? "IP 近似定位（非精确 GPS）" : "浏览器定位（WGS-84 已转 GCJ-02）",
    approximate,
    lowAccuracy,
  };
}

/** 精度短句：仅定位来源且高德/浏览器返回了精度时展示；POI 选点没有精度 */
export function accuracyText(place: GeoPlace | null): string | null {
  if (place === null || place.source !== "geolocation" || place.accuracy_m === null) return null;
  return `精度约 ±${Math.round(place.accuracy_m)} 米`;
}

/* ---------------- 建议模式 ---------------- */

export interface AdviceModeView {
  title: string;
  badge: string;
  mode: AdviceMode;
  /** 只有 mode=llm 才允许出现“模型分析”语义 */
  isModel: boolean;
  /** 模型调用失败后降级为 rules */
  degraded: boolean;
  /** 模式口径说明（展示建议来源时使用） */
  modeNote: string;
}

export function adviceModeView(
  advice: Pick<AdviceResponse, "mode" | "degraded_from">,
): AdviceModeView {
  if (advice.mode === "llm") {
    return {
      title: "模型分析建议",
      badge: "模型分析",
      mode: "llm",
      isModel: true,
      degraded: false,
      modeNote: "服务端响应 mode=llm：仅在真实模型调用成功且输出通过校验时出现。",
    };
  }
  if (advice.mode === "unavailable") {
    return {
      title: "出行建议不可用",
      badge: "不可用",
      mode: "unavailable",
      isModel: false,
      degraded: false,
      modeNote: "服务端响应 mode=unavailable：本次未生成可用建议，路线事实不受影响。",
    };
  }
  const degraded = advice.degraded_from === "llm";
  return {
    title: "基础路线建议",
    badge: "规则",
    mode: "rules",
    isModel: false,
    degraded,
    modeNote: degraded
      ? "服务端响应 mode=rules：模型调用失败后降级为基础规则建议，不含模型分析。"
      : "服务端响应 mode=rules：按固定规则给出，不含模型分析。",
  };
}

/** 建议请求失败码 → 用户可读短句（保留“基础路线建议不可用”由卡片统一表达） */
export function adviceErrorText(err: {
  code: string;
  message: string;
  status: number | null;
}): string {
  switch (err.code) {
    case "timeout":
      return "请求超时";
    case "network":
      return "网络异常";
    case "invalid_response":
      return "响应未通过契约校验";
    case "http_error":
      return `服务返回错误${err.status !== null ? `（HTTP ${err.status}）` : ""}`;
    default:
      return err.message;
  }
}

/* ---------------- 地图绘制计数 ---------------- */

/** 实际绘制到地图的路线数：仅统计高德返回了有效折线的候选 */
export function drawnRouteCount(result: RouteSearchResult | null): number {
  if (result === null || result.status !== "ok") return 0;
  return result.routes.filter(
    (r) => Array.isArray(r.polyline) && r.polyline.length >= 2,
  ).length;
}
