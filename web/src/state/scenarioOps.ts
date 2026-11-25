/**
 * 场景/结果身份与 patch 应用的纯函数（从 store 抽出，便于针对性单测）。
 */
import type { Objective, ParsePatch, Scenario, SimulationResult } from "../contract/types";

/**
 * 所有有效候选均已释放旅客但无人登车（服务目标未满足，但方案合法）。
 * 用于前端突出提示“仍有旅客滞留，需调整方案或资源”，
 * 且不把它们误报为“无合法候选”。零需求（released=0）不触发。
 */
export function allValidStranded(
  results: Pick<SimulationResult, "status" | "metrics">[]
): boolean {
  const valid = results.filter((r) => r.status === "valid" && r.metrics !== null);
  if (valid.length === 0) return false;
  return valid.every((r) => r.metrics!.released_count > 0 && r.metrics!.boarded_count === 0);
}

/** 场景身份：05 §5 要求用 scenario_id + revision 核对结果是否过期 */
export function scenarioIdentity(scenario: Scenario): string {
  return `${scenario.scenario_id}@${scenario.revision}`;
}

export interface RunIdentity {
  scenario_id: string;
  scenario_revision: number;
  objective: Objective;
  seed: number;
}

/** 一轮结果是否对应当前场景/目标/seed（过期判定） */
export function runMatchesCurrent(
  run: RunIdentity,
  scenario: Scenario,
  objective: Objective,
  seed: number
): boolean {
  return (
    run.scenario_id === scenario.scenario_id &&
    run.scenario_revision === scenario.revision &&
    run.objective === objective &&
    run.seed === seed
  );
}

/** 待确认 patch 是否仍绑定当前场景（旧 patch 不得应用到新场景） */
export function canApplyPending(
  pending: { scenario_id: string; base_revision: number },
  scenario: Scenario
): boolean {
  return pending.scenario_id === scenario.scenario_id && pending.base_revision === scenario.revision;
}

/* ------------------------------------------------------------------ */
/* 视图选择（当前查看方案/需求组）：进入/退出回放时保存与校正          */
/* ------------------------------------------------------------------ */

export interface ViewSelection {
  planId: string | null;
  groupId: string | null;
}

/**
 * 把视图选择校正到目标 plans/groups（进入回放或退出回放共用，纯函数）：
 * - planId 不在 plans 中（含 null）→ 回退到 recommendationPlanId（也须合法）→ 再回退第一个候选 → 无候选为 null；
 * - groupId 非 null 但不在 groups 中（跨版本回放常见）→ 回退第一个组 → 无组为 null。
 * 只做归属校验与合理回退：不发请求、不改 seed/revision、不自动重新生成。
 */
export function reconcileSelection(
  selection: ViewSelection,
  plans: readonly { plan_id: string }[],
  recommendationPlanId: string | null | undefined,
  groups: readonly { group_id: string }[]
): ViewSelection {
  const planIds = new Set(plans.map((p) => p.plan_id));
  let planId = selection.planId !== null && planIds.has(selection.planId) ? selection.planId : null;
  if (planId === null && recommendationPlanId != null && planIds.has(recommendationPlanId)) {
    planId = recommendationPlanId;
  }
  if (planId === null) planId = plans[0]?.plan_id ?? null;

  const groupIds = new Set(groups.map((g) => g.group_id));
  const groupId =
    selection.groupId !== null && groupIds.has(selection.groupId)
      ? selection.groupId
      : groups[0]?.group_id ?? null;
  return { planId, groupId };
}

/**
 * 未经校验的补丁项视图：来自服务端或测试的**运行时输入**，
 * 即使类型层已是 ParsePatch，应用前仍按白名单重新校验，未知目标/字段一律跳过。
 */
export interface UntrustedPatchItem {
  target: string;
  id: string;
  field: string;
  value: unknown;
}

export interface PatchApplyResult {
  next: Scenario;
  applied: UntrustedPatchItem[];
  skipped: { item: UntrustedPatchItem; reason: string }[];
}

const EDGE_PATCH_FIELDS = new Set(["closed", "travel_s", "capacity_per_min"]);
const GROUP_PATCH_FIELDS = new Set(["count", "walk_time_factor", "board_deadline_s"]);

