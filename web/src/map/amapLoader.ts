import AMapLoader from "@amap/amap-jsapi-loader";
import type { AmapNamespace } from "./types";

export const AMAP_LOAD_TIMEOUT_MS = 12000;

let promise: Promise<AmapNamespace> | null = null;

/**
 * 高德 JS API 2.0 单例加载（官方 loader；其本身亦不会重复请求网络资源）。
 *
 * 关键设计：超时内置于缓存的 promise 本身——
 * 官方 loader 在 key/安全密钥无效时可能永久 pending，若只在外层 race 超时，
 * 挂起的全局 promise 会被后续调用复用，永远无法恢复。
 * 这里超时即令缓存 promise 拒绝并清空缓存，用户重试时将真正重新发起加载；
 * 迟到完成的底层 load 对已拒绝的包装 promise 无效（settle 一次），无副作用。
 */
export function loadAmap(key: string, securityJsCode: string): Promise<AmapNamespace> {
  if (!promise) {
    // 安全密钥仅在有值时挂载（未启用安全密钥的旧 key 不需要）
    if (securityJsCode !== "") {
      (window as unknown as { _AMapSecurityConfig: { securityJsCode: string } })._AMapSecurityConfig = {
        securityJsCode,
      };
    }
    const raw = AMapLoader.load({ key, version: "2.0", plugins: [] }) as Promise<AmapNamespace>;
    promise = new Promise<AmapNamespace>((resolve, reject) => {
      const timer = setTimeout(() => {
        promise = null; // 超时：丢弃挂起缓存，允许下次重新发起
        reject(new Error(`加载超时（>${AMAP_LOAD_TIMEOUT_MS / 1000}s）：可能 key/安全密钥无效或网络异常`));
      }, AMAP_LOAD_TIMEOUT_MS);
      raw.then(
        (ns) => {
          clearTimeout(timer);
          resolve(ns);
        },
        (e: unknown) => {
          clearTimeout(timer);
          promise = null; // 明确失败：清空缓存，允许重试
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      );
    });
  }
  return promise;
}

/** 测试用：重置加载器缓存 */
export function resetAmapLoaderForTest(): void {
  promise = null;
}
