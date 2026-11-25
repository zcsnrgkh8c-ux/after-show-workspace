# 散场之后：B 决策与接口服务

本目录是《散场之后》的服务端实现，负责 `server/api/**`、`server/decision/**`、`server/app.ts` 与根工程配置。默认使用 TypeScript + Node.js 内置 `http`，不引入额外框架。

契约以 `散场之后/05_共同接口与联调约定.md` 为准：`schema_version="1.0"`、字段 `snake_case`、时间单位为秒。

## 1. 启动

```powershell
npm install
npm run dev      # 编译并启动
npm start        # 仅启动已编译产物
npm test         # 编译后运行 A/B 共 55 项测试
```

默认地址 `http://localhost:8787`，可用 `PORT` 覆盖。

启动日志会打印：

```text
[散场之后] engine=external version=1.0.0
[散场之后] llm_configured=false（mode 由实际调用决定）
```

## 2. 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `PORT` | 否 | 服务端口，默认 `8787` |
| `LLM_API_KEY` | 否 | OpenAI 兼容接口密钥；缺省时解析固定走 rules |
| `LLM_MODEL` | 否 | 模型名/Endpoint ID |
| `LLM_BASE_URL` | 否 | 默认 `https://ark.cn-beijing.volces.com/api/v3`；DeepSeek 使用 `https://api.deepseek.com` |
| `LLM_TIMEOUT_MS` | 否 | 服务端模型超时，默认 `15000`；到时先降级 rules，范围 100～120000 |

密钥只从服务端环境变量读取，不写入代码、验收产物或前端。`health.llm_configured` 只表示配置存在，不代表模型可访问；真实调用必须以 `mode=llm`、实际 trace、脱敏输入输出和耗时为证。

DeepSeek 本地进程配置示例（把占位符替换为本地凭据，不要写入文件）：

```powershell
$env:LLM_API_KEY="<仅在本机设置>"
$env:LLM_MODEL="deepseek-chat"
$env:LLM_BASE_URL="https://api.deepseek.com"
$env:LLM_TIMEOUT_MS="15000"
npm run dev
```

**超时配合**：C 的 parse 请求超时必须大于 `LLM_TIMEOUT_MS`，默认建议至少 `20000ms`，给服务端 15 秒超时及 rules 降级留出余量。当前集成副本没有 `web/`，因此前端实际超时值与浏览器确认流程尚未验收，不能用服务端回归代替。

真实模型与本地确认重算证据：

```powershell
node scripts/llm_real_check.js success   # 真实指令 → mode=llm → 合法 patch
node scripts/llm_real_check.js missing   # 不存在对象的提示
node scripts/llm_real_check.js failure   # 无效凭据 → 真实 401 → rules
node scripts/recompute_llm_patch.js      # 本地副本 revision+1 → A 引擎重算，非 C 浏览器确认
```

脱敏产物保存在 `验收产物/llm/`。

## 3. 接口

### GET /api/health

```json
{"status":"ok","schema_version":"1.0","engine_ready":true,"llm_configured":false}
```

### POST /api/scenario/parse

请求 `{scenario, instruction}`，返回 `{patch, summary, warnings, mode}`。`patch` 只是待确认修改，不修改场景、不递增 `revision`。

```json
{"scenario": { "...": "见 fixtures/concert_demo.scenario.json" }, "instruction": "关闭2号出口，减少一辆车"}
```

```json
{
  "patch": [
    {"target":"edge","id":"b1","field":"closed","value":true},
    {"target":"vehicle","id":"B3","field":"enabled","value":false}
  ],
  "summary": "待确认修改：关闭边 b1；移除车辆 B3",
  "warnings": [
    "移除车辆需用户确认；应用时从 fleet 删除对应 vehicle_id，重置场景才能恢复。",
    "补丁需要用户确认后应用；应用后 revision 加 1，旧方案与旧结果过期。"
  ],
  "mode": "rules"
}
```

应用语义：`vehicle.enabled=false` 表示从 `fleet` 删除该 `vehicle_id`，不向车辆对象追加契约外字段；重置场景才能恢复。确认应用后由 C 端执行 `revision+1`。

### POST /api/plan/generate

请求 `{scenario, objective, seed}`，`objective` 为 `efficiency | inclusion | balanced`，`seed` 可省略（默认 `20261114`）。返回 `{plans, trace, mode}`。

三类策略：

- `baseline`：唯一调用 A 的 `buildBaselinePlan`，按最短开放合法步行路线与固定班次生成；B 不再维护第二套基线。
- `independent`：出口角色按最快合法路线分流，公交角色把班次集中到最忙站点；合并后可能违反共享站点间隔，得到 invalid 候选供展示，不参与排名。
- `coordinated`：协调器按 `boarding_gap_s` 与 `round_trip_s` 错峰，并按 objective 重排站点；若仍不合法则回退为基线安全排班，并在 `notes` 中说明未观察到改进。

