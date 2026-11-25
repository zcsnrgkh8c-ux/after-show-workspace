# 窗口2本轮交接：「我的出行」体验与来源说明（2026-11-14）

> **状态：模块开发完成，等待整合。已停写。** 未宣称完整产品验收通过。
> 本轮只改窗口2白名单：`web/src/features/travel/TravelPage.tsx`、`web/src/features/travel/ui/**`、本交接文档。
> 未改 `geo/**`、`vendor/**`、`app/useTravelFlow.ts`、`api/**`、`shared/**`、`server/**`、`App.tsx`、`styles.css`；未安装依赖、未改环境变量、未读取或打印任何密钥。

## 1. 本轮目标与结果

把已有真实地点出行模块整理成普通观众可执行的流程，并明确来源分层，**没有重新实现定位、搜索或路线服务**：

- 流程：使用当前位置 / 手选起点 → 选择终点 → 规划路线 → 查看路线事实与建议。
- 主操作随步骤变化，同一时刻只有一个主按钮；授权拒绝、超时、低精度、无坐标候选均保留手选回退。
- 先显示高德路线事实，再显示服务端建议；建议慢/失败不抹去路线。
- 单候选明确“只解释这一条”，不出现“多路线智能择优”。
- 模式严格按响应表达：只有 `mode=llm` 才标“模型分析”；`rules` 标“规则”；`unavailable` 标“不可用”；失败/超时据实提示。
- 来源说明：定位来源/精度、地点候选、地图与路线、预计步行时间、建议、无台阶证据分别标注。
- 不宣称已到店铺门口、不把缺失证据当无台阶、不新增公交/室内/会合入口。
- 与散场推演通过页面切换衔接；本页数据不写入 `Scenario / Plan`。

## 2. 改动清单

### 新增

| 文件 | 内容 |
|---|---|
| `ui/TravelSteps.tsx` | 四步指示（起点/终点/规划/结果，当前步骤 `aria-current`）+ 当前步骤唯一主操作 + 可选次级操作 + 状态说明。步骤 chip 仅指示，不触发请求。 |
| `ui/display.ts` | 纯展示推导：`stepForInputs`、`placeSourceView`、`accuracyText`、`adviceModeView`、`adviceErrorText`、`drawnRouteCount`。不发请求、不改数据。 |
| `ui/display.test.ts` | 12 例：步骤推导、GPS/IP/POI/低精度来源、llm/rules/degraded/unavailable 模式、失败文案、折线绘制计数。 |
| `HANDOFF-窗口2-本轮.md` | 本文件（保留原 `HANDOFF.md` 历史证据，未覆盖）。 |

### 修改（均为原导出保留 + 可选扩展）

| 文件 | 改动 |
|---|---|
| `TravelPage.tsx` | 新增可选 `TravelPageProps { onBackToJourney?: () => void }`；页头/返回入口；真实地点边界说明；步骤与主操作；布局改为桌面「左表单+结果 / 右地图」、窄屏「表单→结果→地图」；地图来源与绘制计数说明；底部「数据来源与能力边界」；地图容器高度局部修正；`OriginDestForm` 传确认地点与 `showPlanButton={false}`（规划主操作由步骤条承担）。地图生命周期、SDK 单例、RouteOverlay、聚焦逻辑原样保留。 |
| `ui/OriginDestForm.tsx` | 新增可选 `originPlace` / `destPlace` / `showPlanButton`；已确认地点显示来源（POI / 浏览器定位已转 GCJ-02 / IP 近似）与真实精度；IP 近似或精度 >100m 显示低精度提示；不传新 props 时行为与原版一致（表单内规划按钮默认仍显示）。 |
| `ui/RouteCard.tsx` | 卡头改为“路线事实 + 状态 + 高德地图 + 候选数”；单候选提示；指标改为“距离（高德）/ 预计步行时间（高德估算）/ 无台阶证据”；新增数据口径说明（估算非实际、unknown 不代表无障碍、未到店门口）；错误/无路线明确“未请求建议、不用估算/直线替代”；页脚明确 `AMap.Walking` 来源与查询时间。 |
| `ui/AdviceSection.tsx` | 新增可选 `candidateCount`；卡头“出行建议 + 模式 chip + 服务端”；`llm`→模型分析、`rules`→基础路线建议/规则、`degraded_from=llm`→降级、`unavailable`→不可用（不再伪装基础建议）；单候选说明；失败按超时/网络/校验/HTTP 分类；来源行与“模式与来源说明”折叠；建议不覆盖路线事实。 |
| `ui/travel.css` | 全部改用窗口4变量并带 fallback（原先 `--text-muted/--warn-text/--radius/--shadow/--text` 在整合后已不存在）；新增页头/边界/步骤/来源/模式 chip/单候选/说明等局部类；桌面双列、窄屏单列；390px 断点（步骤 2×2、指标单列、地图 240px）；主操作与候选触达约 44px。 |

