# 第二阶段 travel 模块契约（窗口4发布，1~3只读导入）

类型唯一源：`shared/travel.types.ts`（web 侧通过 `web/src/contract/travel.ts` 薄镜像 re-export，禁止第二套定义）。

## 服务端（窗口3）

- `server/travel/validate.ts`
  - `validateAdviceRequest(body: unknown): TravelValidation<AdviceRequest>`，`TravelValidation<T> = { ok: true; value: T } | { ok: false; errors: string[] }`
  - `TRAVEL_LIMITS`：`MAX_CANDIDATES=6, MAX_NOTE_CHARS=200, MAX_ID_CHARS=64, MAX_EXPLANATION_CHARS=500, MAX_WARNINGS=10, MAX_WARNING_CHARS=200, DISTANCE_M_MAX=200000, DURATION_S_MAX=172800, TRANSFER_MAX=10`
- `server/travel/rules.ts`
  - `buildRulesAdvice(req: AdviceRequest): AdviceResponse`（纯函数，确定性规则，无环境依赖）
- `server/travel/llm.ts`
  - `travelLlmConfigured(): boolean`（复用 LLM_API_KEY/LLM_MODEL 环境约定，不改 decision/llm.ts）
  - `adviseWithLlm(req: AdviceRequest): Promise<LlmAdviceOutput>`，`LlmAdviceOutput = { selected_route_id: string|null; reason_codes: AdviceReasonCode[]; evidence: AdviceEvidenceRef[]; explanation: string; warnings: string[]; model: string; duration_ms: number }`
  - 任何输出不合法（未知 routeId、证据引用 null 指标、超长、JSON 不合法、超时、HTTP 错误）→ throw，由上层降级
- `server/travel/advice.ts`
  - `buildTravelAdvice(req: AdviceRequest): Promise<AdviceResponse>`（编排：未配置→rules；llm 成功→mode=llm；失败→rules + degraded_from="llm" + 脱敏 warning）
- `server/travel/handler.ts`
  - `travelAdvice(body: unknown): Promise<AdviceResponse>`，校验失败抛 `ApiError(400, "invalid_request", ...)`；在 `server/app.ts` 的 `POST_ROUTES` 注册 `/api/travel/advice`

## 前端（窗口1 UI / 窗口2 geo / 窗口4 编排）

- `web/src/contract/travel.ts`：`export * from "../../../shared/travel.types";`
- `web/src/map/amapLoader.ts`（窗口2可扩展，保持导出兼容）
  - `loadAmap(): Promise<AMapNamespace>`（单例、12s 超时、失败清缓存可重试）
  - `ensurePlugins(names: string[]): Promise<void>`（可验证、去重、幂等）
  - `getMapCredentials(): { key: string; securityCode: string | null } | null`（不打印值）
- `web/src/api/travelAdvice.ts`
  - `postTravelAdvice(req: AdviceRequest): Promise<AdviceResponse>`（超时 `VITE_API_TIMEOUT_MS` 默认 20000 > 服务端 LLM_TIMEOUT_MS）
  - `validateAdviceResponse(payload: unknown): { ok: true; value: AdviceResponse } | { ok: false; errors: string[] }`
  - `TravelApiError { code: string; message: string; status: number | null }`
- `web/src/features/travel/geo/`（窗口2）
  - `locateOnce(opts?: { timeout_ms?: number }): Promise<LocateOutcome>`；`LocateOutcome = { status: "ok"; place: GeoPlace } | { status: "denied"|"timeout"|"unavailable"|"error"; message: string }`；单次定位，禁 watchPosition；IP 近似不得冒充精确 GPS
  - `searchPlaces(input: { keyword: string; city: string | null; request_seq: number }): Promise<SearchOutcome>`；`SearchOutcome = { status: "ok"; suggestions: PlaceSuggestion[]; request_seq: number } | { status: "error"; error_code: string; message: string; request_seq: number }`
  - `planWalking(input: { origin: GeoPlace; destination: GeoPlace }): Promise<RouteSearchResult>`（内部生成 request_id/candidate_set_id；只解析真实返回，缺字段 null；禁止合成路线回退）
  - `RouteOverlay` 类：`constructor(map: AMapNS.Map)`；`render(routes: TravelRoute[], selectedRouteId: string | null): void`；`clear(): void`；`destroy(): void`（选中高亮其余淡化；单次替换清理旧覆盖物）
  - 纯解析函数导出供测试：`parseWalkingResult(raw: unknown, ctx: { request_id; candidate_set_id; origin; destination; queried_at }): RouteSearchResult`；`parsePlaceTips(raw: unknown, ctx: { request_seq }): PlaceSuggestion[]`；`parseLocateOutcome(raw: unknown): LocateOutcome`
- `web/src/features/travel/`（窗口1 UI + 窗口4 编排，本工作区合并实现）
  - `TravelPage.tsx`（页面组装）、`ui/`（OriginDestForm、RouteCard、AdviceSection、偏好 chips）、`app/useTravelFlow.ts`（状态编排）、`HANDOFF.md`

## 编排规则（红线）

1. 编辑输入文本 → 立即失效已确认坐标、旧路线、旧建议（防"新文字+旧坐标"）。
2. 关键词搜索防抖 300ms，request_seq 丢弃旧响应；手选后迟到定位不得覆盖。
3. 路线/建议各自独立 request 身份；旧 candidate_set_id 的建议响应一律丢弃；后端返回陌生 routeId 必须拒绝。
4. 先显示高德路线，再非阻塞请求建议；建议失败保留路线，显示"基础路线建议不可用"，不转圈致死。
5. mode=rules 显示"基础路线建议"，mode=llm 才可显示"AI路线建议"；无台阶证据 unknown 必须显示"尚未核实"。
6. 精确位置/住址不进 localStorage/URL/日志；本阶段不持久化行程。
7. 高德/后端/模型失败各自独立呈现，不统一报"成功"；不画直线冒充路径。
