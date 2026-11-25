/**
 * findNearbyGates 场馆召回双通道回归（修复验证）：
 * 实测 PlaceSearch.searchNearby 对大学/场馆类 POI 经常不召回（真实 key 环境两次复现返回空），
 * 修复后 AutoComplete 作为第二召回通道，城市级结果按 Haversine 裁剪到请求半径内；
 * 另外周边召回的常是“田径场/体育馆”这类子设施，主场馆名（venueKeyword）作为门检索候选。
 */
import { describe, expect, it } from "vitest";
import { buildNearbyLayout, findNearbyGates, type NearbySearchPort } from "./venueGeometry";

const ME: [number, number] = [115.8709, 28.7400];

describe("findNearbyGates：searchNearby 不召回时走 AutoComplete 通道", () => {
  function acOnlyPort(opts: {
    /** AutoComplete 关键词 → POI；simulates 城市级输入提示 */
    ac: Record<string, { name: string; position: [number, number] }[]>;
  }): NearbySearchPort {
    return {
      searchFirst: async () => null,
      searchNearby: async () => [], // 真实环境实测：周边搜“大学/学院”等类型词不召回
      autocomplete: async (kw) => {
        const hit = Object.keys(opts.ac).find((k) => kw.startsWith(k));
        return hit ? opts.ac[hit] : [];
      },
    };
  }

  it("searchNearby 全空时，AutoComplete 召回半径内的场馆并查到其门", async () => {
    const p = acOnlyPort({
      ac: {
        大学: [
          { name: "华东交通大学(双港东校区)", position: [115.870943, 28.740046] },
          { name: "某远处的大学", position: [116.5, 29.2] }, // 超出 3km，应被裁剪
        ],
        华东交通大学: [
          { name: "华东交通大学南区(西门)", position: [115.866956, 28.737321] },
          { name: "华东交通大学南区(北门)", position: [115.868502, 28.742928] },
        ],
      },
    });
    const r = await findNearbyGates(p, ME, 3000);
    expect(r.venues.map((v) => v.name)).toEqual(["华东交通大学(双港东校区)"]);
    // 按距我的位置升序：北门比西门更近
    expect(r.gates.map((g) => g.name)).toEqual(["华东交通大学南区(北门)", "华东交通大学南区(西门)"]);
    expect(r.gates[0].distanceM!).toBeLessThan(3000);
  });

  it("AutoComplete 也未召回 → 仍返回空，不编造场馆与出口", async () => {
    const r = await findNearbyGates(acOnlyPort({ ac: {} }), ME, 3000);
    expect(r).toEqual({ gates: [], venues: [] });
  });

  it("周边只召回子设施（田径场）时，主场馆名提示仍能查到真实校门", async () => {
    const p: NearbySearchPort = {
      searchFirst: async () => null,
      searchNearby: async () => [],
      autocomplete: async (kw) => {
        if (kw === "大学") return [{ name: "华东交通大学南区田径场", position: [115.869, 28.7395] }];
        if (kw.startsWith("华东交通大学")) {
          return [
            { name: "华东交通大学南区(西门)", position: [115.866956, 28.737321] },
            { name: "华东交通大学南区(北门)", position: [115.868502, 28.742928] },
          ];
        }
        return []; // “华东交通大学南区田径场门/西”等子设施关键词落空
      },
    };
    const r = await findNearbyGates(p, ME, 3000, { city: "南昌市", venueKeyword: "华东交通大学" });
    expect(r.gates.map((g) => g.name)).toEqual(["华东交通大学南区(北门)", "华东交通大学南区(西门)"]);
  });

  it("我的位置已换到别处时，城市级召回的原场馆门超出半径必须丢弃", async () => {
    const ELSEWHERE: [number, number] = [115.95, 28.68]; // 与华交相距约 12km
    const p: NearbySearchPort = {
      searchFirst: async () => null,
      searchNearby: async () => [],
      autocomplete: async (kw) => {
        // 城市级 AutoComplete 仍会返回原场馆的门（华交），但它们不在“我”的 3km 内
        if (kw.startsWith("华东交通大学")) {
          return [
            { name: "华东交通大学南区(西门)", position: [115.866956, 28.737321] },
            { name: "华东交通大学南区(北门)", position: [115.868502, 28.742928] },
          ];
        }
        return [];
      },
    };
    const r = await findNearbyGates(p, ELSEWHERE, 3000, { city: "南昌市", venueKeyword: "华东交通大学" });
    expect(r.gates).toEqual([]);
  });

  it("双通道同时召回同一场馆 → 去重后不重复", async () => {
    const venue = { name: "华东交通大学(双港东校区)", position: [115.870943, 28.740046] as [number, number] };
    const p: NearbySearchPort = {
      searchFirst: async () => null,
      searchNearby: async (kw) => (kw === "大学" ? [venue] : []),
      autocomplete: async (kw) => (kw.includes("大学") ? [venue] : []),
    };
    const r = await findNearbyGates(p, ME, 3000);
    expect(r.venues).toHaveLength(1);
  });

  it("一个场馆都没召回时不检索门，也不复用默认场馆名", async () => {
    const asked: string[] = [];
    const p: NearbySearchPort = {
      searchFirst: async () => null,
      searchNearby: async () => [],
      autocomplete: async (kw) => {
        asked.push(kw);
        return [];
      },
    };
    const r = await findNearbyGates(p, [115.95, 28.68], 3000, {
      city: "南昌市",
      venueKeyword: "华东交通大学",
      venueAnchor: [115.870943, 28.740046],
    });
    expect(r).toEqual({ gates: [], venues: [] });
    expect(asked.some((k) => k.startsWith("华东交通大学"))).toBe(false);
  });

  it("交大旁边选中其他场馆（600m 内但名称无关）时，不把交大的门算过来", async () => {
    const CAMPUS: [number, number] = [115.870943, 28.740046]; // 配置主场馆（华交）
    const OTHER: [number, number] = [115.8721, 28.7401]; // 距华交约 110m 的另一场馆
    const p: NearbySearchPort = {
      searchFirst: async () => null,
      searchNearby: async (kw) =>
        kw === "体育中心" ? [{ name: "南昌国际体育中心", position: OTHER }] : [],
      autocomplete: async (kw) => {
        if (kw.startsWith("南昌国际体育中心")) {
          return [{ name: "南昌国际体育中心西门", position: [115.8728, 28.7402] }];
        }
        // 城市级检索仍会返回华交的门，但它不属于“南昌国际体育中心”
        if (kw.startsWith("华东交通大学")) {
          return [{ name: "华东交通大学南区(西门)", position: [115.866956, 28.737321] }];
        }
        return [];
      },
    };
    const r = await findNearbyGates(p, [115.873, 28.7405], 3000, {
      city: "南昌市",
      venueKeyword: "华东交通大学",
      venueAnchor: CAMPUS,
    });
    expect(r.gates.map((g) => g.name)).toEqual(["南昌国际体育中心西门"]);
  });
});

