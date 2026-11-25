/**
 * 将真实 LLM 验收中保存的 patch 应用于本地副本，revision+1 后用 A 引擎重算。
 * 这是 C 确认流程的服务端契约演练，不冒充 C 浏览器已确认。
 */
const fs = require("node:fs");
const path = require("node:path");
const {
  generatePlanCandidates,
  comparePlanCandidates,
} = require("../dist/server/decision/service.js");

const ROOT = path.resolve(__dirname, "..");
const SEED = 20261114;
const evidencePath = path.join(ROOT, "验收产物", "llm", "01_真实模型_关闭2号出口.json");
const llmEvidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
if (!llmEvidence.real_llm_success_observed || llmEvidence.mode !== "llm") {
  throw new Error("缺少真实 LLM 成功证据，不能进行本次重算演练");
}

const scenario = JSON.parse(
  fs.readFileSync(path.join(ROOT, "fixtures", "concert_demo.scenario.json"), "utf8"),
);
for (const item of llmEvidence.patch) {
  if (item.target === "vehicle" && item.field === "enabled" && item.value === false) {
    scenario.fleet = scenario.fleet.filter((vehicle) => vehicle.vehicle_id !== item.id);
    continue;
  }
  const collection = item.target === "edge" ? scenario.edges : scenario.groups;
  const idField = item.target === "edge" ? "edge_id" : "group_id";
  const target = collection.find((entry) => entry[idField] === item.id);
  if (!target) throw new Error(`patch 目标不存在：${item.target}/${item.id}`);
  target[item.field] = item.value;
}
const beforeRevision = scenario.revision;
scenario.revision += 1;

const generateStarted = Date.now();
const generated = generatePlanCandidates(scenario, "balanced", SEED);
const generateDuration = Date.now() - generateStarted;
const compareStarted = Date.now();
const compared = comparePlanCandidates(scenario, generated.plans, SEED, "balanced");
const compareDuration = Date.now() - compareStarted;

const output = {
  ran_at: new Date().toISOString(),
  confirmation_actor: "local_server_rehearsal_not_C",
  c_browser_confirmed: false,
  note: "真实 LLM patch 已在本地副本确认应用并 revision+1 重算；C 浏览器确认仍待其实际代码与页面验收。",
  source_llm_evidence: path.relative(ROOT, evidencePath),
  scenario_id: scenario.scenario_id,
  revision_before: beforeRevision,
  revision_after: scenario.revision,
  applied_patch: llmEvidence.patch,
  seed: SEED,
  objective: "balanced",
  generate_duration_ms: generateDuration,
  compare_duration_ms: compareDuration,
  plans: generated.plans,
  results: compared.results,
  recommendation: compared.recommendation,
  trace: compared.trace,
  mode: compared.mode,
  engine_versions: [...new Set(compared.results.map((result) => result.engine_version))],
};
const target = path.join(ROOT, "验收产物", "llm", "04_本地确认升版重算.json");
fs.writeFileSync(target, JSON.stringify(output, null, 2), "utf8");
console.log(JSON.stringify({
  revision_before: beforeRevision,
  revision_after: scenario.revision,
  engine_versions: output.engine_versions,
  statuses: compared.results.map((result) => ({ plan_id: result.plan_id, status: result.status })),
  recommendation: compared.recommendation,
  generate_duration_ms: generateDuration,
  compare_duration_ms: compareDuration,
  c_browser_confirmed: false,
  output: path.relative(ROOT, target),
}, null, 2));
