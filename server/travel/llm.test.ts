/**
 * llm.test.ts —— travel LLM 适配层（adviseWithLlm / travelLlmConfigured）行为测试。
 * 运行：node --test server/travel/llm.test.ts（Node ≥ 24，零依赖）。
 * 全程以桩替换 globalThis.fetch，绝不真实联网；环境变量在 beforeEach 设置、afterEach 还原。
 */

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import type { AdviceRequest, RouteCandidateSummary } from "../../shared/travel.types.ts";
import { adviseWithLlm, travelLlmConfigured } from "./llm.ts";

/* ---------- 环境与网络桩 ---------- */

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV: Record<string, string | undefined> = {
  LLM_API_KEY: process.env.LLM_API_KEY,
  LLM_MODEL: process.env.LLM_MODEL,
  LLM_BASE_URL: process.env.LLM_BASE_URL,
  LLM_TIMEOUT_MS: process.env.LLM_TIMEOUT_MS,
};

beforeEach(() => {
  process.env.LLM_API_KEY = "test-key";
  process.env.LLM_MODEL = "test-model";
  delete process.env.LLM_BASE_URL;
  delete process.env.LLM_TIMEOUT_MS;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

interface RecordedCall {
  url: string;
  init: RequestInit;
}

/** 以桩替换 globalThis.fetch：返回固定 HTTP 响应并记录调用参数，绝不发起真实请求。 */
function stubLlmResponse(reply: { content?: string; status?: number; rawBody?: string } = {}): RecordedCall[] {
  const calls: RecordedCall[] = [];
  const status = reply.status ?? 200;
  const body =
    reply.rawBody ?? JSON.stringify({ choices: [{ message: { content: reply.content ?? "" } }] });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => JSON.parse(body),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return calls;
}

/* ---------- 夹具 ---------- */

function candidate(overrides: Partial<RouteCandidateSummary> = {}): RouteCandidateSummary {
  return {
    route_id: "r1",
    mode: "walking",
    distance_m: 850,
    estimated_duration_s: 620,
    walking_distance_m: 850,
    transfer_count: 0,
    step_free_evidence: "unknown",
    ...overrides,
  };
}

/** r2 的 transfer_count 为 null：用于验证证据引用 null 指标必须被拒绝。 */
function makeRequest(candidates?: RouteCandidateSummary[]): AdviceRequest {
  return {
    request_id: "req-1",
    candidate_set_id: "cs-1",
    preference: { preference: "less_walking", needs_step_free: false, note: "带老人出行" },
    candidates: candidates ?? [
      candidate(),
      candidate({
        route_id: "r2",
        distance_m: 1200,
        estimated_duration_s: 900,
        walking_distance_m: 900,
        transfer_count: null,
        step_free_evidence: "satisfied",
      }),
    ],
  };
}

const VALID_OUTPUT = {
  selected_route_id: "r2",
  reason_codes: ["step_free_satisfied", "shorter_duration"],
  evidence: [
    { route_id: "r2", metric: "step_free_evidence" },
    { route_id: "r1", metric: "estimated_duration_s" },
  ],
  explanation: "r2 具备无台阶证据；r1 总时长更短，供偏好时长者参考。",
  warnings: ["r2 里程略长，请留意体力。"],
};

/* ---------- 用例 ---------- */

test("合法 JSON 输出 → 通过且字段正确，请求契约干净", async () => {
  assert.equal(travelLlmConfigured(), true);
  const calls = stubLlmResponse({ content: JSON.stringify(VALID_OUTPUT) });
  const result = await adviseWithLlm(makeRequest());

  assert.equal(result.selected_route_id, "r2");
  assert.deepEqual(result.reason_codes, ["step_free_satisfied", "shorter_duration"]);
  assert.deepEqual(result.evidence, [
    { route_id: "r2", metric: "step_free_evidence" },
    { route_id: "r1", metric: "estimated_duration_s" },
  ]);
  assert.equal(result.explanation, VALID_OUTPUT.explanation);
  assert.deepEqual(result.warnings, VALID_OUTPUT.warnings);
  assert.equal(result.model, "test-model");
  assert.ok(Number.isFinite(result.duration_ms) && result.duration_ms >= 0);

  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith("/chat/completions"));
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer test-key");
  const body = JSON.parse(String(calls[0].init.body)) as {
    model: string;
    messages: Array<{ role: string; content: string }>;
  };
  assert.equal(body.model, "test-model");
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[0].role, "system");
  const userContent = body.messages[1].content;
  assert.ok(userContent.includes('"preference":"less_walking"'));
  assert.ok(userContent.includes("r1") && userContent.includes("r2"));
  // 红线：不外发坐标、地址、折线
  assert.ok(!userContent.includes("lng"));
  assert.ok(!userContent.includes("lat"));
  assert.ok(!userContent.includes("polyline"));
  assert.ok(!userContent.includes("address"));
});

