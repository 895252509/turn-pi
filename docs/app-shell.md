# Turn Pi 应用外壳（App Shell）设计

> 状态：第 1、2、3 步均已落地（视图/hash 路由、历史会话列表、模块 icon rail + 可折叠上下文列、断点分级 + 窄屏自动收起、移动端抽屉模块条）
> 目标读者：接手前端结构改造的工程师

---

## 0. 一页结论

左侧面板的问题是**导航和内容混在一列**：历史会话是 O(n) 的内容，却长期占着 O(1) 的常驻空间。
拆成两条轴之后，左栏高度就不随模块数量增长：

| 轴 | 内容 | 桌面 | 移动 |
| --- | --- | --- | --- |
| 轴 1：模块（全局、互斥、可路由） | 对话 / Agent / 技能 / MCP / 定时任务 | 最左固定 icon rail | 抽屉内的模块条（不常驻底部 tab） |
| 轴 2：上下文（属于某个模块、可折叠） | 对话→历史会话；技能→分类；MCP→server 列表 | 模块内的第二列，可折叠 + 拖宽 | sheet |

判断标准：**常驻导航只留给"高频 + 互斥"的切换。** 移动端 95% 时间在对话，低频模块不值得常驻 56px 底部空间（底部还要留给 composer + safe-area + iOS 自带工具条）。

## 1. 视图与列表

### 1.1 视图路由（`web/src/lib/view.ts` + `store.ts`）

- `AppView = 'chat' | 'agents' | 'skills' | 'mcp' | 'jobs'`，`settings` 故意不算模块（它是深度配置的弹窗）。
- `agents` 是整页工作台（模板列表 + 编辑器 + 预览三列），和 `jobs` 一样属于「整页配置/排障」，所以是模块而不是弹窗。见 `docs/agent-templates.md`。
- **hash 是视图的唯一真相**：`#/chat`、`#/skills`…；未知/空 hash 回落 `#/chat`。
- `store.view` / `setView()` / `syncViewFromHash()`；`App.tsx` 监听 `hashchange`。
- `openSession()`、`newChat()` 一定把视图切回 `chat`（将来从技能/MCP 里点历史会话时靠这行）。
- **会话 id 不进 hash**：仍由 `SESSION_KEY`（localStorage）记忆，避免两处真相打架。真要支持分享链接时再扩成 `#/chat/<sessionId>`。
- 非对话视图渲染各自的模块视图（`jobs` → `JobsView`、`agents` → `AgentsView`、`mcp` → `McpView`、`skills` → `SkillsSidebar` + `SkillsView`），
  `.app` 收成 `56px + 1fr`（`.app.view-module`），右栏不渲染。
- **定时任务已从设置弹窗迁到 rail 模块**：配置/执行记录是整页工作，放在 `#/jobs` 里既能深链、
  也不会被「关闭设置」误关；设置弹窗只剩通用 / 供应商 / 凭据 / 模型与工具 / 关于 5 个 tab。

### 1.2 历史会话列表（`web/src/components/SessionList.tsx`）

从 `Sidebar.tsx` 抽出，分组 / 折叠记忆 / 归档 / 搜索都在组件内，外层只负责摆位置：

```tsx
<SessionList searchable onOpened={() => setDrawer(null)} />
```

- `searchable`：搜索框（`#sessions-search`），匹配 name / title / workspaceLabel / worktreeBranch；
  搜索时强制展开分组与已归档（并禁用折叠按钮，避免"点了没反应"）；Esc 只清空搜索，不冒泡到全局关抽屉。
- `onOpened`：打开会话后的回调，留给弹窗 / sheet 复用（左栏不需要）。
- 移动端（≤980px）`.session-action` 常驻可见、`.session-open` 行高 ≥44px —— 触屏没有 hover，
  否则归档入口等于不存在、行也太小。

## 2. 外壳结构