### 发现并修复的集成缺陷

高德 SDK 创建地图后会向容器追加 `amap-container` 类，窗口4全局样式 `.amap-container { height: 440px }` 以同优先级后加载覆盖了 `travel-map-canvas` 的 340px（浏览器实测 computed height=440px）。已在本模块局部样式中用 `.travel-map .travel-map-canvas`（更高优先级）固定 340/280/240px 与 16px 圆角；实测修复后 computed height=340px、radius=16px。**未改全局样式。**

## 3. 原调用兼容

- `TravelPage` 仍是具名导出；`<TravelPage />` 不传 props 可正常编译运行（`tsc --noEmit` 0 错误）。窗口4可改为 `<TravelPage onBackToJourney={() => setTab("journey")} />` 获得返回入口；不传则不显示返回按钮，不改变其他行为。
- `OriginDestForm` / `RouteCard` / `AdviceSection` 原 props 未删除、未改语义；新增 props 全部可选。
- `useTravelFlow`、`RouteOverlay`、`loadAmapWithPlugins` 未改；仍复用同一份路线结果、同一个 overlay 与同一个 SDK loader，没有第二套缓存/定位/SDK。
- `App.tsx` 未改：全局入口仍由窗口4决定，本模块未抢占默认首页。

## 4. 给窗口4的回调需求

```ts
// App.tsx 现有 <TravelPage /> 可原样保留；若要提供返回散场建议入口：
{tab === "travel" && <TravelPage onBackToJourney={() => setTab("journey")} />}
```

无需其他接线；本页不读取全局 store / health / 仿真接口，不因后端仿真引擎不可用而新增跨域阻塞。travel 建议接口自身的超时/失败在本页独立展示。

## 5. 模式与数据来源表

| 展示项 | 实际来源 | 页面表达 | 本轮验证状态 |
|---|---|---|---|
| 定位 | 浏览器 `navigator.geolocation` 单次定位（WGS-84 → GCJ-02）优先；失败后高德 Geolocation（可能 IP 近似） | “浏览器定位（WGS-84 已转 GCJ-02）”或“IP 近似定位（非精确 GPS）”；显示接口返回精度；IP/精度 >100m 提示核对起点；拒绝授权不落 IP | 真实浏览器定位**未完成**（自动化权限挂起）；来源/精度映射有单测 |
| 地点候选 | 高德 AutoComplete | 名称 + 区县/地址；无坐标候选禁用并提示改选 | 手输 + 真实候选点选已验证；无坐标候选本轮未遇到 |
| 距离 | 高德 Walking 返回 `distance` | “距离（高德）” | 真实调用验证（19.0 km） |
| 预计步行时间 | 高德 Walking 返回 `time` | “预计步行时间（高德估算）”，注明估算非实际用时 | 真实调用验证（252 分 50 秒） |
| 折线与起终点标记 | 高德 Walking 返回真实折线 | 地图绘制；`polyline=null` 不画、不用直线替代；标注已绘制条数 | 真实路线后地图组件沿用既有 overlay；本轮未逐屏核对地图线条 |
| 无台阶证据 | 高德步行规划未提供该字段 | 恒“尚未核实（高德未提供）”；不称无障碍、不称到店门口 | 真实调用后页面显示“尚未核实” |
| 出行建议 | 服务端 `POST /api/travel/advice` | 模式 chip：`llm`→模型分析；`rules`→规则；`degraded_from=llm`→模型失败降级；`unavailable`→不可用；失败显示超时/网络/校验/HTTP | 真实接口 rules 已验证；llm 未配置 |
| 地图底图/坐标 | 高德 JS API 2.0，GCJ-02 | “地图与路线来源：高德地图 JS API 2.0 · 坐标 GCJ-02”；保留高德 logo/审图号 | 真实浏览器加载验证 |
| 与散场推演 | 两者完全独立 | 页头“与散场建议相互独立”；边界条与来源说明注明不写入 `Scenario/Plan`，不把模拟班次当真实公交 | 代码层确认（本页不 import store / 不调用仿真 API） |
| 明确不提供 | — | 室内图、店铺门口可达性、公交/换乘、实时路况/导航、同行会合 | 未添加任何入口 |

## 6. 实际验证（真实执行）

### 6.1 类型与测试

- `npx tsc --noEmit`：**0 错误**。
- `npx vitest run`：**235/235 通过**（21 文件），其中本模块 `ui/display.test.ts` 12 例、`geo.test.ts` 14 例。
- 未执行 `npm run build`（按分工完整构建由窗口4统一执行，避免写共享 `dist`）。

### 6.2 真实服务状态

