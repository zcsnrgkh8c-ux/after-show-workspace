/**
 * 定位视野决策回归（修复“点定位后地图空白”）：
 * 境外坐标不得移动视野；城市级/IP 定位不得放大到街道级。
 */
import { describe, expect, it } from "vitest";
import { isInChinaCoverage, locateViewPlan, zoomForLocation } from "./locateView";

describe("isInChinaCoverage", () => {
  it("南昌/北京在范围内", () => {
    expect(isInChinaCoverage([115.870943, 28.740046])).toBe(true);
    expect(isInChinaCoverage([116.39, 39.9])).toBe(true);
  });

  it("东京/纽约在范围外", () => {
    expect(isInChinaCoverage([139.7671, 35.6812])).toBe(false);
    expect(isInChinaCoverage([-74.006, 40.7128])).toBe(false);
  });
});

describe("zoomForLocation", () => {
  it("城市级定位用 11 级", () => {
    expect(zoomForLocation({ precision: "city", accuracyM: undefined })).toBe(11);
  });

  it("IP 级精度（>5km 或无精度）用 11 级", () => {
    expect(zoomForLocation({ precision: "browser", accuracyM: 20000 })).toBe(11);
    expect(zoomForLocation({ precision: "browser", accuracyM: undefined })).toBe(11);
  });

  it("1~5km 用 13 级，精确定位用 15 级", () => {
    expect(zoomForLocation({ precision: "browser", accuracyM: 2000 })).toBe(13);
    expect(zoomForLocation({ precision: "browser", accuracyM: 40 })).toBe(15);
  });
});

describe("locateViewPlan", () => {
  it("境外坐标：不移动视野，给出可操作原因", () => {
    const plan = locateViewPlan({
      position: [139.7671, 35.6812],
      source: "geolocation",
      precision: "browser",
      label: "当前定位",
      accuracyM: 30,
    });
    expect(plan.move).toBe(false);
    if (!plan.move) {
      expect(plan.reason).toBe("请使用国内IP访问");
    }
  });

  it("国内精确定位：移动并放大到 15 级", () => {
    expect(
      locateViewPlan({
        position: [115.870943, 28.740046],
        source: "geolocation",
        precision: "browser",
        label: "当前定位",
        accuracyM: 40,
      })
    ).toEqual({ move: true, zoom: 15 });
  });

  it("国内城市级：移动但保持城市视野（11 级）", () => {
    expect(
      locateViewPlan({
        position: [115.87, 28.74],
        source: "geolocation",
        precision: "city",
        label: "南昌市",
      })
    ).toEqual({ move: true, zoom: 11 });
  });
});
