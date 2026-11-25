# 窗口3交接档案（features/review）

> **本轮最新交接见 [HANDOFF_主卖点轮.md](./HANDOFF_主卖点轮.md)（2026-11-14 主卖点整理轮）。以下为整合轮历史记录，保留不改。**

**模块开发完成，等待整合。** 交付后窗口3停止编辑；整合修复权归窗口4。

日期：2026-11-14。维护人：窗口3。
白名单：`web/src/pages/ComparePage.tsx / ScenarioPage.tsx / ReplayPage.tsx`、`web/src/components/MetricsView.tsx / GroupPanel.tsx / ScenarioEditor.tsx / DiffPreview.tsx` 及专属样式/测试、`web/src/features/review/**`。

## 1. 改动文件清单

### 新增
| 文件 | 说明 |
|---|---|
| `src/pages/ScenarioPage.tsx` | 演示控制页（default export，无参数可用）：标题明确“修改的是模拟输入”。含情境预设、自然语言改场景、DiffPreview、手动编辑（折叠）、高级设置（seed/目标，折叠）。 |
| `src/pages/ReplayPage.tsx` | 已保存结果与技术详情页（default export，无参数可用）：回放历史/保存/查看/退出在前，运行详情默认折叠。 |
| `src/features/review/review.css` | 全部 `review-` 前缀，无全局 `button/.panel/.btn/h2` 覆盖；统一视觉变量带 fallback（#F6F8FC/#182238/#526079/#315CE7/16px 圆角）。被三个页面导入（Vite 去重，只打包一次）。 |
| `src/features/review/display.ts` | 局部展示推导：`groupViolationsByCode`（按 code 归类、warning 不丢）、`decisionModeText`、`recommendationFactWarnings`（推荐方案事实提醒）、`resultHasUnfinished`。纯函数，全部来自服务端字段，缺失返回 null/空。 |
| `src/features/review/display.test.ts` | 上述 4 个纯函数的单测（10 例）。 |
| `src/features/review/ViolationGroupList.tsx` | 校验问题按 code 分组：计数真实、severity 徽标、展开可见 path/原文；未知 code 保留原码。 |
| `src/features/review/DeparturesTable.tsx` | 班次表：车辆/站点/发车时刻（`labels.fmtClock` 模拟 mm:ss），直接来自 `Plan.departures`。 |
| `src/features/review/TracePanel.tsx` | 运行详情（工程验收）：默认折叠 `<details>`；展开后服务状态网格、generate/compare 工具轨迹、前端请求日志、重新检测服务。回放视图下轨迹来自保存快照并有说明。 |
| 本文件 | 交接档案。 |

### 修改
| 文件 | 改动 |
|---|---|
| `src/pages/ComparePage.tsx` | 见 §2。保留 default export；新增可选 `onViewJourney?: () => void`。 |
| `src/components/DiffPreview.tsx` | 新增可选 `onGoHome?: () => void`；“变更已应用”面板加“更新出行建议（按新场景重新生成）”按钮（调用既有 `generateAndCompare`，引擎受阻/busy 时禁用）。确认事件仍然只做 apply，不在同一回调里 generate。旧调用（无 props，如 DemoControls）不受影响。 |
| `src/components/GroupPanel.tsx` | 路线徽标改用 `labels.routeSequenceText` 可读名 + 保留原始 route_id 小字；Props 与导出未变。 |
| `src/components/MetricsView.tsx` | **未改动**（`fmtSeconds` 被 TimelinePlayer/JourneyRecommendation 引用，签名保持；default export 保持）。 |
| `src/components/ScenarioEditor.tsx` | **未改动**（default export 保持；由 ScenarioPage 用折叠区收纳）。 |

### 未动（只读遵守）
`App.tsx / main.tsx / styles.css / labels.ts / store / api / contract / replayStorage / DemoControls.tsx / 地图与 journey 域文件`。

## 2. 页面可选 Props（窗口4接线用）

| 页面/组件 | Props | 语义 |
|---|---|---|
| `ComparePage` | `onViewJourney?: () => void` | 点击卡内“在路线图中查看”：先按原语义 `selectPlan(planId)`，再调用回调回首页。**无回调时**：就地展开 ComparePage 底部“过程回放与组视角（高级详情）”，保证操作有可见反馈。 |
| `DiffPreview` | `onGoHome?: () => void` | 变更应用后可选“回首页查看建议”按钮；未提供时不显示该按钮，就地“更新出行建议”始终可用。 |
| `ScenarioPage` / `ReplayPage` | 无 props | default export、无参数使用。跨页跳转未私自实现，如需（如断线横幅“查看已保存结果”）由窗口4经 anchor/路由处理。 |

建议接线：`<ComparePage onViewJourney={() => 切到 journey tab} />`；`<ScenarioPage />` 接“演示控制”入口；`<ReplayPage />` 接“已保存结果/运行详情”入口。

## 3. 原能力入口位置（对照原 DemoControls 长页）

