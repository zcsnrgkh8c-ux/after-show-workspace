/**
 * 出行建议 HTTP 入口（POST /api/travel/advice）：
 * 先做请求体结构校验，失败抛 400 invalid_request（details 为错误消息数组），
 * 通过后进入 LLM→rules 编排。
 */
import { AdviceResponse } from "../../shared/travel.types";
import { ApiError } from "../api/handlers";
import { buildTravelAdvice } from "./advice";
import { validateAdviceRequest } from "./validate";

export async function travelAdvice(body: unknown): Promise<AdviceResponse> {
  const validation = validateAdviceRequest(body);
  if (!validation.ok) {
    throw new ApiError(
      400,
      "invalid_request",
      validation.errors[0] ?? "出行建议请求参数不合法",
      validation.errors,
    );
  }
  return buildTravelAdvice(validation.value);
}
