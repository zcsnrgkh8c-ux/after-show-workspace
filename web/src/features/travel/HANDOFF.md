# travel 模块交接（窗口2 补派完成）

模块根：`web/src/features/travel/`。契约源：`app/CONTRACT.md`（只读）+ `shared/travel.types.ts`。类型经 `web/src/contract/travel` 薄镜像导入，未新增第二套定义。

## 一、导出清单

### geo/（高德 JS SDK 适配层）

| 文件 | 导出 | 说明 |
| --- | --- | --- |
| `geo/geolocation.ts` | `locateOnce(opts?: { timeout_ms?; amap? }): Promise<LocateOutcome>` | AMap.Geolocation 单次 getCurrentPosition（默认 10s、enableHighAccuracy、禁 watchPosition）；IP 定位标注"IP近似"，绝不冒充 GPS |
| | `parseLocateOutcome(raw): LocateOutcome` | 纯函数：PERMISSION_DENIED→denied、TIMEOUT→timeout、POSITION_UNAVAILABLE→unavailable、其余→error；complete 缺有效坐标→error |
| | `readCoord(p)` / `shortRandom()` | LngLat 实例/普通对象统一读坐标；短随机 id |
| `geo/places.ts` | `searchPlaces({keyword, city, request_seq, amap?}): Promise<SearchOutcome>` | AMap.AutoComplete.search；keyword 为空→invalid_keyword |
| | `parsePlaceTips(raw, {request_seq}): PlaceSuggestion[]` | 纯函数：location 缺失/空数组/全 0 → `null`（禁 [0,0] 充数）；suggestion_id=`sug-{seq}-{index}` |
| `geo/walking.ts` | `planWalking({origin, destination, amap?}): Promise<RouteSearchResult>` | 内部 crypto.randomUUID 生成 request_id/candidate_set_id；只解析真实返回，绝不合成直线 |
| | `parseWalkingResult(raw, ctx): RouteSearchResult` | 纯函数：route.distance→distance_m、route.time→estimated_duration_s（秒）、steps 摊平 polyline（getLng()/lng 双兼容）、step_free_evidence 恒 "unknown"；空 routes→no_route；错误→provider_error（error_code 归类 timeout/network/provider_error） |
| `geo/routeOverlay.ts` | `RouteOverlay(map, ns?)` | `render(routes, selectedRouteId)`（先 clear 再画；选中宽 6 不透明、其余宽 3 低透明；polyline null 跳过；起终点 Marker 取真实折线端点；fitView 一次）；`clear()` / `destroy()`；不动 logo/审图号 |

### ui/（受控展示组件，无自身副作用）

| 文件 | 导出 | 说明 |
| --- | --- | --- |
| `ui/OriginDestForm.tsx` | `OriginDestForm(props)` | 起终点输入+候选下拉（名称+区县+地址，无坐标候选禁选并提示）；起点区"使用当前位置"/"手动输入地点"常驻；定位徽标（定位中/已定位(约X米)/被拒绝/超时/不可用/定位失败）；拒绝后高亮手输框不反复要授权；偏好 chips + 无台阶勾选 + ≤200 字补充说明；回调：onChange/onPick/onLocate/onSwap/onClear/onPlan/onPreferenceChange |
| `ui/RouteCard.tsx` | `RouteCard(props)` | 状态徽标（规划中/成功/无路线/服务错误）；距离"X.X km"、时长"X 分 Y 秒"、无台阶证据三态；步骤 `<details>` 折叠；多路线 tab 仅 onSelectRoute（父级高亮，不重新请求）；无路线保留修改入口；error_code 中文解释；页脚"数据来源：高德地图 · 查询时间 HH:mm:ss" |
| `ui/AdviceSection.tsx` | `AdviceSection(props)` | advising→"AI 分析中…（不阻塞路线查看）"；llm→"AI路线建议"、rules→"基础路线建议"（rules 无 AI 字样）、degraded_from=llm→"模型不可用，已降级"；reason_codes 中文标签、evidence 依据、warnings 醒目；"建议选择：方案X"；adviceError→"基础路线建议不可用"（保留路线） |
| `ui/travel.css` | — | 复用全局变量；桌面左右分栏、≤767px 纵向堆叠；390px 无横向溢出 |

### app/ + 页面

