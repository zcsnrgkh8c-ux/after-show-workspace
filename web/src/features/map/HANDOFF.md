# 窗口2 交接：地图视觉与聚合帧播放（features/map）

> 状态：**模块开发完成，等待整合**。改动全部位于窗口2白名单内（`web/src/map/**`、`web/src/features/map/**`、`web/src/components/Sandbox.tsx`、`web/src/components/TimelinePlayer.tsx`），未触碰其他窗口文件。局部测试 22/22 通过，`npx tsc --noEmit` 全量类型检查通过。

## 1. 固定交付接口（窗口4接线用）

```ts
// web/src/features/map/MapExperience.tsx
export interface MapExperienceProps {
  selectedRouteId: string | null; // 单向展示输入：窗口1点击路线 → App 传入；null=无选中
}
export default MapExperience; // 作为 mapSlot 注入首页；组件自行读取 store/useViewingBundle
```

行为要点：

- 数据统一取自 `useViewingBundle()`（自动区分实时/回放、沿用过期判定）+ `state.selectedPlanId / selectedGroupId / playT / playing`。
- 状态展示（准确、不冒充有效建议）：
  - 旧结果过期 → 警示条 + 只显示场地基础示意（不画任何方案路线、无播放入口）；
  - 无结果 → 按健康状态给准确原因（服务不可达 / 引擎未就绪 / 连接中 / 尚未计算）；
  - 回放 → 附"已保存结果回放"说明；
  - 当前需求被判定无可行路线（复用 `labels.serveStatusForGroup`：无分配 / 全关闭 / 台阶不合规 / 方案校验未通过）→ 警示条 + **不画任何方案路线**，不显示成功路线；
  - 合法结果但仍有滞留 / 错过末班 → 保留警示文字（滞留≠断路、登车≠赶上截止）。
- "查看散场过程"默认折叠；展开后**只有一个** `TimelinePlayer`，按返回 timeline 播放，时刻为"模拟第 05:00"格式（`fmtSimTime`）；当前帧人数与全程汇总分区、守恒口径放在 details 里。
- 地图优先模式：`getMapConfig(scenario).ok` 时默认"地图"，否则"示意图"；切换、失败重试、"查看示意图"入口均保留（SDK 12s 超时兜底、失败可重试等既有机制未动）。
- "示意位置 · 非实时导航"常驻；`coordVerified=false` 提示改为简洁一行 + 可展开详情；高德 logo/审图号由 SDK 自带未动。
- 点选详情：示意图节点/通道点击 → 本组件底部详情条（容量、边 ID、travel_s、boarding_gap 等技术信息只在这里）；高德节点点击 → 原有信息卡（信息窗）不变。
- 全部交互为纯展示状态：不发请求、不改 revision、不写 Scenario/Plan。

## 2. 涉及文件

新增：

- `web/src/features/map/MapExperience.tsx` —— 固定交付接口组件。
- `web/src/features/map/experience.ts` —— 纯函数推导：`mapExperienceStatus / mapServeView / planRoutesForMap / playableTimeline`（不重复造公共 labels/selectors，服务状态复用 `labels.serveStatusForGroup`）。
- `web/src/features/map/mapExperience.module.css` —— CSS Modules 作用域样式（类名带 journey-map- 语义；只用窗口4变量带 fallback：`--surface/--text-primary/--text-secondary/--accent/--radius-card`；无任何全局选择器覆盖）。
- `web/src/features/map/experience.test.ts` —— 14 项。

修改（均为既有文件加**可选**能力，默认行为不变）：

