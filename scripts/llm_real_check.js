/**
 * 真实 LLM 解析验收（凭据只从进程环境读取，不写入产物）。
 * 用法：node scripts/llm_real_check.js success|missing|failure
 * 输出：验收产物/llm/*.json，包含脱敏输入输出与实际耗时。
 */
const fs = require("node:fs");
const path = require("node:path");
const { parseScenarioInstruction } = require("../dist/server/decision/parse.js");
const { validateScenario } = require("../dist/server/simulation/index.js");

const ROOT = path.resolve(__dirname, "..");
const CASES = {
  success: {
    instruction: "关闭2号出口，减少一辆车",
    file: "01_真实模型_关闭2号出口.json",
  },
  missing: {
    instruction: "关闭不存在的9号出口",
    file: "02_真实模型_不存在对象.json",
  },
  failure: {
    instruction: "关闭2号出口，减少一辆车",
    file: "03_调用失败_rules降级.json",
  },
};

function sanitize(value) {
  if (typeof value === "string") {
    let text = value
      .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
      .replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]")
      .replace(/(api key:\s*)\S+/gi, "$1[REDACTED]")
      .replace(/request_id:\s*[0-9a-f-]+/gi, "request_id:[REDACTED]");
    const key = process.env.LLM_API_KEY;
    if (key) text = text.split(key).join("[REDACTED]");
    return text;
  }
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitize(v)]));
  }
  return value;
}

function applyPatch(scenario, patch) {
  const next = JSON.parse(JSON.stringify(scenario));
  for (const item of patch) {
    if (item.target === "vehicle" && item.field === "enabled" && item.value === false) {
      next.fleet = next.fleet.filter((vehicle) => vehicle.vehicle_id !== item.id);
      continue;
    }
    const collection = item.target === "edge" ? next.edges : next.groups;
    const idField = item.target === "edge" ? "edge_id" : "group_id";
    const target = collection.find((entry) => entry[idField] === item.id);
    if (target) target[item.field] = item.value;
  }
  next.revision += 1;
  return next;
}

async function main() {
  const caseName = process.argv[2] || "success";
  const config = CASES[caseName];
  if (!config) throw new Error(`未知用例：${caseName}`);
  const scenario = JSON.parse(
    fs.readFileSync(path.join(ROOT, "fixtures", "concert_demo.scenario.json"), "utf8"),
  );
  const before = JSON.stringify(scenario);
  const started = Date.now();
  const outcome = await parseScenarioInstruction(scenario, config.instruction);
  const serviceDuration = Date.now() - started;

  const revised = applyPatch(scenario, outcome.patch);
  const appliedIssues = validateScenario(revised);
  const llmSteps = outcome.trace.filter((step) => step.source === "llm");
  const evidence = {
    ran_at: new Date().toISOString(),
    case: caseName,
    provider: "deepseek",
    model: process.env.LLM_MODEL || null,
    instruction: config.instruction,
    scenario_id: scenario.scenario_id,
    scenario_revision_before: scenario.revision,
    scenario_revision_after_local_check: revised.revision,
    scenario_unchanged_by_parse: JSON.stringify(scenario) === before,
    mode: outcome.mode,
    patch: outcome.patch,
    summary: outcome.summary,
    warnings: outcome.warnings,
    service_duration_ms: serviceDuration,
    trace: outcome.trace,
    real_model_exchange: outcome.llm_exchange || null,
    real_llm_call_observed: llmSteps.length > 0,
    real_llm_success_observed: outcome.mode === "llm" && llmSteps.some((step) => step.status === "ok"),
    fallback_observed:
      outcome.mode === "rules" &&
      llmSteps.some((step) => step.status === "error") &&
      outcome.trace.some((step) => step.source === "rules" && step.status === "ok"),
    local_patch_application_check: {
      note: "仅在本地副本应用 patch 做契约校验，不代表 C 已完成确认。",
      errors: appliedIssues.filter((issue) => issue.severity === "error"),
      warning_codes: appliedIssues.filter((issue) => issue.severity === "warning").map((issue) => issue.code),
    },
    evidence_note: "llm_configured 仅是配置检查；real_llm_call_observed/success_observed 与 trace、耗时才是实际调用证据。",
  };

  const outDir = path.join(ROOT, "验收产物", "llm");
  fs.mkdirSync(outDir, { recursive: true });
  const target = path.join(outDir, config.file);
  fs.writeFileSync(target, JSON.stringify(sanitize(evidence), null, 2), "utf8");
  console.log(JSON.stringify(sanitize({
    case: caseName,
    mode: outcome.mode,
    patch: outcome.patch,
    warnings: outcome.warnings,
    service_duration_ms: serviceDuration,
    trace: outcome.trace.map((step) => ({
      source: step.source,
      status: step.status,
      duration_ms: step.duration_ms,
    })),
    real_llm_success_observed: evidence.real_llm_success_observed,
    fallback_observed: evidence.fallback_observed,
    patch_application_errors: evidence.local_patch_application_check.errors.length,
    output: path.relative(ROOT, target),
  }), null, 2));
}

main().catch((error) => {
  console.error(sanitize({ message: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
});
