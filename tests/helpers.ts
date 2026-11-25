import fs from "node:fs";
import path from "node:path";
import { Scenario } from "../shared/types";

export function loadScenario(fileName: string): Scenario {
  const file = path.join(__dirname, "..", "..", "fixtures", fileName);
  return JSON.parse(fs.readFileSync(file, "utf8")) as Scenario;
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 清掉模型配置，保证测试始终走可复现的 rules 路径。 */
export function clearLlmEnv(): void {
  delete process.env.LLM_API_KEY;
  delete process.env.LLM_MODEL;
  delete process.env.LLM_BASE_URL;
  delete process.env.LLM_TIMEOUT_MS;
}
