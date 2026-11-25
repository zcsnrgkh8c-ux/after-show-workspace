# 窗口3交接档案（本轮：主卖点整理）

**状态：模块开发完成，等待窗口4整合与统一浏览器回归。** 交付后窗口3停止编辑。
日期：2026-11-14。范围：`features/review/**`、`pages/ComparePage.tsx`、`pages/ScenarioPage.tsx`、`pages/ReplayPage.tsx`。

## 1. 本轮目标

把已有决策能力整理成“可理解、可追溯的依据”，并给出可复现的演示线；主卖点仍是**照顾不同出行需求的散场方案**，首页建议为主体验，方案对比用于证明建议如何得出。未新增算法、接口、业务状态，未改 App/labels/store/api/服务端。

## 2. 改动文件

### 新增
| 文件 | 说明 |
|---|---|
| `src/features/review/planEvidence.ts` | 三问推导纯函数：`needEvidenceRows`（逐需求：可读名/人数/服务状态/剩余/错过截止）、`servedNeedCount`、`unfinishedNeedRows`、`serveStatusTitle`。只整理服务端字段，null 保持 null。 |
| `src/features/review/planEvidence.test.ts` | 12 例：路线安排、通道关闭受阻、invalid 不产指标、未完成口径、null 语义、状态全文。 |
| `交付/主卖点优化_20261114/本轮主卖点与演示脚本.md` | 约 2 分钟主线 + 可加约 1 分钟“我的出行”补充；含口播禁区与兜底。 |
| `交付/主卖点优化_20261114/功能与证据对照.md` | 已实现 / 当前验证 / 未验证 / 下一阶段四类，记录真实来源与模式。 |

### 修改
| 文件 | 改动 |
|---|---|
| `src/pages/ComparePage.tsx` | 顶部新增“方案依据 · 三策略对比”引导与**三问结论区**：① 当前能服务哪些需求（逐需求状态+原因）② 还有谁未完成/未赶上截止（组级真实数字+事实提醒）③ 为什么推荐/拒绝（服务端 status/reason/tradeoffs/原文 + 被拒方案清单 + 引擎/模式依据）。旧推荐框内容全部迁入 Q3，未删除；三策略卡保留并新增需求覆盖小标签；新增“这一页结论从哪来”工具轨迹折叠；过程回放/地图/组视角仍默认收起。过期时不出三问结论，改为“结论暂不可用：情况已变化”+更新按钮。 |
| `src/pages/ScenarioPage.tsx` | 新增“演示控制 · 情境调整”页头与**当前模拟输入只读汇总**（revision、已关闭通道 ID、无台阶通道开放数、seed/目标）；预设按钮说明将关闭/恢复的具体通道 ID；恢复说明明确“只恢复通道开闭，不动车辆/人数/seed/回放”；增加“不同输入不可混用历史数字”与复现顺序说明。页面加载不自动改场景、不发请求。 |
| `src/pages/ReplayPage.tsx` | 新增页内模式说明：回放中显示名称/保存时间/场景版本/非本次计算/实时运行禁用；实时视角说明列表为历史结果。保存/加载/退出、localStorage 限制、禁用语义均保留。 |
| `src/features/review/TracePanel.tsx` | 将内部轨迹列表导出为 `TraceStepList`（内容与行为不变），供方案对比页复用；`TracePanel` 默认导出不变。 |
| `src/features/review/review.css` | 新增 `review-page-head / review-answers / review-answer* / review-need* / review-unfinished-row / review-rejected / review-stale-answers / review-mode-banner / review-card-needs` 等样式；仍全部 `review-` 前缀，无全局元素覆盖。 |

### 未动
`App.tsx / main.tsx / styles.css / labels.ts / store / api / contract / replayStorage / DemoControls（已退役）/ 地图与 journey 域`。

## 3. 页面 Props / 接线

| 页面 | Props | 变化 |
|---|---|---|
| `ComparePage` | `onViewJourney?: () => void` | 未变；仍为“先 selectPlan 再回调，无回调就地展开高级详情”。 |
| `ScenarioPage` / `ReplayPage` | 无 | default export、无参数使用。 |
| `DiffPreview` | `onGoHome?: () => void` | 未变（本轮未改该文件）。 |

窗口4现有接线可直接复用，**无需新增回调**。页面内部标题已对齐本轮命名（“方案依据 · 三策略对比”“演示控制 · 情境调整”“已保存结果”），主导航文字仍由窗口4决定。

## 4. 三问与旧信息的位置（便于验收）

1. **Q1 能服务谁**：方案对比顶部三问区左列（推荐方案优先；无推荐时用当前查看方案并明示来源）。
2. **Q2 谁没完成**：中列；组级 remaining / missed_deadline，`null` 不显示为 0；下方黄色事实提醒。
3. **Q3 为什么**：右列；服务端推荐 status/reason/tradeoffs/原文折叠；invalid 方案列出拒绝原因；末段记录引擎版本与 generate/compare mode。
4. **旧明细**：策略卡“展开明细”内的分流表、班次表、算法备注、校验分组、完整指标、plan_id/rev/engine techline、单方案重跑全部保留。
5. **trace**：方案对比“这一页结论从哪来”（按需展开）；完整运行详情仍在已保存结果页 `TracePanel`（默认折叠）。

## 5. 本轮实际执行结果

- `npx tsc --noEmit`（`web/`）：✅ 0 错误。
- `npx vitest run`（`web/`）：✅ 21 文件 / 235 例通过（2026-11-14 18:39 执行；含其他窗口并行新增的测试）。本窗口新增 `planEvidence.test.ts` 12 例、既有 `display.test.ts` 10 例均通过。
- 真实样例核对：离线读取 `验收产物/results_AB联调/03_scenario1_normal_generate_compare.json`，用同一推导函数核对（推荐方案三类需求均安排路线、截止组 24 人错过截止；固定班次未完成含普通组与截止组；组级剩余之和等于总体 remaining_count；invalid 不产数字）。**临时校验脚本已删除，不作为交付测试。**
- 未运行服务端、未重启服务、未打开共享浏览器、未写 dist。

## 6. 未验项（留窗口4统一回归）

1. 本轮新 UI 的真浏览器视觉与交互（三问区 3 列/单列、折叠、390/1366/1920）。
2. 受阻 → 恢复 → 重算的当轮全链路实机复测（逻辑沿用既有流程，文案/输入汇总为本轮改动）。
3. 回放页新模式说明与全局横幅的实机组合。
4. 并列（tradeoff）推荐场景的实机表现：本轮未构造出并列结果，仅按服务端 status 展示。
5. 真实 LLM / 真实场馆成效 / 真机定位手势：仍不在本轮验证范围。

## 7. 事实边界（本轮已写入页面/文档）

- 300/300 登车 ≠ 全部按时；错过截止单独展示。
- 组级结果 ≠ 个人 ETA；模拟收益 ≠ 真实场馆成效。
- “少 B3 + 关 b1”与“少 B3 + 关 a1”是不同输入，不混用。
- LLM 仅按实际成功 mode 描述；无多智能体自主决策证据。
- `llm_configured` 只表示配置存在，不代表本次模型执行。
- 预设/自然语言/手动编辑都必须预览确认；页面加载不自动改场景、不自动重算。
- 恢复只通过既有 patch 流程，只恢复当前已关闭通道，不清空回放、不重置其他设置。
