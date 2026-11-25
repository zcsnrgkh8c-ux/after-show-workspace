import type {
  CompareRequest,
  CompareResponse,
  GenerateRequest,
  GenerateResponse,
  HealthResponse,
  ParseRequest,
  ParseResponse,
  SimulateRequest,
  SimulationResult,
} from "../contract/types";
import { API_BASE_URL, API_TIMEOUT_MS, IS_DEV_MOCK } from "./config";
import { ApiError } from "./errors";
import { mockApi } from "./mock";
import {
  validateCompareResponse,
  validateGenerateResponse,
  validateHealth,
  validateParseResponse,
  validateSimulationResult,
} from "./validate";

export { ApiError } from "./errors";
export type { ApiErrorKind } from "./errors";

/** 前端真实请求日志（工具轨迹页展示用；不含伪造数据） */
export interface ClientLogEvent {
  method: "GET" | "POST";
  path: string;
  status: "ok" | "http_error" | "timeout" | "network_error" | "bad_response";
  http_status?: number;
  duration_ms: number;
  summary: string;
}

type ClientLogger = (e: ClientLogEvent) => void;
let clientLogger: ClientLogger | null = null;
export function setClientLogger(l: ClientLogger | null): void {
  clientLogger = l;
}

function emit(e: ClientLogEvent): void {
  try {
    clientLogger?.(e);
  } catch {
    /* 日志回调异常不影响主流程 */
  }
}

async function request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
  const started = performance.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const durationMs = Math.round(performance.now() - started);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      emit({ method, path, status: "http_error", http_status: res.status, duration_ms: durationMs, summary: `HTTP ${res.status}` });
      throw new ApiError("http", `${method} ${path} 返回 HTTP ${res.status}`, {
        httpStatus: res.status,
        detail: text.slice(0, 500),
      });
    }
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      emit({ method, path, status: "bad_response", http_status: res.status, duration_ms: durationMs, summary: "响应不是合法 JSON" });
      throw new ApiError("bad_response", `${method} ${path} 响应不是合法 JSON`);
    }
    emit({ method, path, status: "ok", http_status: res.status, duration_ms: durationMs, summary: "ok" });
    return data;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    const durationMs = Math.round(performance.now() - started);
    if (err instanceof DOMException && err.name === "AbortError") {
      emit({ method, path, status: "timeout", duration_ms: durationMs, summary: `超时(>${API_TIMEOUT_MS}ms)` });
      throw new ApiError("timeout", `${method} ${path} 请求超时（>${Math.round(API_TIMEOUT_MS / 1000)}s）`);
    }
    emit({ method, path, status: "network_error", duration_ms: durationMs, summary: "网络错误/服务不可达" });
    throw new ApiError("network", `${method} ${path} 无法连接服务（网络错误或服务未启动）`);
  } finally {
    clearTimeout(timer);
  }
}

export interface Api {
  health(): Promise<HealthResponse>;
  parseScenario(req: ParseRequest): Promise<ParseResponse>;
  generatePlans(req: GenerateRequest): Promise<GenerateResponse>;
  simulate(req: SimulateRequest): Promise<SimulationResult>;
  compare(req: CompareRequest): Promise<CompareResponse>;
}

const liveApi: Api = {
  health: () => request("GET", "/api/health") as Promise<HealthResponse>,
  parseScenario: (req) => request("POST", "/api/scenario/parse", req) as Promise<ParseResponse>,
  generatePlans: (req) => request("POST", "/api/plan/generate", req) as Promise<GenerateResponse>,
  simulate: (req) => request("POST", "/api/simulate", req) as Promise<SimulationResult>,
  compare: (req) => request("POST", "/api/compare", req) as Promise<CompareResponse>,
};

/** 统一在出口处做运行时校验：残缺/错类型响应一律变成 bad_response 显式错误 */
function withValidation(inner: Api): Api {
  return {
    health: async () => validateHealth(await inner.health()),
    parseScenario: async (req) => validateParseResponse(await inner.parseScenario(req)),
    generatePlans: async (req) => validateGenerateResponse(await inner.generatePlans(req)),
    simulate: async (req) => validateSimulationResult(await inner.simulate(req)),
    compare: async (req) => validateCompareResponse(await inner.compare(req)),
  };
}

/**
 * 当前生效的 API 实现。
 * IS_DEV_MOCK 为 true 时使用开发占位 mock（必须 VITE_API_MODE=mock 显式启用，
 * 且 UI 常驻“开发 mock”标识）；否则一律走真实 HTTP，接口失败绝不静默回退 mock。
 * 两条路径都经过同一组运行时校验。
 */
export const api: Api = withValidation(IS_DEV_MOCK ? mockApi : liveApi);