- `web/src/map/overlayController.ts` —— `rebuildRoutes(scenario, geo, plan, selectedGroupId, selectedRouteId?)`：第 5 参可选；设置时**仅该路线**加粗（#315CE7，宽 7），其余淡化（#94a3b8，宽 3），路线文字只标注在选中路线一处；未设置时回落到组高亮，与原行为一致。
- `web/src/map/AmapView.tsx` —— 新增可选 props：`selectedRouteId?: string | null`（透传给 rebuildRoutes）、`variant?: "full" | "compact"`（compact：容器高 `clamp(280px, 46vh, 400px)`、创建时 `scrollWheel:false` 把滚轮让给页面滚动；地图实例不因 variant 变化重建）。未核实坐标 banner 改为简洁一行 + `<details>` 展开。
- `web/src/components/Sandbox.tsx` —— 新增可选 prop `selectedRouteId?: string | null`：设置时仅该路线加粗、其余淡化；关闭/台阶仍用线型+文字双重编码；优先于组高亮。
- `web/src/components/TimelinePlayer.tsx` —— ①卸载时若仍在播放则自动 `setPlaying(false)`（防隐藏播放器推进 playT）；②新增"人数口径说明"details（每帧守恒：已释放=已登车+排队中+步行中；全程：已释放=已登车+仍未登车，仍未登车≠全部赶上截止）。**`frameAt` 既有导出保留**，`fmtSeconds` 仍从 MetricsView 引用未迁移。
- `web/src/map/overlayController.test.ts` —— 新增 selectedRouteId 用例（8 项）。

未改动（明确说明）：`components/MapPanel.tsx` 不在白名单内，未动（旧页面继续用）；`styles.css / labels.ts / store / App / 各页面` 未动；`api/**`、`contract/**` 只读；未装新依赖、未改 package/vite 配置。

## 3. 原调用兼容情况

- 所有新增 props/参数均为可选、有合理默认，`tsc --noEmit` 通过即证明 `JourneyPage / MapPanel / ComparePage / DemoControls` 等旧调用无需修改即可编译运行。
- `MapExperience` 是新容器，旧页面不引用它；窗口4把它作为 mapSlot 注入首页后，**首页不要同时再挂第二个 TimelinePlayer**（本组件已拥有首页播放入口；若 journey 新功能需要组级帧联动，请把 frame 传给组面板而不是再建播放器）。
- `MapExperience` 期望窗口1传入的 `selectedRouteId` 是当前场景中存在的路线 ID；不存在时本组件自动回落到组视角高亮（防旧 ID 残留）。

## 4. 播放计时器处理（防多播放器）

- 播放间隔计时器仍只在 `TimelinePlayer` 内（唯一实现），驱动全局 `state.playT/playing`。
- 三层防"隐藏播放器"：
  1. `MapExperience` 折叠（processOpen=false）→ 立即 `setPlaying(false)`；
  2. `TimelinePlayer` 卸载 → 若 playing 为 true 自动暂停（playingRef 判断，避免无谓 dispatch）；
  3. 切方案/更新建议/退出回放 → 既有 reducer（selectPlan/generateDone/exitReplay）本就重置 playT=0、playing=false，未改动。
- 同一 store 只有一个 playing 标志；只要页面同一时刻只挂载一个播放器实例（见上），就不存在多个计时器推进同一 playT。

## 5. 局部测试

`npx vitest run src/map/overlayController.test.ts src/features/map/experience.test.ts` → **22/22 通过**：

- 覆盖物生命周期不变式（帧推进零创建/零移除）继续通过；
- selectedRouteId：仅选中路线加粗、其余淡化、文字一处、优先于组高亮、无效 ID 无高亮；
- experience：过期/无结果（四种健康态原因）/回放边界；无分配/全关闭/台阶不合规/invalid → blocked 不画成功路线；滞留与错过末班警示保留；valid 无指标 → unknown（null 不当 0）；仅合法结果且有时间线才可回放。

未做浏览器压测（按分工浏览器操作统一由窗口4执行）。

## 6. 地图真实渲染未验证项（交窗口4）

1. **真机浏览器渲染未验证**：本轮仅静态检查与单测；此前记录的真实 key 渲染结论（瓦片/审图号/覆盖物/帧标签/反复切换无残留）对应旧代码版本，本轮改动后需窗口4在浏览器复验：选中路线加粗/其余淡化、compact 高度、滚轮行为（compact 下滚轮应滚动页面而非缩放）、折叠展开播放、过期/阻断状态条。
2. **移动端手势**：compact 已关滚轮缩放；触摸单指拖拽仍会平移地图（嵌入式地图固有行为），是否满足"手势不妨碍纵向滚动"需窗口4实测，必要时再议（不改坐标/不加依赖前提下可选方案：降低地图高度占比或提示用户使用页面空白区滚动）。
3. **1366×768 可读性**：容器 `clamp(280px, 46vh, 400px)` 按视口自适应，实际观感由窗口4确认；全局 `.amap-container` 420px 高度定义在 styles.css（窗口4权限），如需全局调整请窗口4处理。
4. 高德 logo/审图号：SDK 自带，未验证被 compact 尺寸遮挡的情况，窗口4渲染时顺带确认。

