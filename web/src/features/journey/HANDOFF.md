# 窗口1 交接文档 — 首页建议与产品表达（features/journey）

状态：**完成并停写，等待整合**（2026-11-14 本轮：主卖点表达与首页层级）。本轮只改 `web/src/features/journey/**` 与本文件，未触碰 App、地图、travel、公共 labels/store/API/types、既有验收报告。

## 1. 本轮改动清单

| 文件 | 改动 |
| --- | --- |
| `JourneyPage.tsx` | ① 顶部新增「当前场景与数据模式」一行事实条（场景名 + 模拟推演/已保存结果回放/开发占位数据 + 边界说明）；② 页面顺序改为 场景与数据模式 → 出行需求 → 当前安排 → 地图 → 必要指标 → 依据与调整（DOM 顺序即移动端顺序，桌面地图左列跨三行、建议列右侧）；③ 新增可选 `onOpenTravel`；④ 移动端「返回建议 ↑」移到地图区顶部，滚到地图后立即可点。 |
| `JourneyAdviceCard.tsx` | ① 建议区拆为三个卡：`JourneySummaryCard`（当前安排/受阻原因）、`JourneyMetricsCard`（必要指标，本轮新增导出）、`JourneyDetailCard`（路线明细、推荐理由、依据入口）；② 受阻块内新增真实下一步入口「查看其他方案」「调整演示情境」；③ 无候选/无方案状态给对应真实入口；④ 路线速览仅在未受阻时作为主操作，受阻时隐藏「在地图中查看」；⑤ 次级入口按接线表命名：方案依据·对比 / 情境调整 / 已保存结果 / 我的出行（可选）；⑥ 结果状态文案「模拟已完成」→「推演已完成」，避免在受阻时暗示成功；⑦ 无路线时标题改「路线安排」，不再写「建议路线」。 |
| `JourneyNeedChips.tsx` | 同类多组时需求卡人数显示「共 N 人」（单组仍为「N 人」），不把汇总人数冒充当前组分母。 |
| `display.ts` | 新增纯函数 `journeyContextFor`（MOCK > 回放 > 实时模拟；只描述数据来源，不判断结果新鲜度）；其余既有导出签名不变。 |
| `display.context.test.ts` | 新增 5 例：实时模拟边界、回放标签、空回放标签、MOCK 优先、空场景标题回退。 |
| `journey.css` | 新增顶部上下文条、三卡网格区（桌面 `map/summary/metrics/detail`，≤900px 单列 summary→map→metrics→detail）、受阻下一步按钮；路线按钮 44px、次级链接 40px；全部 `journey-` 前缀，复用全局变量并带 fallback。 |

保留未动：`journeyCardState` / `routeItemsForGroup` / `routeSummaryForCard` / `formatWaitSeconds` 语义与既有测试；切组 `selectGroup`、生成 `generateAndCompare`、移动端滚动与选中清除逻辑。

## 2. 入口 / 回调契约

```ts
export interface JourneyPageProps {
  mapSlot: ReactNode;
  selectedRouteId: string | null;
  onSelectRoute: (routeId: string | null) => void;
  onOpenCompare: () => void;   // 页面内文案：方案依据·对比
  onOpenDemo: () => void;      // 页面内文案：情境调整
  onOpenReplay: () => void;    // 页面内文案：已保存结果
  onOpenTravel?: () => void;   // 可选（新增）：文案「我的出行」；未传则不渲染，避免死链
}
```

- 默认导出 `JourneyPage`；具名导出 `JourneySummaryCard` / `JourneyMetricsCard` / `JourneyDetailCard` / `JourneyNeedChips`（同目录使用，未对外承诺）。
- **需窗口4接线**：若希望首页「查看依据与调整」里出现「我的出行」，请给 `<JourneyPage>` 传 `onOpenTravel={() => setTab("travel")}`；当前 App 未传，浏览器中该链接不渲染（其余三个入口正常）。
- 全局导航名称仍由窗口4维护；本页只使用接线表里的入口文案，不改导航。

## 3. 读取的 store / 动作（未新增业务状态）

- `useApp()`：`selectedGroupId`、`selectedPlanId`、`busyGenerate`、`viewing`（仅取回放标签用于上下文条）。
- `useViewingBundle()`：`inReplay`、`bundle`、`outdated`、`scenarioForView`、`engineBlocked`、`engineBlockReason`。
- `useActions()`：`selectGroup`（切需求仅改视角）、`generateAndCompare`（唯一业务请求入口）。
- 只读复用 `labels.ts`（`needOptionsFromScenario`、`groupDisplayName`、`fmtClock`、`planDisplayName`、路线/受阻/指标/理由映射）与 `api/config.ts#IS_DEV_MOCK`。
- 未改 reducer、请求守卫、回放持久化、API/contract、地图与 travel。

