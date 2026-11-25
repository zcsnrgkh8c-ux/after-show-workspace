import { describe, expect, it } from "vitest";
import { cloneDefaultScenario } from "../contract/defaultScenario";
import type { Plan, SimulationResult, TimelineFrame } from "../contract/types";
import type { GeoMapping } from "./config";
import { MapOverlayController } from "./overlayController";
import type { AmapOverlayInstance } from "./types";

/* ---------- 假 AMap：记录创建/移除/标签更新次数 ---------- */

class FakeOverlay {
  static created = 0;
  labels: string[] = [];
  texts: string[] = [];
  handlers = new Map<string, () => void>();
  constructor(public readonly kind: string, public readonly opts: Record<string, unknown>) {
    FakeOverlay.created++;
  }
  on(event: string, cb: () => void) {
    this.handlers.set(event, cb);
  }
  setLabel(o: { content: string }) {
    this.labels.push(o.content);
  }
  setText(t: string) {
    this.texts.push(t);
  }
}

class FakeInfoWindow {
  content = "";
  opened = 0;
  closed = 0;
  setContent(c: string) {
    this.content = c;
  }
  open() {
    this.opened++;
  }
  close() {
    this.closed++;
  }
}

class FakeMap {
  added: FakeOverlay[] = [];
  removedTotal = 0;
  destroyed = false;
  add(o: FakeOverlay) {
    this.added.push(o);
  }
  remove(o: FakeOverlay) {
    this.removedTotal++;
    this.added = this.added.filter((x) => x !== o);
  }
  destroy() {
    this.destroyed = true;
  }
}

function fakeAmap(infoWindow: FakeInfoWindow) {
  return {
    Marker: class extends FakeOverlay {
      constructor(o: Record<string, unknown>) {
        super("marker", o);
      }
    },
    Polyline: class extends FakeOverlay {
      constructor(o: Record<string, unknown>) {
        super("polyline", o);
      }
    },
    Text: class extends FakeOverlay {
      constructor(o: Record<string, unknown>) {
        super("text", o);
      }
    },
    InfoWindow: function () {
      return infoWindow;
    } as unknown as new () => FakeInfoWindow,
    Pixel: function () {} as unknown as new (x: number, y: number) => unknown,
  };
}

/* ---------- 夹具 ---------- */

const scenario = cloneDefaultScenario();

const geo: GeoMapping = {
  venueName: "测试场地",
  coordVerified: true,
  nodes: { S: [1, 1], E1: [2, 2], E2: [3, 3], E3: [4, 4], P1: [5, 5], P2: [6, 6] },
  // edges 不配置 → 直连 + “模拟通道示意”
};

function mkFrame(t: number, nodeQueues: Record<string, number>, edgeCounts: Record<string, number>): TimelineFrame {
  return {
    t_s: t,
    released_count: 0,
    boarded_count: 0,
    queued_count: 0,
    walking_count: 0,
    node_queues: nodeQueues,
    edge_counts: edgeCounts,
    group_counts: {},
  };
}

const result = {
  departures_log: [{ vehicle_id: "B1", stop_id: "P1", depart_s: 100, boarded_count: 30 }],
} as unknown as SimulationResult;

const plan = {
  allocations: [
    { group_id: "regular", routes: [{ route_id: "R1", share: 1 }] },
    { group_id: "step_free", routes: [{ route_id: "R2", share: 1 }] },
    { group_id: "deadline", routes: [{ route_id: "R1", share: 1 }] },
  ],
} as unknown as Plan;

function setup() {
  FakeOverlay.created = 0;
  const map = new FakeMap();
  const info = new FakeInfoWindow();
  const ctl = new MapOverlayController(fakeAmap(info) as never, map as never);
  return { map, info, ctl };
}

const markers = (map: FakeMap) => map.added.filter((o) => o.kind === "marker");
const texts = (map: FakeMap) => map.added.filter((o) => o.kind === "text");
const lines = (map: FakeMap) => map.added.filter((o) => o.kind === "polyline");
const lastOf = (o: FakeOverlay) => o.labels[o.labels.length - 1] ?? "";

/* ---------- 测试 ---------- */

