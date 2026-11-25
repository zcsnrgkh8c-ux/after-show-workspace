/**
 * 真实步行动线适配回归：
 * - 只接受高德真实折线，空折线/错误一律失败；
 * - 超时有界，迟到回调忽略；
 * - 缺距离/时间为 null，不补 0。
 */
import { describe, expect, it } from "vitest";
import { parseEdgeWalking, planEdgeWalking } from "./edgeWalking";
import type { AmapNamespace } from "./types";

function fakeAmap(walking: unknown): AmapNamespace {
  return {
    Map: function () {} as never,
    Marker: function () {} as never,
    Polyline: function () {} as never,
    Text: function () {} as never,
    InfoWindow: function () {} as never,
    Pixel: function () {} as never,
    LngLat: function (this: { lng: number; lat: number }, lng: number, lat: number) {
      this.lng = lng;
      this.lat = lat;
    } as never,
    Walking: walking as never,
  };
}

describe("parseEdgeWalking", () => {
  it("正常返回：距离/时间 + steps 折线摊平（实例与普通对象混用）", () => {
    const out = parseEdgeWalking({
      status: "complete",
      result: {
        routes: [
          {
            distance: "320",
            time: 280,
            steps: [
              {
                path: [
                  { lng: 115.87, lat: 28.74 },
                  { getLng: () => 115.871, getLat: () => 28.741 },
                ],
              },
              { path: [{ lng: 115.872, lat: 28.742 }] },
            ],
          },
        ],
      },
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.distance_m).toBe(320);
      expect(out.value.duration_s).toBe(280);
      expect(out.value.polyline).toEqual([
        [115.87, 28.74],
        [115.871, 28.741],
        [115.872, 28.742],
      ]);
    }
  });

  it("缺 distance/time → null，不补 0", () => {
    const out = parseEdgeWalking({
      status: "complete",
      result: { routes: [{ steps: [{ path: [{ lng: 1, lat: 2 }, { lng: 1.1, lat: 2.1 }] }] }] },
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.distance_m).toBeNull();
      expect(out.value.duration_s).toBeNull();
    }
  });

  it("无路线 / 折线为空 → 失败，不用直线替代", () => {
    expect(parseEdgeWalking({ status: "complete", result: { routes: [] } })).toEqual({
      ok: false,
      reason: "高德未返回可行步行路线",
    });
    const noPath = parseEdgeWalking({ status: "complete", result: { routes: [{ steps: [] }] } });
    expect(noPath.ok).toBe(false);
    if (!noPath.ok) expect(noPath.reason).toContain("未返回步行折线");
  });

  it("高德错误状态 → 带原因失败", () => {
    const out = parseEdgeWalking({ status: "error", result: { info: "INVALID_PARAMS", message: "参数错误" } });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("参数错误");
  });
});

describe("planEdgeWalking", () => {
  it("插件缺失 → 直接失败，不抛错", async () => {
    const out = await planEdgeWalking(fakeAmap(undefined), [1, 2], [1.1, 2.1]);
    expect(out.ok).toBe(false);
  });

  it("插件永不回调 → 有界超时", async () => {
    const Walking = function () {
      return { search: () => {} };
    };
    const started = Date.now();
    const out = await planEdgeWalking(fakeAmap(Walking), [1, 2], [1.1, 2.1], 60);
    expect(out.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
    if (!out.ok) expect(out.reason).toContain("超时");
  });

  it("正常回调 → 返回真实折线", async () => {
    const Walking = function () {
      return {
        search: (
          _o: unknown,
          _d: unknown,
          cb: (status: unknown, result: unknown) => void
        ) => {
          cb("complete", {
            routes: [{ distance: 100, time: 80, steps: [{ path: [{ lng: 1, lat: 2 }, { lng: 1.1, lat: 2.1 }] }] }],
          });
        },
      };
    };
    const out = await planEdgeWalking(fakeAmap(Walking), [1, 2], [1.1, 2.1], 500);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value.polyline.length).toBe(2);
  });
});
