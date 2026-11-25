/**
 * 高德 JSAPI 2.0 加载器封装：
 * - loadAmap：单例加载（默认 12s 超时；失败/超时清空缓存允许重试）
 * - ensurePlugins：先查 AMap[name] 存在性，仅加载缺失插件；按插件名去重并发共享同一 promise；单插件默认 10s 超时
 * - loadAmapWithPlugins：组合入口
 * 任何错误信息不得包含 key / securityJsCode 的值。
 */
import type { AMapNamespace, LoadError } from "./types";
import { getMapCredentials } from "./config";

// 契约兼容：CONTRACT.md 将 getMapCredentials 也列在 amapLoader 导出下，转发一份保持两条 import 路径可用
export { getMapCredentials } from "./config";

/** 默认加载超时：12 秒 */
export const DEFAULT_LOAD_TIMEOUT_MS = 12_000;
/** 默认单插件加载超时：10 秒 */
export const DEFAULT_PLUGIN_TIMEOUT_MS = 10_000;

export interface LoadOptions {
  /** 覆盖默认超时（测试可注入短超时），缺省 loadAmap 12s / ensurePlugins 单插件 10s */
  timeout_ms?: number;
}

let loaderPromise: Promise<AMapNamespace> | null = null;
const pluginPromiseByName = new Map<string, Promise<void>>();

/**
 * 插件构造器存在性检查：传入名可为 "AMap.Geolocation"（全名）或 "Geolocation"（短名）。
 * SDK 实际挂载在短名（AMap.Geolocation → AMap.Geolocation 构造器，键为 "Geolocation"），
 * 直接用全名索引恒为 undefined，会把加载成功的插件误判为缺失/不可用。
 */
function pluginReady(AMap: AMapNamespace, name: string): boolean {
  const short = name.includes(".") ? name.slice(name.indexOf(".") + 1) : name;
  const bag = AMap as unknown as Record<string, unknown>;
  return Boolean(bag[name] ?? bag[short]);
}

function makeError(code: LoadError["code"], message: string): LoadError {
  return { code, message };
}

/** 仅供测试：清空单例缓存与插件去重表 */
export function __resetAmapLoaderForTest(): void {
  loaderPromise = null;
  pluginPromiseByName.clear();
}

async function importJsapiLoader(): Promise<{
  load: (opts: { key: string; version: string; plugins: string[] }) => Promise<AMapNamespace>;
}> {
  const mod = await import("@amap/amap-jsapi-loader");
  const loader = (mod as { default?: unknown }).default ?? mod;
  if (!loader || typeof (loader as { load?: unknown }).load !== "function") {
    throw makeError("dynamic_import_failed", "amap-jsapi-loader 模块形态异常（缺少 load 方法）");
  }
  return loader as {
    load: (opts: { key: string; version: string; plugins: string[] }) => Promise<AMapNamespace>;
  };
}

async function doLoadAmap(timeoutMs: number): Promise<AMapNamespace> {
  const credentials = getMapCredentials();
  if (!credentials) {
    // 注意：此处不得打印任何 key 值
    throw makeError(
      "missing_key",
      "未配置高德 Key：请在 web/demo-config.js 填写 amapKey（或用 VITE_AMAP_KEY 构建）后刷新，否则无法获取真实路线",
    );
  }
  if (credentials.securityCode) {
    // securityJsCode 必须在 JSAPI 实际加载前注入；同为敏感信息，不打印
    window._AMapSecurityConfig = { securityJsCode: credentials.securityCode };
  }
  const loader = await importJsapiLoader();
  return new Promise<AMapNamespace>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(makeError("timeout", `加载高德 JSAPI 超时（${timeoutMs}ms）`));
    }, timeoutMs);
    try {
      loader
        .load({ key: credentials.key, version: "2.0", plugins: [] })
        .then((ns) => {
          clearTimeout(timer);
          resolve(ns);
        })
        .catch((err: unknown) => {
          clearTimeout(timer);
          reject(
            makeError(
              "dynamic_import_failed",
              `高德 JSAPI 加载失败：${err instanceof Error ? err.message : String(err)}`,
            ),
          );
        });
    } catch (err) {
      clearTimeout(timer);
      reject(
        makeError(
          "dynamic_import_failed",
          `高德 JSAPI 加载失败：${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  });
}

export function loadAmap(options?: LoadOptions): Promise<AMapNamespace> {
  if (loaderPromise) return loaderPromise;
  const timeoutMs = options?.timeout_ms ?? DEFAULT_LOAD_TIMEOUT_MS;
  loaderPromise = doLoadAmap(timeoutMs).catch((err) => {
    // 失败/超时必须清空缓存，允许调用方重试（交接文档硬性要求）
    loaderPromise = null;
    throw err;
  });
  return loaderPromise;
}

function doLoadPlugin(AMap: AMapNamespace, name: string, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(makeError("plugin_failed", `高德插件 ${name} 加载超时（${timeoutMs}ms）`));
    }, timeoutMs);
    try {
      AMap.plugin([name], () => {
        clearTimeout(timer);
        // 回调触发后验证插件构造器确实存在，防止“回调了但没装上”
        if (pluginReady(AMap, name)) {
          resolve();
        } else {
          reject(makeError("plugin_failed", `高德插件 ${name} 回调已触发但 ${name} 构造器不可用`));
        }
      });
    } catch (err) {
      clearTimeout(timer);
      reject(
        makeError(
          "plugin_failed",
          `调用 AMap.plugin(${name}) 失败：${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  });
}

function loadPluginOnce(AMap: AMapNamespace, name: string, timeoutMs: number): Promise<void> {
  const existing = pluginPromiseByName.get(name);
  if (existing) return existing;
  const p = doLoadPlugin(AMap, name, timeoutMs).finally(() => {
    // 结算后移除：成功者下次靠 AMap[name] 存在性检查自然跳过；失败者允许重试
    pluginPromiseByName.delete(name);
  });
  pluginPromiseByName.set(name, p);
  return p;
}

export async function ensurePlugins(names: string[], options?: LoadOptions): Promise<void> {
  const AMap = await loadAmap(options);
  const timeoutMs = options?.timeout_ms ?? DEFAULT_PLUGIN_TIMEOUT_MS;
  const missing = names.filter((name) => !pluginReady(AMap, name));
  await Promise.all(
    missing.map((name) => {
      const p = loadPluginOnce(AMap, name, timeoutMs);
      // 防 Promise.all 因某个插件先失败而提前 reject 后，其余插件的超时拒绝变成 unhandled rejection
      p.catch(() => {});
      return p;
    }),
  );
}

export async function loadAmapWithPlugins(
  names: string[],
  options?: LoadOptions,
): Promise<AMapNamespace> {
  await ensurePlugins(names, options);
  return loadAmap();
}
