/**
 * demand.ts — 确定性需求生成与路线分配。
 *
 * 公平性铁律：释放时刻只由 scenario + seed 生成一次，与任何 plan 无关；
 * 所有候选 plan 共用同一批 person_id 与释放时刻。路线分配在释放时刻
 * 生成之后纯确定性进行，不消耗任何随机数，因此策略差异不会改变到达人群。
 */

import type { Plan, Scenario } from "../../shared/types.ts";

/** 单个旅客的不可变需求描述（引擎内部扩展其运行状态） */
export interface PersonSpec {
  person_id: string;
  group_id: string;
  release_s: number;
  /** 分配的路线；null = 留在 S 等待（未满足服务） */
  route_id: string | null;
  route_edge_ids: string[];
  walk_time_factor: number;
  board_deadline_s: number | null;
}

/** FNV-1a 32bit：稳定字符串散列，不依赖运行环境 */
export function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32：确定性 PRNG，返回 [0, 1) */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 由 scenario + seed 一次性生成全部旅客的释放时刻。
 * 每组一条独立 PRNG 流（键 = hash(seed, group_id)），与组的遍历顺序、
 * 其他组的人数、以及后续任何 plan 均无关。
 * 释放时刻在 [release_start_s, release_end_s] 内均匀抽取并对齐 step_s（两端可取）。
 * 返回按 (release_s, person_id) 排序——同一到达时刻按固定 person_id 排序。
 */
export function generateDemand(scenario: Scenario, seed: number): PersonSpec[] {
  const persons: PersonSpec[] = [];
  for (const g of scenario.groups) {
    const rng = mulberry32(hashString(`${seed}:${g.group_id}`));
    const spanSteps = Math.round((g.release_end_s - g.release_start_s) / scenario.step_s);
    for (let i = 0; i < g.count; i++) {
      const k = Math.min(Math.floor(rng() * (spanSteps + 1)), spanSteps);
      persons.push({
        person_id: `${g.group_id}#${String(i).padStart(6, "0")}`,
        group_id: g.group_id,
        release_s: g.release_start_s + k * scenario.step_s,
        route_id: null,
        route_edge_ids: [],
        walk_time_factor: g.walk_time_factor,
        board_deadline_s: g.board_deadline_s,
      });
    }
  }
  persons.sort(
    (a, b) => a.release_s - b.release_s || (a.person_id < b.person_id ? -1 : a.person_id > b.person_id ? 1 : 0),
  );
  return persons;
}

/**
 * 最大余数法：把 n 按 shares 拆成整数，同余数按 route_id 字典序（此处即下标序，调用方已排序）。
 */
export function largestRemainder(n: number, shares: number[]): number[] {
  const base = shares.map((s) => Math.floor(n * s));
  let rest = n - base.reduce((a, b) => a + b, 0);
  const order = shares
    .map((s, i) => ({ i, frac: n * s - Math.floor(n * s) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const o of order) {
    if (rest <= 0) break;
    base[o.i] += 1;
    rest -= 1;
  }
  return base;
}

/**
 * 按 plan.allocations 把路线确定性分配给具体旅客（就地修改）。
 * 组内按 person_id 顺序对路线“轮转发牌”：避免先释放的人整块挤入第一条
 * 路线造成系统性偏倚；分配过程不消耗随机数。
 * routes 为空的组保持 route_id = null（留在 S）。
 */
export function assignRoutes(scenario: Scenario, plan: Plan, persons: PersonSpec[]): void {
  const routeById = new Map(scenario.routes.map((r) => [r.route_id, r]));
  for (const alloc of plan.allocations) {
    const members = persons
      .filter((p) => p.group_id === alloc.group_id)
      .sort((a, b) => (a.person_id < b.person_id ? -1 : 1));
    const entries = alloc.routes
      .filter((r) => r.share > 0)
      .slice()
      .sort((a, b) => (a.route_id < b.route_id ? -1 : a.route_id > b.route_id ? 1 : 0));
    if (members.length === 0 || entries.length === 0) continue;
    const quotas = largestRemainder(members.length, entries.map((e) => e.share));
    let cursor = 0;
    for (const p of members) {
      while (quotas[cursor] === 0) cursor = (cursor + 1) % entries.length;
      p.route_id = entries[cursor].route_id;
      p.route_edge_ids = routeById.get(entries[cursor].route_id)!.edge_ids.slice();
      quotas[cursor] -= 1;
      cursor = (cursor + 1) % entries.length;
    }
  }
}
