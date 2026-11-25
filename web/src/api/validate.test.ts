import { describe, expect, it } from "vitest";
import { ApiError } from "./errors";
import { mockApi } from "./mock";
import { DEFAULT_SCENARIO } from "../contract/defaultScenario";
import {
  validateCompareResponse,
  validateGenerateResponse,
  validateHealth,
  validateParseResponse,
  validateSimulationResult,
} from "./validate";

function expectBadResponse(fn: () => unknown, fieldHint: string) {
  try {
    fn();
    throw new Error("应当抛出 bad_response，但未抛出");
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    const e = err as ApiError;
    expect(e.kind).toBe("bad_response");
    expect(e.message).toContain(fieldHint);
  }
}

/* ---------- 缺字段 / 错类型 JSON ---------- */

describe("运行时校验：缺字段与错类型", () => {
  it("health 缺 engine_ready → bad_response", () => {
    expectBadResponse(
      () => validateHealth({ status: "ok", schema_version: "1.0", llm_configured: false }),
      "engine_ready"
    );
  });

  it("health 完整合法 → 通过", () => {
    const h = validateHealth({ status: "ok", schema_version: "1.0", engine_ready: true, llm_configured: false });
    expect(h.schema_version).toBe("1.0");
  });

  it("parse.patch 项缺 id → bad_response", () => {
    expectBadResponse(
      () =>
        validateParseResponse({
          patch: [{ target: "edge", field: "closed", value: true }],
          summary: "s",
          warnings: [],
          mode: "rules",
        }),
      "patch[0].id"
    );
  });

  it("parse.mode 为非法枚举 → bad_response", () => {
    expectBadResponse(
      () => validateParseResponse({ patch: [], summary: "s", warnings: [], mode: "gpt" }),
      "parse.mode"
    );
  });

  it("generate.plans[0] 的 share 是字符串 → bad_response", () => {
    expectBadResponse(
      () =>
        validateGenerateResponse({
          plans: [
            {
              schema_version: "1.0",
              plan_id: "p1",
              scenario_id: "s",
              scenario_revision: 1,
              strategy: "baseline",
              name: "n",
              allocations: [{ group_id: "g", routes: [{ route_id: "R1", share: "0.5" }] }],
              departures: [],
            },
          ],
          trace: [],
          mode: "rules",
        }),
      "share"
    );
  });

  it("trace 项 status 为非法枚举 → bad_response", () => {
    expectBadResponse(
      () =>
        validateGenerateResponse({
          plans: [],
          trace: [{ step: 1, actor: "a", action: "b", source: "rules", summary: "s", status: "success" }],
          mode: "rules",
        }),
      "trace[0].status"
    );
  });

  it("result.metrics.p95 为非 null 非数字 → bad_response", () => {
    expectBadResponse(
      () =>
        validateSimulationResult({
          schema_version: "1.0",
          engine_version: "e",
          scenario_id: "s",
          scenario_revision: 1,
          plan_id: "p",
          seed: 1,
          status: "valid",
          violations: [],
          metrics: {
            released_count: 1,
            boarded_count: 1,
            remaining_count: 0,
            mean_queue_wait_all_released_s: 1,
            p95_queue_wait_boarded_s: "fast",
            missed_deadline_count: 0,
            clearance_time_s: 10,
          },
          group_metrics: [],
          timeline: [],
          departures_log: [],
        }),
      "p95_queue_wait_boarded_s"
    );
  });

  it("timeline 帧缺 node_queues → bad_response", () => {
    expectBadResponse(
      () =>
        validateSimulationResult({
          schema_version: "1.0",
          engine_version: "e",
          scenario_id: "s",
          scenario_revision: 1,
          plan_id: "p",
          seed: 1,
          status: "invalid",
          violations: [],
          metrics: null,
          group_metrics: [],
          timeline: [
            { t_s: 0, released_count: 0, boarded_count: 0, queued_count: 0, walking_count: 0, edge_counts: {}, group_counts: {} },
          ],
          departures_log: [],
        }),
      "node_queues"
    );
  });

  it("compare.recommendation.status 非法 → bad_response", () => {
    expectBadResponse(
      () =>
        validateCompareResponse({
          results: [],
          recommendation: { plan_id: null, status: "best", reason: "r", tradeoffs: [] },
          trace: [],
          mode: "rules",
        }),
      "recommendation.status"
    );
  });
});

/* ---------- 用 dev-mock 产出的真实形状数据做正例 ---------- */

describe("运行时校验：dev-mock 全链路数据均能通过", () => {
  it("health/parse/generate/simulate/compare 的 mock 响应全部通过校验", async () => {
    const health = await mockApi.health();
    expect(() => validateHealth(health)).not.toThrow();

    const parsed = await mockApi.parseScenario({ scenario: DEFAULT_SCENARIO, instruction: "关闭2号出口，减少一辆车" });
    expect(() => validateParseResponse(parsed)).not.toThrow();
    expect(parsed.patch.length).toBeGreaterThan(0);

    const gen = await mockApi.generatePlans({ scenario: DEFAULT_SCENARIO, objective: "balanced", seed: 20261114 });
    expect(() => validateGenerateResponse(gen)).not.toThrow();
    expect(gen.plans.length).toBe(3);

    const sim = await mockApi.simulate({ scenario: DEFAULT_SCENARIO, plan: gen.plans[0], seed: 20261114 });
    expect(() => validateSimulationResult(sim)).not.toThrow();
    expect(sim.timeline.length).toBeGreaterThan(0);

    const cmp = await mockApi.compare({ scenario: DEFAULT_SCENARIO, plans: gen.plans, seed: 20261114, objective: "balanced" });
    expect(() => validateCompareResponse(cmp)).not.toThrow();
    expect(cmp.results.length).toBe(3);
  });

  it("invalid 方案同样结构合法（metrics 为 null、timeline 为空数组）", async () => {
    const gen = await mockApi.generatePlans({ scenario: DEFAULT_SCENARIO, objective: "balanced", seed: 1 });
    const indep = gen.plans.find((p) => p.strategy === "independent")!;
    const sim = await mockApi.simulate({ scenario: DEFAULT_SCENARIO, plan: indep, seed: 1 });
    expect(() => validateSimulationResult(sim)).not.toThrow();
    expect(sim.status).toBe("invalid");
    expect(sim.metrics).toBeNull();
    expect(sim.violations.length).toBeGreaterThan(0);
  });
});
