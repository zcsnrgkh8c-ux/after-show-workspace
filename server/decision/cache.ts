import crypto from "node:crypto";
import { Plan, Scenario, SimulationResult } from "../../shared/types";

const MAX_ENTRIES = 200;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * 结果缓存以“场景内容 + 方案内容 + seed + 引擎版本”为键。
 * 即使调用方忘记递增 revision，也不会把不同内容的旧结果当成新结果。
 */
export class ResultCache {
  private readonly entries = new Map<string, SimulationResult>();

  key(scenario: Scenario, plan: Plan, seed: number, engineVersion: string): string {
    return crypto
      .createHash("sha256")
      .update(JSON.stringify({ scenario, plan, seed, engineVersion }))
      .digest("hex");
  }

  get(key: string): SimulationResult | undefined {
    const value = this.entries.get(key);
    return value ? clone(value) : undefined;
  }

  set(key: string, result: SimulationResult): void {
    if (this.entries.size >= MAX_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, clone(result));
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

export const resultCache = new ResultCache();
