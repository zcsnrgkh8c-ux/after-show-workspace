/**
 * 公交/地铁展示层回归：
 * - 只解析高德真实 plans；空方案如实 no_route；
 * - 步行+公交分段摊平为折线；缺 path → polyline null；
 * - 换乘次数与步行距离按真实分段计算，不补 0。
 */
import { describe, expect, it } from "vitest";
import type { GeoPlace } from "../../../contract/travel";
import { parseTransitResult, planTransit, transitPolicyFor } from "./transit";

const ORIGIN: GeoPlace = {
  place_id: "p-o",
  label: "起点",
  lng: 115.87,
  lat: 28.74,
  coord_system: "GCJ-02",
  source: "poi",
  accuracy_m: null,
  source_note: "POI",
  city: "南昌市",
  address: null,
};
const DEST: GeoPlace = {
  ...ORIGIN,
  place_id: "p-d",
  label: "终点",
  lng: 115.9,
  lat: 28.68,
};

const CTX = {
  request_id: "req-t",
  candidate_set_id: "cand-t",
  origin: ORIGIN,
  destination: DEST,
  queried_at: "2026-11-14T12:00:00.000Z",
};

describe("parseTransitResult", () => {
  it("步行 + 地铁分段：摊平折线、换乘 0、步行距离来自分段", () => {
    const out = parseTransitResult(
      {
        status: "complete",
        result: {
          plans: [
            {
              distance: 5200,
              time: 1800,
              walking_distance: 800,
              segments: [
                {
                  walking: {
                    distance: 300,
                    time: 240,
                    steps: [{ path: [{ lng: 115.87, lat: 28.74 }, { lng: 115.871, lat: 28.741 }] }],
                  },
                },
                {
                  bus: {
                    buslines: [
                      {
                        name: "地铁1号线",
                        distance: 4900,
                        time: 1560,
                        via_num: 4,
                        departure_stop: { name: "双港" },
                        arrival_stop: { name: "八一广场" },
                        path: [{ lng: 115.88, lat: 28.72 }, { lng: 115.89, lat: 28.7 }],
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      },
      CTX
    );
    expect(out.status).toBe("ok");
    expect(out.routes[0].transfer_count).toBe(0);
    expect(out.routes[0].walking_distance_m).toBe(800);
    expect(out.routes[0].legs.map((l) => l.kind)).toEqual(["walking", "subway"]);
    expect(out.routes[0].legs[1].label).toBe("地铁");
    expect(out.routes[0].legs[1].detail).toContain("双港 → 八一广场");
    expect(out.routes[0].polyline).toEqual([
      [115.87, 28.74],
      [115.871, 28.741],
      [115.88, 28.72],
      [115.89, 28.7],
    ]);
  });

  it("JSAPI 2.0 实际格式：plan.path + transit_mode + lines/on_station/off_station", () => {
    const out = parseTransitResult(
      {
        status: "complete",
        result: {
          plans: [
            {
              distance: 18630,
              time: 3004,
              walking_distance: 1010,
              path: [
                { lng: 121.4737, lat: 31.2304 },
                { lng: 121.4726, lat: 31.2331 },
                { lng: 121.3263, lat: 31.1942 },
              ],
              segments: [
                {
                  transit_mode: "WALK",
                  instruction: "步行896米到达人民广场",
                  distance: 896,
                  time: 1083,
                  transit: { path: [{ lng: 121.4737, lat: 31.2304 }] },
                },
                {
                  transit_mode: "SUBWAY",
                  instruction: "乘坐地铁2号线途径8站到达虹桥2号航站楼",
                  distance: 17620,
                  time: 1800,
                  transit: {
                    via_num: 8,
                    lines: [{ name: "地铁2号线(浦东1号2号航站楼--蟠祥路·国家会计学院)", type: "地铁线路" }],
                    on_station: { name: "人民广场" },
                    off_station: { name: "虹桥2号航站楼" },
                    path: [{ lng: 121.4726, lat: 31.2331 }, { lng: 121.3263, lat: 31.1942 }],
                  },
                },
                {
                  transit_mode: "WALK",
                  instruction: "步行114米到达目的地",
                  distance: 114,
                  time: 121,
                  transit: { path: [{ lng: 121.3263, lat: 31.1942 }] },
                },
              ],
            },
          ],
        },
      },
      CTX
    );
    expect(out.status).toBe("ok");
    const route = out.routes[0];
    expect(route.transfer_count).toBe(0);
    expect(route.walking_distance_m).toBe(1010);
    expect(route.legs.map((l) => l.kind)).toEqual(["walking", "subway", "walking"]);
    expect(route.legs[1].detail).toContain("地铁2号线");
    expect(route.legs[1].detail).toContain("人民广场 → 虹桥2号航站楼");
    expect(route.polyline).toHaveLength(3);
  });

  it("两段公交 → 换乘 1 次；缺少 path → polyline null", () => {
    const out = parseTransitResult(
      {
        status: "complete",
        result: {
          plans: [
            {
              distance: 3000,
              time: 1200,
              segments: [
                { bus: { buslines: [{ name: "公交2路", distance: 1000, time: 400 }] } },
                { bus: { buslines: [{ name: "公交5路", distance: 2000, time: 800 }] } },
              ],
            },
          ],
        },
      },
      CTX
    );
    expect(out.routes[0].transfer_count).toBe(1);
    expect(out.routes[0].polyline).toBeNull();
    expect(out.routes[0].walking_distance_m).toBeNull();
  });

  it("无方案 → no_route；错误状态 → provider_error", () => {
    const empty = parseTransitResult({ status: "complete", result: { plans: [] } }, CTX);
    expect(empty.status).toBe("no_route");
    const error = parseTransitResult(
      { status: "error", result: { info: "INVALID_PARAMS", message: "参数错误" } },
      CTX
    );
    expect(error.status).toBe("provider_error");
    expect(error.message).toContain("参数错误");
  });
});

describe("planTransit", () => {
  function fakeAmap(transfer: unknown): Parameters<typeof planTransit>[0]["amap"] {
    return {
      Map: function () {} as never,
      LngLat: function (this: { lng: number; lat: number }, lng: number, lat: number) {
        this.lng = lng;
        this.lat = lat;
      } as never,
      Marker: function () {} as never,
      Polyline: function () {} as never,
      plugin: (() => {}) as never,
      Transfer: transfer as never,
    };
  }

  it("插件永不回调 → 有界超时", async () => {
    const Transfer = function () {
      return { search: () => {} };
    };
    const started = Date.now();
    const out = await planTransit({
      origin: ORIGIN,
      destination: DEST,
      city: "南昌市",
      amap: fakeAmap(Transfer),
      timeout_ms: 60,
    });
    expect(out.status).toBe("provider_error");
    expect(out.error_code).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("偏好映射为高德策略：少换乘=2、少步行=3、均衡不传", () => {
    expect(transitPolicyFor("less_transfer")).toBe("least_transfer");
    expect(transitPolicyFor("less_walking")).toBe("least_walk");
    expect(transitPolicyFor("balanced")).toBe("default");
    expect(transitPolicyFor(null)).toBe("default");
  });

  it("少换乘偏好确实传入 Transfer 构造参数（不是只存在界面状态里）", async () => {
    const captured: Array<Record<string, unknown>> = [];
    const Transfer = function (opts: Record<string, unknown>) {
      captured.push(opts);
      return {
        search: (_o: unknown, _d: unknown, cb: (status: unknown, result: unknown) => void) => {
          cb("complete", { plans: [{ distance: 1000, time: 600, segments: [] }] });
        },
      };
    };
    const out = await planTransit({
      origin: ORIGIN,
      destination: DEST,
      city: "南昌市",
      preference: "less_transfer",
      amap: fakeAmap(Transfer),
    });
    expect(captured[0].policy).toBe(2);
    expect(out.policy).toBe("least_transfer");
  });

  it("少步行偏好传 policy=3；均衡不传 policy", async () => {
    const captured: Array<Record<string, unknown>> = [];
    const Transfer = function (opts: Record<string, unknown>) {
      captured.push(opts);
      return { search: (_o: unknown, _d: unknown, cb: (s: unknown, r: unknown) => void) => cb("complete", { plans: [] }) };
    };
    const amap = fakeAmap(Transfer);
    await planTransit({ origin: ORIGIN, destination: DEST, city: "南昌市", preference: "less_walking", amap });
    await planTransit({ origin: ORIGIN, destination: DEST, city: "南昌市", preference: "balanced", amap });
    expect(captured[0].policy).toBe(3);
    expect("policy" in captured[1]).toBe(false);
  });

  it("无台阶硬需求：高德无此参数，结果如实标记未筛选", async () => {
    const Transfer = function () {
      return { search: (_o: unknown, _d: unknown, cb: (s: unknown, r: unknown) => void) => cb("complete", { plans: [] }) };
    };
    const out = await planTransit({
      origin: ORIGIN,
      destination: DEST,
      city: "南昌市",
      needs_step_free: true,
      amap: fakeAmap(Transfer),
    });
    expect(out.step_free_unverified).toBe(true);
  });

  it("正常回调 → 返回真实方案", async () => {
    const Transfer = function () {
      return {
        search: (_o: unknown, _d: unknown, cb: (status: unknown, result: unknown) => void) => {
          cb("complete", {
            plans: [
              {
                distance: 1000,
                time: 600,
                segments: [
                  { walking: { distance: 200, time: 150, steps: [{ path: [{ lng: 1, lat: 2 }, { lng: 1.1, lat: 2.1 }] }] } },
                  { bus: { buslines: [{ name: "地铁1号线", distance: 800, time: 450, path: [{ lng: 1.1, lat: 2.1 }, { lng: 1.2, lat: 2.2 }] }] } },
                ],
              },
            ],
          });
        },
      };
    };
    const out = await planTransit({
      origin: ORIGIN,
      destination: DEST,
      city: "南昌市",
      amap: fakeAmap(Transfer),
      timeout_ms: 500,
    });
    expect(out.status).toBe("ok");
    expect(out.routes[0].legs).toHaveLength(2);
  });
});
