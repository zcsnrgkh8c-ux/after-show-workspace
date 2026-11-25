/**
 * 出行建议 API（POST /api/travel/advice）：
 * - 请求超时必须大于服务端 LLM_TIMEOUT_MS（默认 15000ms），否则 LLM 还没返回前端就先断了；
 *   因此 VITE_API_TIMEOUT_MS 默认 20000。
 * - 响应体必须先过契约校验（validateAdviceResponse）才返回给调用方。
 */
import { getRuntimeConfig } from "../runtimeConfig";
import type {
  AdviceMetricField,
  AdviceMode,
  AdviceReasonCode,
  AdviceRequest,
  AdviceResponse,
} from "../contract/travel";

const DEFAULT_BASE_URL = "http://localhost:8787";
/** 必须大于服务端 LLM_TIMEOUT_MS（15000ms） */
const DEFAULT_TIMEOUT_MS = 20000;

const MAX_ID_CHARS = 64;
const MAX_EXPLANATION_CHARS = 500;
const MAX_WARNINGS = 10;
const MAX_WARNING_CHARS = 200;

/** 与 shared/travel.types.ts 的联合类型保持同步的枚举清单 */
const ADVICE_MODES: readonly AdviceMode[] = ["llm", "rules", "unavailable"];
const ADVICE_REASON_CODES: readonly AdviceReasonCode[] = [
  "single_candidate",
  "shorter_duration",
  "less_walking",
  "fewer_transfers",
  "balanced_default",
  "step_free_satisfied",
  "no_candidate_meets_preference",
];
const ADVICE_METRIC_FIELDS: readonly AdviceMetricField[] = [
  "distance_m",
  "estimated_duration_s",
  "walking_distance_m",
  "transfer_count",
  "step_free_evidence",
];

export class TravelApiError extends Error {
  code: string;
  status: number | null;

  constructor(code: string, message: string, status: number | null = null) {
    super(message);
    this.name = "TravelApiError";
    this.code = code;
    this.status = status;
  }
}

export function getApiBase(): string {
  // 运行时配置优先；空串表示与页面同源（由同源网关转发 /api）。
  const runtimeBase = getRuntimeConfig().apiBaseUrl;
  if (typeof runtimeBase === "string") return runtimeBase.trim();
  const raw = import.meta.env.VITE_API_BASE_URL;
  return raw && raw.trim() !== "" ? raw.trim() : DEFAULT_BASE_URL;
}

