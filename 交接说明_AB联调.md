# 《散场之后》A/B 联调交接说明

交接日期：2026-11-14

## 1. 交接范围

本包包含 A/B 服务端集成副本：A 的 `server/simulation/**` 与 fixtures、B 的 `server/decision/**`、`server/api/**`、`server/app.ts`，以及统一契约、构建配置、自动化测试和最新验收证据。

- 不包含 C 的 `web/**`，未修改或验收 C 的高德功能。
- 不包含 `node_modules`、`dist`，请在交接环境重新安装和构建。
- 收录 `results_AB联调/` 与脱敏 `llm/`；bridge fixture 的旧指标未纳入本包，凭据未纳入本包。
- 默认端口保持 B=`8787`，五接口及 `compare.objective` 均保留，`schema_version="1.0"`。

## 2. 启动与验证

```powershell
npm install
npm run build
npm test
npm start
```

另开终端执行三场景验收：

```powershell
node scripts/acceptance_run.js
```

如需真实 DeepSeek 解析，只在当前进程设置凭据，不写入文件：

```powershell
$env:LLM_API_KEY="<仅在本机设置>"
$env:LLM_MODEL="deepseek-chat"
$env:LLM_BASE_URL="https://api.deepseek.com"
$env:LLM_TIMEOUT_MS="15000"
npm start
```

C 的 parse 超时应大于服务端 `LLM_TIMEOUT_MS`，默认建议至少 `20000ms`。根 `.gitignore` 已白名单 `web/.env.example`，真实 `.env` 仍被忽略。

本次实际结果：

- `npm run build`：通过，A 的 `.ts` 导入已统一重写为可运行 CommonJS。
- `npm test`：55/55 通过，其中 A 27 项、B 28 项。
- `node dist/server/app.js`：8787 启动成功，日志为 `engine=external version=1.0.0`。
- 两次独立 compare 的 results SHA-256 均为 `d300149f03605d0d8c46c221fad887950f111b800f84369c877a1f3450772847`；第二次出现 3 条真实 cache trace。

引擎身份必须看启动日志与 `SimulationResult.engine_version`，不能用 `health.engine_ready` 代替。正式模式加载 A 失败会明确终止，不会回退 bridge。

## 3. 联调约定

1. `shared/types.ts` 是唯一契约：A canonical 类型为主，B 旧名称仅为 TypeScript 别名；HTTP、Trace、Patch、Recommendation 也在该文件统一发布。
2. baseline 遵守 05，由 A 的 `buildBaselinePlan` 唯一提供；B 不再生成第二套基线。
3. parse 只返回待确认 patch，不修改场景、不递增 revision。确认应用及 `revision+1` 由前端流程完成。
4. “关闭2号出口，减少一辆车”在 rules 模式下生成 `b1.closed=true` 和移除 B3；未知出口会明确 warning。
5. `/api/simulate`：缺 `plan_id` 等结构错误为 HTTP 400 + error 信封；完整身份的旧 revision 等领域无效候选为 HTTP 200 + `status=invalid` + violations。
6. 真实 DeepSeek 已成功调用：正常指令 `mode=llm`，返回 `b2.closed=true` 与移除 B3，模型耗时 `2196ms`；不存在 9 号出口返回空 patch 和明确提示，耗时 `2037ms`。无效凭据触发真实 HTTP 401 后降级 rules，模型步骤耗时 `290ms`。脱敏输入输出见 `验收产物/llm/01～03`。
7. 真实 patch 已在本地副本应用并 `revision 1→2`，A 1.0.0 重算推荐 coordinated（remaining=15、mean_wait=652.7s、missed=29）；证据 `04_本地确认升版重算.json` 明确 `c_browser_confirmed=false`，不能冒充 C 页面确认。
8. 服务端超时由 `LLM_TIMEOUT_MS` 控制，默认 15000ms；回归验证 100ms 测试超时后约 125ms 降级，且不输出凭据。C 实际页面超时仍未验证。

## 4. A 1.0.0 三场景真实结果

统一 seed=`20261114`、objective=`balanced`。independent 在三场景均因 `PLAN_STOP_GAP` 为 invalid，不参与排名。

| 场景 | 方案 | remaining | mean_queue_wait_s | missed_deadline | clearance_time_s | boarded/released |
|---|---|---:|---:|---:|---:|---:|
| 正常散场 | baseline | 110 | 926.7 | 49 | null | 190/300 |
| 正常散场 | coordinated | 0 | 421.65 | 24 | 1650 | 300/300 |
| 封路减车 | baseline | 150 | 1088.9 | 49 | null | 150/300 |
| 封路减车 | coordinated | 0 | 629.7 | 37 | 1650 | 300/300 |
| 台阶受阻 | baseline | 150 | 1118.9 | 49 | null | 150/300 |
| 台阶受阻 | coordinated | 40 | 492.3 | 21 | null | 260/300 |

三场景均推荐 coordinated。场景三仍有 40 人未登车且 clearance=null，推荐不等于全部需求满足。完整推荐理由、tradeoffs、timeline 与原始响应见 `验收产物/results_AB联调/`。

## 5. 包内主要文件

- `shared/types.ts`、`tsconfig.json`、`package.json`、`package-lock.json`
- `server/simulation/**`：A 校验、需求生成、仿真、指标与 baseline
- `server/decision/**`：B 解析、候选、协调、比较、缓存与 A 引擎端口
- `server/api/handlers.ts`、`server/app.ts`：五接口与 8787 启动
- `fixtures/**`：三场景 JSON、A 的场景/方案及真实样例
- `tests/**`、`server/simulation/engine.test.ts`：A/B 回归测试
- `散场之后/05_共同接口与联调约定.md`、`06_今日推进与演示验收.md`
- `验收产物/验收报告_B决策层.md`、`验收产物/results_AB联调/**`、`验收产物/llm/**`

## 6. 接收方待办

### A/B

- 若更新 A 引擎，必须同步提升 `ENGINE_VERSION`，重跑 55 项测试和三场景验收，不沿用旧结果。
- DeepSeek 真实输入输出、401 降级和本地升版重算已验证；其他模型、其他指令及 C 浏览器链路不得据此推定通过。

### C 浏览器验收

1. 集中 API 配置是否指向 B 的 8787。
2. patch 展示、用户确认、确认后 `revision+1` 与旧结果失效提示；当前只完成本地服务端演练。
3. parse 页面超时必须大于服务端 `LLM_TIMEOUT_MS`，默认建议至少 20000ms，且降级前不能由页面提前报错。
4. objective 切换后重新比较，以及 invalid、remaining、null 的同屏展示。
5. 使用结果身份字段防止过期回放，完成 timeline 与 cache 结果展示。
6. 高德与导航功能不在本次验收范围内，需由 C 单独验证。
