/**
 * 出行建议编排：优先模型分析，未配置或失败时降级为规则建议。
 * 红线：降级提示固定文案、不含供应商错误细节；rules 结果不得标注为 AI。
 */
import { AdviceRequest, AdviceResponse } from "../../shared/travel.types";
import { adviseWithLlm, travelLlmConfigured } from "./llm";
import { buildRulesAdvice } from "./rules";

const MAX_WARNINGS = 10;
const DEGRADED_WARNING = "模型分析不可用，已降级为基础建议";

/** warnings 满 10 条时替换最后一条，否则追加。 */
function appendWarning(warnings: string[], warning: string): string[] {
  if (warnings.length >= MAX_WARNINGS) {
    return [...warnings.slice(0, MAX_WARNINGS - 1), warning];
  }
  return [...warnings, warning];
}

function isKnownCandidate(req: AdviceRequest, routeId: string): boolean {
  return req.candidates.some((candidate) => candidate.route_id === routeId);
}

export async function buildTravelAdvice(req: AdviceRequest): Promise<AdviceResponse> {
  if (!travelLlmConfigured()) {
    return buildRulesAdvice(req);
  }

  try {
    const llm = await adviseWithLlm(req);
    // 双保险：llm 已校验过，这里仍拒绝指向候选集之外的选择。
    if (llm.selected_route_id !== null && !isKnownCandidate(req, llm.selected_route_id)) {
      throw new Error("selected_route_id 不在候选集内");
    }
    return {
      request_id: req.request_id,
      candidate_set_id: req.candidate_set_id,
      mode: "llm",
      selected_route_id: llm.selected_route_id,
      reason_codes: llm.reason_codes,
      evidence: llm.evidence,
      explanation: llm.explanation,
      warnings: llm.warnings,
      degraded_from: null,
    };
  } catch {
    const fallback = buildRulesAdvice(req);
    return {
      ...fallback,
      degraded_from: "llm",
      warnings: appendWarning(fallback.warnings, DEGRADED_WARNING),
    };
  }
}