describe("MapOverlayController：覆盖物生命周期与帧更新分离", () => {
  it("rebuildBase 一次创建 6 节点标记 + 6 通道线 + 6 文字，共 18 个覆盖物", () => {
    const { map, ctl } = setup();
    ctl.rebuildBase(scenario, geo);
    expect(FakeOverlay.created).toBe(18);
    expect(markers(map).length).toBe(6);
    expect(lines(map).length).toBe(6);
    expect(texts(map).length).toBe(6);
    expect(map.added.length).toBe(18);
  });

  it("只推进 frame：创建/移除次数不增加，标签正常更新", () => {
    const { map, ctl } = setup();
    ctl.rebuildBase(scenario, geo);
    ctl.applyFrame(scenario, geo, mkFrame(0, {}, {}), null);
    const createdAfterBase = FakeOverlay.created;

    for (const t of [100, 200, 300]) {
      ctl.applyFrame(scenario, geo, mkFrame(t, { P1: 12, S: 5 }, { a1: 3 }), result);
    }

    expect(FakeOverlay.created).toBe(createdAfterBase); // 无新增创建
    expect(map.removedTotal).toBe(0); // 无任何移除
    expect(map.added.length).toBe(18); // 无重复覆盖物

    const p1 = markers(map).find((m) => (m.opts.extData as { node_id: string }).node_id === "P1")!;
    expect(lastOf(p1)).toContain("排队 12");
    expect(lastOf(p1)).toContain("累计登车 30"); // 来自真实 departures_log（t≥100）

    const sMarker = markers(map).find((m) => (m.opts.extData as { node_id: string }).node_id === "S")!;
    expect(lastOf(sMarker)).toContain("排队 5");

    const a1Text = texts(map).find((t) => t.texts.length > 0)!;
    expect(a1Text.texts[a1Text.texts.length - 1]).toContain("3人步行");
  });

  it("再次 rebuildBase（场景变更）：旧覆盖物全部移除、无重复残留", () => {
    const { map, ctl } = setup();
    ctl.rebuildBase(scenario, geo);
    ctl.rebuildBase(scenario, geo);
    expect(map.removedTotal).toBe(18);
    expect(map.added.length).toBe(18);
    expect(FakeOverlay.created).toBe(36);
  });

  it("rebuildRoutes：按方案创建路线覆盖物；仅选中组路线标注文字且不残留", () => {
    const { map, ctl } = setup();
    ctl.rebuildBase(scenario, geo);
    const baseCreated = FakeOverlay.created;

    ctl.rebuildRoutes(scenario, geo, plan, null);
    // 未选中组：R1、R2 各 1 条线，无路线文字
    expect(FakeOverlay.created).toBe(baseCreated + 2);
    const afterFirst = map.added.length;

    ctl.rebuildRoutes(scenario, geo, plan, "step_free");
    // 默认组视角：命中路线加粗，但不在图上铺份额标签（比例由路线卡承载）→ 先清后建，2 线 + 0 文字
    expect(map.added.length).toBe(afterFirst);

    // 选中组命中的路线加粗高亮
    const routeLines = lines(map).filter((l) => (l.opts.extData as { route_id?: string }).route_id);
    const r2 = routeLines.find((l) => (l.opts.extData as { route_id: string }).route_id === "R2")!;
    expect(r2.opts.strokeWeight).toBe(7);
    expect(r2.opts.strokeColor).toBe("#315CE7");
    const r1 = routeLines.find((l) => (l.opts.extData as { route_id: string }).route_id === "R1")!;
    expect(r1.opts.strokeColor).toBe("#94a3b8");

    // 默认组视角不贴任何路线文字（避免出口附近份额标签挤压）
    const routeTexts = texts(map).filter((t) => (t.opts.text as string).includes("路线"));
    expect(routeTexts.length).toBe(0);

    // plan 置空 → 路线覆盖物清空
    ctl.rebuildRoutes(scenario, geo, null, null);
    expect(lines(map).filter((l) => (l.opts.extData as { route_id?: string }).route_id).length).toBe(0);
  });

  it("rebuildRoutes + selectedRouteId：仅选中路线加粗、其余淡化、文字只标注一处；且优先于组高亮", () => {
    const { map, ctl } = setup();
    ctl.rebuildBase(scenario, geo);

    // 只传 selectedRouteId（组为 null）
    ctl.rebuildRoutes(scenario, geo, plan, null, "R1");
    let routeLines = lines(map).filter((l) => (l.opts.extData as { route_id?: string }).route_id);
    const r1 = routeLines.find((l) => (l.opts.extData as { route_id: string }).route_id === "R1")!;
    const r2 = routeLines.find((l) => (l.opts.extData as { route_id: string }).route_id === "R2")!;
    expect(r1.opts.strokeWeight).toBe(7);
    expect(r1.opts.strokeColor).toBe("#315CE7");
    expect(r2.opts.strokeWeight).toBe(3);
    expect(r2.opts.strokeColor).toBe("#94a3b8");
    const routeTexts = texts(map).filter((t) => (t.opts.text as string).includes("路线"));
    expect(routeTexts.length).toBe(1);
    expect(routeTexts[0].opts.text).toContain("R1");

    // selectedRouteId 优先于 selectedGroupId：即便选中 step_free 组，也只加粗 R1
    ctl.rebuildRoutes(scenario, geo, plan, "step_free", "R1");
    routeLines = lines(map).filter((l) => (l.opts.extData as { route_id?: string }).route_id);
    expect(routeLines.find((l) => (l.opts.extData as { route_id: string }).route_id === "R1")!.opts.strokeColor).toBe("#315CE7");
    expect(routeLines.find((l) => (l.opts.extData as { route_id: string }).route_id === "R2")!.opts.strokeColor).toBe("#94a3b8");

    // selectedRouteId 不在方案使用路线中：无任何路线加粗、无路线文字
    ctl.rebuildRoutes(scenario, geo, plan, null, "R999");
    routeLines = lines(map).filter((l) => (l.opts.extData as { route_id?: string }).route_id);
    expect(routeLines.length).toBe(2);
    expect(routeLines.every((l) => l.opts.strokeColor === "#94a3b8")).toBe(true);
    expect(texts(map).filter((t) => (t.opts.text as string).includes("路线")).length).toBe(0);
  });

  it("文字编码：关闭/台阶有短文字标签，开放无台阶通道不贴文字（容量与边 ID 留给点选详情）", () => {
    const { map, ctl } = setup();
    const closedScenario = cloneDefaultScenario();
    closedScenario.edges[0].closed = true; // a1
    ctl.rebuildBase(closedScenario, geo);
    const textsNow = texts(map);
    const closedText = textsNow.find((t) => (t.opts.text as string).includes("已关闭"))!;
    expect(closedText.opts.text).toContain("✕已关闭");
    expect(textsNow.filter((t) => (t.opts.text as string) === "台阶").length).toBe(2); // c1、c2
    expect(textsNow.filter((t) => (t.opts.text as string) === "").length).toBe(3); // a2、b1、b2
  });

  it("dispose：覆盖物全部移除；dispose 后所有方法静默无副作用", () => {
    const { map, info, ctl } = setup();
    ctl.rebuildBase(scenario, geo);
    ctl.rebuildRoutes(scenario, geo, plan, null);
    ctl.dispose();
    expect(map.added.length).toBe(0);
    expect(info.closed).toBe(1);
    const createdAtDispose = FakeOverlay.created;
    expect(() => {
      ctl.rebuildBase(scenario, geo);
      ctl.applyFrame(scenario, geo, mkFrame(0, { P1: 1 }, {}), result);
      ctl.rebuildRoutes(scenario, geo, plan, null);
    }).not.toThrow();
    expect(FakeOverlay.created).toBe(createdAtDispose);
  });

  it("节点点击回调透传 node_id；showNodeInfo 打开信息窗", () => {
    const { map, info, ctl } = setup();
    let clicked: string | null = null;
    ctl.onNodeClick = (id) => (clicked = id);
    ctl.rebuildBase(scenario, geo);
    const p2 = markers(map).find((m) => (m.opts.extData as { node_id: string }).node_id === "P2")!;
    p2.handlers.get("click")!();
    expect(clicked).toBe("P2");
    ctl.showNodeInfo(scenario, geo, mkFrame(50, { P2: 8 }, {}), "P2");
    expect(info.opened).toBe(1);
    expect(info.content).toContain("P2");
    expect(info.content).toContain("排队：8");
  });
});
