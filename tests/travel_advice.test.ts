/**
 * 出行建议接口测试：直接调用 travelAdvice()，不起 HTTP 服务器。
 * 覆盖：rules 直通 / 400 invalid_request / LLM 失败降级 / LLM 成功返回。
 * 测试内自行保存与恢复 LLM 环境变量与 globalThis.fetch。
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { ApiError } from "../server/api/handlers";
import { travelAdvice } from "../server/travel/handler";
import { AdviceRequest, RouteCandidateSummary } from "../shared/travel.types";

const ENV_KEYS = ["LLM_API_KEY", "LLM_MODEL", "LLM_BASE_URL", "LLM_TIMEOUT_MS"] as const;
const originalEnv: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) {
  originalEnv[key] = process.env[key];
}
const originalFetch = globalThis.fetch;

function clearTravelLlmEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

function setFakeLlmEnv(): void {
  process.env.LLM_API_KEY = "test-fake-api-key";
  process.env.LLM_MODEL = "test-fake-model";
  delete process.env.LLM_BASE_URL;
  delete process.env.LLM_TIMEOUT_MS;
}

function buildCandidate(routeId: string, overrides: Partial<RouteCandidateSummary> = {}): RouteCandidateSummary {
  return {
    route_id: routeId,
    mode: "walking",
    distance_m: 1200,
    estimated_duration_s: 900,
    walking_distance_m: 1200,
    transfer_count: null,
    step_free_evidence: "unknown",
    ...overrides,
  };
}

function buildRequest(): AdviceRequest {
  return {
    request_id: "req-travel-test-001",
    candidate_set_id: "cand-travel-test-001",
    preference: { preference: "balanced", needs_step_free: false, note: null },
    candidates: [
      buildCandidate("amap-route-1"),
      buildCandidate("amap-route-2", {
        distance_m: 1500,
        estimated_duration_s: 1100,
        walking_distance_m: 1500,
        step_free_evidence: "satisfied",
      }),
    ],
  };
}

after(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  globalThis.fetch = originalFetch;
});

test("未配置模型时走规则建议并回显请求标识", async () => {
  clearTravelLlmEnv();
  const request = buildRequest();
  const response = await travelAdvice(request);
  assert.equal(response.mode, "rules");
  assert.equal(response.request_id, request.request_id);
  assert.equal(response.candidate_set_id, request.candidate_set_id);
  assert.equal(response.degraded_from, null);
  assert.ok(
    response.selected_route_id === null ||
      request.candidates.some((candidate) => candidate.route_id === response.selected_route_id),
  );
});

test("非法请求体抛出 400 invalid_request 且 details 为字符串数组", async () => {
  clearTravelLlmEnv();
  const base = buildRequest() as unknown as Record<string, unknown>;
  const missingCandidates = { ...base };
  delete missingCandidates.candidates;
  const emptyCandidates = { ...base, candidates: [] };
  const duplicatedRouteId = {
    ...base,
    candidates: [buildCandidate("amap-route-1"), buildCandidate("amap-route-1")],
  };

  for (const body of [missingCandidates, emptyCandidates, duplicatedRouteId]) {
    await assert.rejects(travelAdvice(body), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 400);
      assert.equal(error.code, "invalid_request");
      assert.ok(Array.isArray(error.details));
      const details = error.details as unknown[];
      assert.ok(details.length > 0);
      assert.ok(details.every((item) => typeof item === "string"));
      return true;
    });
  }
});

test("模型调用失败时降级为规则建议并标注 degraded_from=llm", async () => {
  setFakeLlmEnv();
  globalThis.fetch = (async () => {
    throw new Error("stub: network unavailable");
  }) as unknown as typeof fetch;

  try {
    const response = await travelAdvice(buildRequest());
    assert.equal(response.mode, "rules");
    assert.equal(response.degraded_from, "llm");
    assert.ok(response.warnings.some((item) => item.includes("降级")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("模型返回合法输出时返回 llm 模式且选择属于候选集", async () => {
  setFakeLlmEnv();
  const llmPayload = {
    selected_route_id: "amap-route-1",
    reason_codes: ["shorter_duration"],
    evidence: [{ route_id: "amap-route-1", metric: "estimated_duration_s" }],
    explanation:
      "路线 amap-route-1 全程约 1200 米、约 900 秒，短于 amap-route-2 的约 1100 秒，推荐前者。",
    warnings: [],
  };
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [
        {
          message: {
            content: "```json\n" + JSON.stringify(llmPayload) + "\n```",
          },
        },
      ],
    }),
  })) as unknown as typeof fetch;

  try {
    const request = buildRequest();
    const response = await travelAdvice(request);
    assert.equal(response.mode, "llm");
    assert.equal(response.degraded_from, null);
    assert.equal(response.request_id, request.request_id);
    assert.equal(response.candidate_set_id, request.candidate_set_id);
    assert.ok(
      response.selected_route_id !== null &&
        request.candidates.some((candidate) => candidate.route_id === response.selected_route_id),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
