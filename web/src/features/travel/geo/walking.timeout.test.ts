/**
 * 步行规划超时回归：
 * AMap.Walking 在某些状态下既不回调也不抛错，planWalking 必须有界返回 provider_error(timeout)，
 * 否则 useTravelFlow 的 planning 锁永久占用、用户无法重试。
 */
import { describe, expect, it } from "vitest";
import type { GeoPlace } from "../../../contract/travel";
import type { AMapNamespace } from "../vendor/types";
import { planWalking } from "./walking";

const origin: GeoPlace = {
  place_id: "o",
  label: "起点",
  lng: 115.87,
  lat: 28.74,
  coord_system: "GCJ-02",
  source: "poi",
  accuracy_m: null,
  source_note: "POI",
  city: null,
  address: null,
};
const destination: GeoPlace = { ...origin, place_id: "d", label: "终点" };

function fakeAmap(walkingBehavior: "silent" | "throw"): AMapNamespace {
  return {
    Map: function () {} as never,
    LngLat: function (this: { lng: number; lat: number }, lng: number, lat: number) {
      this.lng = lng;
      this.lat = lat;
    } as never,
    Marker: function () {} as never,
    Polyline: function () {} as never,
    plugin: () => {},
    Walking: function () {
      return {
        search: () => {
          if (walkingBehavior === "throw") throw new Error("network error");
          // silent：不回调、不抛错
        },
      };
    } as never,
  };
}

describe("planWalking 有界超时", () => {
  it("Walking 永不回调 → 超时返回 provider_error(timeout)，不永久挂起", async () => {
    const started = Date.now();
    const r = await planWalking({ origin, destination, amap: fakeAmap("silent"), timeout_ms: 60 });
    const elapsed = Date.now() - started;
    expect(r.status).toBe("provider_error");
    expect(r.error_code).toBe("timeout");
    expect(r.routes).toHaveLength(0);
    expect(r.message).toContain("超时");
    expect(elapsed).toBeLessThan(2000);
  });

  it("search 同步抛错 → 立即可重试的错误（不被超时覆盖）", async () => {
    const r = await planWalking({ origin, destination, amap: fakeAmap("throw"), timeout_ms: 5000 });
    expect(r.status).toBe("provider_error");
    expect(r.error_code).toBe("provider_error");
    expect(r.message).toContain("调用步行规划失败");
  });
});
