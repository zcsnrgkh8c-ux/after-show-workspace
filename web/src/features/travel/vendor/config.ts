/**
 * 高德凭证读取：运行时配置（/demo-config.js）优先，回退 import.meta.env；
 * 绝不打印 key / securityJsCode 的值。
 */
import { getRuntimeConfig, runtimeOrEnv } from "../../../runtimeConfig";
import type { LoadError } from "./types";

export interface MapCredentials {
  key: string;
  securityCode: string | null;
}

/** Vite 环境变量类型（在 vite-env.d.ts 缺省时此处局部声明，保持 env 可访问） */
declare global {
  interface ImportMetaEnv {
    readonly VITE_AMAP_KEY?: string;
    readonly VITE_AMAP_SECURITY_JS_CODE?: string;
    readonly VITE_API_BASE_URL?: string;
    readonly VITE_API_TIMEOUT_MS?: string;
  }
}

/**
 * 读取高德凭证。key 未配置返回 null（页面据此显示诚实提示）；
 * securityJsCode 可选。任何日志/错误都不得输出 key 值。
 */
export function getMapCredentials(): MapCredentials | null {
  const runtime = getRuntimeConfig();
  const key = runtimeOrEnv(runtime.amapKey, import.meta.env.VITE_AMAP_KEY);
  if (key === "") {
    return null;
  }
  const securityCode = runtimeOrEnv(runtime.amapSecurityJsCode, import.meta.env.VITE_AMAP_SECURITY_JS_CODE);
  return {
    key,
    securityCode: securityCode !== "" ? securityCode : null,
  };
}

/** 判断 LoadError（供 UI 层归类错误提示用） */
export function isLoadError(e: unknown): e is LoadError {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    typeof (e as LoadError).code === "string"
  );
}
