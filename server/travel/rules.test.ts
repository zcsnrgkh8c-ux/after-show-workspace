/**
 * rules.ts 单元测试：确定性规则建议的排序、闸门与"不伪造事实"红线。
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  AdviceRequest,
  RouteCandidateSummary,
} from "../../shared/travel.types";
import { buildRulesAdvice } from "./rules";

function candidate(overrides: Partial<RouteCandidateSummary> & { route_id: string }): RouteCandidateSummary {
  return {
    mode: "walking",
    distance_m: null,
    estimated_duration_s: null,
    walking_distance_m: null,
    transfer_count: null,
    step_free_evidence: "unknown",
    ...overrides,
  };
}

function request(
  candidates: RouteCandidateSummary[],
  overrides?: Partial<Pick<AdviceRequest, "request_id" | "candidate_set_id">> & {
    preference?: "balanced" | "less_walking" | "less_transfer";
    needs_step_free?: boolean;
  },
): AdviceRequest {
  return {
    request_id: overrides?.request_id ?? "req-1",
    candidate_set_id: overrides?.candidate_set_id ?? "cand-1",
    preference: {
      preference: overrides?.preference ?? "balanced",
      needs_step_free: overrides?.needs_step_free ?? false,
      note: null,
    },
    candidates,
  };
}

describe("buildRulesAdvice 基础语义", () => {
  it("回显请求身份，mode=rules，degraded_from=null", () => {
    const result = buildRulesAdvice(
      request([candidate({ route_id: "amap-r1" })], { request_id: "req-x", candidate_set_id: "cand-y" }),
    );
    assert.equal(result.request_id, "req-x");
    assert.equal(result.candidate_set_id, "cand-y");
    assert.equal(result.mode, "rules");
    assert.equal(result.degraded_from, null);
  });

  it("单候选：single_candidate，不做多路线择优宣称", () => {
    const result = buildRulesAdvice(
      request([candidate({ route_id: "amap-r1", distance_m: 850, estimated_duration_s: 720 })]),
    );
    assert.equal(result.selected_route_id, "amap-r1");
    assert.deepEqual(result.reason_codes, ["single_candidate"]);
    assert.ok(result.explanation.includes("唯一"));
    assert.ok(result.explanation.includes("未进行多路线择优"));
    assert.ok(result.explanation.includes("850 米"));
  });

  it("balanced：按预计耗时升序选择，理由 shorter_duration，证据含双方时长", () => {
    const result = buildRulesAdvice(
      request([
        candidate({ route_id: "r-slow", estimated_duration_s: 900 }),
        candidate({ route_id: "r-fast", estimated_duration_s: 600 }),
      ]),
    );
    assert.equal(result.selected_route_id, "r-fast");
    assert.deepEqual(result.reason_codes, ["shorter_duration"]);
    assert.ok(result.evidence.some((e) => e.route_id === "r-fast" && e.metric === "estimated_duration_s"));
    assert.ok(result.evidence.some((e) => e.route_id === "r-slow" && e.metric === "estimated_duration_s"));
  });

  it("balanced：时长并列时按步行距离决胜，理由 less_walking", () => {
    const result = buildRulesAdvice(
      request([
        candidate({ route_id: "r-a", estimated_duration_s: 600, walking_distance_m: 1000 }),
        candidate({ route_id: "r-b", estimated_duration_s: 600, walking_distance_m: 500 }),
      ]),
    );
    assert.equal(result.selected_route_id, "r-b");
    assert.deepEqual(result.reason_codes, ["less_walking"]);
  });

  it("balanced：时长全部缺失 → balanced_default + 如实 warning，不宣称更短", () => {
    const result = buildRulesAdvice(
      request([
        candidate({ route_id: "r-1" }),
        candidate({ route_id: "r-2" }),
      ]),
    );
    assert.equal(result.reason_codes.includes("shorter_duration"), false);
    assert.equal(result.reason_codes.includes("balanced_default"), true);
    assert.ok(result.warnings.some((w) => w.includes("预计耗时缺失")));
  });
});

describe("buildRulesAdvice 偏好比较", () => {
  it("less_walking：优先用 walking_distance_m 比较（distance 不同也不干扰）", () => {
    const result = buildRulesAdvice(
      request(
        [
          candidate({ route_id: "r-long", walking_distance_m: 1000, distance_m: 800 }),
          candidate({ route_id: "r-short", walking_distance_m: 500, distance_m: 900 }),
        ],
        { preference: "less_walking" },
      ),
    );
    assert.equal(result.selected_route_id, "r-short");
    assert.deepEqual(result.reason_codes, ["less_walking"]);
    assert.ok(result.evidence.every((e) => e.metric === "walking_distance_m"));
  });

  it("less_walking：指标全缺失时退回时长排序，理由 balanced_default + warning", () => {
    const result = buildRulesAdvice(
      request(
        [
          candidate({ route_id: "r-1", estimated_duration_s: 900 }),
          candidate({ route_id: "r-2", estimated_duration_s: 600 }),
        ],
        { preference: "less_walking" },
      ),
    );
    assert.equal(result.selected_route_id, "r-2");
    assert.equal(result.reason_codes.includes("less_walking"), false);
    assert.equal(result.reason_codes.includes("balanced_default"), true);
    assert.ok(result.warnings.some((w) => w.includes("步行距离缺失")));
  });

  it("less_walking：步行距离并列时退回时长并如实说明", () => {
    const result = buildRulesAdvice(
      request(
        [
          candidate({ route_id: "r-1", walking_distance_m: 800, estimated_duration_s: 900 }),
          candidate({ route_id: "r-2", walking_distance_m: 800, estimated_duration_s: 600 }),
        ],
        { preference: "less_walking" },
      ),
    );
    assert.equal(result.selected_route_id, "r-2");
    assert.equal(result.reason_codes.includes("less_walking"), false);
    assert.ok(result.warnings.some((w) => w.includes("相同")));
  });

  it("less_transfer：步行模式换乘全 0（相同）→ 退回时长排序 + warning", () => {
    const result = buildRulesAdvice(
      request(
        [
          candidate({ route_id: "r-1", transfer_count: 0, estimated_duration_s: 900 }),
          candidate({ route_id: "r-2", transfer_count: 0, estimated_duration_s: 600 }),
        ],
        { preference: "less_transfer" },
      ),
    );
    assert.equal(result.selected_route_id, "r-2");
    assert.equal(result.reason_codes.includes("fewer_transfers"), false);
    assert.ok(result.warnings.some((w) => w.includes("换乘")));
  });
});

describe("buildRulesAdvice 无台阶闸门", () => {
  it("需求为真且全部 unknown → selected=null，warning 尚未核实，不推荐", () => {
    const result = buildRulesAdvice(
      request(
        [candidate({ route_id: "r-1" }), candidate({ route_id: "r-2" })],
        { needs_step_free: true },
      ),
    );
    assert.equal(result.selected_route_id, null);
    assert.deepEqual(result.reason_codes, ["no_candidate_meets_preference"]);
    assert.ok(result.warnings.some((w) => w.includes("尚未核实")));
  });

  it("需求为真且全部 unsatisfied → selected=null", () => {
    const result = buildRulesAdvice(
      request(
        [
          candidate({ route_id: "r-1", step_free_evidence: "unsatisfied" }),
          candidate({ route_id: "r-2", step_free_evidence: "unsatisfied" }),
        ],
        { needs_step_free: true },
      ),
    );
    assert.equal(result.selected_route_id, null);
    assert.ok(result.warnings.some((w) => w.includes("没有候选确认")));
  });

  it("需求为真且部分 satisfied → 只在 satisfied 中比较选择", () => {
    const result = buildRulesAdvice(
      request(
        [
          candidate({ route_id: "r-unknown", estimated_duration_s: 100, step_free_evidence: "unknown" }),
          candidate({ route_id: "r-ok-fast", estimated_duration_s: 300, step_free_evidence: "satisfied" }),
          candidate({ route_id: "r-ok-slow", estimated_duration_s: 900, step_free_evidence: "satisfied" }),
          candidate({ route_id: "r-bad", estimated_duration_s: 50, step_free_evidence: "unsatisfied" }),
        ],
        { needs_step_free: true },
      ),
    );
    assert.equal(result.selected_route_id, "r-ok-fast");
    assert.deepEqual(result.reason_codes, ["shorter_duration", "step_free_satisfied"]);
    assert.ok(result.evidence.some((e) => e.route_id === "r-ok-fast" && e.metric === "step_free_evidence"));
    assert.equal(result.evidence.some((e) => e.route_id === "r-unknown"), false);
    assert.equal(result.evidence.some((e) => e.route_id === "r-bad"), false);
  });
});

describe("buildRulesAdvice 证据与输出约束", () => {
  it("证据引用不指向 null 指标", () => {
    const result = buildRulesAdvice(
      request([
        candidate({ route_id: "r-1", estimated_duration_s: 600, walking_distance_m: null }),
        candidate({ route_id: "r-2", estimated_duration_s: 900, walking_distance_m: 400 }),
      ]),
    );
    for (const e of result.evidence) {
      const target = result.evidence.length > 0 ? [candidate({ route_id: "r-1", estimated_duration_s: 600 }), candidate({ route_id: "r-2", estimated_duration_s: 900, walking_distance_m: 400 })] : [];
      if (e.metric === "walking_distance_m") {
        const c = target.find((x) => x.route_id === e.route_id);
        if (c) assert.notEqual(c.walking_distance_m, null);
      }
    }
    assert.equal(result.evidence.some((e) => e.route_id === "r-1" && e.metric === "walking_distance_m"), false);
  });

  it("explanation ≤500 字符且数字来自候选事实", () => {
    const result = buildRulesAdvice(
      request([
        candidate({ route_id: "r-1", estimated_duration_s: 1500, walking_distance_m: 1200 }),
        candidate({ route_id: "r-2", estimated_duration_s: 600, walking_distance_m: 850 }),
      ]),
    );
    assert.ok(result.explanation.length <= 500);
    assert.ok(result.explanation.includes("850 米"));
  });

  it("全部候选时长并列且步行并列 → balanced_default + warning", () => {
    const result = buildRulesAdvice(
      request([
        candidate({ route_id: "r-1", estimated_duration_s: 600, walking_distance_m: 800 }),
        candidate({ route_id: "r-2", estimated_duration_s: 600, walking_distance_m: 800 }),
      ]),
    );
    assert.equal(result.reason_codes.includes("shorter_duration"), false);
    assert.equal(result.reason_codes.includes("balanced_default"), true);
    assert.ok(result.warnings.some((w) => w.includes("均相同")));
  });
});
