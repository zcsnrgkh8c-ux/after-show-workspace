# 出行建议模块（travel）交接说明

## 新增接口

### POST /api/travel/advice

基于前端已取回的高德候选路线摘要（1~6 条），返回一条结构化出行建议。
服务端不接触坐标、地址与折线，只接收 `RouteCandidateSummary` 摘要与偏好。
内部编排：已配置模型时先调 LLM（`adviseWithLlm`），失败或未配置时降级为规则建议（`buildRulesAdvice`）。

- 注册位置：`server/app.ts` 的 `POST_ROUTES`（处理器 `server/travel/handler.ts` 的 `travelAdvice`）。
- 编排逻辑：`server/travel/advice.ts` 的 `buildTravelAdvice`。
- 契约类型：`shared/travel.types.ts`（`AdviceRequest` / `AdviceResponse`）。

## 请求示例

```json
{
  "request_id": "req-20261114-001",
  "candidate_set_id": "cand-20261114-001",
  "preference": { "preference": "balanced", "needs_step_free": false, "note": null },
  "candidates": [
    {
      "route_id": "amap-route-1",
      "mode": "walking",
      "distance_m": 1200,
      "estimated_duration_s": 900,
      "walking_distance_m": 1200,
      "transfer_count": null,
      "step_free_evidence": "unknown"
    },
    {
      "route_id": "amap-route-2",
      "mode": "walking",
      "distance_m": 1500,
      "estimated_duration_s": 1100,
      "walking_distance_m": 1500,
      "transfer_count": null,
      "step_free_evidence": "satisfied"
    }
  ]
}
```

> 示例中的 `amap-route-1` / `amap-route-2` 为演示用假 routeId，语义为公开路线编号，不含私人地点。

## 响应示例（mode=llm，模型成功且选择合法）

```json
{
  "request_id": "req-20261114-001",
  "candidate_set_id": "cand-20261114-001",
  "mode": "llm",
  "selected_route_id": "amap-route-1",
  "reason_codes": ["shorter_duration"],
  "evidence": [{ "route_id": "amap-route-1", "metric": "estimated_duration_s" }],
  "explanation": "路线 amap-route-1 全程约 1200 米、约 900 秒，短于 amap-route-2 的约 1100 秒，推荐前者。",
  "warnings": [],
  "degraded_from": null
}
```

`mode=rules`（未配置模型）时结构相同，`mode="rules"`、`degraded_from=null`；
模型失败降级时 `mode="rules"`、`degraded_from="llm"`，并在 warnings 追加固定文案
"模型分析不可用，已降级为基础建议"（warnings 满 10 条时替换最后一条）。

## 错误与降级语义

| 场景 | 结果 |
| --- | --- |
| 请求体结构非法（缺字段 / candidates 为空 / 超出 1~6 条 / route_id 重复 / route_id 指向不存在候选等） | HTTP 400，错误信封 `code="invalid_request"`，`message` 取第一条错误，`details` 为字符串数组（全部校验错误） |
| 未配置模型（`travelLlmConfigured()` 为 false） | 直接走规则建议，`mode="rules"`，`degraded_from=null` |
| 模型调用失败或输出不合法（含 `selected_route_id` 不在候选集内） | 降级为规则建议，`mode="rules"`，`degraded_from="llm"`，warnings 追加固定降级文案；文案 ≤200 字符、脱敏，不含供应商错误体/密钥/URL |
| 请求体过大 / 非法 JSON | 沿用 `server/app.ts` 通用信封（413 body_too_large / 400 invalid_json） |

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `LLM_API_KEY` | 模型 API Key；与 `LLM_MODEL` 同时存在才启用 LLM 路径 |
| `LLM_MODEL` | 模型名称（接入点 ID） |
| `LLM_BASE_URL` | 可选，OpenAI 兼容 base URL，默认火山方舟 v3 |
| `LLM_TIMEOUT_MS` | 可选，模型调用超时毫秒数，默认 15000 |

## 测试清单（tests/travel_advice.test.ts，直接调 travelAdvice()，不起服务器）

1. 未配置模型：合法请求 → `mode="rules"`、回显 `request_id`/`candidate_set_id`、`degraded_from=null`。
2. 非法请求体（缺 candidates / candidates 为空数组 / route_id 重复）→ 抛 `ApiError`，status=400、code="invalid_request"、details 为字符串数组（3 组子用例）。
3. 假 API Key/Model + fetch 恒 reject 桩 → `mode="rules"`、`degraded_from="llm"`、warnings 含"降级"。
4. 假 fetch 返回合法模型 JSON（含 ``` 围栏）→ `mode="llm"` 且 `selected_route_id` 属于候选集。

测试内自行保存/恢复 `LLM_*` 环境变量与 `globalThis.fetch`（`after` 钩子统一还原）。

## 未完成项

- 真实 LLM 联调验收（配置真实 `LLM_API_KEY`/`LLM_MODEL` 后的端到端调用）待协调者统一执行。
- `server/travel/validate.ts`、`server/travel/rules.ts`、`server/travel/llm.ts` 由并行代理提供，按以下签名引用：
  - `validateAdviceRequest(body: unknown): TravelValidation<AdviceRequest>`
  - `buildRulesAdvice(req: AdviceRequest): AdviceResponse`
  - `travelLlmConfigured(): boolean`、`adviseWithLlm(req: AdviceRequest): Promise<LlmAdviceOutput>`