| 原 DemoControls 内容 | 现位置 |
|---|---|
| `#demo-controls` 演示情境与场景编辑（预设/NL/DiffPreview/ScenarioEditor） | `ScenarioPage`（手动编辑收进折叠区，默认收起） |
| seed / 优化目标编辑（原在 ComparePage 顶部） | `ScenarioPage` → “高级设置（随机 seed / 优化目标）”折叠区；ComparePage 只保留只读目标规则说明 |
| `#replay-manage` 回放管理 | `ReplayPage` → “已保存结果” |
| `#run-details` 运行详情（服务状态/工具轨迹/请求日志） | `ReplayPage` → `TracePanel`（默认折叠；原状完整保留，包括 llm_configured 不代表模型执行的说明、mock 提示、失败与耗时） |

**DemoControls.tsx 处置结论（答复窗口4 §2 的待定项）**：其功能已被 ScenarioPage + ReplayPage 完整承接，建议整合期退役该文件并同步调整 App 的“更多”菜单锚点（改为指向两页的入口）。窗口3不越权删除。

## 4. 技术详情保留位置

- 原始 plan_id / rev / 引擎版本 / 生成与比较 mode：ComparePage 卡片“展开明细”顶部两行 techline。
- 班次表：卡内“发车班次”（DeparturesTable）；算法备注（plan.notes）同区。
- 校验问题：卡内“校验问题”，按 code 分组、计数真实，展开见 severity/path/原文，warning 不丢。
- 服务端原始推荐理由：推荐框 `rec-raw` 折叠区（技术原文原样）。
- 服务状态/工具轨迹/请求日志：ReplayPage 的 TracePanel（默认折叠，展开完整可达）。
- 单方案重跑：仍在卡内明细区，禁用语义未变（stale/回放中/busy/服务不可达/引擎未就绪）。

## 5. 演示变化操作顺序（保持既有流程）

1. ScenarioPage：情境预设或自然语言/手动编辑 → **预览（DiffPreview）→ 确认应用（revision+1）**，确认事件只 apply 不 generate。
2. 应用后面板提供“更新出行建议（按新场景重新生成）”按钮（或全局“更新建议”横幅）→ 用户点击才重新计算；亦可稍后自行生成。
3. 旧结果在 revision 更新后立即过期（stale 标识、禁用保存/重跑），不覆盖、不冒充新结果。
4. ComparePage：重新生成并比较 → 紧凑卡查看 → “在路线图中查看”回首页（需窗口4接 onViewJourney）。

## 6. null / invalid / 回放语义（未改变，仅重排展示）

- null 一律显示“—/未清空/（零释放）/（无人登车）”，不变 0（MetricsView 原逻辑未动）。
- invalid：卡头“未参与推荐”徽标 + 摘要行“存在班次冲突（等实际原因），未参与推荐”；明细内分组原因；无有效指标时明示“未通过校验，无有效模拟指标”。
- 推荐身份/并列/无合法候选按服务端 `recommendation` 原样展示，不重排、不伪造评分、不永远突出 coordinated；返回 no_valid_candidate 但存在有效结果时保留前端核对警示。
- **全部成功叙事不吞事实**：推荐框内新增 `review-rec-warn`——推荐方案 remaining>0 或 missed>0 时显示真实人数（如“300/300 已登车，但有 24 人错过截止”）；卡内同样有提醒。全释放零登车的 stranded 告警框保留。
- 回放：保存/查看/退出与禁用语义原样（回放中不可再保存；过期结果不可保存）；localStorage 限制说明写明“同浏览器同源可用、清除站点数据会删除”；数据与 replayStorage 均未改。MOCK、断线、引擎未就绪、过期标识全部保留。

## 7. 已测 / 未测

已测：
- `npx tsc --noEmit`：通过（运行时点 16:10 左右，当时窗口1/2域文件亦无错误；如后续其他窗口文件报错，按归属处理，非本窗口改动）。
- `npx vitest run` 全量 11 个文件 109 例全部通过（含本窗口新增 display.test.ts 10 例）。
- DiffPreview/GroupPanel 为可选增强，旧调用（DemoControls、JourneyPage）Props 兼容，编译与现有测试可证。

未测（留窗口4整合期）：实际浏览器端到端（三页视觉、折叠交互、onViewJourney 实跳、回放全流程、5174 联调、三档分辨率截图）、与窗口1 journey 页、窗口2 MapExperience 的整合接线、构建产物验收。

## 8. 给窗口4的提醒

1. App“更多”菜单现为锚点跳转 DemoControls；接线后改为切换到 ScenarioPage / ReplayPage 两页（演示控制、已保存结果）。
2. ComparePage 高级详情默认收起、展开才挂载 TimelinePlayer/MapPanel/GroupPanel，满足“同时只有一个活动播放器”；整合时与 JourneyPage 不同时挂载即可。
3. ScenarioPage 的情境预设仍走 nlPending（预览→确认），未硬编码特定边；如未来场景无 step_free 边/无关闭边，按钮自动禁用。
4. 本窗口未新建任何与 labels/store 同名的公共文件；如需新中文映射（如更多 violation code 中文），请发回窗口4集中补充。
5. `review.css` 在 ComparePage/ScenarioPage/ReplayPage 三处导入（打包去重）；TracePanel/ViolationGroupList 若被别的窗口复用，请一并导入该文件。
