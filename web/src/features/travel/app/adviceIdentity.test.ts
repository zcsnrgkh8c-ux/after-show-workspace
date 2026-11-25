/**
 * 建议响应身份守卫回归：
 * 核查报告指出“只做格式校验、未与本次请求比对”——结构合法但 request_id/candidate_set_id
 * 不属于本次请求的响应必须被拒绝。
 */
import { describe, expect, it } from "vitest";
import { matchesAdviceIdentity } from "./adviceIdentity";

const req = { request_id: "req-1", candidate_set_id: "cand-1" };

describe("matchesAdviceIdentity", () => {
  it("两个身份都一致才接受", () => {
    expect(matchesAdviceIdentity({ ...req }, req)).toBe(true);
  });

  it("request_id 不一致（结构合法）必须拒绝", () => {
    expect(matchesAdviceIdentity({ request_id: "req-2", candidate_set_id: "cand-1" }, req)).toBe(false);
  });

  it("candidate_set_id 不一致（同结构不同请求）必须拒绝", () => {
    expect(matchesAdviceIdentity({ request_id: "req-1", candidate_set_id: "cand-2" }, req)).toBe(false);
  });

  it("空串身份不接受（不把缺失当匹配）", () => {
    expect(matchesAdviceIdentity({ request_id: "", candidate_set_id: "cand-1" }, req)).toBe(false);
    expect(matchesAdviceIdentity({ request_id: "req-1", candidate_set_id: "" }, req)).toBe(false);
  });
});
