/**
 * 输入提示（POI 搜索）适配（AMap.AutoComplete）：
 * - tips 的 location 缺失/全 0 时 location=null，禁止 [0,0] 充数；
 * - 解析失败如实返回错误，不造假 POI。
 */
import type { AMapNamespace } from "../vendor/types";
import type { PlaceSuggestion } from "../../../contract/travel";
import { loadAmapWithPlugins } from "../vendor/amapLoader";
import { readCoord } from "./geolocation";

export type SearchOutcome =
  | { status: "ok"; suggestions: PlaceSuggestion[]; request_seq: number }
  | { status: "error"; error_code: string; message: string; request_seq: number };

export interface SearchPlacesInput {
  keyword: string;
  /** 搜索范围城市，可空（空时由高德按默认范围搜索） */
  city: string | null;
  /** 自增请求序号，用于编排层丢弃旧响应 */
  request_seq: number;
  /** 已就绪的 AMap 命名空间；缺省时按需加载 AMap.AutoComplete 插件 */
  amap?: AMapNamespace;
  /** 超时（毫秒）：高德 AutoComplete 偶发不回调，必须有界返回错误 */
  timeout_ms?: number;
}

/** 默认搜索超时：高德 AutoComplete 不回调时避免“搜索中…”永久停留 */
export const DEFAULT_SEARCH_TIMEOUT_MS = 8_000;

/**
 * 纯函数：解析 AutoComplete.search 的 tips 数组（兼容 { tips: [...] } 包装）。
 * suggestion_id 确定性地取 `sug-{request_seq}-{index}`，同一请求内唯一。
 */
export function parsePlaceTips(
  raw: unknown,
  ctx: { request_seq: number },
): PlaceSuggestion[] {
  let tips: unknown;
  if (Array.isArray(raw)) {
    tips = raw;
  } else if (typeof raw === "object" && raw !== null && Array.isArray((raw as { tips?: unknown }).tips)) {
    tips = (raw as { tips: unknown[] }).tips;
  } else {
    return [];
  }
  const list = tips as unknown[];
  const out: PlaceSuggestion[] = [];
  list.forEach((tip, index) => {
    if (typeof tip !== "object" || tip === null) return;
    const o = tip as Record<string, unknown>;
    const label = typeof o.name === "string" && o.name !== "" ? o.name : null;
    if (!label) return;
    const coord = readCoord(o.location);
    // location 缺失、全 0（高德对行政区/线路类提示返回 [0,0] 或空数组）一律视为无坐标
    const hasRealCoord =
      coord !== null && !(coord.lng === 0 && coord.lat === 0);
    out.push({
      suggestion_id: `sug-${ctx.request_seq}-${index}`,
      label,
      district: typeof o.district === "string" && o.district !== "" ? o.district : null,
      address: typeof o.address === "string" && o.address !== "" ? o.address : null,
      location: hasRealCoord ? { lng: coord.lng, lat: coord.lat } : null,
    });
  });
  return out;
}

/** 输入提示搜索入口 */
export async function searchPlaces(input: SearchPlacesInput): Promise<SearchOutcome> {
  const keyword = input.keyword.trim();
  if (keyword === "") {
    return {
      status: "error",
      error_code: "invalid_keyword",
      message: "关键词为空",
      request_seq: input.request_seq,
    };
  }
  let AMap: AMapNamespace;
  try {
    AMap = input.amap ?? (await loadAmapWithPlugins(["AMap.AutoComplete"]));
  } catch (err) {
    return {
      status: "error",
      error_code: "plugin_missing",
      message: `输入提示插件不可用：${err instanceof Error ? err.message : String(err)}`,
      request_seq: input.request_seq,
    };
  }
  const AutoCompleteCtor = AMap.AutoComplete;
  if (typeof AutoCompleteCtor !== "function") {
    return {
      status: "error",
      error_code: "plugin_missing",
      message: "输入提示插件 AMap.AutoComplete 不可用",
      request_seq: input.request_seq,
    };
  }

  return new Promise<SearchOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: SearchOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolve(outcome);
    };
    const timeoutMs = input.timeout_ms ?? DEFAULT_SEARCH_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      finish({
        status: "error",
        error_code: "timeout",
        message: `地点搜索超时（${Math.round(timeoutMs / 1000)} 秒未返回），请重试或手动输入更具体的地点`,
        request_seq: input.request_seq,
      });
    }, timeoutMs);

    try {
      const options: Record<string, unknown> = {};
      if (input.city !== null && input.city !== "") {
        options.city = input.city;
      }
      const ac = new AutoCompleteCtor(options);
      ac.search(keyword, (status: unknown, result: unknown) => {
        if (status === "complete") {
          finish({
            status: "ok",
            suggestions: parsePlaceTips(result, { request_seq: input.request_seq }),
            request_seq: input.request_seq,
          });
        } else {
          const info =
            typeof result === "object" &&
            result !== null &&
            typeof (result as { info?: unknown }).info === "string"
              ? (result as { info: string }).info
              : "";
          finish({
            status: "error",
            error_code: info.toUpperCase().includes("TIMEOUT") ? "timeout" : "provider_error",
            message: `地点搜索失败：${info || "未知错误"}`,
            request_seq: input.request_seq,
          });
        }
      });
    } catch (err) {
      finish({
        status: "error",
        error_code: "provider_error",
        message: `调用地点搜索失败：${err instanceof Error ? err.message : String(err)}`,
        request_seq: input.request_seq,
      });
    }
  });
}