describe("buildNearbyLayout：清空旧布局且不补齐缺失节点", () => {
  const VENUE = { name: "南昌国际体育中心", position: [115.8721, 28.7401] as [number, number] };

  it("一个出口都没找到 → 只保留 S（我的位置），清空原场馆布局", () => {
    const r = buildNearbyLayout(ME, [], [], []);
    expect(Object.keys(r.geo.nodes)).toEqual(["S"]);
    expect(r.geo.nodes["S"]).toEqual(ME);
    expect(r.geo.venueName).toBe("我的位置附近");
    expect(r.notes.join("")).toContain("已清空原场馆布局");
  });

  it("只找到 1 个出口、1 个接驳点 → 只写真实节点，E2/E3/P2 不出现", () => {
    const gate = { name: "南昌国际体育中心西门", position: [115.8728, 28.7402] as [number, number], distanceM: 80 };
    const stop = { name: "国体中心地铁站", position: [115.8735, 28.7408] as [number, number] };
    const r = buildNearbyLayout(ME, [VENUE], [gate], [stop]);
    expect(Object.keys(r.geo.nodes).sort()).toEqual(["E1", "P1", "S"]);
    expect(r.geo.nodes["E1"]).toEqual(gate.position);
    expect(r.geo.nodes["P1"]).toEqual(stop.position);
    expect(r.notes.join("")).toContain("未找到的节点不再用原场馆坐标补齐");
  });
});
