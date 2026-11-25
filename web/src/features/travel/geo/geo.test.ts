/**
 * geo 适配层纯解析函数测试（node 环境，固定假响应，不真实网络）：
 * - parseWalkingResult：正常多路线 / 缺 distance→null / 空→no_route / 错误→provider_error / polyline 摊平
 * - parsePlaceTips：正常 / 无 location tip→null / 空 keyword（空 tips）
 * - parseLocateOutcome：ok / IP近似标注 / denied / timeout / unavailable
 */
import { describe, expect, it } from "vitest";
import { parseLocateOutcome } from "./geolocation";
import { parsePlaceTips } from "./places";
import { parseWalkingResult } from "./walking";
import type { GeoPlace } from "../../../contract/travel";

const ORIGIN: GeoPlace = {
  place_id: "poi-origin-fix",
  label: "测试起点",
  lng: 116.397428,
  lat: 39.90923,
  coord_system: "GCJ-02",
  source: "poi",
  accuracy_m: null,
  source_note: "POI",
  city: "北京市",
  address: "东城区测试路1号",
};

const DEST: GeoPlace = {
  place_id: "poi-dest-fix",
  label: "测试终点",
  lng: 116.418757,
  lat: 39.917544,
  coord_system: "GCJ-02",
  source: "poi",
  accuracy_m: null,
  source_note: "POI",
  city: "北京市",
  address: "西城区测试路2号",
};

const CTX = {
  request_id: "req-fixed-0001",
  candidate_set_id: "cand-fixed-0001",
  origin: ORIGIN,
  destination: DEST,
  queried_at: "2026-11-14T10:00:00.000Z",
};

/** LngLat 实例形态的假坐标（带 getLng/getLat 方法） */
function lngLatInstance(lng: number, lat: number) {
  return { getLng: () => lng, getLat: () => lat };
}

describe("parseWalkingResult", () => {
  it("正常多路线：解析距离/时长/步骤/折线，身份与起终点原样回显", () => {
    const raw = {
      status: "complete",
      result: {
        routes: [
          {
            distance: 1250,
            time: 900,
            steps: [
              { instruction: "沿测试路向东步行100米", distance: 100, time: 80, path: [lngLatInstance(116.397428, 39.90923), { lng: 116.3985, lat: 39.9095 }] },
              { instruction: "右转进入测试二路", distance: 1150, time: 820, path: [{ lng: 116.3985, lat: 39.9095 }, { lng: 116.418757, lat: 39.917544 }] },
            ],
          },
          {
            distance: 1800,
            time: 1300,
            steps: [
              { instruction: "沿另一条路步行", distance: 1800, time: 1300, path: [lngLatInstance(116.397428, 39.90923), { lng: 116.41, lat: 39.915 }, { lng: 116.418757, lat: 39.917544 }] },
            ],
          },
        ],
      },
    };
    const result = parseWalkingResult(raw, CTX);

    expect(result.status).toBe("ok");
    expect(result.request_id).toBe("req-fixed-0001");
    expect(result.candidate_set_id).toBe("cand-fixed-0001");
    expect(result.origin).toEqual(ORIGIN);
    expect(result.destination).toEqual(DEST);
    expect(result.mode).toBe("walking");
    expect(result.error_code).toBeNull();
    expect(result.routes).toHaveLength(2);

    const r1 = result.routes[0];
    expect(r1.route_id.startsWith("amap-r1-")).toBe(true);
    expect(r1.provider).toBe("amap");
    expect(r1.queried_at).toBe("2026-11-14T10:00:00.000Z");
    expect(r1.distance_m).toBe(1250);
    expect(r1.estimated_duration_s).toBe(900);
    expect(r1.walking_distance_m).toBe(1250);
    expect(r1.transfer_count).toBe(0);
    expect(r1.steps).toEqual([
      { instruction: "沿测试路向东步行100米", distance_m: 100, duration_s: 80 },
      { instruction: "右转进入测试二路", distance_m: 1150, duration_s: 820 },
    ]);
    // polyline 摊平：两条 step 的 path 依序合并为 [lng,lat]
    expect(r1.polyline).toEqual([
      [116.397428, 39.90923],
      [116.3985, 39.9095],
      [116.3985, 39.9095],
      [116.418757, 39.917544],
    ]);
    expect(r1.step_free_evidence).toBe("unknown");
    expect(r1.step_free_note).toBeNull();

    const r2 = result.routes[1];
    expect(r2.route_id.startsWith("amap-r2-")).toBe(true);
    expect(r2.distance_m).toBe(1800);
    expect(r2.polyline).toEqual([
      [116.397428, 39.90923],
      [116.41, 39.915],
      [116.418757, 39.917544],
    ]);
  });

  it("路线缺 distance/time → null，缺 path → polyline null（不造直线）", () => {
    const raw = {
      status: "complete",
      result: {
        routes: [
          {
            steps: [{ instruction: "无量化数据的步骤" }],
          },
        ],
      },
    };
    const result = parseWalkingResult(raw, CTX);
    expect(result.status).toBe("ok");
    const r = result.routes[0];
    expect(r.distance_m).toBeNull();
    expect(r.estimated_duration_s).toBeNull();
    expect(r.walking_distance_m).toBeNull();
    expect(r.steps[0]).toEqual({ instruction: "无量化数据的步骤", distance_m: null, duration_s: null });
    expect(r.polyline).toBeNull();
  });

  it("空 routes → no_route，且不发 error_code", () => {
    const result = parseWalkingResult({ status: "complete", result: { routes: [] } }, CTX);
    expect(result.status).toBe("no_route");
    expect(result.routes).toEqual([]);
    expect(result.error_code).toBeNull();
    expect(result.message).toContain("未返回可行步行路线");
  });

  it("错误回调 → provider_error + 归类 error_code（timeout）", () => {
    const result = parseWalkingResult(
      { status: "error", result: { info: "TIMEOUT", message: "请求超时" } },
      CTX,
    );
    expect(result.status).toBe("provider_error");
    expect(result.error_code).toBe("timeout");
    expect(result.routes).toEqual([]);
    expect(result.message).toContain("超时");
  });

  it("网络类错误信息 → error_code network", () => {
    const result = parseWalkingResult(
      { status: "error", result: { info: "NETWORK_ERROR", message: "连接失败" } },
      CTX,
    );
    expect(result.status).toBe("provider_error");
    expect(result.error_code).toBe("network");
  });
});

