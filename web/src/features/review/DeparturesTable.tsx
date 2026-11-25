import React from "react";
import type { Plan } from "../../contract/types";
import { fmtClock } from "../../labels";

/**
 * 班次表：车辆 / 站点 / 发车时刻（模拟时间 mm:ss）。
 * 数据直接来自 Plan.departures 原始字段，不做任何加工。
 */
export default function DeparturesTable({ plan }: { plan: Plan }) {
  if (plan.departures.length === 0) {
    return <p className="review-departures-note">本方案无计划班次。</p>;
  }
  return (
    <div>
      <div className="review-departures-note">发车班次 {plan.departures.length} 班（时刻为模拟时间 mm:ss）：</div>
      <table className="table">
        <thead>
          <tr>
            <th>车辆</th>
            <th>站点</th>
            <th>发车时刻</th>
          </tr>
        </thead>
        <tbody>
          {plan.departures.map((d, i) => (
            <tr key={i}>
              <td className="mono">{d.vehicle_id}</td>
              <td className="mono">{d.stop_id}</td>
              <td className="mono">{fmtClock(d.depart_s)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
