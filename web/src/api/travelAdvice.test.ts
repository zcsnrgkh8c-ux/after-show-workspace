import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdviceRequest, AdviceResponse } from "../contract/travel";
import { TravelApiError, postTravelAdvice, validateAdviceResponse } from "./travelAdvice";

// 打桩 globalThis.fetch：测试不做真实网络请求
const fetchMock = vi.fn();

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const validRequest: AdviceRequest = {
  request_id: "req-1",
  candidate_set_id: "set-1",
  preference: { preference: "balanced", needs_step_free: false, note: null },
  candidates: [
    {
      route_id: "route-a",
      mode: "walking",
      distance_m: 1200,
      estimated_duration_s: 900,
      walking_distance_m: 1200,
      transfer_count: null,
      step_free_evidence: "unknown",
    },
  ],
};

const validResponse: AdviceResponse = {
  request_id: "req-1",
  candidate_set_id: "set-1",
  mode: "rules",
  selected_route_id: "route-a",
  reason_codes: ["shorter_duration"],
  evidence: [{ route_id: "route-a", metric: "estimated_duration_s" }],
  explanation: "推荐路线A：总里程更短，预计用时更少。",
  warnings: [],
  degraded_from: null,
};

describe("postTravelAdvice", () => {
  it("成功信封：返回通过校验的响应体，URL/方法/头/超时信号正确", async () => {
    vi.stubEnv("VITE_API_BASE_URL", "http://api.test");
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => validResponse,
    });

    const result = await postTravelAdvice(validRequest);

    expect(result).toEqual(validResponse);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://api.test/api/travel/advice");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(init.body).toBe(JSON.stringify(validRequest));
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("HTTP 400 错误信封：抛 TravelApiError（code/message 来自信封，status=400）", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { code: "invalid_request", message: "候选数量超限" } }),
    });

    const err = (await postTravelAdvice(validRequest).catch((e) => e)) as TravelApiError;

    expect(err).toBeInstanceOf(TravelApiError);
    expect(err.code).toBe("invalid_request");
    expect(err.status).toBe(400);
    expect(err.message).toBe("候选数量超限");
  });

  it("HTTP 错误信封解析失败：兜底 code http_error", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error("not json");
      },
    });

    const err = (await postTravelAdvice(validRequest).catch((e) => e)) as TravelApiError;

    expect(err).toBeInstanceOf(TravelApiError);
    expect(err.code).toBe("http_error");
    expect(err.status).toBe(502);
    expect(err.message).toBe("HTTP 502");
  });

  it("超时：AbortController 触发后 reject code timeout", async () => {
    vi.stubEnv("VITE_API_TIMEOUT_MS", "30");
    vi.useFakeTimers();
    // fetch 挂起直到 abort 信号触发
    fetchMock.mockImplementation((_url: unknown, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        (init!.signal as AbortSignal).addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });

    const p = postTravelAdvice(validRequest);
    const rejection = expect(p).rejects.toMatchObject({ code: "timeout", status: null });
    await vi.advanceTimersByTimeAsync(31);
    await rejection;
  });

  it("网络失败：reject code network", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

    const err = (await postTravelAdvice(validRequest).catch((e) => e)) as TravelApiError;

    expect(err).toBeInstanceOf(TravelApiError);
    expect(err.code).toBe("network");
    expect(err.status).toBeNull();
  });

  it("成功但响应体非法：reject code invalid_response", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ...validResponse, request_id: "" }),
    });

    const err = (await postTravelAdvice(validRequest).catch((e) => e)) as TravelApiError;

    expect(err).toBeInstanceOf(TravelApiError);
    expect(err.code).toBe("invalid_response");
    expect(err.status).toBe(200);
  });

  it("成功但响应体不是 JSON：reject code invalid_response", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("not json");
      },
    });

    const err = (await postTravelAdvice(validRequest).catch((e) => e)) as TravelApiError;

    expect(err).toBeInstanceOf(TravelApiError);
    expect(err.code).toBe("invalid_response");
  });
});

describe("validateAdviceResponse", () => {
  it("合法响应体：ok=true 且返回原值", () => {
    const result = validateAdviceResponse(validResponse);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(validResponse);
  });

  it("边界：request_id/candidate_set_id 恰好 64 字符合法", () => {
    const result = validateAdviceResponse({
      ...validResponse,
      request_id: "r".repeat(64),
      candidate_set_id: "c".repeat(64),
    });
    expect(result.ok).toBe(true);
  });

  it("缺字段：逐项报错", () => {
    const result = validateAdviceResponse({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const joined = result.errors.join("\n");
      expect(joined).toContain("request_id");
      expect(joined).toContain("candidate_set_id");
      expect(joined).toContain("mode");
      expect(joined).toContain("selected_route_id");
      expect(joined).toContain("reason_codes");
      expect(joined).toContain("evidence");
      expect(joined).toContain("explanation");
      expect(joined).toContain("warnings");
      expect(joined).toContain("degraded_from");
    }
  });

  it("坏枚举：mode/reason_codes/metric/degraded_from 非法时报错", () => {
    const result = validateAdviceResponse({
      ...validResponse,
      mode: "gpt",
      reason_codes: ["made_up_code"],
      evidence: [{ route_id: "route-a", metric: "distance_ft" }],
      degraded_from: "rules",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const joined = result.errors.join("\n");
      expect(joined).toContain("mode");
      expect(joined).toContain("reason_codes");
      expect(joined).toContain("evidence");
      expect(joined).toContain("degraded_from");
    }
  });

  it("id 超长（65 字符）：报错", () => {
    const result = validateAdviceResponse({ ...validResponse, request_id: "r".repeat(65) });
    expect(result.ok).toBe(false);
  });

  it("explanation 超长（501 字符）与空串：报错", () => {
    expect(
      validateAdviceResponse({ ...validResponse, explanation: "长".repeat(501) }).ok,
    ).toBe(false);
    expect(validateAdviceResponse({ ...validResponse, explanation: "" }).ok).toBe(false);
  });

  it("warnings 超 10 条或单条超 200 字符：报错", () => {
    expect(
      validateAdviceResponse({ ...validResponse, warnings: Array.from({ length: 11 }, () => "w") })
        .ok,
    ).toBe(false);
    expect(
      validateAdviceResponse({ ...validResponse, warnings: ["w".repeat(201)] }).ok,
    ).toBe(false);
  });

  it("evidence 项 route_id 为空串或非对象：报错", () => {
    expect(
      validateAdviceResponse({
        ...validResponse,
        evidence: [{ route_id: "", metric: "distance_m" }],
      }).ok,
    ).toBe(false);
    expect(validateAdviceResponse({ ...validResponse, evidence: ["route-a"] }).ok).toBe(false);
  });

  it("selected_route_id 允许 null；非空字符串也合法", () => {
    expect(
      validateAdviceResponse({ ...validResponse, selected_route_id: null }).ok,
    ).toBe(true);
    expect(
      validateAdviceResponse({ ...validResponse, selected_route_id: "route-a" }).ok,
    ).toBe(true);
    expect(
      validateAdviceResponse({ ...validResponse, selected_route_id: "" }).ok,
    ).toBe(false);
  });
});