function asUntrusted(item: ParsePatch): UntrustedPatchItem {
  return item as unknown as UntrustedPatchItem;
}

/**
 * 应用服务端返回的受限 patch（05 §6 scenario/parse）。
 * 白名单之外的修改项一律跳过并给出原因，不静默应用未知修改。
 */
export function applyPatchToScenario(scenario: Scenario, patch: readonly ParsePatch[]): PatchApplyResult {
  const next = structuredClone(scenario);
  const applied: UntrustedPatchItem[] = [];
  const skipped: { item: UntrustedPatchItem; reason: string }[] = [];

  for (const raw of patch) {
    const item = asUntrusted(raw);
    if (item.target === "edge") {
      const edge = next.edges.find((e) => e.edge_id === item.id);
      if (!edge) skipped.push({ item, reason: `边 ${item.id} 不存在` });
      else if (!EDGE_PATCH_FIELDS.has(item.field)) skipped.push({ item, reason: `边不支持修改字段 ${item.field}` });
      else if (item.field === "closed" && typeof item.value === "boolean") {
        edge.closed = item.value;
        applied.push(item);
      } else if ((item.field === "travel_s" || item.field === "capacity_per_min") && typeof item.value === "number" && item.value > 0) {
        if (item.field === "travel_s") edge.travel_s = item.value;
        else edge.capacity_per_min = item.value;
        applied.push(item);
      } else skipped.push({ item, reason: `字段 ${item.field} 的值非法` });
    } else if (item.target === "group") {
      const group = next.groups.find((g) => g.group_id === item.id);
      if (!group) skipped.push({ item, reason: `旅客组 ${item.id} 不存在` });
      else if (!GROUP_PATCH_FIELDS.has(item.field)) skipped.push({ item, reason: `旅客组不支持修改字段 ${item.field}` });
      else if (item.field === "count" && typeof item.value === "number" && Number.isInteger(item.value) && item.value >= 0) {
        group.count = item.value;
        applied.push(item);
      } else if (item.field === "walk_time_factor" && typeof item.value === "number" && item.value > 0) {
        group.walk_time_factor = item.value;
        applied.push(item);
      } else if (item.field === "board_deadline_s" && (item.value === null || (typeof item.value === "number" && item.value > 0))) {
        group.board_deadline_s = item.value;
        applied.push(item);
      } else skipped.push({ item, reason: `字段 ${item.field} 的值非法` });
    } else if (item.target === "vehicle") {
      // 05 §6：移除操作的应用语义是从 fleet 删除该 vehicle_id
      if (item.field === "enabled" && item.value === false) {
        const idx = next.fleet.findIndex((v) => v.vehicle_id === item.id);
        if (idx < 0) skipped.push({ item, reason: `车辆 ${item.id} 不存在` });
        else {
          next.fleet.splice(idx, 1);
          applied.push(item);
        }
      } else skipped.push({ item, reason: `车辆仅支持 enabled=false（移除）` });
    } else {
      skipped.push({ item, reason: `不支持的修改目标` });
    }
  }

  next.revision = scenario.revision + 1;
  return { next, applied, skipped };
}

/** 查 patch 项在当前场景中的旧值（差异预览用） */
export function patchOldValue(scenario: Scenario, item: UntrustedPatchItem): string {
  if (item.target === "edge") {
    const e = scenario.edges.find((x) => x.edge_id === item.id);
    if (!e) return "（不存在）";
    if (item.field === "closed") return e.closed ? "已关闭" : "开放";
    if (item.field === "travel_s") return `${e.travel_s}s`;
    if (item.field === "capacity_per_min") return `${e.capacity_per_min}/min`;
    return "—";
  }
  if (item.target === "group") {
    const g = scenario.groups.find((x) => x.group_id === item.id);
    if (!g) return "（不存在）";
    if (item.field === "board_deadline_s") return g.board_deadline_s === null ? "无期限" : `${g.board_deadline_s}s`;
    return "—";
  }
  if (item.target === "vehicle") {
    const v = scenario.fleet.find((x) => x.vehicle_id === item.id);
    return v ? `在役（容量${v.capacity}）` : "（不存在）";
  }
  return "—";
}
