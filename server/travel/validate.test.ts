/**
 * validate.test.ts — travel 建议请求校验器测试。
 * 运行：node --test server/travel/validate.test.ts（Node ≥ 24，零依赖）
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { TRAVEL_LIMITS, validateAdviceRequest } from "./validate.ts";

/* ---------- 工具 ---------- */

function candidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    route_id: "R1",
    mode: "walking",
    distance_m: 1200,
    estimated_duration_s: 900,
    walking_distance_m: 1200,
    transfer_count: null,
    step_free_evidence: "unknown",
    ...overrides,
  };
}

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    request_id: "req-1",
    candidate_set_id: "set-1",
    preference: { preference: "balanced", needs_step_free: false, note: null },
    candidates: [candidate()],
    ...overrides,
  };
}

/** 断言校验失败，返回错误列表（并检查每条消息非空） */
function expectFail(body: unknown): string[] {
  const result = validateAdviceRequest(body);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.ok(result.errors.length > 0, "校验失败时 errors 不能为空");
  for (const message of result.errors) {
    assert.equal(typeof message, "string");
    assert.ok(message.trim().length > 0, "错误消息必须非空");
  }
  return result.errors;
}

/** 断言校验通过，返回归一后的 value */
function expectOk(body: unknown) {
  const result = validateAdviceRequest(body);
  if (!result.ok) throw new Error(`应通过校验，实际错误：${result.errors.join("; ")}`);
  return result.value;
}

/* ---------- 1. 合法请求与归一 ---------- */

test("合法最小请求通过，value 只含契约字段且 note 空串归一为 null", () => {
  const value = expectOk(
    request({
      extra_top: "ignored",
      preference: { preference: "less_walking", needs_step_free: true, note: "", extra: 1 },
      candidates: [candidate({ route_id: "R2", extra: true })],
    }),
  );
  assert.deepEqual(Object.keys(value).sort(), ["candidate_set_id", "candidates", "preference", "request_id"]);
  assert.equal(value.request_id, "req-1");
  assert.equal(value.candidate_set_id, "set-1");
  assert.deepEqual(Object.keys(value.preference).sort(), ["needs_step_free", "note", "preference"]);
  assert.deepEqual(value.preference, { preference: "less_walking", needs_step_free: true, note: null });
  assert.equal(value.candidates.length, 1);
  assert.deepEqual(Object.keys(value.candidates[0]).sort(), [
    "distance_m",
    "estimated_duration_s",
    "mode",
    "route_id",
    "step_free_evidence",
    "transfer_count",
    "walking_distance_m",
  ]);
  assert.equal(value.candidates[0].route_id, "R2");
  assert.equal(value.candidates[0].mode, "walking");
  assert.equal(value.candidates[0].distance_m, 1200);
  assert.equal(value.candidates[0].transfer_count, null);
  assert.equal(value.candidates[0].step_free_evidence, "unknown");
});

test("边界值合法：指标取 0 与上限、note 恰好 200 字符、6 条候选", () => {
  const note = "a".repeat(TRAVEL_LIMITS.MAX_NOTE_CHARS);
  const candidates = Array.from({ length: TRAVEL_LIMITS.MAX_CANDIDATES }, (_, i) =>
    candidate({
      route_id: `R${i + 1}`,
      distance_m: i === 0 ? 0 : TRAVEL_LIMITS.DISTANCE_M_MAX,
      estimated_duration_s: i === 0 ? 0 : TRAVEL_LIMITS.DURATION_S_MAX,
      transfer_count: i === 0 ? 0 : TRAVEL_LIMITS.TRANSFER_MAX,
      step_free_evidence: i === 0 ? "satisfied" : "unsatisfied",
    }),
  );
  const value = expectOk(request({ preference: { preference: "less_transfer", needs_step_free: false, note }, candidates }));
  assert.equal(value.candidates.length, 6);
  assert.equal(value.candidates[0].distance_m, 0);
  assert.equal(value.candidates[0].estimated_duration_s, 0);
  assert.equal(value.candidates[1].distance_m, TRAVEL_LIMITS.DISTANCE_M_MAX);
  assert.equal(value.candidates[1].estimated_duration_s, TRAVEL_LIMITS.DURATION_S_MAX);
  assert.equal(value.candidates[1].transfer_count, TRAVEL_LIMITS.TRANSFER_MAX);
  assert.equal(value.preference.note, note);
});

test("note 为空串/纯空白时合法且 value 中归一为 null", () => {
  for (const note of ["", "   ", " \n\t "]) {
    const value = expectOk(request({ preference: { preference: "balanced", needs_step_free: false, note } }));
    assert.equal(value.preference.note, null);
  }
});