## 4. 局部验证结果（真实执行）

### 4.1 测试与类型
- `npx vitest run src/features/journey` → **29/29 通过**（13 既有 + 11 过期/推荐绑定 + 5 新增上下文）。
- `npx tsc --noEmit`（web） → **0 错误**。

### 4.2 真浏览器（ego Chromium，live 8787 + Vite 5174）
| 项 | 实测 |
| --- | --- |
| 首次无结果 | 缺省需求普通出行（180 人），无硬编码成绩；上下文条「模拟推演 · 合成场景的群体推演，不是实时导航」；主按钮「生成出行建议」44px。 |
| 生成 | 恰好新增 `POST /api/plan/generate` + `POST /api/compare` 两个请求；结果 180/180、仍未登车 0、平均排队 6 分 24 秒；3 条分流路线 33%/31%/36%，R3 标「含台阶」。 |
| 切需求 | 切「需要无台阶通行」后 **零新增业务请求**；路线变 2 条 51%/49%、指标 40/40；路线速览与所选路线一致。 |
| 选路线 | 点「在地图中查看」→ 速览变「当前查看/取消查看」、明细行选中 1 条、地图标签出现「路线 R1（本组 51%）」；再点取消恢复。 |
| 过期 | 演示控制应用「无台阶通道全部受阻」→ rev2；首页只显示「情况已变化，原建议已过期（当前 rev2 / 旧 rev1）」，旧指标、路线、速览全部不渲染，主按钮「更新建议」。 |
| 受阻 | 更新后：红块「本方案未为该需求安排接驳路线」+ 说明 + 「查看其他方案」「调整演示情境」两个真实入口；无「在地图中查看」；指标 0/40、仍未登车 40、平均排队 27 分 17 秒；无绿色成功块；详情写「本方案未为该需求安排接驳路线」。 |
| 恢复 | 演示控制「恢复已关闭通道」→ 更新后 40/40、2 条路线、绿色「该需求已有可行的接驳路线」，主操作恢复「在地图中查看」。 |
| 回放 | 保存并载入回放：上下文条「已保存结果回放 · 历史计算快照「窗口1验证」，非本次计算」+ 摘要卡回放徽标；「重新计算」禁用并提示「退出回放后可重新计算」；退出后恢复「模拟推演」与实时结果。 |
| 桌面 1366×768 | `scrollWidth 1351 / innerWidth 1366` 无横向溢出；地图 734px / 建议列 490px ≈ 60/40；上下文、需求、当前安排与主操作首屏可见；主按钮/需求卡/路线按钮 44–55px。 |
| 手机 390×844 | `scrollWidth 390` 无横向溢出；顺序 = 上下文/需求 → 当前安排 → 地图 → 指标 → 依据；「在地图中查看」位于首屏 y≈670（44px）；点选后滚动到地图（scrollY 885、地图 top 0），「返回建议 ↑」在地图顶部 y=0、44px；点击回到摘要（summary top 0）。 |
| 无推荐 / 接口错误 | 仅单测覆盖 `no_valid_candidate` 分支；接口断线态本轮未停服务验证（全局横幅由窗口4负责）。 |

截图（临时目录，非交付物）：`C:/Users/76827/ego/journey-verify-20261114-1838/`（`final-1366x768.png`、`final-390x844.png`、`desktop-blocked.png`、`desktop-outdated.png`、`desktop-replay.png` 等）。

## 5. 未验项 / 待整合

1. **我的出行入口**：需窗口4传 `onOpenTravel` 才会在首页出现；未传时是刻意不渲染（不是遗漏）。
2. **接口错误/断线**：未停服务验证；本页只在建议卡显示禁用原因，全局横幅仍由窗口4负责。
3. **无推荐浏览器态**：`no_valid_candidate` 只有单测与代码路径核对，未构造出真实场景复现。
4. **1920×1080**：本轮未重新截图（前轮验收通过）；布局为弹性 3fr/2fr，预期不受影响，建议整合回归时补一张。
5. **真机触屏**：390 宽地图单指拖拽仍为桌面浏览器仿真，未做真机手势验证（地图属窗口2）。
6. 本轮把「返回建议」从地图下方移到地图上方（移动端）；桌面仍隐藏，建议整合回归时重点看一眼该入口。
7. 事实边界提醒：页面只展示组级模拟安排（分流比例、平均排队、错过截止），不写个人 ETA、不写实际派车、不写个人轨迹；300/300 不等于全部赶上截止，末班组仍显示「有 N 人未赶在截止前登车」。

整合完成后请以本轮代码与 `web/用户端改造验收.md` 的最新记录为准，不要用本文件替代验收报告。
