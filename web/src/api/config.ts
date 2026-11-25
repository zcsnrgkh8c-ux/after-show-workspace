/**
 * API 配置集中管理（05 §7：各 API 地址由前端配置集中管理，不分散写死端口）。
 * 通过环境变量覆盖：VITE_API_BASE_URL / VITE_API_TIMEOUT_MS / VITE_API_MODE
 * 运行时配置（/demo-config.js 的 apiBaseUrl）优先；空串表示与页面同源。
 */
import { getRuntimeConfig } from "../runtimeConfig";

const runtimeBaseUrl = getRuntimeConfig().apiBaseUrl;

export const API_BASE_URL: string =
  typeof runtimeBaseUrl === "string"
    ? runtimeBaseUrl.trim()
    : (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "http://localhost:3000";

export const API_TIMEOUT_MS: number = Number(
  (import.meta.env.VITE_API_TIMEOUT_MS as string | undefined) ?? 15000
);

/** "mock" = 开发占位 mock（VITE_API_MODE=mock 显式启用，UI 全程显著标识） */
export const API_MODE: "live" | "mock" =
  (import.meta.env.VITE_API_MODE as string | undefined) === "mock" ? "mock" : "live";

export const IS_DEV_MOCK = API_MODE === "mock";
