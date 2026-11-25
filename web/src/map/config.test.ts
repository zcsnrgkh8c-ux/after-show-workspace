import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cloneDefaultScenario } from "../contract/defaultScenario";
import { getMapConfig, parseGeoMapping } from "./config";

const scenario = cloneDefaultScenario();

const VALID_JSON = JSON.stringify({
  venueName: "测试场馆",
  coordVerified: true,
  nodes: {
    S: [116.39, 39.9],
    E1: [116.385, 39.895],
    E2: [116.39, 39.895],
    E3: [116.395, 39.895],
    P1: [116.386, 39.888],
    P2: [116.394, 39.888],
  },
  edges: { a1: [[116.39, 39.9], [116.385, 39.895]] },
});

beforeEach(() => {
  // 与本地 .env.local 隔离：三个地图变量默认清空
  vi.stubEnv("VITE_AMAP_KEY", "");
  vi.stubEnv("VITE_AMAP_SECURITY_JS_CODE", "");
  vi.stubEnv("VITE_MAP_GEO_JSON", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("parseGeoMapping：地理映射解析与场景覆盖校验", () => {
  it("未配置 → geo=null 且说明缺失", () => {
    const { geo, issues } = parseGeoMapping(undefined, scenario);
    expect(geo).toBeNull();
    expect(issues.join()).toContain("VITE_MAP_GEO_JSON");
  });

  it("非法 JSON → geo=null", () => {
    const { geo, issues } = parseGeoMapping("{not json", scenario);
    expect(geo).toBeNull();
    expect(issues.join()).toContain("合法 JSON");
  });

  it("合法配置：全部节点覆盖、无缺失告警", () => {
    const { geo, issues } = parseGeoMapping(VALID_JSON, scenario);
    expect(geo).not.toBeNull();
    expect(geo!.coordVerified).toBe(true);
    expect(geo!.nodes.S).toEqual([116.39, 39.9]);
    expect(geo!.edges?.a1?.length).toBe(2);
    expect(issues).toEqual([]);
  });

  it("缺节点坐标 → 明确列出缺失节点", () => {
    const json = JSON.stringify({ nodes: { S: [116.39, 39.9] } });
    const { geo, issues } = parseGeoMapping(json, scenario);
    expect(geo).not.toBeNull();
    const text = issues.join("；");
    expect(text).toContain("E1");
    expect(text).toContain("P2");
  });

  it("坐标越界/类型错 → 忽略该项并告警", () => {
    const json = JSON.stringify({
      nodes: { S: [116.39, 99], E1: [116.385, 39.895], E2: [116.39, 39.895], E3: [116.395, 39.895], P1: [116.386, 39.888], P2: [116.394, 39.888] },
    });
    const { geo, issues } = parseGeoMapping(json, scenario);
    expect(geo!.nodes.S).toBeUndefined();
    expect(issues.join()).toContain("缺少节点坐标：S");
  });

  it("coordVerified 缺省按未核实处理", () => {
    const json = JSON.stringify({ nodes: { S: [116.39, 39.9], E1: [116.385, 39.895], E2: [116.39, 39.895], E3: [116.395, 39.895], P1: [116.386, 39.888], P2: [116.394, 39.888] } });
    const { geo } = parseGeoMapping(json, scenario);
    expect(geo!.coordVerified).toBe(false);
  });

  it("折线含非法坐标 → 忽略该通道并告警", () => {
    const json = JSON.stringify({
      coordVerified: true,
      nodes: { S: [116.39, 39.9], E1: [116.385, 39.895], E2: [116.39, 39.895], E3: [116.395, 39.895], P1: [116.386, 39.888], P2: [116.394, 39.888] },
      edges: { a1: [[116.39, 39.9], ["x", 1]] },
    });
    const { geo, issues } = parseGeoMapping(json, scenario);
    expect(geo!.edges?.a1).toBeUndefined();
    expect(issues.join()).toContain("a1");
  });
});

describe("getMapConfig：凭据与坐标齐备判定", () => {
  it("全部缺失 → ok=false 且 missing 含 key 与坐标", () => {
    const c = getMapConfig(scenario);
    expect(c.ok).toBe(false);
    if (!c.ok) {
      expect(c.missing).toContain("VITE_AMAP_KEY");
      expect(c.missing.join()).toContain("VITE_MAP_GEO_JSON");
    }
  });

  it("齐备 → ok=true", () => {
    vi.stubEnv("VITE_AMAP_KEY", "k");
    vi.stubEnv("VITE_AMAP_SECURITY_JS_CODE", "s");
    vi.stubEnv("VITE_MAP_GEO_JSON", VALID_JSON);
    const c = getMapConfig(scenario);
    expect(c.ok).toBe(true);
  });

  it("安全密钥可选：只有 key + 坐标（未启用安全密钥的旧 key）→ ok=true", () => {
    vi.stubEnv("VITE_AMAP_KEY", "k");
    vi.stubEnv("VITE_MAP_GEO_JSON", VALID_JSON);
    const c = getMapConfig(scenario);
    expect(c.ok).toBe(true);
    if (c.ok) expect(c.securityJsCode).toBe("");
  });

  it("有 key 但坐标缺失 → ok=false，不假装可用", () => {
    vi.stubEnv("VITE_AMAP_KEY", "k");
    vi.stubEnv("VITE_AMAP_SECURITY_JS_CODE", "s");
    vi.stubEnv("VITE_MAP_GEO_JSON", JSON.stringify({ nodes: { S: [1, 1] } }));
    const c = getMapConfig(scenario);
    expect(c.ok).toBe(false);
  });
});
