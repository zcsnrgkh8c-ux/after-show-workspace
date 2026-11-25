# B同学：AI协同决策与接口

## 目标与边界

B负责“场景—候选方案—仿真比较—人工选择”服务端闭环。一场馆、三出口、两接驳点；不做信号控制、训练或SUMO。

B负责 `server/api/**`、`server/decision/**`、`server/app.ts`。根配置先协商再改。A负责仿真、fixture和共享类型，C负责 `web/**`。以05为准：`schema_version: "1.0"`，JSON用 `snake_case`，不得另建schema。

## TRAE提示词

```text
你是B同学的TypeScript结对助手。先读01、05和shared/types.ts，列改动文件与联调风险，再编码。

实现B负责目录：解析只产出待确认patch；两个角色提plan，中央协调器调用A的validateScenario、validatePlan、simulate；按objective（efficiency/inclusion/balanced）生成和比较baseline、independent、coordinated，由人选择。compare必须返回真实SimulationResult及05规定的recommendation。trace记录实际LLM、rules、validator、simulator或cache步骤；无LLM时明确mode=rules，不伪造代理。遵守05、1.0、snake_case和valid/invalid/error；未找到候选不等于无解。
```

## 决策与对照

1. `scenario/parse` 只产出待确认补丁；确认应用后 `revision+1`，旧Plan/Result拒绝。Plan与Result使用 `scenario_revision`，不得另造 `schema_revision`。
2. 出口角色在已开放的合法路线中分配客流，公交角色使用既有车辆与容量安排班次；两者不能通过偷偷打开封闭出口或增加车辆容量来改善指标。中央协调器检查资源冲突和物理约束；资源变化必须先修改Scenario并经用户确认。
3. 三策略共用scenario、seed和物理约束。baseline固定合法；independent独立生成后共同校验；coordinated联合修订。不保证协同每项都赢。
4. 三类旅客为常规、避开台阶、受末班期限约束。比较同时报告：期限时未登车人数、全部已释放旅客人均累计等待、已登车P95等待并同时显示未登车人数；若截止仍未清空，清空时间为 `null`。
5. objective仅为 `efficiency | inclusion | balanced`，按05可见规则比较，不把不同单位直接加权。所有数值来自A的SimulationResult；约束失败为invalid，内部异常为error。

## 冻结API

- `POST /api/scenario/parse`：`{scenario,instruction}` → `{patch,summary,warnings,mode}`
- `POST /api/plan/generate`：`{scenario,objective,seed}` → `{plans,trace,mode}`
- `POST /api/simulate`：`{scenario,plan,seed}` → `SimulationResult`
- `POST /api/compare`：`{scenario,plans,seed,objective}` → 真实 `results` 数组与 `recommendation={plan_id,status,reason,tradeoffs}`；status仅为 `recommended | tradeoff | no_valid_candidate`，objective与generate保持一致。
- `GET /api/health`：返回05规定的status、schema_version、engine_ready、llm_configured

缺字段时先说明用途和兼容影响，由负责人更新05后再编码。

## 依赖与交付

依赖A提供共享类型、三个函数及合法fixture；与C确认模式、trace、错误和指标字段。新增依赖须协商，无密钥仍须启动。

B应交付：五个路由、状态与模式、规则闭环、至少一次真实LLM解析/生成及工具执行记录、三类策略编排、启动命令与接口样例。LLM不可用时有明确规则降级，但不能把规则版本声称为已完成AI能力。未验收前不得写成已实现。

## 验收

- 同scenario、plan、seed可复现，三策略共用物理条件；
- 用户确认前补丁不进入生成和仿真；
- valid、invalid、error分流正确，compare逐项引用真实SimulationResult；
- 三类旅客与规定指标齐全，未清空时为 `null`；
- trace字段、source、status符合05；无密钥时显示rules且仍能演示；
- C仅依据05接入，A不为B复制仿真核心。

## 降级

LLM或网络不可用时固定 `mode: rules`：关键词/表单生成补丁，枚举合法候选，校验后调用仿真，并记录真实rules/validator/simulator trace。coordinated可降为一次确定性冲突修复。A未联通时仅用其标记的fixture，并注明“fixture/待联调”。
