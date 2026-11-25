/**
 * validate.ts — travel 建议请求校验器（POST /api/travel/advice 唯一入口校验）。
 * 契约源：shared/travel.types.ts（AdviceRequest / RouteCandidateSummary / TravelPreference）。
 * 原则：
 * - 不提前短路：一次收集全部字段错误，便于调用方定位修复；
 * - 只输出契约字段：多余字段丢弃，note 空串归一为 null；
 * - 数字红线：null 表示高德未返回该指标，NaN/Infinity 一律非法。
 */

import type {
  AdviceRequest,
  PreferenceKind,
  RouteCandidateSummary,
  StepFreeEvidence,
  TravelPreference,
} from "../../shared/travel.types.ts";

/** travel 输入护栏（口径与 web/src/features/travel/app/CONTRACT.md 一致） */
export const TRAVEL_LIMITS = {
  MAX_CANDIDATES: 6,
  MIN_CANDIDATES: 1,
  MAX_NOTE_CHARS: 200,
  MAX_ID_CHARS: 64,
  MAX_EXPLANATION_CHARS: 500,
  MAX_WARNINGS: 10,
  MAX_WARNING_CHARS: 200,
  DISTANCE_M_MAX: 200000,
  DURATION_S_MAX: 172800,
  TRANSFER_MAX: 10,
} as const;

export type TravelValidation<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const PREFERENCES: readonly string[] = ["balanced", "less_walking", "less_transfer"];
const STEP_FREE_EVIDENCE_VALUES: readonly string[] = ["unknown", "satisfied", "unsatisfied"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** 非空字符串、长度 ≤ MAX_ID_CHARS 且 trim 后非空；失败写入错误并返回 null。 */
function validateId(value: unknown, field: string, errors: string[]): string | null {
  if (typeof value !== "string" || value.length === 0) {
    errors.push(`${field} 必须是非空字符串`);
    return null;
  }
  if (value.length > TRAVEL_LIMITS.MAX_ID_CHARS) {
    errors.push(`${field} 长度超过上限 ${TRAVEL_LIMITS.MAX_ID_CHARS}`);
    return null;
  }
  if (value.trim().length === 0) {
    errors.push(`${field} 不能为空白字符串`);
    return null;
  }
  return value;
}

/** null（高德未返回该指标）或有限数字 ∈ [0, max]；NaN/Infinity 非法。 */
function validateMetric(value: unknown, field: string, max: number, errors: string[]): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    errors.push(`${field} 必须为 null 或有限数字`);
    return null;
  }
  if (value < 0 || value > max) {
    errors.push(`${field} 超出允许范围 0~${max}`);
    return null;
  }
  return value;
}

function validatePreference(raw: unknown, errors: string[]): TravelPreference | null {
  if (!isRecord(raw)) {
    errors.push("preference 必须是对象");
    return null;
  }

  let valid = true;

  const pref = raw.preference;
  if (typeof pref !== "string" || !PREFERENCES.includes(pref)) {
    errors.push("preference.preference 必须为 balanced | less_walking | less_transfer");
    valid = false;
  }
  if (typeof raw.needs_step_free !== "boolean") {
    errors.push("preference.needs_step_free 必须为 boolean");
    valid = false;
  }

  // note：null 或 ≤200 字符字符串；空串/纯空白视为未填写，value 中归一为 null
  let note: string | null = null;
  const rawNote = raw.note;
  if (typeof rawNote === "string") {
    if (rawNote.length > TRAVEL_LIMITS.MAX_NOTE_CHARS) {
      errors.push(`preference.note 长度超过上限 ${TRAVEL_LIMITS.MAX_NOTE_CHARS}`);
      valid = false;
    } else if (rawNote.trim().length > 0) {
      note = rawNote;
    }
  } else if (rawNote !== null) {
    errors.push("preference.note 必须为 null 或字符串");
    valid = false;
  }

  if (!valid) return null;
  return {
    preference: pref as PreferenceKind,
    needs_step_free: raw.needs_step_free as boolean,
    note,
  };
}