/* ---------- 2. 非法 body 形态 ---------- */

test("body 为数组/字符串/null/数字/布尔时拒绝", () => {
  for (const body of [[], ["x"], "text", null, 42, true]) {
    const errors = expectFail(body);
    assert.deepEqual(errors, ["请求体必须是 JSON 对象"]);
  }
});

/* ---------- 3. 缺字段 ---------- */

test("缺少全部顶层字段时逐字段报出 5 条错误", () => {
  const errors = expectFail({});
  assert.equal(errors.length, 5);
  assert.ok(errors.some((m) => m.includes("request_id")));
  assert.ok(errors.some((m) => m.includes("candidate_set_id")));
  assert.ok(errors.some((m) => m.includes("preference")));
  assert.ok(errors.filter((m) => m.includes("candidates")).length === 2); // 非数组 + 数量不足
});

/* ---------- 4. ID 校验 ---------- */

test("request_id/candidate_set_id 超长、空串、纯空白、非字符串均拒绝", () => {
  const long = "x".repeat(TRAVEL_LIMITS.MAX_ID_CHARS + 1);
  for (const field of ["request_id", "candidate_set_id"] as const) {
    for (const bad of [long, "", "   ", 123, null]) {
      const errors = expectFail(request({ [field]: bad }));
      assert.ok(
        errors.some((m) => m.includes(field)),
        `${field}=${JSON.stringify(bad)} 应报错并含字段名：${errors.join("; ")}`,
      );
    }
  }
  expectOk(request({ request_id: "x".repeat(TRAVEL_LIMITS.MAX_ID_CHARS) })); // 恰好 64 字符合法
});

/* ---------- 5. candidates 数量 ---------- */

test("candidates 0 条与 7 条均拒绝且报数量上下限", () => {
  const empty = expectFail(request({ candidates: [] }));
  assert.ok(empty.some((m) => m.includes("candidates") && m.includes("少于") && m.includes("1")));
  const seven = expectFail(
    request({ candidates: Array.from({ length: 7 }, (_, i) => candidate({ route_id: `R${i}` })) }),
  );
  assert.ok(seven.some((m) => m.includes("candidates") && m.includes("超过") && m.includes("6")));
});

/* ---------- 6. 重复 route_id ---------- */

test("重复 route_id 拒绝且报重复", () => {
  const errors = expectFail(
    request({ candidates: [candidate({ route_id: "R9" }), candidate({ route_id: "R9", distance_m: 2000 })] }),
  );
  assert.ok(errors.some((m) => m.includes("route_id") && m.includes("重复")));
});

/* ---------- 7. mode 校验 ---------- */

test("mode 非 walking（含缺失与大小写不符）拒绝", () => {
  for (const mode of ["transit", "Walking", "", null, 1, true]) {
    const errors = expectFail(request({ candidates: [candidate({ mode })] }));
    assert.ok(
      errors.some((m) => m.includes("mode")),
      `mode=${JSON.stringify(mode)} 应报错并含字段名：${errors.join("; ")}`,
    );
  }
  const missing = expectFail(request({ candidates: [candidate({ mode: undefined })] }));
  assert.ok(missing.some((m) => m.includes("mode")));
});

/* ---------- 8. 指标校验 ---------- */

test("指标负数、NaN/Infinity、字符串数字、对象均拒绝且含字段名", () => {
  const metricFields = ["distance_m", "walking_distance_m", "estimated_duration_s", "transfer_count"] as const;
  for (const field of metricFields) {
    for (const bad of [-1, "100", NaN, Infinity, -Infinity, {}, true]) {
      const errors = expectFail(request({ candidates: [candidate({ [field]: bad })] }));
      assert.ok(
        errors.some((m) => m.includes(field)),
        `${field}=${String(bad)} 应报错并含字段名：${errors.join("; ")}`,
      );
    }
  }
});

test("各指标恰好越界（上限+1）拒绝且报范围", () => {
  const cases = [
    ["distance_m", TRAVEL_LIMITS.DISTANCE_M_MAX],
    ["walking_distance_m", TRAVEL_LIMITS.DISTANCE_M_MAX],
    ["estimated_duration_s", TRAVEL_LIMITS.DURATION_S_MAX],
    ["transfer_count", TRAVEL_LIMITS.TRANSFER_MAX],
  ] as const;
  for (const [field, limit] of cases) {
    const errors = expectFail(request({ candidates: [candidate({ [field]: limit + 1 })] }));
    assert.ok(
      errors.some((m) => m.includes(field) && m.includes("范围")),
      `${field}=${limit + 1} 应报范围错误：${errors.join("; ")}`,
    );
  }
});

