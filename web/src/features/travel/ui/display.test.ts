/**
 * 窗口2本轮局部测试：出行步骤、来源/精度、建议模式与地图绘制计数的纯展示推导。
 * 关注：规则建议不冒充模型、unavailable 不伪装成基础建议、IP 近似不称精确定位、
 * 无坐标/无折线不被算作已绘制。全部为 node 环境纯函数测试，不请求外部服务。
 */
import { describe, expect, it } from "vitest";
import type { GeoPlace, RouteSearchResult, TravelRoute } from "../../../contract/travel";
import {
  accuracyText,
  adviceErrorText,
  adviceModeView,
  drawnRouteCount,
  placeSourceView,
  stepForInputs,
} from "./display";

const POI: GeoPlace = {
  place_id: "poi-1",
  label: "测试地点",
  lng: 115.87,
  lat: 28.74,
  coord_system: "GCJ-02",
  source: "poi",
  accuracy_m: null,
  source_note: "POI",
  city: "南昌市",
  address: "测试路1号",
};

function geo(accuracy: number | null, sourceNote: string): GeoPlace {
  return {
    place_id: "geo-1",
    label: "当前位置",
    lng: 115.87,
    lat: 28.74,
    coord_system: "GCJ-02",
    source: "geolocation",
    accuracy_m: accuracy,
    source_note: sourceNote,
    city: null,
    address: null,
  };
}

describe("stepForInputs：主操作随步骤变化", () => {
  it("无起点→起点；仅有起点→终点；起终点齐→规划；已有结果→结果", () => {
    expect(stepForInputs({ hasOrigin: false, hasDestination: false, hasRouteResult: false })).toBe("origin");
    expect(stepForInputs({ hasOrigin: true, hasDestination: false, hasRouteResult: false })).toBe("destination");
    expect(stepForInputs({ hasOrigin: true, hasDestination: true, hasRouteResult: false })).toBe("plan");
    expect(stepForInputs({ hasOrigin: true, hasDestination: true, hasRouteResult: true })).toBe("result");
  });
});

describe("placeSourceView / accuracyText：定位与地点来源按真实字段表达", () => {
  it("POI 来源明确为高德地点检索，无精度", () => {
    const v = placeSourceView(POI)!;
    expect(v.text).toContain("POI");
    expect(v.lowAccuracy).toBe(false);
    expect(accuracyText(POI)).toBeNull();
  });

  it("浏览器定位（GPS 路径）标注已转 GCJ-02；精度 40m 不告警", () => {
    const place = geo(40, "GPS");
    const v = placeSourceView(place)!;
    expect(v.text).toContain("浏览器定位");
    expect(v.text).toContain("GCJ-02");
    expect(v.approximate).toBe(false);
    expect(v.lowAccuracy).toBe(false);
    expect(accuracyText(place)).toBe("精度约 ±40 米");
  });

  it("IP 近似明确标注非精确 GPS，并触发低精度提示", () => {
    const v = placeSourceView(geo(2000, "IP近似"))!;
    expect(v.text).toContain("IP 近似");
    expect(v.text).toContain("非精确");
    expect(v.approximate).toBe(true);
    expect(v.lowAccuracy).toBe(true);
  });

  it("浏览器定位精度超过 100m 视为低精度；精度缺失时不编造", () => {
    expect(placeSourceView(geo(500, "GPS"))!.lowAccuracy).toBe(true);
    const noAcc = geo(null, "GPS");
    expect(placeSourceView(noAcc)!.lowAccuracy).toBe(false);
    expect(accuracyText(noAcc)).toBeNull();
    expect(placeSourceView(null)).toBeNull();
  });
});

describe("adviceModeView：rules 不冒充模型，llm 才标模型分析", () => {
  it("mode=llm → 模型分析；badge 为模型分析", () => {
    const v = adviceModeView({ mode: "llm", degraded_from: null });
    expect(v.isModel).toBe(true);
    expect(v.title).toBe("模型分析建议");
    expect(v.badge).toBe("模型分析");
  });

  it("mode=rules（纯规则）→ 基础路线建议，不含模型/AI 语义", () => {
    const v = adviceModeView({ mode: "rules", degraded_from: null });
    expect(v.isModel).toBe(false);
    expect(v.degraded).toBe(false);
    expect(v.title).toBe("基础路线建议");
    expect(v.badge).toBe("规则");
    expect(v.title).not.toContain("模型");
    expect(v.title).not.toContain("AI");
  });

  it("rules + degraded_from=llm → 明确指出模型调用失败后降级", () => {
    const v = adviceModeView({ mode: "rules", degraded_from: "llm" });
    expect(v.degraded).toBe(true);
    expect(v.isModel).toBe(false);
    expect(v.modeNote).toContain("降级");
  });

  it("mode=unavailable → 出行建议不可用，不伪装成基础建议", () => {
    const v = adviceModeView({ mode: "unavailable", degraded_from: null });
    expect(v.title).toBe("出行建议不可用");
    expect(v.title).not.toBe("基础路线建议");
    expect(v.badge).toBe("不可用");
    expect(v.isModel).toBe(false);
  });
});

describe("adviceErrorText：建议失败据实提示", () => {
  it("超时/网络/校验失败/HTTP 错误映射为可读短句", () => {
    expect(adviceErrorText({ code: "timeout", message: "x", status: null })).toBe("请求超时");
    expect(adviceErrorText({ code: "network", message: "x", status: null })).toBe("网络异常");
    expect(adviceErrorText({ code: "invalid_response", message: "x", status: 200 })).toBe("响应未通过契约校验");
    expect(adviceErrorText({ code: "http_error", message: "x", status: 500 })).toContain("HTTP 500");
    expect(adviceErrorText({ code: "other", message: "原始信息", status: null })).toBe("原始信息");
  });
});

describe("drawnRouteCount：只统计真实返回折线的路线", () => {
  const route = (id: string, polyline: Array<[number, number]> | null): TravelRoute =>
    ({
      route_id: id,
      polyline,
      distance_m: 1000,
      estimated_duration_s: 600,
      step_free_evidence: "unknown",
    }) as unknown as TravelRoute;

  const result = (status: RouteSearchResult["status"], routes: TravelRoute[]): RouteSearchResult =>
    ({ status, routes }) as unknown as RouteSearchResult;

  it("null / no_route / provider_error 均为 0", () => {
    expect(drawnRouteCount(null)).toBe(0);
    expect(drawnRouteCount(result("no_route", []))).toBe(0);
    expect(drawnRouteCount(result("provider_error", []))).toBe(0);
  });

  it("ok：无折线与单点折线不计数，仅有效折线计数", () => {
    const routes = [
      route("r1", [[1, 1], [2, 2]]),
      route("r2", null),
      route("r3", [[1, 1]]),
    ];
    expect(drawnRouteCount(result("ok", routes))).toBe(1);
  });
});
