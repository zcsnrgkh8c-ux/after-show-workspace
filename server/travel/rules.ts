/**
 * 规则建议引擎：确定性、纯函数，只依据候选已有事实做选择与解释。
 * 红线：比较性理由必须能由候选非 null 指标验证；指标缺失不得宣称更优；
 * 无台阶 unknown 不得当作满足；不伪造任何数字。
 */
import {
  AdviceEvidenceRef,
  AdviceMetricField,
  AdviceReasonCode,
  AdviceRequest,
  AdviceResponse,
  RouteCandidateSummary,
} from "../../shared/travel.types";

const MAX_EXPLANATION_CHARS = 500;
const MAX_WARNINGS = 10;
const MAX_WARNING_CHARS = 200;

/** 少步行比较口径：优先 walking_distance_m，缺失退回 distance_m。 */
function effectiveWalking(c: RouteCandidateSummary): number | null {
  return c.walking_distance_m ?? c.distance_m;
}

function metricValue(c: RouteCandidateSummary, metric: AdviceMetricField): number | null {
  if (metric === "step_free_evidence") return null;
  const raw = c[metric];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function fmtMinutes(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  return minutes < 1 ? "不到 1 分钟" : `${minutes} 分钟`;
}

function fmtMeters(meters: number): string {
  return `${Math.round(meters)} 米`;
}

interface CompareResult {
  /** 排序后的候选（含 null 指标者垫底，按原顺序） */
  ordered: RouteCandidateSummary[];
  /** 选中候选的该指标是否严格优于至少一个其他候选 */
  strictlyBetter: boolean;
  /** 第一个严格劣于选中者的候选（用于对比说明） */
  runnerUp: RouteCandidateSummary | null;
  /** 是否存在任何非 null 指标可用于比较 */
  hasAnyValue: boolean;
  /** 全部非 null 值是否相等（相等时不得宣称更优） */
  allEqual: boolean;
}

/**
 * 按指标升序挑选：null 指标候选不参与排名（垫底，保持原顺序）。
 * strictlyBetter=false 时调用方不得使用该指标的比较性理由。
 */
function pickBy(
  pool: RouteCandidateSummary[],
  metric: AdviceMetricField,
): CompareResult {
  const entries = pool.map((candidate, index) => ({
    candidate,
    index,
    value: metricValue(candidate, metric),
  }));
  const valid = entries.filter((e) => e.value !== null);
  const sorted = [...valid].sort((a, b) =>
    (a.value as number) !== (b.value as number)
      ? (a.value as number) - (b.value as number)
      : a.index - b.index,
  );
  const ordered = [
    ...sorted.map((e) => e.candidate),
    ...entries.filter((e) => e.value === null).map((e) => e.candidate),
  ];
  if (valid.length === 0) {
    return { ordered, strictlyBetter: false, runnerUp: null, hasAnyValue: false, allEqual: false };
  }
  const best = sorted[0].value as number;
  const firstWorse = sorted.find((e) => (e.value as number) > best);
  const values = valid.map((e) => e.value as number);
  return {
    ordered,
    strictlyBetter: firstWorse !== undefined,
    runnerUp: firstWorse !== undefined ? firstWorse.candidate : null,
    hasAnyValue: true,
    allEqual: firstWorse === undefined,
  };
}

function ref(routeId: string, metric: AdviceMetricField): AdviceEvidenceRef {
  return { route_id: routeId, metric };
}

function pushWarning(warnings: string[], text: string): void {
  const trimmed = text.slice(0, MAX_WARNING_CHARS);
  if (!warnings.includes(trimmed) && warnings.length < MAX_WARNINGS) {
    warnings.push(trimmed);
  }
}

/** 描述文本（不含数字的事实性短语），供 explanation 拼接。 */
function describeCandidate(c: RouteCandidateSummary): string {
  const parts: string[] = [];
  const walking = effectiveWalking(c);
  if (walking !== null) parts.push(`预计步行 ${fmtMeters(walking)}`);
  if (c.estimated_duration_s !== null) parts.push(`预计耗时 ${fmtMinutes(c.estimated_duration_s)}`);
  return parts.length > 0 ? `（${parts.join("、")}）` : "";
}

export function buildRulesAdvice(req: AdviceRequest): AdviceResponse {
  const { preference, needs_step_free } = req.preference;
  const all = req.candidates;
  const warnings: string[] = [];
  const reasonCodes: AdviceReasonCode[] = [];
  const evidence: AdviceEvidenceRef[] = [];

  /* ---------- 无台阶硬需求闸门 ---------- */
  let pool: RouteCandidateSummary[];
  if (needs_step_free) {
    const unknownExists = all.some((c) => c.step_free_evidence === "unknown");
    pool = all.filter((c) => c.step_free_evidence === "satisfied");
    if (pool.length === 0) {
      if (unknownExists) {
        pushWarning(warnings, "无台阶通行情况尚未核实");
        return assemble(
          req,
          null,
          ["no_candidate_meets_preference"],
          [],
          "没有候选确认满足无台阶需求：现有候选的无台阶情况尚未核实，无法据其宣称满足，暂不推荐。",
          warnings,
        );
      }
      pushWarning(warnings, "没有候选确认满足无台阶需求");
      return assemble(
        req,
        null,
        ["no_candidate_meets_preference"],
        [],
        "没有候选确认满足无台阶需求，暂不推荐。",
        warnings,
      );
    }
  } else {
    pool = [...all];
  }

  /* ---------- 单候选 ---------- */
  if (pool.length === 1) {
    const only = pool[0];
    reasonCodes.push("single_candidate");
    if (needs_step_free) {
      reasonCodes.push("step_free_satisfied");
      evidence.push(ref(only.route_id, "step_free_evidence"));
    }
    const detail = describeCandidate(only);
    const explanation =
      detail !== ""
        ? `候选 ${only.route_id} 是当前唯一可用路线${detail}。当前仅有一条候选，未进行多路线择优。`
        : `候选 ${only.route_id} 是当前唯一可用路线，指标信息不足。当前仅有一条候选，未进行多路线择优。`;
    return assemble(req, only, reasonCodes, evidence, explanation, warnings);
  }

  /* ---------- 多候选按偏好选择 ---------- */
  let selected: RouteCandidateSummary;
  let primaryMetric: AdviceMetricField | null = null;
  let fallback = false;

  if (preference === "less_walking") {
    const walk = pickBy(pool, "walking_distance_m");
    if (walk.hasAnyValue && walk.strictlyBetter) {
      selected = walk.ordered[0];
      primaryMetric = "walking_distance_m";
      if (walk.runnerUp !== null) {
        evidence.push(ref(selected.route_id, "walking_distance_m"));
        evidence.push(ref(walk.runnerUp.route_id, "walking_distance_m"));
      }
    } else {
      fallback = true;
      if (!walk.hasAnyValue) {
        pushWarning(warnings, "步行距离缺失，无法按少步行比较，已按预计耗时排序");
      } else {
        pushWarning(warnings, "各候选步行距离相同，已按预计耗时排序");
      }
      const duration = pickBy(pool, "estimated_duration_s");
      selected = duration.ordered[0];
      if (duration.hasAnyValue && duration.strictlyBetter) {
        // 仍按契约要求使用 balanced_default，不做二次比较性宣称
        if (duration.runnerUp !== null) {
          evidence.push(ref(selected.route_id, "estimated_duration_s"));
          evidence.push(ref(duration.runnerUp.route_id, "estimated_duration_s"));
        }
      }
    }
  } else if (preference === "less_transfer") {
    const transfer = pickBy(pool, "transfer_count");
    if (transfer.hasAnyValue && transfer.strictlyBetter) {
      selected = transfer.ordered[0];
      primaryMetric = "transfer_count";
      if (transfer.runnerUp !== null) {
        evidence.push(ref(selected.route_id, "transfer_count"));
        evidence.push(ref(transfer.runnerUp.route_id, "transfer_count"));
      }
    } else {
      fallback = true;
      if (!transfer.hasAnyValue) {
        pushWarning(warnings, "换乘信息缺失，无法按少换乘比较，已按预计耗时排序");
      } else {
        pushWarning(warnings, "各候选换乘次数相同，已按预计耗时排序");
      }
      const duration = pickBy(pool, "estimated_duration_s");
      selected = duration.ordered[0];
      if (duration.hasAnyValue && duration.strictlyBetter) {
        if (duration.runnerUp !== null) {
          evidence.push(ref(selected.route_id, "estimated_duration_s"));
          evidence.push(ref(duration.runnerUp.route_id, "estimated_duration_s"));
        }
      }
    }
  } else {
    // balanced：时长优先，并列时用步行距离决胜
    const duration = pickBy(pool, "estimated_duration_s");
    if (duration.hasAnyValue && duration.strictlyBetter) {
      selected = duration.ordered[0];
      primaryMetric = "estimated_duration_s";
      if (duration.runnerUp !== null) {
        evidence.push(ref(selected.route_id, "estimated_duration_s"));
        evidence.push(ref(duration.runnerUp.route_id, "estimated_duration_s"));
      }
    } else if (duration.hasAnyValue && duration.allEqual) {
      // 时长并列：步行距离更少者如实说明为 less_walking
      const walk = pickBy(pool, "walking_distance_m");
      selected = walk.ordered[0];
      if (walk.hasAnyValue && walk.strictlyBetter) {
        primaryMetric = "walking_distance_m";
        if (walk.runnerUp !== null) {
          evidence.push(ref(selected.route_id, "walking_distance_m"));
          evidence.push(ref(walk.runnerUp.route_id, "walking_distance_m"));
        }
      } else {
        fallback = true;
        if (!walk.hasAnyValue) pushWarning(warnings, "预计耗时并列且步行距离缺失，按默认顺序选择");
        else pushWarning(warnings, "各候选预计耗时与步行距离均相同，按默认顺序选择");
      }
    } else {
      fallback = true;
      selected = duration.ordered[0];
      pushWarning(warnings, "预计耗时缺失，无法按耗时比较，按默认顺序选择");
    }
  }

  /* ---------- 理由码 ---------- */
  if (fallback) {
    reasonCodes.push("balanced_default");
  } else if (primaryMetric === "walking_distance_m") {
    reasonCodes.push("less_walking");
  } else if (primaryMetric === "transfer_count") {
    reasonCodes.push("fewer_transfers");
  } else if (primaryMetric === "estimated_duration_s") {
    reasonCodes.push("shorter_duration");
  } else {
    reasonCodes.push("balanced_default");
  }
  if (needs_step_free) {
    reasonCodes.push("step_free_satisfied");
    evidence.push(ref(selected.route_id, "step_free_evidence"));
  }

  /* ---------- explanation ---------- */
  const explanation = buildExplanation(preference, fallback, selected, primaryMetric);

  return assemble(req, selected, reasonCodes, evidence, explanation, warnings);
}

function buildExplanation(
  preference: "balanced" | "less_walking" | "less_transfer",
  fallback: boolean,
  selected: RouteCandidateSummary,
  primaryMetric: AdviceMetricField | null,
): string {
  const detail = describeCandidate(selected);
  if (fallback) {
    const head =
      detail !== ""
        ? `候选 ${selected.route_id}${detail}，指标不足以支撑偏好比较，按默认顺序选择。`
        : `候选 ${selected.route_id} 指标信息不足，按默认顺序选择。`;
    return head;
  }
  const base = detail !== "" ? `候选 ${selected.route_id}${detail}` : `候选 ${selected.route_id}（指标信息不足）`;
  if (primaryMetric === "walking_distance_m") {
    return `${base}，步行距离在候选中更少。`;
  }
  if (primaryMetric === "transfer_count") {
    return `${base}，换乘次数在候选中更少。`;
  }
  if (primaryMetric === "estimated_duration_s") {
    return `${base}，预计耗时在候选中更短。`;
  }
  return preference === "balanced"
    ? `${base}，按综合考虑选择。`
    : `${base}，按偏好选择。`;
}

function assemble(
  req: AdviceRequest,
  selected: RouteCandidateSummary | null,
  reasonCodes: AdviceReasonCode[],
  evidence: AdviceEvidenceRef[],
  explanation: string,
  warnings: string[],
): AdviceResponse {
  return {
    request_id: req.request_id,
    candidate_set_id: req.candidate_set_id,
    mode: "rules",
    selected_route_id: selected === null ? null : selected.route_id,
    reason_codes: reasonCodes,
    evidence,
    explanation: explanation.slice(0, MAX_EXPLANATION_CHARS),
    warnings: warnings.slice(0, MAX_WARNINGS),
    degraded_from: null,
  };
}
