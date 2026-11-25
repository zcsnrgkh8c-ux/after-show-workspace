/**
 * 缓存回放的本地持久化（仅存成功计算结果与场景快照）。
 * 目的：服务不可达或页面刷新后，仍可查看已标记的“缓存回放”，
 * 保证脱网演示可用；不曾在服务端或前端伪造任何指标。
 */
import type { SavedReplay } from "./store";

const STORAGE_KEY = "after-show:replays:v1";
/** 仅保留最近若干条，避免超出 localStorage 配额 */
const MAX_PERSISTED = 2;

function storage(): Storage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

/** 读取持久化回放；损坏或格式不符时返回空数组，不影响主流程 */
export function loadPersistedReplays(): SavedReplay[] {
  const s = storage();
  if (!s) return [];
  try {
    const raw = s.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is SavedReplay => {
      if (typeof item !== "object" || item === null) return false;
      const r = item as Partial<SavedReplay>;
      return (
        typeof r.replay_id === "string" &&
        typeof r.label === "string" &&
        typeof r.saved_at === "number" &&
        typeof r.scenario === "object" &&
        r.scenario !== null &&
        typeof r.bundle === "object" &&
        r.bundle !== null
      );
    });
  } catch {
    return [];
  }
}

/** 写入持久化回放（超出配额时丢弃最旧一条重试一次，仍失败则放弃持久化） */
export function persistReplays(replays: SavedReplay[]): void {
  const s = storage();
  if (!s) return;
  let list = replays.slice(-MAX_PERSISTED);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      s.setItem(STORAGE_KEY, JSON.stringify(list));
      return;
    } catch {
      if (list.length <= 1) {
        try {
          s.removeItem(STORAGE_KEY);
        } catch {
          /* 忽略清理失败 */
        }
        return;
      }
      list = list.slice(-1);
    }
  }
}