describe("parsePlaceTips", () => {
  it("正常 tips：解析名称/区县/地址/坐标，suggestion_id 含 request_seq 与序号", () => {
    const raw = {
      tips: [
        { id: "B000A1", name: "测试广场", district: "北京市东城区", address: "测试路10号", location: { lng: 116.397428, lat: 39.90923 } },
        { id: "B000A2", name: "测试公园", district: "北京市西城区", address: "另一条路20号", location: lngLatInstance(116.41, 39.91) },
      ],
    };
    const tips = parsePlaceTips(raw, { request_seq: 7 });
    expect(tips).toHaveLength(2);
    expect(tips[0]).toEqual({
      suggestion_id: "sug-7-0",
      label: "测试广场",
      district: "北京市东城区",
      address: "测试路10号",
      location: { lng: 116.397428, lat: 39.90923 },
    });
    expect(tips[1].suggestion_id).toBe("sug-7-1");
    expect(tips[1].location).toEqual({ lng: 116.41, lat: 39.91 });
  });

  it("location 缺失/空数组/全0 → location=null，禁止 [0,0] 充数", () => {
    const raw = {
      tips: [
        { name: "无坐标POI", district: "北京市", address: "", location: null },
        { name: "空数组坐标POI", district: "北京市", address: "", location: [] },
        { name: "全零坐标POI", district: "北京市", address: "", location: { lng: 0, lat: 0 } },
        { name: "正常POI", district: "北京市", address: "x", location: { lng: 116.4, lat: 39.9 } },
      ],
    };
    const tips = parsePlaceTips(raw, { request_seq: 1 });
    expect(tips).toHaveLength(4);
    expect(tips[0].location).toBeNull();
    expect(tips[1].location).toBeNull();
    expect(tips[2].location).toBeNull();
    expect(tips[3].location).toEqual({ lng: 116.4, lat: 39.9 });
  });

  it("空数据形态（无 tips / 空数组 / 非对象）→ 空列表，不造假 POI", () => {
    expect(parsePlaceTips({}, { request_seq: 1 })).toEqual([]);
    expect(parsePlaceTips({ tips: [] }, { request_seq: 1 })).toEqual([]);
    expect(parsePlaceTips(null, { request_seq: 1 })).toEqual([]);
    expect(parsePlaceTips("error", { request_seq: 1 })).toEqual([]);
  });
});

describe("parseLocateOutcome", () => {
  it("complete + html5 → ok：GeoPlace 标注 GPS、精度、GCJ-02", () => {
    const raw = {
      status: "complete",
      result: {
        position: { lng: 116.397428, lat: 39.90923 },
        accuracy: 35,
        location_type: "html5",
      },
    };
    const outcome = parseLocateOutcome(raw);
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.place.place_id.startsWith("geo-")).toBe(true);
    expect(outcome.place.label).toBe("当前位置");
    expect(outcome.place.lng).toBe(116.397428);
    expect(outcome.place.lat).toBe(39.90923);
    expect(outcome.place.coord_system).toBe("GCJ-02");
    expect(outcome.place.source).toBe("geolocation");
    expect(outcome.place.source_note).toBe("GPS");
    expect(outcome.place.accuracy_m).toBe(35);
    expect(outcome.place.city).toBeNull();
    expect(outcome.place.address).toBeNull();
  });

  it("location_type=ip → source_note 必须标注 IP近似（不冒充精确 GPS）", () => {
    const raw = {
      status: "complete",
      result: {
        position: lngLatInstance(116.4, 39.92),
        accuracy: null,
        location_type: "ip",
      },
    };
    const outcome = parseLocateOutcome(raw);
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.place.source_note).toBe("IP近似");
    expect(outcome.place.accuracy_m).toBeNull();
  });

  it("PERMISSION_DENIED → denied", () => {
    const outcome = parseLocateOutcome({
      status: "error",
      result: { info: "PERMISSION_DENIED", message: "User denied Geolocation" },
    });
    expect(outcome.status).toBe("denied");
    if (outcome.status === "ok") return;
    expect(outcome.message).toContain("权限");
  });

  it("TIMEOUT → timeout", () => {
    const outcome = parseLocateOutcome({
      status: "error",
      result: { info: "TIMEOUT", message: "Timeout expired" },
    });
    expect(outcome.status).toBe("timeout");
  });

  it("POSITION_UNAVAILABLE → unavailable", () => {
    const outcome = parseLocateOutcome({
      status: "error",
      result: { info: "POSITION_UNAVAILABLE", message: "位置不可用" },
    });
    expect(outcome.status).toBe("unavailable");
  });

  it("complete 但缺有效坐标 → error（不编造坐标）", () => {
    const outcome = parseLocateOutcome({
      status: "complete",
      result: { position: null, location_type: "ip" },
    });
    expect(outcome.status).toBe("error");
  });
});
