/**
 * 共享契约薄重导出层（唯一字段定义在仓库根 shared/types.ts）。
 * 本文件不再声明任何字段，仅补充 C 侧历史命名别名，避免大面积改动消费者。
 */
export * from "../../../shared/types";

export type { DecisionMode as Mode } from "../../../shared/types";
export type { TraceStep as TraceEntry } from "../../../shared/types";
export type { ParsePatch as PatchItem } from "../../../shared/types";
export type { PlannedDeparture as PlanDeparture } from "../../../shared/types";
export type { GroupMetrics as GroupMetric } from "../../../shared/types";
