import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { AddressInfo } from "node:net";
import { createServer } from "../server/app";
import { resultCache } from "../server/decision/cache";
import { clearLlmEnv, loadScenario } from "./helpers";

let server: ReturnType<typeof createServer>;
let base = "";

before(async () => {
  clearLlmEnv();
  resultCache.clear();
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("GET /api/health 返回契约字段", async () => {
  const response = await fetch(`${base}/api/health`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.status, "ok");
  assert.equal(body.schema_version, "1.0");
  assert.equal(body.engine_ready, true);
  assert.equal(typeof body.llm_configured, "boolean");
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
});

test("POST /api/scenario/parse 返回待确认补丁", async () => {
  const scenario = loadScenario("concert_demo.scenario.json");
  const response = await post("/api/scenario/parse", {
    scenario,
    instruction: "关闭西侧通道，减少一辆车",
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.mode, "rules");
  assert.ok(Array.isArray(body.patch));
  assert.ok((body.patch as unknown[]).length > 0);
  assert.equal(typeof body.summary, "string");
  assert.ok(Array.isArray(body.warnings));
});

test("generate → simulate → compare 端到端返回真实结果", async () => {
  const scenario = loadScenario("concert_demo.scenario.json");

  const generateResponse = await post("/api/plan/generate", {
    scenario,
    objective: "balanced",
    seed: 20261114,
  });
  assert.equal(generateResponse.status, 200);
  const generated = (await generateResponse.json()) as {
    plans: Array<{ plan_id: string }>;
    trace: unknown[];
    mode: string;
  };
  assert.equal(generated.plans.length, 3);
  assert.equal(generated.mode, "rules");
  assert.ok(generated.trace.length > 0);

  const simulateResponse = await post("/api/simulate", {
    scenario,
    plan: generated.plans[0],
    seed: 20261114,
  });
  assert.equal(simulateResponse.status, 200);
  const result = (await simulateResponse.json()) as {
    status: string;
    metrics: Record<string, number> | null;
    timeline: unknown[];
  };
  assert.equal(result.status, "valid");
  assert.ok(result.metrics);
  assert.ok(result.timeline.length > 0);

  const compareResponse = await post("/api/compare", {
    scenario,
    plans: generated.plans,
    seed: 20261114,
    objective: "balanced",
  });
  assert.equal(compareResponse.status, 200);
  const compared = (await compareResponse.json()) as {
    results: Array<{ status: string; metrics: unknown }>;
    recommendation: { status: string; plan_id: string | null; reason: string; tradeoffs: string[] };
    trace: Array<{ source: string }>;
  };
  assert.equal(compared.results.length, 3);
  assert.ok(compared.trace.some((step) => step.source === "simulator"));
  assert.ok(["recommended", "tradeoff"].includes(compared.recommendation.status));
  assert.ok(compared.recommendation.plan_id);
  assert.ok(compared.recommendation.reason.length > 0);
});

test("simulate 区分结构错误 HTTP 400 与完整身份领域 invalid HTTP 200", async () => {
  const scenario = loadScenario("concert_demo.scenario.json");
  const generatedResponse = await post("/api/plan/generate", {
    scenario,
    objective: "balanced",
    seed: 20261114,
  });
  const generated = (await generatedResponse.json()) as { plans: Array<Record<string, unknown>> };
  const plan = generated.plans[0];

  const malformed = { ...plan };
  delete malformed.plan_id;
  const malformedResponse = await post("/api/simulate", { scenario, plan: malformed, seed: 20261114 });
  assert.equal(malformedResponse.status, 400);
  const malformedBody = (await malformedResponse.json()) as { error?: { code?: string } };
  assert.equal(malformedBody.error?.code, "missing_plan_id");

  const stale = { ...plan, plan_id: "stale_domain_candidate", scenario_revision: scenario.revision + 1 };
  const staleResponse = await post("/api/simulate", { scenario, plan: stale, seed: 20261114 });
  assert.equal(staleResponse.status, 200);
  const staleBody = (await staleResponse.json()) as {
    status: string;
    metrics: unknown;
    violations: Array<{ code: string }>;
  };
  assert.equal(staleBody.status, "invalid");
  assert.equal(staleBody.metrics, null);
  assert.ok(staleBody.violations.some((item) => item.code === "PLAN_STALE_REVISION"));
});

test("非法 JSON 返回 400 错误信封", async () => {
  const response = await post("/api/compare", "{not json");
  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: { code: string; message: string } };
  assert.equal(body.error.code, "invalid_json");
  assert.ok(body.error.message.length > 0);
});

test("非法场景返回 400 invalid_scenario 并带 issues", async () => {
  const scenario = loadScenario("concert_demo.scenario.json") as unknown as Record<string, unknown>;
  scenario.schema_version = "2.0";
  const response = await post("/api/plan/generate", {
    scenario,
    objective: "balanced",
    seed: 1,
  });
  assert.equal(response.status, 400);
  const body = (await response.json()) as {
    error: { code: string; details: Array<{ code: string }> };
  };
  assert.equal(body.error.code, "invalid_scenario");
  assert.ok(body.error.details.some((item) => item.code === "SCHEMA_VERSION_UNSUPPORTED"));
});

test("不存在的接口返回 404，方法不对返回 405", async () => {
  const notFound = await fetch(`${base}/api/unknown`);
  assert.equal(notFound.status, 404);
  const notFoundBody = (await notFound.json()) as { error: { code: string } };
  assert.equal(notFoundBody.error.code, "not_found");

  const wrongMethod = await fetch(`${base}/api/compare`);
  assert.equal(wrongMethod.status, 405);
  const wrongMethodBody = (await wrongMethod.json()) as { error: { code: string } };
  assert.equal(wrongMethodBody.error.code, "method_not_allowed");
});

test("compare 拒绝重复 plan_id", async () => {
  const scenario = loadScenario("concert_demo.scenario.json");
  const generated = (await (
    await post("/api/plan/generate", { scenario, objective: "efficiency", seed: 20261114 })
  ).json()) as { plans: unknown[] };
  const duplicated = [generated.plans[0], generated.plans[0]];
  const response = await post("/api/compare", {
    scenario,
    plans: duplicated,
    seed: 20261114,
    objective: "efficiency",
  });
  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(body.error.code, "duplicate_plan_id");
});
