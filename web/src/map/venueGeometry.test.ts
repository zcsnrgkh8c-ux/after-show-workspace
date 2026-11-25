import { describe, expect, it, vi } from "vitest";

import type { GeoMapping } from "./config";
import {
  bearingDeg,
  buildVenueGeometry,
  dedupeByProximity,
  distanceM,
  findNearbyGates,
  isAuxiliaryGate,
  isGateName,
  normalizeVenueKeyword,
  pickGates,
  resolveVenueGeometry,
  venueCoreKeys,
  type NearbySearchPort,
} from "./venueGeometry";

const CENTER: [number, number] = [113.3194, 23.1343];

const FALLBACK: GeoMapping = {
  venueName: "示意场馆",
  coordVerified: false,
  center: CENTER,
  nodes: { S: CENTER, E1: [1, 1], E2: [2, 2], E3: [3, 3], P1: [4, 4], P2: [5, 5] },
};

describe("normalizeVenueKeyword", () => {
  it("去掉括号说明与空白", () => {
    expect(normalizeVenueKeyword("天河体育中心（示意）")).toBe("天河体育中心");
    expect(normalizeVenueKeyword(" 天河 体育中心 ")).toBe("天河体育中心");
    expect(normalizeVenueKeyword("（仅展示）")).toBe("");
  });
});

describe("bearingDeg：方位角", () => {
  it("正北 0°、正东 90°、正南 180°、正西 270°", () => {
    expect(bearingDeg(CENTER, [CENTER[0], CENTER[1] + 0.01])).toBeCloseTo(0, 3);
    expect(bearingDeg(CENTER, [CENTER[0] + 0.01, CENTER[1]])).toBeCloseTo(90, 0);
    expect(bearingDeg(CENTER, [CENTER[0], CENTER[1] - 0.01])).toBeCloseTo(180, 3);
    expect(bearingDeg(CENTER, [CENTER[0] - 0.01, CENTER[1]])).toBeCloseTo(270, 0);
  });
});

describe("isGateName / dedupeByProximity：命名与重复点判定", () => {
  it("校门与出入口命名命中，门诊部不命中", () => {
    expect(isGateName("华东交通大学南区(西门)")).toBe(true);
    expect(isGateName("华东交通大学南区(北2门)")).toBe(true);
    expect(isGateName("天河体育中心南入口")).toBe(true);
    expect(isGateName("华东交通大学-门诊部")).toBe(false);
    expect(isGateName("华东交通大学停车场")).toBe(false);
  });

  it("距离计算与近似重复点去重", () => {
    const a: [number, number] = [115.872916, 28.743001];
    const b: [number, number] = [115.873996, 28.743015];
    expect(distanceM(a, b)).toBeGreaterThan(90); // 两个不同门，不应合并
    const near: [number, number] = [115.872925, 28.743005];
    expect(distanceM(a, near)).toBeLessThan(5);
    const kept = dedupeByProximity([
      { name: "南区(北2门)", position: a },
      { name: "双港东校区南区(北2门)", position: near },
      { name: "南区(南门)", position: [115.871286, 28.734271] },
    ]);
    expect(kept.map((p) => p.name)).toEqual(["南区(北2门)", "南区(南门)"]);
  });
});

