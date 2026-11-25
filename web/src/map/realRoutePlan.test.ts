/**
 * 真实步行动线纯逻辑回归：通道筛选、只覆盖成功折线、结果说明不夸大。
 */
import { describe, expect, it } from "vitest";
import { cloneDefaultScenario } from "../contract/defaultScenario";
import type { GeoMapping } from "./config";
import { buildRealRouteNotes, mergeRealRoutes, plannableEdges } from "./realRoutePlan";

const GEO: GeoMapping = {
  venueName: "测试场馆",
  coordVerified: false,
  nodes: {
    S: [115.87, 28.74],
    E1: [115.865, 28.735],
    E2: [115.87, 28.735],
    E3: [115.875, 28.735],
    P1: [115.866, 28.728],
    P2: [115.874, 28.728],
  },
};

describe("plannableEdges", () => {
  it("跳过已关闭通道与缺坐标通道", () => {
    const scenario = cloneDefaultScenario();
    const closed = scenario.edges[0];
    closed.closed = true;
    const edges = plannableEdges(scenario, GEO);
    expect(edges.find((e) => e.edge_id === closed.edge_id)).toBeUndefined();
    expect(edges.length).toBe(scenario.edges.length - 1);

    const missing = plannableEdges(scenario, { ...GEO, nodes: { ...GEO.nodes, E3: undefined as never } });
    expect(missing.find((e) => e.from === "E3" || e.to === "E3")).toBeUndefined();
  });
});

describe("mergeRealRoutes", () => {
  it("只覆盖成功通道，保留其他几何，且不修改原对象", () => {
    const original: GeoMapping = { ...GEO, edges: { a1: [[115.87, 28.74], [115.865, 28.735]] } };
    const snapshot = JSON.stringify(original);
    const merged = mergeRealRoutes(original, [
      { edge_id: "a1", distance_m: 300, duration_s: 240, polyline: [[115.87, 28.74], [115.869, 28.739], [115.865, 28.735]] },
      { edge_id: "b1", distance_m: 200, duration_s: 150, polyline: [[115.87, 28.74], [115.87, 28.735]] },
    ]);
    expect(merged.edges?.["a1"].length).toBe(3);
    expect(merged.edges?.["b1"].length).toBe(2);
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it("空结果原样返回", () => {
    expect(mergeRealRoutes(GEO, [])).toBe(GEO);
  });
});

describe("buildRealRouteNotes", () => {
  it("成功与失败分开写，不把失败写成真实路线", () => {
    const scenario = cloneDefaultScenario();
    const edges = scenario.edges.slice(0, 2);
    const notes = buildRealRouteNotes(
      edges,
      [
        {
          edge_id: edges[0].edge_id,
          distance_m: 1250,
          duration_s: 900,
          polyline: [[1, 2], [1.1, 2.1]],
        },
      ],
      [{ edge_id: edges[1].edge_id, reason: "超时" }]
    );
    expect(notes[0]).toContain("1/2 条来自高德步行规划");
    expect(notes[0]).toContain("客流指标仍为模拟，不进入推演");
    expect(notes[1]).toContain("1.3 km");
    expect(notes[1]).toContain("约 15 分钟");
    expect(notes[2]).toContain("未取到真实路线");
    expect(notes[2]).toContain("保留模拟示意线");
  });
});
