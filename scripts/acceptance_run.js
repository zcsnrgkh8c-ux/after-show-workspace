/**
 * 验收产物生成脚本（只读演示，不修改任何源码）。
 *
 * 前提：按约定方式已启动服务（npm start，默认 http://localhost:8787）。
 * 用法：node scripts/acceptance_run.js [BASE_URL]
 * 输出：验收产物/results/ 下的 JSON 与 stdout 的指标摘要。
 * 所有数字均来自服务端真实返回（fixture 参考引擎时会在 health 中如实暴露）。
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const BASE_URL = (process.argv[2] || "http://localhost:8787").replace(/\/+$/, "");
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "验收产物", "results_AB联调");
const SEED = 20261114;

const SCENARIOS = [
  { key: "scenario1_normal", file: "concert_demo.scenario.json", label: "场景一：正常散场" },
  { key: "scenario2_closed_reduced", file: "concert_demo_closed_reduced.scenario.json", label: "场景二：出口关闭并减少车辆" },
  { key: "scenario3_stepfree_blocked", file: "concert_demo_stepfree_blocked.scenario.json", label: "场景三：通行需求无法被当前候选满足" },
];

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function writeResult(name, value) {
  const target = path.join(OUT_DIR, `${name}.json`);
  fs.writeFileSync(target, JSON.stringify(value, null, 2), "utf8");
  return target;
}

async function getJson(url) {
  const res = await fetch(url);
  return { status: res.status, body: await res.json() };
}

async function postJson(url, payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

function metricsRow(scenarioLabel, planId, result) {
  const m = result.metrics;
  return {
    场景: scenarioLabel,
    engine_version: result.engine_version,
    plan_id: planId,
    status: result.status,
    remaining: m ? m.remaining_count : null,
    mean_queue_wait_s: m ? m.mean_queue_wait_all_released_s : null,
    missed_deadline: m ? m.missed_deadline_count : null,
    clearance_time_s: m ? m.clearance_time_s : null,
    boarded: m ? m.boarded_count : null,
    released: m ? m.released_count : null,
  };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const meta = { base_url: BASE_URL, seed: SEED, objective: "balanced", ran_at: new Date().toISOString() };

  // 01 health
  const health = await getJson(`${BASE_URL}/api/health`);
  writeResult("01_health", { meta, response: health });
  console.log("health:", JSON.stringify(health.body));

  // 02 parse（演示脚本口径的自然语言指令）
  const demoScenario = JSON.parse(
    fs.readFileSync(path.join(ROOT, "fixtures", SCENARIOS[0].file), "utf8"),
  );
  const parse = await postJson(`${BASE_URL}/api/scenario/parse`, {
    scenario: demoScenario,
    instruction: "关闭2号出口，减少一辆车",
  });
  writeResult("02_parse_自然语言指令", { meta, instruction: "关闭2号出口，减少一辆车", response: parse });
  console.log("parse mode:", parse.body.mode, "| patch:", JSON.stringify(parse.body.patch));

  const allRows = [];
  const perScenario = [];

  for (const [index, sc] of SCENARIOS.entries()) {
    const scenario = JSON.parse(fs.readFileSync(path.join(ROOT, "fixtures", sc.file), "utf8"));

    const generate = await postJson(`${BASE_URL}/api/plan/generate`, {
      scenario,
      objective: "balanced",
      seed: SEED,
    });
    if (generate.status !== 200) throw new Error(`${sc.key} generate 失败: ${JSON.stringify(generate.body)}`);

    const compare = await postJson(`${BASE_URL}/api/compare`, {
      scenario,
      plans: generate.body.plans,
      objective: "balanced",
      seed: SEED,
    });
    if (compare.status !== 200) throw new Error(`${sc.key} compare 失败: ${JSON.stringify(compare.body)}`);

    const resultsHash = sha256(JSON.stringify(compare.body.results));
    const invalidInfo = compare.body.results
      .filter((r) => r.status !== "valid")
      .map((r) => ({ plan_id: r.plan_id, status: r.status, violations: r.violations.map((v) => v.code) }));

    writeResult(`03_${sc.key}_generate_compare`, {
      meta,
      label: sc.label,
      scenario_id: scenario.scenario_id,
      revision: scenario.revision,
      generate: generate.body,
      compare: compare.body,
      results_sha256: resultsHash,
      invalid_candidates: invalidInfo,
    });

    for (const r of compare.body.results) {
      allRows.push(metricsRow(sc.label, r.plan_id, r));
    }

    perScenario.push({
      label: sc.label,
      recommendation: compare.body.recommendation,
      invalid_candidates: invalidInfo,
      trace_sources: compare.body.trace.map((t) => `${t.step}:${t.source}:${t.status}`),
    });

    console.log(
      `${sc.label} → recommendation=${compare.body.recommendation.status}/${compare.body.recommendation.plan_id}`,
    );

    // 场景三额外检查：step_free 组保留、未被强行分配
    if (index === 2) {
      const best = compare.body.results.find(
        (r) => r.plan_id === compare.body.recommendation.plan_id || r.status === "valid",
      );
      const stepFree = best && best.group_metrics.find((g) => g.group_id === "step_free");
      writeResult("04_场景三_step_free组保留检查", {
        meta,
        plan_id: best ? best.plan_id : null,
        step_free_group_metrics: stepFree || null,
        note: "step_free 组不因候选不可行而被删除或强行安排楼梯路线；remaining>0 表示未满足需求被如实保留。",
      });
    }
  }

  // 05 可复现性 + 缓存：对场景一重复 compare
  const scenario1 = demoScenario;
  const gen1 = await postJson(`${BASE_URL}/api/plan/generate`, {
    scenario: scenario1, objective: "balanced", seed: SEED,
  });
  const cmp1 = await postJson(`${BASE_URL}/api/compare`, {
    scenario: scenario1, plans: gen1.body.plans, objective: "balanced", seed: SEED,
  });
  const cmp2 = await postJson(`${BASE_URL}/api/compare`, {
    scenario: scenario1, plans: gen1.body.plans, objective: "balanced", seed: SEED,
  });
  const h1 = sha256(JSON.stringify(cmp1.body.results));
  const h2 = sha256(JSON.stringify(cmp2.body.results));
  const cacheHits = cmp2.body.trace.filter((t) => t.source === "cache");
  writeResult("05_可复现与缓存", {
    meta,
    first_sha256: h1,
    second_sha256: h2,
    identical: h1 === h2,
    second_compare_cache_steps: cacheHits,
    note: "两次独立 compare 的 results 完全一致即同 seed 可复现；第二次出现 source=cache 的 trace 步骤即命中缓存，不重跑仿真。",
  });
  console.log("reproducible:", h1 === h2, "| cache steps:", cacheHits.length);

  // 06 非法输入拒绝（校验演示，与正常策略分开）
  const badPlan = JSON.parse(JSON.stringify(gen1.body.plans[0]));
  badPlan.scenario_revision = scenario1.revision + 99;
  const stale = await postJson(`${BASE_URL}/api/simulate`, {
    scenario: scenario1, plan: badPlan, seed: SEED,
  });
  writeResult("06_非法输入拒绝_校验演示", {
    meta,
    note: "以下为刻意构造的非法请求，用于展示系统拒绝路径，不属于任何正常策略候选。",
    stale_revision_plan: { scenario_revision_set_to: badPlan.scenario_revision, response: stale },
  });
  console.log("stale revision HTTP/status:", stale.status, stale.body.status, stale.body.violations?.map((v) => v.code));

  writeResult("00_指标汇总", {
    meta,
    engine_versions: [...new Set(allRows.map((row) => row.engine_version))],
    rows: allRows,
    scenarios: perScenario,
  });
  console.table(allRows);
  console.log("验收产物写入完成：", OUT_DIR);
}

main().catch((error) => {
  console.error("验收运行失败:", error);
  process.exit(1);
});