describe("findNearbyGates：以我的位置为中心找附近出口", () => {
  const ME: [number, number] = [115.8709, 28.7400];

  function port(venues: { name: string; position: [number, number] }[], gatesByVenue: Record<string, { name: string; position: [number, number] }[]>): NearbySearchPort {
    return {
      searchFirst: async () => null,
      searchNearby: async (kw) => (kw === "大学" || kw === "学院" ? venues : []),
      autocomplete: async (kw) => {
        const hit = Object.keys(gatesByVenue).find((v) => kw.startsWith(v));
        return hit ? gatesByVenue[hit] : [];
      },
    };
  }

  it("按距当前位置升序返回最近场馆的门（不混入其他场馆的门）", async () => {
    const p = port(
      [
        { name: "华东交通大学(双港东校区)", position: [115.870943, 28.740046] },
        { name: "江西财经大学(蛟桥园校区)", position: [115.8589, 28.7516] },
      ],
      {
        "华东交通大学": [
          { name: "华东交通大学南区(西门)", position: [115.866956, 28.737321] },
          { name: "华东交通大学南区(北门)", position: [115.868502, 28.742928] },
        ],
        "江西财经大学": [{ name: "江西财经大学(东门)", position: [115.86, 28.752] }],
      }
    );
    const r = await findNearbyGates(p, ME, 3000);
    expect(r.venues.length).toBe(2);
    // 归属只取最近场馆：江西财经大学的门不能算到当前位置所在场馆名下
    expect(r.gates.map((g) => g.name)).toEqual([
      "华东交通大学南区(北门)",
      "华东交通大学南区(西门)",
    ]);
    expect(r.gates[0].distanceM!).toBeLessThan(r.gates[1].distanceM!);
  });

  it("附近没有场馆时返回空，不编造出口", async () => {
    const r = await findNearbyGates(port([], {}), ME, 3000);
    expect(r).toEqual({ gates: [], venues: [] });
  });

  it("过滤停车场与门诊部这类伪出入口", async () => {
    const p = port([{ name: "华东交通大学", position: [115.870943, 28.740046] }], {
      "华东交通大学": [
        { name: "华东交通大学南区(西门)", position: [115.866956, 28.737321] },
        { name: "华东交通大学地面停车场(出入口)", position: [115.871, 28.7401] },
        { name: "华东交通大学-门诊部", position: [115.869971, 28.739234] },
      ],
    });
    const r = await findNearbyGates(p, ME, 3000);
    expect(r.gates.map((g) => g.name)).toEqual(["华东交通大学南区(西门)"]);
  });
});

describe("venueCoreKeys：多候选匹配词", () => {
  it("城市前缀场馆同时生成去前缀名与尾部候选", () => {
    const keys = venueCoreKeys("广州天河体育中心");
    expect(keys).toContain("广州天河体育中心");
    expect(keys).toContain("天河体育中心");
    expect(keys).toContain("体育中心");
  });

  it("无城市前缀时仍可用全名与尾部匹配", () => {
    const keys = venueCoreKeys("天河体育中心");
    expect(keys).toContain("天河体育中心");
    expect(keys).toContain("体育中心");
  });
});

describe("pickGates：只认可信的“场馆门”", () => {
  it("保留名称含门且含场馆核心词的 POI", () => {
    const pois = [
      { name: "天河体育中心北门", position: [113.3194, 23.135] as [number, number] },
      { name: "天河体育中心-1号门", position: [113.3205, 23.1343] as [number, number] },
    ];
    expect(pickGates("天河体育中心", pois).map((p) => p.name)).toHaveLength(2);
  });

  it("场馆名带城市前缀时，仍能匹配到不带前缀的门", () => {
    const pois = [{ name: "天河体育中心北门", position: [113.3194, 23.135] as [number, number] }];
    expect(pickGates("广州天河体育中心", pois)).toHaveLength(1);
  });

  it("“入口”命名同样视为门", () => {
    const pois = [{ name: "天河体育中心南入口", position: [113.3194, 23.133] as [number, number] }];
    expect(pickGates("广州天河体育中心", pois)).toHaveLength(1);
  });

  it("排除远处小区的门与不含门的 POI", () => {
    const pois = [
      { name: "天河体育中心南门", position: [113.3194, 23.133] as [number, number] },
      { name: "耀星华庭东门", position: [113.325, 23.136] as [number, number] },
      { name: "天河体育中心停车场", position: [113.3194, 23.134] as [number, number] },
    ];
    const kept = pickGates("天河体育中心", pois);
    expect(kept.map((p) => p.name)).toEqual(["天河体育中心南门"]);
  });

  it("有观众门时排除停车场附属出入口", () => {
    const pois = [
      { name: "广州天河体育中心地面停车场(西入口)", position: [113.317, 23.134] as [number, number] },
      { name: "天河体育中心地下停车场(出入口)", position: [113.318, 23.134] as [number, number] },
      { name: "天河体育中心东门", position: [113.322, 23.134] as [number, number] },
    ];
    const kept = pickGates("广州天河体育中心", pois);
    expect(kept.map((p) => p.name)).toEqual(["天河体育中心东门"]);
  });

  it("只有停车场出入口时退回使用（由说明标注仅供参考）", () => {
    const pois = [{ name: "天河体育中心地下停车场(出入口)", position: [113.318, 23.134] as [number, number] }];
    const kept = pickGates("广州天河体育中心", pois);
    expect(kept).toHaveLength(1);
    expect(isAuxiliaryGate(kept[0].name)).toBe(true);
  });
});

