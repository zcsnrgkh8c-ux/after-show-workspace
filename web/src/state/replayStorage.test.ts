import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { loadPersistedReplays, persistReplays } from "./replayStorage";
import type { SavedReplay } from "./store";

function mkReplay(id: string): SavedReplay {
  return {
    replay_id: id,
    saved_at: 1,
    label: id,
    scenario: {} as SavedReplay["scenario"],
    bundle: {} as SavedReplay["bundle"],
  };
}

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}

beforeEach(() => {
  vi.stubGlobal("localStorage", new MemoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("replayStorage：脱网回放持久化", () => {
  it("写入后可读回，且最多保留最近 2 条", () => {
    persistReplays([mkReplay("a"), mkReplay("b"), mkReplay("c")]);
    const loaded = loadPersistedReplays();
    expect(loaded.map((r) => r.replay_id)).toEqual(["b", "c"]);
  });

  it("无数据或损坏 JSON 时返回空数组，不抛异常", () => {
    expect(loadPersistedReplays()).toEqual([]);
    localStorage.setItem("after-show:replays:v1", "{not json");
    expect(() => loadPersistedReplays()).not.toThrow();
    expect(loadPersistedReplays()).toEqual([]);
  });

  it("过滤缺少必需字段的条目", () => {
    localStorage.setItem(
      "after-show:replays:v1",
      JSON.stringify([{ replay_id: "ok", saved_at: 1, label: "l", scenario: {}, bundle: {} }, { bad: true }])
    );
    expect(loadPersistedReplays().map((r) => r.replay_id)).toEqual(["ok"]);
  });

  it("配额不足时降级为仅保留最新一条，不抛出", () => {
    const storage = new MemoryStorage();
    let first = true;
    storage.setItem = (k: string, v: string) => {
      if (first) {
        first = false;
        throw new Error("QuotaExceededError");
      }
      MemoryStorage.prototype.setItem.call(storage, k, v);
    };
    vi.stubGlobal("localStorage", storage);
    expect(() => persistReplays([mkReplay("a"), mkReplay("b")])).not.toThrow();
    expect(loadPersistedReplays().map((r) => r.replay_id)).toEqual(["b"]);
  });
});