test("带 ```json 围栏的输出 → 通过", async () => {
  stubLlmResponse({ content: "```json\n" + JSON.stringify(VALID_OUTPUT) + "\n```" });
  const result = await adviseWithLlm(makeRequest());
  assert.equal(result.selected_route_id, "r2");
});

test("selected_route_id 为未知 ID → throw", async () => {
  stubLlmResponse({ content: JSON.stringify({ ...VALID_OUTPUT, selected_route_id: "r9" }) });
  await assert.rejects(() => adviseWithLlm(makeRequest()), /selected_route_id/);
});

test("selected_route_id 既非 null 也非字符串 → throw", async () => {
  stubLlmResponse({ content: JSON.stringify({ ...VALID_OUTPUT, selected_route_id: 42 }) });
  await assert.rejects(() => adviseWithLlm(makeRequest()), /selected_route_id/);
});

test("evidence 引用候选中为 null 的指标 → throw", async () => {
  stubLlmResponse({
    content: JSON.stringify({ ...VALID_OUTPUT, evidence: [{ route_id: "r2", metric: "transfer_count" }] }),
  });
  await assert.rejects(() => adviseWithLlm(makeRequest()), /null/);
});

test("evidence 引用未知 route_id 或非法 metric → throw", async () => {
  stubLlmResponse({
    content: JSON.stringify({ ...VALID_OUTPUT, evidence: [{ route_id: "r9", metric: "distance_m" }] }),
  });
  await assert.rejects(() => adviseWithLlm(makeRequest()), /route_id/);

  stubLlmResponse({
    content: JSON.stringify({ ...VALID_OUTPUT, evidence: [{ route_id: "r1", metric: "price" }] }),
  });
  await assert.rejects(() => adviseWithLlm(makeRequest()), /metric/);
});

test("evidence 引用 step_free_evidence 恒可（即使候选为 unknown）→ 通过", async () => {
  stubLlmResponse({
    content: JSON.stringify({ ...VALID_OUTPUT, evidence: [{ route_id: "r1", metric: "step_free_evidence" }] }),
  });
  const result = await adviseWithLlm(makeRequest());
  assert.deepEqual(result.evidence, [{ route_id: "r1", metric: "step_free_evidence" }]);
});

test("reason_codes 含非法枚举值 → throw", async () => {
  stubLlmResponse({
    content: JSON.stringify({ ...VALID_OUTPUT, reason_codes: ["shorter_duration", "made_up_reason"] }),
  });
  await assert.rejects(() => adviseWithLlm(makeRequest()), /reason_codes/);
});

test("reason_codes 为空数组 → throw", async () => {
  stubLlmResponse({ content: JSON.stringify({ ...VALID_OUTPUT, reason_codes: [] }) });
  await assert.rejects(() => adviseWithLlm(makeRequest()), /reason_codes/);
});

test("explanation 超过 500 字符 → throw", async () => {
  stubLlmResponse({ content: JSON.stringify({ ...VALID_OUTPUT, explanation: "长".repeat(501) }) });
  await assert.rejects(() => adviseWithLlm(makeRequest()), /explanation/);
});

