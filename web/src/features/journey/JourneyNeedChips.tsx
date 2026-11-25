/**
 * 出行需求选择（窗口1局部实现，journey- 前缀）。
 * 选项来自当前 Scenario 的实际组（labels.needOptionsFromScenario）；切换只改查看视角：
 * 调用现有 selectGroup，不发业务请求、不改人数 / seed / revision。
 * 同一需求类型覆盖多组时不汇总分母冒充单组：列出该类型下各组供明确选择。
 */
import React from "react";
import type { ScenarioGroup } from "../../contract/types";
import type { NeedOption } from "../../labels";

interface JourneyNeedChipsProps {
  options: NeedOption[];
  groups: ScenarioGroup[];
  selectedGroupId: string | null;
  onSelect: (groupId: string) => void;
}

export function JourneyNeedChips({ options, groups, selectedGroupId, onSelect }: JourneyNeedChipsProps) {
  if (options.length === 0) {
    return <p className="journey-dim journey-chips">当前场景没有旅客组，无法选择出行需求。</p>;
  }
  const activeOption = options.find((o) => o.groupIds.includes(selectedGroupId ?? "")) ?? null;
  return (
    <div className="journey-chips">
      <div className="journey-chip-row" role="group" aria-label="出行需求">
        {options.map((o) => {
          const active = o.groupIds.includes(selectedGroupId ?? "");
          return (
            <button
              key={o.type}
              type="button"
              className={`journey-chip ${active ? "journey-chip-active" : ""}`}
              aria-pressed={active}
              onClick={() => onSelect(o.groupIds[0])}
            >
              <span className="journey-chip-label">{o.label}</span>
              <span className="journey-chip-count">
                {o.groupIds.length > 1 ? `共 ${o.peopleCount} 人` : `${o.peopleCount} 人`}
              </span>
            </button>
          );
        })}
      </div>
      {activeOption !== null && activeOption.groupIds.length > 1 && (
        <div className="journey-subgroup-row">
          <span className="journey-dim">该需求包含 {activeOption.groupIds.length} 组旅客，当前查看：</span>
          {activeOption.groupIds.map((gid, i) => {
            const g = groups.find((x) => x.group_id === gid);
            const active = selectedGroupId === gid;
            return (
              <button
                key={gid}
                type="button"
                className={`journey-subgroup ${active ? "journey-subgroup-active" : ""}`}
                aria-pressed={active}
                onClick={() => onSelect(gid)}
              >
                第 {i + 1} 组（{g ? g.count : "?"} 人）
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
