# 窗口4交接档案（features/shell）

**当前状态：三窗口整合完成，浏览器验收通过（2026-11-14）。** 窗口1（journey）/窗口2（map）/窗口3（review）均已交付 HANDOFF 并停写；窗口4已完成接线、退役旧文件、全量测试/构建与真浏览器验收。详见 `web/用户端改造验收.md`。

日期：2026-11-14。维护人：窗口4（App.tsx / main.tsx / styles.css / labels.ts / labels.test.ts / features/shell/** / 用户端改造验收.md）。

## 0. 整合结果摘要（本节为整合后新增）

- 接线：`App.tsx` 挂载 `features/journey/JourneyPage`（mapSlot=窗口2 `MapExperience`，传 selectedRouteId）+ 窗口3 `ComparePage(onViewJourney)` / `ScenarioPage` / `ReplayPage`；tab 集合 journey/compare/demo/replay；更多菜单指向 演示控制（ScenarioPage）/ 已保存结果（ReplayPage）/ 数据说明（页脚锚点）。
- 退役（回收站，窗口4执行，均经 HANDOFF 确认）：`pages/JourneyPage.tsx`、`pages/DemoControls.tsx`、`components/NeedSelector.tsx`、`components/JourneyRecommendation.tsx`。
- styles.css 清理：移除旧 journey/need/rec/strategy/run-status 死类与冲突断点；保留窗口3仍在用的 `rec-raw`/`recommend-box`/基元类、MapPanel 的 `map-panel` 族、TimelinePlayer 的 `process-total/frame`、trace/amap/sandbox 族。
- `index.html` 标题改为“散场之后 — 出行建议（模拟演示）”。
- 全量验证：`tsc --noEmit` 0 错误；vitest 11 文件 109/109 通过；`npm run build` 成功；真浏览器（live 8787）回归数字与交互全过（见验收文档 §4）。

## 1. 背景与当前状态

本仓库此前由“整份改造提示词”的原窗口做了部分全目录改动；按四窗口约定，该任务已停止跨目录写入，转为窗口4职责。**既有改动全部保留，未回滚、未清理。**

并行阶段（当前）：窗口4只编辑白名单文件；窗口1～3并行开发各自模块。三份模块 HANDOFF 齐备并确认停写后，窗口4取得 `web/**` 整合修复权。

- 后端 8787（live）与前端 dev 5174 沿用既有后台进程，未重启、未改配置。
- `server/** / shared/** / fixtures/** / tests/** / 根配置 / .env*` 未改动；`web/src/api/**`、`contract/**` 只读。
- 当前 `tsc` 状态：见 §6。

## 2. 原全量任务遗留产物 → 归属

### 窗口1域（journey）
| 文件 | 状态 |
|---|---|
| `src/pages/JourneyPage.tsx` | 原任务新增，可编译运行。**未实现窗口1契约**（无 mapSlot/selectedRouteId/onOpenCompare/onOpenDemo/onOpenReplay props）。窗口1 请演化为 `features/journey/JourneyPage.tsx`（default export，按接线契约），或告知窗口4如何处置本文件。 |
| `src/components/NeedSelector.tsx` | 原任务新增，可用。内容属 journey 域，窗口1可吸收进自己的目录；吸收后告知窗口4清理引用。 |
| `src/components/JourneyRecommendation.tsx` | 同上。含建议卡/分流建议/组指标映射，复用 `labels.ts` 纯函数。 |

### 窗口2域（map）
| 文件 | 状态 |
|---|---|
| `src/components/Sandbox.tsx` | 原任务已改写：可读节点名、选中需求路线加粗高亮（plan+selectedGroupId props，均可选，不破坏旧调用）、关闭/台阶线型+短文字编码、点选回调 onPick（可选）。对应测试未新增。 |
| `src/components/TimelinePlayer.tsx` | 原任务已改写：`模拟第 mm:ss` 格式、全程结果与当前播放时刻分区、frameAt 导出保留。 |
| `src/map/overlayController.ts` (+.test.ts) | 原任务已改：节点标签用可读名（`labels.nodeDisplayName`）、通道标签只留状态短文字（已关闭/台阶/步行人数，容量与边 ID 移出主视图）、路线文字只在选中组路线标注一处、未选中路线淡化（#94a3b8）。测试已同步更新并应通过。 |
| `src/map/AmapView.tsx` | 原任务小改：文案“查看示意图”、图例“蓝色粗线=当前需求路线”。逻辑未动。 |
| `src/components/MapPanel.tsx` | 原任务新增（地图面板：地图/示意图切换、点选详情条、示意位置常驻说明）。属 map 域，窗口2可吸收进 `features/map/MapExperience.tsx`。 |
| `src/map/SandboxSwitch.tsx` | **已删除**（原任务整合进 MapPanel）。窗口2如需可自行重建。 |

### 窗口3域（review / 现有三页）
| 文件 | 状态 |
|---|---|
| `src/pages/ComparePage.tsx` | 原任务已改写为紧凑摘要卡（策略中文名/已登车/仍未登车/错过截止，明细按需展开，invalid 显示“…未参与推荐”+查看原因）。**未加 `onViewJourney?` 可选 prop**，窗口3按契约补。 |
| `src/components/GroupPanel.tsx` | 原任务小改：组名 chip 改用 `labels.groupDisplayName`（普通出行/需要无台阶通行/希望赶上末班）。其余未动。 |
| `src/components/ScenarioEditor.tsx` / `DiffPreview.tsx` / `MetricsView.tsx` | 未改动（MetricsView 的 `fmtSeconds` 被 TimelinePlayer/JourneyRecommendation 引用，签名保留）。 |
| `src/pages/ScenarioPage.tsx` / `src/pages/ReplayPage.tsx` | **已被原任务删除（回收站）**。窗口3需重建 default export 的两页（演示控制 / 已保存结果）。窗口4无法用工具恢复回收站，如需原文请手动从回收站还原或重写。 |
| `src/pages/DemoControls.tsx` | 原任务新增（NL+场景编辑+情境预设+回放管理+运行详情合并页）。**窗口3/4归属待定**：并行期 App 临时用它渲染“更多”目标；整合期拟退役，由窗口3 的 ScenarioPage+ReplayPage 承接，或划归窗口3。窗口3 交接时请给出结论。 |

### 窗口4域（已完成/进行中）
| 文件 | 状态 |
|---|---|
| `src/labels.ts` + `labels.test.ts` | 新增纯展示映射（节点/路线可读名、需求类型、方案中文名、组服务状态、组关键指标、推荐理由技术词替换、mm:ss 时间），测试覆盖。窗口1～3 需要新映射请提给窗口4集中增加。 |
| `src/state/store.tsx` | 仅追加纯派生 `useViewingBundle()`（inReplay/bundle/outdated/scenarioForView/engineBlocked/engineBlockReason）。reducer/actions/守卫未动。 |
| `src/App.tsx` | 已改为外壳：默认“出行建议”tab、主导航+更多菜单、状态短句横幅（模拟演示/断线/回放/过期/错误）、页脚数据说明。并行期临时 import `pages/JourneyPage` 与 `pages/DemoControls`；整合期按接线契约换 `features/journey/JourneyPage` + `features/map/MapExperience` + 窗口3两页。 |
| `src/features/shell/` | 新增：`MoreMenu.tsx`、`StatusBanners.tsx`、`useSelectedRoute.ts`（App 持有 selectedRouteId 展示状态 + 归属校验清除）、本 HANDOFF。 |
| `src/styles.css` | 窗口4重写：全局变量（--app-bg/--surface/--text-primary/--text-secondary/--accent/--radius-card）、按钮/排版/状态基元、外壳与断点；保留现有全部类名以兼容窗口1～3当前文件。 |
| `web/用户端改造验收.md` | 整合前先写草稿；最终版待整合+浏览器验收后更新。 |

## 3. 接线契约（备忘，整合期执行）

- `features/journey/JourneyPage.tsx` default export，props：`{ mapSlot, selectedRouteId, onSelectRoute, onOpenCompare, onOpenDemo, onOpenReplay }`。
- `features/map/MapExperience.tsx` default export，props：`{ selectedRouteId }`。
- 窗口3：ScenarioPage / ComparePage / ReplayPage 保留 default export；ComparePage 可加可选 `onViewJourney?: () => void`。
- App 拥有 `selectedRouteId`（不写入 Scenario/Plan、不发请求）；场景/轮次/实时回放/方案/组变化时按归属校验清除（已在 `useSelectedRoute.ts` 实现基础版）。
- 切页按需挂载：同时只有一个活动播放器；整合期核对 JourneyPage 与 ComparePage 不同时挂载。

## 4. 给窗口1～3的注意事项

1. 复用 `useApp/useActions/useViewingBundle`；不要重建平行业务状态或同名公共 labels/types 文件。
2. 全局变量已提供：`--app-bg / --surface / --text-primary / --text-secondary / --accent / --radius-card`（带 fallback 使用）。局部样式用各自前缀（journey- / journey-map- / review-），禁止全局覆盖 `button/.panel/.btn/h2`。
3. 需要新中文映射（labels.ts 缺口）时把字段与期望文案发给窗口4。
4. 半成品文件见 §2；吸收后告知窗口4调整引用，不要静默删除。
5. 你们范围内的测试自跑；完整 build/浏览器验证由窗口4统一执行。

## 5. 整合期（窗口4）待办

1. 确认三份 HANDOFF“模块开发完成，等待整合”且已停写。
2. App 接线：`features/journey/JourneyPage`（mapSlot=MapExperience）+ 窗口3 三页；处置 `pages/JourneyPage.tsx`、`pages/DemoControls.tsx`、被吸收的旧组件。
3. tsc/build、前端测试全量；按文件归属修复。
4. 5174 浏览器验收（1366×768 / 1920×1080 / 390×844；固定输入回归参照 190/300、300/300、清空1650s、24 错过截止；无台阶受阻 260/300、40 未登车；切组/切图/选路线/播放不发业务请求；回放标识；地图失败与业务失败分离）。
5. 更新 `web/用户端改造验收.md` 终版（截图路径、已完成/未验项；LLM 真实调用验收列为待办）。

## 6. 当前编译/测试快照（并行阶段）

- `tsc --noEmit`（web）：✅ 0 错误（2026-11-14 16:02 前后复检）。本轮修复三处根因：`labels.ts` 契约导入路径（`../contract/types`→`./contract/types`）、`store.tsx` 内 `runMatchesCurrent` 缺本地导入（此前仅 re-export）、`useViewingBundle` 用 `viewing` 局部变量保证判别联合收窄；另修 `ComparePage` 推荐判空收窄。上述均为窗口4白名单内文件。
- vitest：`labels.test.ts` 17/17 ✅、`map/overlayController.test.ts` 7/7 ✅（随新展示行为同步更新）。全量测试与 build 由窗口4在整合期统一执行。

## 7. 事实边界提醒（对全部窗口）

地图坐标与客流均为模拟；组级数据不是个人 ETA/实时导航/实际派车；300/300 登车不等于赶上截止（默认场景仍有 24 人错过截止）；MOCK、已保存回放、过期、断线、受阻必须清楚标识；null 不显示为 0；llm_configured 不证明实际模型调用。

## 9. 本轮（主卖点优化）最终整合记录 · 2026-11-14 19:15

**状态：本轮整合完成（仅窗口4范围），三窗口已交付并停写。**

### 9.1 前置确认

- 工作目录 `C:/Users/76827/Desktop/trae hks`；项目不是 git 仓库，无法 commit；基线见 `交付/主卖点优化_20261114/基线备份_代码与环境模板_20261114.zip`（不含密钥）。
- HANDOFF：`features/journey/HANDOFF.md`（完成并停写，新增可选 `onOpenTravel`）、`features/travel/HANDOFF-窗口2-本轮.md`（等待整合、已停写，新增可选 `onBackToJourney`）、`features/review/HANDOFF_主卖点轮.md`（完成、停止编辑，无需新回调）。
- 未发现另一目录的整合产物需要迁移；当前 5174 即承载本轮新导航。

### 9.2 本轮改动（窗口4独占）

| 文件 | 改动 |
|---|---|
| `App.tsx` | 一级导航 `散场建议 / 我的出行 / 方案依据·对比` + 更多；接入 `onOpenTravel` / `onBackToJourney`；按作用域切换顶部标签、回放徽标、页脚说明；`document.title` 按页面 |
| `features/shell/scopes.ts`（新） | `surfaceScope` / `bannerVisibility` / `staleReasonText` / `pageTitle` |
| `features/shell/scopes.test.ts`（新） | 11 例作用域与过期原因测试 |
| `features/shell/StatusBanners.tsx` | 新增 `scope`；散场过期/回放/引擎/错误只在群体推演页；travel 断线文案区分且保留真实错误 |
| `features/shell/MoreMenu.tsx` | 移除已提升的 travel；演示控制→情境调整 |
| `labels.ts` | 新增 `OBJECTIVE_LABELS` / `objectiveDisplayName` |
| `styles.css` | `.shell-tag-live`（真实能力页绿色标签） |
| `index.html` | 通用产品标题（不再固定“模拟演示”） |
| 交付文档 | `首页与导航调整说明.md`、`测试与浏览器结果.md`、更新 `功能与证据对照.md`、修正演示脚本口播两处 |

### 9.3 实测

- 根 `npm test` 109/109；前端 `tsc` 0 错误、`vitest` 246/246（新增 11）、`build` 成功。
- 浏览器：导航/入口/零请求；40/40→0/40→40/40；对比 190/300·110·49 与 300/300·0·24；过期原因文案；Travel 绿色来源标签 + rules 建议 + 0.8km/10分35秒；1366×768 与 390×844 无横向溢出。
- 截图：`交付/主卖点优化_20261114/截图/本轮-*.png`。

### 9.4 边界

- Travel 异步边界三项（防抖竞态 / Walking 无超时 / 建议响应身份比对）属真实出行模块，已登记唯一负责人，本轮未改 `useTravelFlow.ts`、`geo/**`、`api/**`。
- 真实 LLM、真机定位、公交换乘、地标找路、同行会合未验证/未实现。
- 未重启服务、未改 `.env.local`、未调用付费模型、未部署。

## 10. 晚间补充（2026-11-14 20:00 后，窗口4）

> §9.4 中“Travel 异步边界未改”与“真实 LLM 未验证”已被本节取代。

| 项 | 结果 | 相关文件 |
|---|---|---|
| 定位后地图空白 | 已修：境外/无底图坐标不再移动视野，按精度选缩放；8 例单测；东京/上海浏览器回归通过 | `map/locateView.ts`（新）、`map/AmapView.tsx` |
| Travel 异步边界三项 | 已修：偏好变化使在途建议失效；Walking 12s 有界超时；建议响应核对 request_id/candidate_set_id | `travel/app/useTravelFlow.ts`、`travel/geo/walking.ts`、`travel/app/adviceIdentity.ts`（新） |
| 真实 LLM | 已验：parse 与 travel advice 均 `mode=llm`（凭据仅进程注入）；travel 首次因模型自造 `reason_codes` 降级，补充枚举提示后成功 | `server/travel/llm.ts`（仅系统提示补充枚举） |
| 测试 | 前端 260/260、服务端 109/109、tsc 0 错误、build 通过 | — |

证据与截图见 `交付/主卖点优化_20261114/测试与浏览器结果.md` §6。