function validateCandidate(
  raw: unknown,
  index: number,
  seenRouteIds: Set<string>,
  errors: string[],
): RouteCandidateSummary | null {
  const field = `candidates[${index}]`;
  if (!isRecord(raw)) {
    errors.push(`${field} 必须是对象`);
    return null;
  }
  const before = errors.length;

  const routeId = validateId(raw.route_id, `${field}.route_id`, errors);
  if (routeId !== null) {
    if (seenRouteIds.has(routeId)) {
      errors.push(`${field}.route_id "${routeId}" 在集合内重复`);
    } else {
      seenRouteIds.add(routeId);
    }
  }

  if (raw.mode !== "walking") {
    errors.push(`${field}.mode 必须为 "walking"`);
  }

  const distanceM = validateMetric(raw.distance_m, `${field}.distance_m`, TRAVEL_LIMITS.DISTANCE_M_MAX, errors);
  const walkingDistanceM = validateMetric(
    raw.walking_distance_m,
    `${field}.walking_distance_m`,
    TRAVEL_LIMITS.DISTANCE_M_MAX,
    errors,
  );
  const estimatedDurationS = validateMetric(
    raw.estimated_duration_s,
    `${field}.estimated_duration_s`,
    TRAVEL_LIMITS.DURATION_S_MAX,
    errors,
  );
  const transferCount = validateMetric(raw.transfer_count, `${field}.transfer_count`, TRAVEL_LIMITS.TRANSFER_MAX, errors);

  const evidence = raw.step_free_evidence;
  if (typeof evidence !== "string" || !STEP_FREE_EVIDENCE_VALUES.includes(evidence)) {
    errors.push(`${field}.step_free_evidence 必须为 unknown | satisfied | unsatisfied`);
  }

  if (errors.length > before || routeId === null) return null;
  return {
    route_id: routeId,
    mode: "walking",
    distance_m: distanceM,
    estimated_duration_s: estimatedDurationS,
    walking_distance_m: walkingDistanceM,
    transfer_count: transferCount,
    step_free_evidence: evidence as StepFreeEvidence,
  };
}

/** 校验 POST /api/travel/advice 请求体；失败时 errors 汇总全部字段问题（不短路）。 */
export function validateAdviceRequest(body: unknown): TravelValidation<AdviceRequest> {
  if (!isRecord(body)) {
    return { ok: false, errors: ["请求体必须是 JSON 对象"] };
  }

  const errors: string[] = [];

  const requestId = validateId(body.request_id, "request_id", errors);
  const candidateSetId = validateId(body.candidate_set_id, "candidate_set_id", errors);
  const preference = validatePreference(body.preference, errors);

  if (!Array.isArray(body.candidates)) {
    errors.push("candidates 必须为数组");
  }
  const rawCandidates: unknown[] = Array.isArray(body.candidates) ? body.candidates : [];
  if (rawCandidates.length < TRAVEL_LIMITS.MIN_CANDIDATES) {
    errors.push(`candidates 数量少于下限 ${TRAVEL_LIMITS.MIN_CANDIDATES}`);
  }
  if (rawCandidates.length > TRAVEL_LIMITS.MAX_CANDIDATES) {
    errors.push(`candidates 数量超过上限 ${TRAVEL_LIMITS.MAX_CANDIDATES}`);
  }

  const seenRouteIds = new Set<string>();
  const candidates: RouteCandidateSummary[] = [];
  for (let i = 0; i < rawCandidates.length; i += 1) {
    const candidate = validateCandidate(rawCandidates[i], i, seenRouteIds, errors);
    if (candidate !== null) candidates.push(candidate);
  }

  if (errors.length > 0 || requestId === null || candidateSetId === null || preference === null) {
    return { ok: false, errors };
  }

  // 只保留契约字段（多余字段丢弃）；note 空串已在 preference 校验中归一为 null
  const value: AdviceRequest = {
    request_id: requestId,
    candidate_set_id: candidateSetId,
    preference,
    candidates,
  };
  return { ok: true, value };
}