test("explanation 为空或纯空白 → throw", async () => {
  stubLlmResponse({ content: JSON.stringify({ ...VALID_OUTPUT, explanation: "" }) });
  await assert.rejects(() => adviseWithLlm(makeRequest()), /explanation/);
  stubLlmResponse({ content: JSON.stringify({ ...VALID_OUTPUT, explanation: "   " }) });
  await assert.rejects(() => adviseWithLlm(makeRequest()), /explanation/);
});

test("warnings 含非字符串项 / 超 10 项 / 单项超 200 字符 → throw", async () => {
  stubLlmResponse({ content: JSON.stringify({ ...VALID_OUTPUT, warnings: [123] }) });
  await assert.rejects(() => adviseWithLlm(makeRequest()), /warnings/);

  stubLlmResponse({
    content: JSON.stringify({
      ...VALID_OUTPUT,
      warnings: Array.from({ length: 11 }, (_, i) => `警告${i}`),
    }),
  });
  await assert.rejects(() => adviseWithLlm(makeRequest()), /warnings/);

  stubLlmResponse({ content: JSON.stringify({ ...VALID_OUTPUT, warnings: ["长".repeat(201)] }) });
  await assert.rejects(() => adviseWithLlm(makeRequest()), /warnings/);
});

test("模型输出缺少必需字段 → throw", async () => {
  stubLlmResponse({
    content: JSON.stringify({
      selected_route_id: "r1",
      reason_codes: ["balanced_default"],
      evidence: [],
      explanation: "仅一条候选。",
    }),
  });
  await assert.rejects(() => adviseWithLlm(makeRequest()), /缺少字段/);
});

test("输出为 JSON 数组而非对象 → throw", async () => {
  stubLlmResponse({ content: "[]" });
  await assert.rejects(() => adviseWithLlm(makeRequest()), /JSON 对象/);
});

test("HTTP 401 → throw 且消息不含供应商响应体细节", async () => {
  const secretBody = JSON.stringify({ error: { message: "invalid api key sk-secret-token-abc123" } });
  stubLlmResponse({ status: 401, rawBody: secretBody });
  await assert.rejects(
    () => adviseWithLlm(makeRequest()),
    (err: Error) => {
      assert.match(err.message, /HTTP 401/);
      assert.ok(!err.message.includes("sk-secret-token"));
      assert.ok(!err.message.includes("invalid api key"));
      return true;
    },
  );
});

test("非法 JSON 输出 → throw", async () => {
  stubLlmResponse({ content: "好的，我的建议是 {selected_route_id: r2}" });
  await assert.rejects(() => adviseWithLlm(makeRequest()), /JSON/);
});

test("fetch 超时（桩永不 resolve，LLM_TIMEOUT_MS=100）→ throw", async () => {
  globalThis.fetch = (async () => new Promise<Response>(() => {})) as unknown as typeof fetch;
  process.env.LLM_TIMEOUT_MS = "100";
  await assert.rejects(() => adviseWithLlm(makeRequest()), /超时/);
});

test("未配置环境变量 → travelLlmConfigured()=false 且调用即 throw，不发起请求", async () => {
  delete process.env.LLM_API_KEY;
  assert.equal(travelLlmConfigured(), false);
  globalThis.fetch = (async () => {
    throw new Error("不应发起真实网络请求");
  }) as unknown as typeof fetch;
  await assert.rejects(() => adviseWithLlm(makeRequest()), /未配置/);
});

test("selected_route_id 为 null（无满足要求的候选）→ 合法通过", async () => {
  stubLlmResponse({
    content: JSON.stringify({
      selected_route_id: null,
      reason_codes: ["no_candidate_meets_preference"],
      evidence: [],
      explanation: "所有候选均无无台阶证据，无法满足硬需求。",
      warnings: [],
    }),
  });
  const result = await adviseWithLlm(makeRequest());
  assert.equal(result.selected_route_id, null);
  assert.deepEqual(result.reason_codes, ["no_candidate_meets_preference"]);
  assert.deepEqual(result.evidence, []);
});
