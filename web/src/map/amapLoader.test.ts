import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@amap/amap-jsapi-loader", () => ({
  default: { load: vi.fn() },
}));

import AMapLoader from "@amap/amap-jsapi-loader";
import { AMAP_LOAD_TIMEOUT_MS, loadAmap, resetAmapLoaderForTest } from "./amapLoader";
import type { AmapNamespace } from "./types";

const loadMock = vi.mocked(AMapLoader.load);
const fakeNs = {} as AmapNamespace;

beforeEach(() => {
  resetAmapLoaderForTest();
  loadMock.mockReset();
  (globalThis as { window?: unknown }).window = {};
});

afterEach(() => {
  vi.useRealTimers();
});

describe("amapLoader：挂起恢复与单例加载", () => {
  it("加载成功后复用缓存（底层 load 只调一次），并写入安全配置", async () => {
    loadMock.mockResolvedValue(fakeNs);
    const a = await loadAmap("k1", "scode");
    const b = await loadAmap("k1", "scode");
    expect(a).toBe(b);
    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(
      (globalThis.window as unknown as { _AMapSecurityConfig: { securityJsCode: string } })._AMapSecurityConfig
        .securityJsCode
    ).toBe("scode");
  });

  it("底层永 pending → 超时拒绝并清空缓存，重试时真正重新发起", async () => {
    vi.useFakeTimers();
    loadMock.mockReturnValue(new Promise<AmapNamespace>(() => {}) as never); // 永挂起
    const p = loadAmap("k1", "s");
    const guard = expect(p).rejects.toThrow(/加载超时/);
    await vi.advanceTimersByTimeAsync(AMAP_LOAD_TIMEOUT_MS);
    await guard;

    // 缓存已清空：重试会重新调用底层 load，而不是复用挂起的 promise
    loadMock.mockResolvedValue(fakeNs);
    const ns = await loadAmap("k1", "s");
    expect(loadMock).toHaveBeenCalledTimes(2);
    expect(ns).toBe(fakeNs);
  });

  it("超时后底层迟到完成：包装 promise 维持拒绝，无副作用，下次加载为全新请求", async () => {
    vi.useFakeTimers();
    let rawResolve!: (v: AmapNamespace) => void;
    loadMock.mockReturnValue(
      new Promise<AmapNamespace>((r) => {
        rawResolve = r;
      }) as never
    );
    const p = loadAmap("k1", "s");
    const guard = expect(p).rejects.toThrow(/加载超时/);
    await vi.advanceTimersByTimeAsync(AMAP_LOAD_TIMEOUT_MS);
    await guard;

    rawResolve(fakeNs); // 迟到完成：对已拒绝的包装 promise 无效
    await Promise.resolve();

    const freshNs = {} as AmapNamespace;
    loadMock.mockResolvedValue(freshNs);
    expect(await loadAmap("k1", "s")).toBe(freshNs);
    expect(loadMock).toHaveBeenCalledTimes(2);
  });

  it("底层立即拒绝：缓存清空，可重试成功", async () => {
    loadMock.mockRejectedValueOnce(new Error("INVALID_USER_KEY"));
    await expect(loadAmap("k1", "s")).rejects.toThrow("INVALID_USER_KEY");
    loadMock.mockResolvedValueOnce(fakeNs);
    expect(await loadAmap("k1", "s")).toBe(fakeNs);
    expect(loadMock).toHaveBeenCalledTimes(2);
  });

  it("同一时刻并发调用共享同一请求", async () => {
    loadMock.mockResolvedValue(fakeNs);
    const [a, b] = await Promise.all([loadAmap("k1", "s"), loadAmap("k1", "s")]);
    expect(a).toBe(b);
    expect(loadMock).toHaveBeenCalledTimes(1);
  });

  it("安全密钥为空时不挂载 _AMapSecurityConfig", async () => {
    loadMock.mockResolvedValue(fakeNs);
    await loadAmap("k1", "");
    expect(
      (globalThis.window as unknown as { _AMapSecurityConfig?: unknown })._AMapSecurityConfig
    ).toBeUndefined();
  });
});