```
.app (grid 4 列)
├─ .rail-nav   56px        模块：对话 / Agent / 技能 / MCP / 定时任务 + 设置 + 连接状态
├─ .rail       220~420px   对话模块的上下文列（历史会话），可折叠、可拖宽
├─ .chat       1fr         主视图（对话 / 定时任务模块 / 技能与 MCP 的占位）
└─ .panel      400~460px   右栏（只在对话模块存在）
```

- `ModuleRail.tsx`：`nav` + `aria-current="page"`，方向键/Home/End 在模块间移动焦点；
  **已选中对话时再点对话图标 = 展开/收起历史会话列**（不需要额外的浮动按钮）；
  生成中时对话图标上挂一个呼吸点（`.rail-nav-live`，`prefers-reduced-motion` 下自动停）。
- **每个入口都带小字标签**（`.rail-nav-label`）：只有图标时第一次使用认不出来；
  窄条 9.5px 一行，超长省略。
- **「新对话」槽位常驻**：历史会话列展开时按钮只是 `visibility: hidden`（`.rail-nav-slot`，
  同时 `tabIndex=-1` + `aria-hidden`），它仍然占位，所以下面的模块图标不会上下跳。
- **rail 可展开成宽条**（`#rail-wide-toggle`，`aria-pressed`，落盘 `pi-webchat:rail-expanded`）：
  窄条 56px（图标 + 小字）↔ 宽条 184px（图标 + 文字横排 + 品牌名）。
  列宽只由一个变量 `--rail-w` 驱动，所有断点/变体的 grid 模板都读它，不重复写死。
- `GlobalFoot.tsx`：设置 + 连接状态。桌面端挂在 rail 底部，移动端挂在抽屉底部；
  用 `isMobile` 保证**同一时刻只渲染一处**，`#conn` / `#rail-settings-toggle` 不会出现重复 id。
- `Splitter` 参数化：`target="panel" | "context"`，统一 `data-target` + `role="separator"`；
  上下文列在左（ArrowRight/右拖变宽），右栏在右（ArrowLeft/左拖变宽），双击/Home 恢复默认。
- `lib/contextColumn.ts`：宽度与折叠状态**按模块分别记忆**
  （`turnpi:context-width:<view>` / `turnpi:context-collapsed:<view>`，宽 200–420，默认 248）。
- **收起/展开有过渡**：上下文列不再卸载，收起只是把 `--ctx-f` 从 1 打到 0，
  列宽写成 `calc(var(--ctx-w) * var(--ctx-f))`；`@property --ctx-f` 注册成 `<number>`
  才能插值（不支持时退化成跳变，布局不受影响）。收起期间 `.rail` 带 `inert` + `aria-hidden`，
  搜索词等内部状态也因此不会被收起清空。
- 列宽来源：桌面端由 `splitter.css` 的 `.app`（读 `--panel-w` / `--ctx-w` / `--ctx-f` / `--rail-w`）负责，
  `app.css` 只做兜底和 ≤980px 的单栏。两边数值必须和 `lib/layout.ts` 保持一致。

## 3. 断点分级

目标不是"把右栏改成 overlay"本身，而是**聊天区不被挤死**。实际选择的是纯数值分级 + 窄屏自动收起：
没有引入第二套 overlay 状态机（少一个 `panelVisible` / `drawer === 'panel'` 互斥的隐患点），
策略集中在 `web/src/lib/layout.ts`。

| 视口 | 布局 | 聊天区实际宽度 |
| --- | --- | --- |
| ≥1440 | `56 + 248 + 1fr + 460` | 676px |
| 1180–1439 | `56 + 220 + 1fr + 400` | 504–763px |
| 981–1179 | 同上，但**上下文列默认收起** | 568px（1024 实测） |
| ≤980 | 单列 + 抽屉（模块条在抽屉顶部） | 全宽 |

**宽条 rail 与上下文列在窄屏二选一**：`railExpanded && 视口 < 1440` 时上下文列自动收起
（`useContextHidden()`），否则 1180 处聊天区会掉到 380px 左右。手动点对话图标仍然能强行展开。

