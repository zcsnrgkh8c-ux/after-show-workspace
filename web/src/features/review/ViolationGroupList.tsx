import React from "react";
import type { ValidationIssue } from "../../contract/types";
import { violationShortText } from "../../labels";
import { groupViolationsByCode } from "./display";

/**
 * 校验问题按 code 分组展示：计数真实、warning 不丢弃；
 * 展开后可看原有 severity / path / 原文，未知 code 保留原码不猜测。
 */
export default function ViolationGroupList({ violations }: { violations: ValidationIssue[] }) {
  if (violations.length === 0) return null;
  const groups = groupViolationsByCode(violations);
  return (
    <div className="review-violations">
      {groups.map((g) => (
        <details key={g.code} className="review-violation-group">
          <summary className="review-violation-summary">
            <span>
              {violationShortText(g.items[0])}（<span className="mono">{g.code}</span>）· 共 {g.count} 条
            </span>
            {g.errors > 0 && <span className="badge badge-danger">错误 {g.errors}</span>}
            {g.warnings > 0 && <span className="badge badge-warn">警告 {g.warnings}</span>}
          </summary>
          <ul className="review-violation-items">
            {g.items.map((v, i) => (
              <li key={i}>
                [{v.severity}] <span className="mono">{v.path}</span>：{v.message}
              </li>
            ))}
          </ul>
        </details>
      ))}
    </div>
  );
}