describe("buildVenueGeometry：诚实布点", () => {
  const venue = { name: "天河体育中心", position: CENTER };

  it("按方位角顺时针把门分配到 E1/E2/E3", () => {
    const gates = [
      { name: "天河体育中心西门", position: [113.317, 23.1343] as [number, number] }, // 270°
      { name: "天河体育中心北门", position: [113.3194, 23.136] as [number, number] }, // 0°
      { name: "天河体育中心东门", position: [113.322, 23.1343] as [number, number] }, // 90°
    ];
    const r = buildVenueGeometry(venue, gates, [], FALLBACK);
    expect(r.geo.nodes.E1).toEqual([113.3194, 23.136]); // 北
    expect(r.geo.nodes.E2).toEqual([113.322, 23.1343]); // 东
    expect(r.geo.nodes.E3).toEqual([113.317, 23.1343]); // 西
    expect(r.geo.nodes.S).toEqual(CENTER);
    expect(r.missingNodes).toEqual(["P1", "P2"]); // 未提供接驳站点：如实标记缺失
  });

  it("门不足时保留原示意坐标并如实列出缺失节点", () => {
    const gates = [{ name: "天河体育中心北门", position: [113.3194, 23.136] as [number, number] }];
    const r = buildVenueGeometry(venue, gates, [], FALLBACK);
    expect(r.geo.nodes.E1).toEqual([113.3194, 23.136]);
    expect(r.geo.nodes.E2).toEqual(FALLBACK.nodes.E2); // 沿用
    expect(r.geo.nodes.E3).toEqual(FALLBACK.nodes.E3);
    expect(r.missingNodes).toEqual(expect.arrayContaining(["E2", "E3", "P1", "P2"]));
    expect(r.notes.some((n) => n.includes("未获取到真实坐标"))).toBe(true);
  });

  it("没有可用门时明确说明，不用任意点冒充出口", () => {
    const r = buildVenueGeometry(venue, [], [], FALLBACK);
    expect(r.geo.nodes.E1).toEqual(FALLBACK.nodes.E1);
    expect(r.notes.some((n) => n.includes("未在 POI 中找到该场馆的门"))).toBe(true);
    expect(r.missingNodes).toEqual(expect.arrayContaining(["E1", "E2", "E3"]));
  });

  it("coordVerified 恒为 false：POI 检索不等于实地核实", () => {
    const gates = [{ name: "天河体育中心北门", position: [113.3194, 23.136] as [number, number] }];
    const r = buildVenueGeometry(venue, gates, [{ name: "体育中心地铁站", position: [113.318, 23.132] as [number, number] }], FALLBACK);
    expect(r.geo.coordVerified).toBe(false);
    expect(r.geo.nodes.P1).toEqual([113.318, 23.132]);
  });
});

describe("resolveVenueGeometry：检索编排", () => {
  const port: NearbySearchPort = {
    searchFirst: vi.fn(async (kw: string) =>
      kw === "天河体育中心" ? { position: CENTER, name: "天河体育中心" } : null
    ),
    searchNearby: vi.fn(async (kw: string) => {
      if (kw === "门") {
        return [
          { name: "天河体育中心北门", position: [113.3194, 23.136] as [number, number] },
          { name: "天河体育中心南门", position: [113.3194, 23.1325] as [number, number] },
        ];
      }
      if (kw === "地铁站") return [{ name: "体育西路站", position: [113.318, 23.132] as [number, number] }];
      return [];
    }),
  };

  it("场馆不存在时返回 null（不猜场馆）", async () => {
    expect(await resolveVenueGeometry(port, "不存在的场馆", FALLBACK)).toBeNull();
  });

  it("正常检索：生成几何并给出数据来源说明", async () => {
    const r = await resolveVenueGeometry(port, "天河体育中心（示意）", FALLBACK);
    expect(r).not.toBeNull();
    expect(r!.geo.nodes.S).toEqual(CENTER);
    expect(r!.missingNodes).toEqual(expect.arrayContaining(["E3", "P2"]));
    expect(r!.notes.some((n) => n.includes("高德 POI"))).toBe(true);
    expect(r!.geo.coordVerified).toBe(false);
  });

  it("空关键词直接返回 null，不发请求", async () => {
    const spy = { searchFirst: vi.fn(), searchNearby: vi.fn() };
    expect(await resolveVenueGeometry(spy, "（示意）", FALLBACK)).toBeNull();
    expect(spy.searchFirst).not.toHaveBeenCalled();
  });
});