- `clampPanelWidth()` 不再按视口比例封顶：最宽拖到「聊天区还剩 340px」为止
  （`PANEL_MIN_CHAT_WIDTH`），再被硬上限 1600 兜住；下限 320。
  `reservedLeft` 把模块 rail 宽窄 + 上下文列当前宽度算进去，
  所以展开宽条 rail / 展开会话列表后右栏会自动回收一点，不会把聊天区挤成 0。
  自动夹取用 `persist=false`，不会主动覆盖上一次手动拖出来的宽度。
- `<1180` 的自动收起是**临时状态**：`contextNarrowOpen` 不落盘，跨断点时重置，
  所以"这次手动展开"不会变成下次启动时的默认。
- `layoutWidth` 由 `App.tsx` 的 resize 监听写进 store，断点判断只有一处。
- 每档断点都要显式写 `.app.view-module` / `.app.ctx-collapsed`，
  否则会漏（类选择器特异性高于媒体查询里的 `.app`）。

### 3.1 移动端模块入口

- 移动端不渲染常驻 `.rail-nav`（56px 在 390px 屏上是 14% 屏宽），改为抽屉顶部的
  `#rail-mods` 一行四个图标 + 文案（`MobileModuleStrip.tsx`），点一下切模块并关抽屉。
- 依旧不做常驻底部 tab bar：底部要留给 composer / safe-area / iOS 自带工具条。
- 预算里的 `env(safe-area-inset-top)` 从 `.rail-head` 挪给了模块条，避免双份留白。

### 3.2 模块切换时不要卸载 ChatPane

SSE 是按 sessionId 订阅的（`store.ts` 的 `connect()` 里 `if (es && subscribedKey === key) return`），
卸载 `ChatPane` 会丢掉滚动位置与 `--head-h/--composer-h` 的测量。模块切换应保持挂载，
不要把「离开对话」当成「结束会话」。

**现状：`view !== 'chat'` 时 ChatPane 仍然是卸载的**。等技能/MCP 真能"边聊边看"时要改成 CSS 隐藏。

## 4. 测试与验证

- `web/scripts/smoke.mjs`（happy-dom，无浏览器，`npm run check:web` 里）：
  搜索命中已归档 / 空态 / 清空、hash 切视图、模块视图卸载与未知 hash 回落、rail 与模块切换、
  定时任务模块（设置里已无该 tab）、MCP 模块（列表 / 测试 / 编辑保存 / 应用到会话 / 二次确认删除）、上下文列拖拽与折叠落盘。还用 `window.happyDOM.setViewport()` **真实驱动 matchMedia 变更**，覆盖
  1024 自动收起 → 手动展开 → 变宽保留 → 再变窄重置，以及 390 移动端（rail 卸载、模块条、设置入口唯一性）。
- `web/scripts/mobile-smoke.mjs`（需要 chromium + 先起 server）：390 抽屉与模块条、1024 窄屏收起、
  1280 / 1440 的聊天区实测宽度、rail 56px。`npm run smoke:mobile`。
- CSS 布局（media query 命中的网格列宽）只能靠浏览器验证；happy-dom 不做布局计算。

## 5. 已知遗留

- **没有做右栏 overlay**：≥981px 时右栏始终是停靠列，只靠宽度夹取让位。若以后 1180 档仍嫌窄，
  再把右栏在 1180–1439 改成 overlay（要同时处理 `panelVisible` / `drawer === 'panel'` / Splitter / 遮罩的互斥）。
- **移动端非对话模块靠顶部模块条返回**：每个模块视图自己渲染 `MobileModuleStrip`（jobs / agents / mcp / skills 都有），移动端 rail 仍然只在对话视图挂载。
- `applyStats()` 里改 `workspaceId` 时没有重算 `worktreeEnabled`（对比 `newChat()` 里的 `worktreePreferred`）。
  跨工作区点开历史会话后，"隔离工作树"的勾选会沿用上一个工作区的偏好，直到点新对话才纠正。