### POST /api/simulate

请求 `{scenario, plan, seed}`，返回 `SimulationResult`。格式错误 400；领域约束不满足返回 200 + `status="invalid"`；内部异常返回 500。

### POST /api/compare

请求 `{scenario, plans, seed, objective}`。`seed` 可省略，默认 `20261114`；`objective` 必须与生成时一致。

```json
{
  "results": ["三个真实 SimulationResult，invalid 候选同样保留"],
  "recommendation": {
    "plan_id": "plan_coordinated_concert_demo_r1_balanced",
    "status": "recommended",
    "reason": "在 balanced 字典序下推荐 plan_coordinated_concert_demo_r1_balanced：remaining_count=0、mean_queue_wait_all_released_s=421.65s、missed_deadline_count=24；其余 1 个合法方案在该规则下不更优。",
    "tradeoffs": ["baseline_concert_demo_rev1：remaining_count=110（+110），missed_deadline_count=49（+25），mean_queue_wait_all_released_s=926.7s（+505.05s）"]
  },
  "trace": ["实际 validator / simulator / cache / rules 步骤"],
  "mode": "rules"
}
```

`recommendation.status` 仅为 `recommended | tradeoff | no_valid_candidate`：

- 只对 `status="valid"` 的结果按 05 的字段顺序做字典序比较。
- 关键指标并列时返回 `tradeoff`，不靠 `plan_id` 宣称胜出。
- 全部候选无效时 `plan_id=null`，理由明确“当前候选未找到，不等于该场景无解”。

排名字段（依次越小越好）：

| objective | 顺序 |
|---|---|
| efficiency | remaining_count → mean_queue_wait_all_released_s → missed_deadline_count |
| inclusion | 优先需求组未登车人数 → missed_deadline_count → remaining_count → mean_queue_wait_all_released_s |
| balanced | remaining_count → missed_deadline_count → mean_queue_wait_all_released_s |

“优先需求组”为 `needs_step_free=true` 或 `board_deadline_s !== null` 的组，重叠条件只计一次。

### 错误信封

```json
{"error":{"code":"invalid_scenario","message":"场景未通过结构校验","details":[{"code":"SCHEMA_VERSION_UNSUPPORTED","path":"schema_version","message":"schema_version 必须为 \"1.0\"","severity":"error"}]}}
```

## 4. 模式与工具记录

`trace` 每项为 `{step,actor,action,source,summary,input_ref,output_ref,status,duration_ms?}`：

- `source` 只使用 `llm | rules | validator | simulator | cache`。
- 只有真实调用模型成功才写 `source="llm"`；无密钥或模型失败时 `mode="rules"`，失败调用记为 `llm/error` 后再降级，不伪造代理讨论。
- `duration_ms` 来自实际计时。
- parse 的 trace 按 05 只记服务端日志（`[parse] ... steps=llm:ok,rules:ok`），响应体保持 `{patch,summary,warnings,mode}` 四字段。

## 5. 引擎联通状态

`server/decision/engine_port.ts` 正式加载 A 的 `server/simulation`，同时检查 `validateScenario`、`validatePlan`、`simulate`、`buildBaselinePlan` 与 `ENGINE_VERSION`。当前启动日志实测为 `engine=external version=1.0.0`。

正式模式不再静默回退 `bridge_engine.ts`：A 模块缺失、导出函数不完整或版本缺失都会明确报错并终止启动。`health.engine_ready` 只用于契约检查，引擎身份以启动日志和每个 `SimulationResult.engine_version` 为准。

## 6. 场景样例

| 文件 | 用途 |
|---|---|
| `fixtures/concert_demo.scenario.json` | 正常散场：300 人、3 车、6 节点 |
| `fixtures/concert_demo_closed_reduced.scenario.json` | 西侧关闭 + 减少一辆车 |
| `fixtures/concert_demo_stepfree_blocked.scenario.json` | 无台阶路线全关，`step_free` 组留在 S |

三个文件使用不同 `scenario_id`，避免把同一 ID、同一 revision 的不同内容互相误认为同一场景。自然语言修改后 `revision+1` 的流程由 parse → 用户确认 → 重新生成来体现。

## 7. 已实现边界

- 一场馆、三出口、两接驳点；不模拟机动车路网、信号相位、碰撞。
- 不通过自然语言增加车辆或容量；资源变化必须先改 Scenario 并经用户确认。
- 不支持中途接管运行中的仿真状态；改条件后从相同初始条件重跑。
- 候选搜索未找到合法方案，只说明本次候选失败，不宣称场景无解。
- 合成输入、规则模式、A 引擎版本与缓存命中在演示中均需明确标识。