export function getApiTimeoutMs(): number {
  const raw = import.meta.env.VITE_API_TIMEOUT_MS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

/**
 * 严格按契约校验 AdviceResponse。
 * 校验项：request_id / candidate_set_id 非空字符串且 ≤64；mode 枚举；
 * selected_route_id 为 null 或非空字符串；reason_codes 每项属于契约枚举；
 * evidence 每项含非空 route_id 且 metric 属于契约枚举；explanation 非空 ≤500；
 * warnings 字符串数组 ≤10 条且每项 ≤200；degraded_from 为 null 或 "llm"。
 */
export function validateAdviceResponse(
  payload: unknown,
): { ok: true; value: AdviceResponse } | { ok: false; errors: string[] } {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { ok: false, errors: ["响应体必须是 JSON 对象"] };
  }
  const obj = payload as Record<string, unknown>;
  const errors: string[] = [];

  const isId = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= MAX_ID_CHARS;
  if (!isId(obj.request_id)) {
    errors.push(`request_id 必须是非空字符串且不超过 ${MAX_ID_CHARS} 字符`);
  }
  if (!isId(obj.candidate_set_id)) {
    errors.push(`candidate_set_id 必须是非空字符串且不超过 ${MAX_ID_CHARS} 字符`);
  }

  if (typeof obj.mode !== "string" || !ADVICE_MODES.includes(obj.mode as AdviceMode)) {
    errors.push(`mode 必须是 ${ADVICE_MODES.join(" / ")} 之一`);
  }

  const srid = obj.selected_route_id;
  if (srid !== null && !(typeof srid === "string" && srid.length > 0)) {
    errors.push("selected_route_id 必须为 null 或非空字符串");
  }

  const reasonOk =
    Array.isArray(obj.reason_codes) &&
    obj.reason_codes.every(
      (c) => typeof c === "string" && ADVICE_REASON_CODES.includes(c as AdviceReasonCode),
    );
  if (!reasonOk) {
    errors.push(`reason_codes 必须是字符串数组且每项属于枚举（${ADVICE_REASON_CODES.join(" / ")}）`);
  }

  const evidenceOk =
    Array.isArray(obj.evidence) &&
    obj.evidence.every(
      (e) =>
        typeof e === "object" &&
        e !== null &&
        !Array.isArray(e) &&
        typeof (e as { route_id?: unknown }).route_id === "string" &&
        ((e as { route_id: string }).route_id as string).length > 0 &&
        ADVICE_METRIC_FIELDS.includes((e as { metric?: unknown }).metric as AdviceMetricField),
    );
  if (!evidenceOk) {
    errors.push(
      `evidence 必须是对象数组且每项包含非空 route_id 与合法 metric 枚举（${ADVICE_METRIC_FIELDS.join(" / ")}）`,
    );
  }

  const explanation = obj.explanation;
  if (
    typeof explanation !== "string" ||
    explanation.length === 0 ||
    explanation.length > MAX_EXPLANATION_CHARS
  ) {
    errors.push(`explanation 必须是非空字符串且不超过 ${MAX_EXPLANATION_CHARS} 字符`);
  }

  const warningsOk =
    Array.isArray(obj.warnings) &&
    obj.warnings.length <= MAX_WARNINGS &&
    obj.warnings.every((w) => typeof w === "string" && w.length <= MAX_WARNING_CHARS);
  if (!warningsOk) {
    errors.push(
      `warnings 必须是字符串数组、不超过 ${MAX_WARNINGS} 条且每项不超过 ${MAX_WARNING_CHARS} 字符`,
    );
  }

  if (obj.degraded_from !== null && obj.degraded_from !== "llm") {
    errors.push('degraded_from 必须为 null 或 "llm"');
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: payload as AdviceResponse };
}

/**
 * 请求出行建议。错误码约定：
 * - HTTP 非 200：解析 {error:{code,message}} 信封；解析失败兜底 code "http_error"
 * - 网络失败："network"；超时："timeout"；成功体未过契约校验："invalid_response"
 */
export async function postTravelAdvice(req: AdviceRequest): Promise<AdviceResponse> {
  const base = getApiBase();
  const timeoutMs = getApiTimeoutMs();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(`${base}/api/travel/advice`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const aborted = controller.signal.aborted || (err as Error)?.name === "AbortError";
    if (aborted) {
      throw new TravelApiError("timeout", `请求出行建议超时（${timeoutMs}ms）`);
    }
    throw new TravelApiError(
      "network",
      `网络请求失败：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  clearTimeout(timer);

  if (res.status !== 200) {
    let code = "http_error";
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { code?: unknown; message?: unknown } };
      const envelope = body && typeof body === "object" ? body.error : null;
      if (envelope && typeof envelope === "object") {
        if (typeof envelope.code === "string" && envelope.code !== "") code = envelope.code;
        if (typeof envelope.message === "string" && envelope.message !== "") {
          message = envelope.message;
        }
      }
    } catch {
      // 信封解析失败，保持兜底 code "http_error"
    }
    throw new TravelApiError(code, message, res.status);
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    throw new TravelApiError("invalid_response", "响应体不是合法 JSON", res.status);
  }
  const validated = validateAdviceResponse(payload);
  if (!validated.ok) {
    throw new TravelApiError(
      "invalid_response",
      `响应未通过契约校验：${validated.errors.join("；")}`,
      res.status,
    );
  }
  return validated.value;
}