## 7. 其他记录（给文件负责人）

- 无外部阻塞问题。
- `MapPanel.tsx`（未归属窗口）仍引用 Sandbox/AmapView 旧签名，兼容无误；若后续整合时旧页面退役，可由其负责人决定去留。
- 守恒口径文字已与 mock/引擎的聚合计数语义核对（released=boarded+queued+walking 每帧成立），非编造。

## 8. 定位与地点跳转（2026-11-14 新增，队友A交接）

需求来源：演示反馈「定位功能加上去；优先呈现定位所在地，附加手动输入所在地，地图直接跳转」。

实现（仅展示层，结果不进入任何计算）：

- `web/src/map/locate.ts`（新增）——纯逻辑 `locateByGeolocation / locateByKeyword / describeLocation` 依赖注入端口，可单测；AMap 适配 `createGeolocationPort / createPlaceSearchPort / ensureLocatePlugins`（插件懒加载，缓存一次，失败清缓存允许重试）。
- `web/src/map/types.ts` —— AmapNamespace 增补 `plugin / Geolocation / PlaceSearch / CitySearch / AutoComplete` 最小类型。
- `web/src/map/AmapView.tsx` —— 地图就绪后**自动定位一次**（autoLocateTriedRef 防重）；工具栏新增「定位到我的位置」按钮 + 关键词输入框（Enter 或「跳转」）。成功：`setZoomAndCenter(15, pos)` + 「当前定位/匹配地名」Marker（userMarkerRef 独立管理）；失败：banner 如实给出原因并提示手动输入兜底，不伪造位置。三级兜底：浏览器精确定位（5s）→ IP 优先（8s）→ CitySearch 城市级；精度标注诚实（±Xm / 城市级）。
- `web/src/map/locate.test.ts`（新增）与 `venueGeometry.test.ts`（新增）覆盖权限/降级/超时/插件单例/门名判定/去重等。
- `web/public/venue-test.html` —— 独立坐标采集页（静态，无构建依赖）：搜场馆门、定位、附近出口、设为 E1/E2/E3、一键生成 `VITE_MAP_GEO_JSON`。

## 9. 场馆校门检索：AutoComplete 是唯一可行通道（2026-11-14 实测，队友A交接）

**问题**：`按真实场馆布点` 对华东交通大学搜不到任何校门，此前误判为“高德未收录”。

**实测结论**（真实 key 逐项验证）：`PlaceSearch.search("华东交通大学西门")` 只返回场馆与学院楼；`searchNearBy("门",…)` 返回建材门窗店；POI `children` 为空；**`AutoComplete.search("华东交通大学西")` 能返回「华东交通大学南区(西门)」并带坐标**。根因：高校校门是低权重 POI，NameSearch 不召回，只有输入提示能返回。

**修复**：① `venueGeometry.ts` 的 `NearbySearchPort` 增加可选 `autocomplete(keyword)`，`resolveVenueGeometry` 用场馆名 + ["门","西","东","南","北","校门","正门"] 分批并发检索（每批 4 个、批间 150ms，失败 300ms 重试一次——高德并发约 20 个会限流 7 个 error）；② 类名必须 `AMap.AutoComplete`（大写 C）；③ `isGateName` 要求以门/入口结尾（防「-门诊部」误判）；④ `dedupeByProximity`（Haversine 30m）合并同门重复 POI；⑤ 高德并发限流实测 20 并发错 7。

**验证**：venue-test.html 搜「华东交通大学」→ 22 个门/出入口（7 个属于该校），可分配 E1/E2/E3、P1/P2 并生成配置。

**集成方（窗口4）补充**：key/安全密钥已按队友A交接更新至 `web/.env.local`（不入库）；`VITE_MAP_GEO_JSON` 场馆中心改为华东交通大学（[115.870943,28.740046]，coordVerified 仍 false，节点为占位、可由布点/采集页覆盖）；AmapView 以交接版为底，保留外壳说明合并（GCJ-02/coordVerified 进“说明”折叠）。自动定位会在地图就绪时触发一次浏览器授权弹窗，属预期设计。