- `GET http://127.0.0.1:8787/api/health` → `{"status":"ok","schema_version":"1.0","engine_ready":true,"llm_configured":false}`。
  说明：**travel LLM 未配置，本轮不能标模型分析**。

### 6.3 真实 `/api/travel/advice` 调用（服务端真实接口，候选为合成的接口级样本）

| 输入 | 真实响应关键字段 |
|---|---|
| 单候选 1536m/1200s/unknown | `mode:"rules"`, `selected_route_id:"r1"`, `reason_codes:["single_candidate"]`, `degraded_from:null`；explanation 含“当前仅有一条候选，未进行多路线择优” |
| 双候选 + `needs_step_free=true` + 证据 unknown | `mode:"rules"`, `selected_route_id:null`, `reason_codes:["no_candidate_meets_preference"]`, `warnings:["无台阶通行情况尚未核实"]` |

说明：以上只验证服务端 rules 语义，**候选数据是接口级合成样本，不代表真实高德路线**；真实高德路线由 6.4 单独验证。

### 6.4 真实浏览器 + 真实高德路线（dev 5173，live 8787）

- 从“更多 → 我的出行”进入；页面标题“我的出行”、四步骤、单一主操作渲染正常。
- 手动输入并经真实 AutoComplete 点选：起点“南昌西站”（江西省南昌市红谷滩区·西站大街1号）、终点“华东交通大学(双港东校区)”（江西省南昌市新建区·双港东大街808号）。
- 点击“规划步行路线”后：路线事实卡状态“规划成功”，**共 1 条候选**，距离 **19.0 km**、预计步行时间 **252 分 50 秒**；页面出现单候选说明。
- 出行建议卡显示“出行建议 / 规则 / 服务端”，**无“模型分析”标识**；控制台无 error/warning。
- 地图容器高度缺陷修复后实测：`computedHeight=340px`、`borderRadius=16px`；826×818 视口下 `scrollWidth=811 < 826`，无横向溢出。
- 主操作按钮实测高度 44px。

### 6.5 步骤流

- 初始：当前步骤“起点”，主操作“使用当前位置”，次级“手动输入起点”。
- 手选起点后进入“终点”；两端确认后进入“规划”，主操作为“规划步行路线”。
- 规划成功后进入“结果”，主操作“查看路线结果”，次级“重新规划”；地图与建议均为真实响应。

## 7. 未验项（不得当作已通过）

1. **390×844 真机/视口运行未验**：自动化浏览器无法修改视口（`window.resizeTo` 被阻止，且无设备模拟工具）。本轮仅完成 CSS 断点设计（≤480 步骤 2×2、指标单列、地图 240px、主按钮全宽）与 826 宽无溢出实测；390 宽实际排版需窗口4复验。
2. **定位拒绝/超时/IP 低精度真实回退未完成**：自动化环境点击“使用当前位置”后权限提示挂起，页面停在“定位中…”，未走到拒绝/超时分支。`geo/geolocation.ts` 与 `useTravelFlow` 未改；解析分支有既有单测，但本轮真实拒绝与 IP 路径未验。
3. **真实 travel LLM（mode=llm）未验**：`llm_configured=false`；页面在收到 `mode=llm` 前不会显示“模型分析”。
4. **路线失败/无路线真实场景未验**：未故意制造 invalid key/网络中断；`provider_error` / `no_route` 分支代码未改，UI 文案已补“未请求建议、不用估算/直线替代”。
5. **无坐标地点候选真实样本未遇到**：禁用与“无坐标，请改选”逻辑保留未改。
6. **建议旧响应/身份不匹配未现场复现**：`useTravelFlow` 的 `adviceSeq` 与 `candidate_set_id` 校验未改，本轮 UI 不涉及该逻辑。
7. **地图路线线条/起终点标记逐屏核对未做**：浏览器验证聚焦路线事实卡与建议模式；overlay 未改。
8. 公网 HTTPS / 真机定位、公交/室内/会合均不在本轮范围。

## 8. 给窗口4的注意事项

1. 如需“返回散场建议”入口，只在 `App.tsx` 传 `onBackToJourney`；不要改 `TravelPage` 内部。
2. 若要调整全局 `.amap-container` 高度或圆角，请注意它会同时影响本页（本页已用更高优先级局部选择器自保）；改完全局后请复验本页地图高度。
3. 本页默认仍从“更多”进入，入口排序由窗口4决定；本模块未抢占默认首页。
4. 首页“散场建议”与本页的切换应保持两个独立页面；不要把本页真实经纬度/路线/建议合并进 `Scenario/Plan`，除非未来提供并验证显式适配器。
5. 本页样式全部以 `travel-` / `route-` / `advice-` 局部类书写，未新增全局选择器；全局 `h2` 等基础样式仍由窗口4拥有。
6. 原 `features/travel/HANDOFF.md` 与既有测试、历史证据均保留，未覆盖。