/* ---------- 9. step_free_evidence 校验 ---------- */

test("step_free_evidence 非法枚举（含缺失与大小写不符）拒绝", () => {
  for (const bad of ["yes", "SATISFIED", "", null, 1, true]) {
    const errors = expectFail(request({ candidates: [candidate({ step_free_evidence: bad })] }));
    assert.ok(
      errors.some((m) => m.includes("step_free_evidence")),
      `step_free_evidence=${JSON.stringify(bad)} 应报错：${errors.join("; ")}`,
    );
  }
  const noEvidence = candidate();
  delete noEvidence.step_free_evidence;
  const missing = expectFail(request({ candidates: [noEvidence] }));
  assert.ok(missing.some((m) => m.includes("step_free_evidence")));
});

/* ---------- 10. preference 与 note 校验 ---------- */

test("note 超长/非 null 非字符串拒绝", () => {
  const longNote = expectFail(
    request({ preference: { preference: "balanced", needs_step_free: false, note: "a".repeat(TRAVEL_LIMITS.MAX_NOTE_CHARS + 1) } }),
  );
  assert.ok(longNote.some((m) => m.includes("note")));
  for (const badNote of [123, true, {}]) {
    const errors = expectFail(request({ preference: { preference: "balanced", needs_step_free: false, note: badNote } }));
    assert.ok(errors.some((m) => m.includes("note")));
  }
});

test("preference 非法枚举、needs_step_free 非严格 boolean、preference 非对象均拒绝", () => {
  const badPref = expectFail(request({ preference: { preference: "fastest", needs_step_free: false, note: null } }));
  assert.ok(badPref.some((m) => m.includes("preference.preference")));
  for (const badBool of ["true", 1, null, 0]) {
    const errors = expectFail(request({ preference: { preference: "balanced", needs_step_free: badBool, note: null } }));
    assert.ok(errors.some((m) => m.includes("needs_step_free")));
  }
  const notObject = expectFail(request({ preference: "balanced" }));
  assert.ok(notObject.some((m) => m.includes("preference")));
});

/* ---------- 11. 全量收集与消息契约 ---------- */

test("多处非法时不短路，一次收集全部 8 条错误", () => {
  const errors = expectFail(
    request({
      request_id: "",
      candidate_set_id: "x".repeat(65),
      preference: { preference: "fastest", needs_step_free: "yes", note: 1 },
      candidates: [candidate({ mode: "transit", distance_m: -5, step_free_evidence: "maybe" })],
    }),
  );
  // request_id + candidate_set_id + preference.preference + needs_step_free + note + mode + distance_m + step_free_evidence
  assert.equal(errors.length, 8);
});

test("错误消息契约：非空且包含字段名", () => {
  const invalidBodies: unknown[] = [
    null,
    [],
    {},
    request({ request_id: null }),
    request({ candidate_set_id: "" }),
    request({ preference: null }),
    request({ preference: { preference: "x", needs_step_free: 0, note: -1 } }),
    request({ candidates: [] }),
    request({ candidates: "R1" }),
    request({ candidates: [null, 3] }),
    request({ candidates: [candidate({ route_id: "" })] }),
    request({ candidates: [candidate({ route_id: "A" }), candidate({ route_id: "A" })] }),
    request({ candidates: [candidate({ mode: "bus" })] }),
    request({ candidates: [candidate({ distance_m: 999999 })] }),
    request({ candidates: [candidate({ estimated_duration_s: "900" })] }),
    request({ candidates: [candidate({ transfer_count: 99 })] }),
    request({ candidates: [candidate({ step_free_evidence: "unknown?" })] }),
    request({ preference: { preference: "balanced", needs_step_free: true, note: "n".repeat(201) } }),
  ];
  const fieldHints = [
    "请求体",
    "request_id",
    "candidate_set_id",
    "preference",
    "candidates",
    "route_id",
    "mode",
    "distance_m",
    "estimated_duration_s",
    "transfer_count",
    "step_free_evidence",
    "note",
    "needs_step_free",
  ];
  for (const body of invalidBodies) {
    const result = validateAdviceRequest(body);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.ok(result.errors.length > 0);
    for (const message of result.errors) {
      assert.ok(message.trim().length > 0, "错误消息必须非空");
      assert.ok(
        fieldHints.some((hint) => message.includes(hint)),
        `错误消息应包含字段名："${message}"`,
      );
    }
  }
});
