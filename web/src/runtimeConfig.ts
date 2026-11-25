/**
 * 运行时配置注入（demo 交付包用）。
 *
 * index.html 在应用脚本之前加载 /demo-config.js，该文件把配置写到 window.__DEMO_CONFIG__，
 * 这样部署后可以直接改配置而无需重新构建前端；未配置的字段回退到 Vite 构建期环境变量。
 *
 * 约定：
 * - amapKey / amapSecurityJsCode / mapGeoJson：非空字符串才生效，空串视为未配置（回退环境变量）。
 * - apiBaseUrl：只要显式写了字符串就生效，空串表示与页面同源（交给同源网关反代 API）。
 */
export interface DemoRuntimeConfig {
  amapKey?: string;
  amapSecurityJsCode?: string;
  mapGeoJson?: string;
  apiBaseUrl?: string;
}

declare global {
  interface Window {
    __DEMO_CONFIG__?: DemoRuntimeConfig;
  }
}

export function getRuntimeConfig(): DemoRuntimeConfig {
  if (typeof window === "undefined") return {};
  const cfg = window.__DEMO_CONFIG__;
  return cfg !== null && typeof cfg === "object" ? cfg : {};
}

/** 非空运行时值优先，否则回退构建期环境变量。 */
export function runtimeOrEnv(runtime: string | undefined, env: string | undefined): string {
  if (typeof runtime === "string" && runtime.trim() !== "") return runtime.trim();
  return (env ?? "").trim();
}