| 文件 | 导出 | 说明 |
| --- | --- | --- |
| `app/useTravelFlow.ts` | `useTravelFlow(options?): TravelFlow`、`LocateBadge`、`MapFocus`、`UseTravelFlowOptions` | 编排 hook，见下方状态机 |
| `TravelPage.tsx` | `TravelPage()` | 凭据 null→顶部诚实提示+规划禁用说明；否则 useEffect 内 loadAmapWithPlugins(Geolocation/AutoComplete/PlaceSearch/Walking) 建 Map；失败/超时显示"地图加载失败，可继续使用输入与结果卡"；RouteOverlay 随 map 就绪创建，routeResult/selectedRouteId 变化→render/clear，卸载 destroy；mapFocus→setZoomAndCenter(15) |

## 二、编排状态机（红线落点）

```
文本输入 ──► 清 confirmed(该端) + 失效 route/advice/selected（防"新文字+旧坐标"）
        └─► 防抖300ms searchPlaces(seq 自增；旧 seq 响应丢弃；city=confirmedOrigin.city)
点选候选 ──► location 非 null 才确认 → GeoPlace{source:"poi",source_note:"POI",place_id:"poi-*"}
        └─► bump locateSeq（迟到定位不得覆盖）+ 失效旧结果 + mapFocus
使用当前位置 ──► locateOnce(10s)；返回后 locateSeq 校验，被取代→徽标复位不覆盖
        └─► ok → confirmedOrigin{source:"geolocation", source_note:"GPS"/"IP近似"} + mapFocus
交换/清除 ──► 草稿与 confirmed 互换/清空 + 全量失效
规划(planRoutes) ──► 双 confirmed 且无阻塞才可用；planSeq 失效在途
        ├─ ok    → 存结果（保留真实候选数）→ 默认选第一条 → 非阻塞 requestAdvice
        └─ no_route/provider_error → 如实呈现，不发建议
requestAdvice ──► RouteCandidateSummary(剔除坐标/地址/折线) + 原 request_id/candidate_set_id
        ├─ 响应身份 ≠ 当前 routeResult 身份 → 丢弃
        ├─ selected_route_id ∉ 候选 → 丢弃 + warning"建议返回了未知路线，已忽略"
        └─ TravelApiError → adviceError（路线保留，"基础路线建议不可用"）
偏好变化 ──► 旧 advice 失效 + 防抖400ms 自动重发一次（仍守身份匹配）
needs_step_free 且任一路线证据 unknown ──► 常显"无台阶通行情况尚未核实"
```

身份计数器：`originSeq/destSeq`（搜索）、`locateSeq`（定位）、`planSeq`（规划）、`adviceSeq`（建议）。

## 三、已测 / 未测

**已测**（`npx vitest run src/features/travel`，14 用例全过，node 环境固定假响应）：
- parseWalkingResult：正常双路线全字段+polyline 摊平（LngLat 实例与普通对象混用）/缺 distance→null、缺 path→polyline null/空 routes→no_route/TIMEOUT→provider_error(timeout)/NETWORK→provider_error(network)。
- parsePlaceTips：正常解析/无坐标三态（null、`[]`、[0,0]）→location null/空数据形态→[]。
- parseLocateOutcome：ok+GPS+精度/`location_type:"ip"`→"IP近似"/denied/timeout/unavailable/complete 缺坐标→error。
- `npx tsc --noEmit` 通过。

**未测（需真机/联调）**：
- 真实 AMap JSAPI 各插件行为（定位精度、tips 形态、Walking 返回结构）需浏览器 + 有效 VITE_AMAP_KEY；定位需 HTTPS 或 localhost。
- 服务端 /api/travel/advice 联调（llm / rules / 降级路径）。
- React 组件渲染与 390px 布局需 `npm run dev` 人工目检。

## 四、遗留项 / 注意

1. `RouteOverlay` 需要构造器二参 `ns`（TravelPage 已传 `AMap` 命名空间）；一参时回退 `window.AMap`，node 下为 null 则跳过绘制。
2. 高德 Walking 无台阶字段缺失，证据恒 `unknown`，后续若 SDK 提供真实字段再升级 satisfied/unsatisfied（当前如实 unknown，不造假）。
3. 公交（Transfer）为后续小步扩展，本阶段 mode 恒 "walking"。
4. 精确位置/住址不进 localStorage/URL/日志；本阶段不持久化行程。
5. 偏好补充说明 note 客户端截断 200 字；服务端仍有一次校验兜底。
