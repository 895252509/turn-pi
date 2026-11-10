# 轮末文件卡片（agent 主动汇报）

> 状态：**P0 已落地**（`report_files` 工具 + sidecar + 轮末卡片 + `pi-resource://` 解析）；P1/P2 仍为设计。
> 范围：**只讨论“收集文件 + 卡片展示 + 点击打开”；不做自动采集、不做 git 快照、不做 diff。**
> 统一文件资源 URL 仍然是独立需求，照旧保留（第 7 节）。
> 参考实现：`deepseek-harness` 容器内 `/app`（dsh `0.2.1-rc.2`）
> 目标读者：接手的工程师

**目录**：[0. 结论](#0-结论) · [1. 为什么只取 present](#1-为什么只取-present) · [2. 我们已有什么](#2-我们已有什么) · [3. 工具设计](#3-工具设计) · [4. 服务端](#4-服务端) · [5. 事件与持久化](#5-事件与持久化) · [6. 前端卡片](#6-前端卡片) · [7. 全局文件资源内部 URL](#7-全局文件资源内部-url) · [8. 实施顺序](#8-实施顺序) · [9. 测试](#9-测试) · [10. 风险与边界](#10-风险与边界)

---

## 0. 结论

**能实现，而且规模比 dsh 小一个数量级。**

最终形态：

1. 给 agent 一个自定义工具 `report_files({ files: [{ path, description?, change?, importance?, line? }] })`；
2. agent 在**觉得用户会想看**的时候主动调用它“汇报”——不是每轮必调，也不要求每轮都有产出；
3. 服务端校验路径、记录到会话 sidecar、通过 SSE 推给前端；
4. 前端在该轮对话下方渲染卡片，按 `importance` 排序/筛选，点击在右侧文件面板打开；
5. 刷新/重启后从 sidecar 还原卡片。

不做的部分（明确决策）：

- 不记录 git 快照，不自动推断“这一轮改了哪些文件”；
- 不生成/展示 diff；
- 不做 hover diff 预览、review tab；
- 不解析正文里的路径自动变成卡片（P2 可选，另说）。

代价：卡片是否出现、内容是否准确，完全取决于 agent 是否调用工具、报得对不对。用工具描述 + `promptGuidelines` + 系统提示词里的简短约定来约束；再叠加 `importance` 分级，让“报多了”不至于淹没主要产出。

收益：不碰 git，不扫工作区，不会把用户手动改的文件算进来，也不需要 `maxFiles` / `maxFileBytes` / `numstat` 这些机制。P0 估计 **0.5–1 个工作日**。

---

## 1. 为什么只取 present

dsh 的 `deliverables` 家族其实有两个独立产品：

| dsh 能力 | 是否采用 | 原因 |
|---|---|---|
| `tool-present`：模型主动声明交付文件 | ✅ 采用 | 正好对应“agent 主动汇报” |
| `workspace-changes`：git 快照自动采集每轮改动 | ❌ 不采用 | 引入 git 成本、误报（用户手改）、diff/review tab 一大套 UI |
| `ui-deliverables` 的 changed-files 卡片 | ❌ 不采用 | 与自动采集绑定 |
| `ui-deliverables` 的 present 卡片 | ✅ 采用（简化版） | 单文件一行 / 多文件网格、点击打开 |
| `dsh-resource://file/...` 地址 | ✅ 采用（改前缀） | 解决卡片、正文、工具行、刷新后的统一寻址 |
| `changes-review` diff tab | ❌ 不采用 | 用户明确不做 diff |

dsh 的 `present` 行为（`packages/deliverables/tool-present`）：

- 入参 `files: [{ path, description? }]`，默认每次最多 8 个；
- 只校验“是普通文件”，不复制内容；
- 相对路径按会话 cwd 解析，绝对路径可以在 cwd 外；
- 成功后追加 `deliverables/presented` 事件；
- 结果文本是每个文件一行 `Presented <path>`。

我们照这个形状做，但加上 `change`（新建/修改）和 `line`（打开定位），并持久化。

---

## 2. 我们已有什么

| 位置 | 现状 |
|---|---|
| `server/chat.ts` `Chat.init()` | `customTools: [recordMethod, credList, credUse]`，加一个工具是现成模式 |
| `server/chat.ts` `forward()` | 工具事件已经通过 `this.emit` → SSE fanout |
| `server/index.ts` `wire()` | 统一把 Chat 事件 fanout 到 clientId 和 pi sessionId |
| `server/chat.ts` `historyPage()` | 按 user message 分页；`stats.turns = userMessages` 与前端“第 N 轮”一致 |
| `server/files.ts` | 只读文件 API，root 为 workspace/worktree id，realpath + containment |
| `server/chat.ts` `findSessionInfo()` | 可按 session id 找会话文件（含 cwd） |
| `web/src/lib/store.ts` `openFile()` | 已有 `(root, path, line)` → 右栏文件 tab |
| `web/src/lib/panel.ts` | `PanelTab` 已有 `file` kind、`nav`、`line` |
| `web/src/components/MessageList.tsx` `TurnBlock` | 轮尾部已有统计条位置，可直接插卡片 |
| `web/src/lib/markdown.ts` | 已有 `resolveFile` / `resolveImage` 钩子 |
| 会话持久化 | `./sessions` JSONL + sidecar 先例（favorites / archive） |

一句话：**工具、轮次、文件读取、右栏打开、持久化模式全都现成**，缺的只是“声明 → 记录 → 展示”这一层。

---

## 3. 工具设计

### 3.1 名字与 schema

```ts
{
  name: 'report_files',
  label: 'Report files',
  description:
    'Optionally report files you created or modified so the user can open them from a card. ' +
    'There is no obligation to call this every turn: skip conversational turns and turns with nothing useful to open. ' +
    'A reported file does not have to be a final deliverable; report it when the user would want to open it. ' +
    'Never report files you only read.',
  promptSnippet: 'optionally report created or modified files as cards (not required every turn)',
  promptGuidelines: [
    'Call report_files only when you created or modified files the user may want to open; skip it for conversational turns, pure analysis, or when no file matters.',
    'Do not force a report: a turn with no meaningful file output needs no card, and one most important file is enough when that is all that matters.',
    'Use importance to say how much each file matters: "high" for the main deliverable, "normal" for supporting changes, "low" for incidental or scratch files.',
    'Use paths relative to the session working directory; absolute paths inside it are also accepted.',
    'Do not report files you only read, commands you ran, or unrelated repository churn.',
    'Set change to "created" or "modified" when you know it; set line when the user should land on a specific line.',
  ],
  parameters: Type.Object({
    files: Type.Array(
      Type.Object({
        path: Type.String({ description: 'Relative to the session cwd, or an absolute path inside it' }),
        description: Type.Optional(Type.String({ description: 'One short line shown under the filename' })),
        change: Type.Optional(Type.Union([
          Type.Literal('created'),
          Type.Literal('modified'),
        ])),
        importance: Type.Optional(Type.Union([
          Type.Literal('high'),
          Type.Literal('normal'),
          Type.Literal('low'),
        ], {
          description: 'high = main deliverable, normal = supporting change, low = incidental/scratch; defaults to normal',
        })),
        line: Type.Optional(Type.Number({ description: '1-based line to open at' })),
      }),
      { maxItems: 8 },
    ),
  }),
}
```

备选名：`present_files` / `present`（dsh 同名）。推荐 `report_files`，语义更贴近“汇报”，也避免和以后可能的“导出/下载”混淆。

### 3.2 校验

在 `execute` 里：

1. `path` 去空白，不能为空、不能含 NUL；
2. 解析：相对路径按 `this.cwd` 拼；绝对路径必须落在 `this.cwd` 内（v1；要放开到其他 root 再改）；
3. `lstat` + `realpath`：
   - 不存在 → 该条报错；
   - 目录 → 报错（提示用具体文件）；
   - 最终符号链接 → 报错（避免指向 cwd 外）；
   - 超过 8 个 → 报错；
4. 去重：同一路径保留最后一次（后出现的覆盖前面的 description/change/importance/line）；
5. `importance` 缺省为 `normal`；非法值按 `normal` 处理（不因为一个枚举写错丢掉整个文件）；
6. 只要有合法文件就成功；非法条目在结果文本里逐条说明，不整体失败（也可以选择整体失败，见 3.4）。

### 3.3 成功结果

```
Reported 3 files:
- server/chat.ts (modified, high)
- docs/file-cards.md (created, normal)
- web/src/lib/fileRef.ts (created, low)
```

不复制内容，不读文件内容，只做 `stat`。

### 3.4 失败策略

推荐**部分成功**：合法文件照常入卡，非法条目在工具结果里返回 `path: reason` 列表。理由：agent 经常一次报多个文件，其中一个路径写错不应让整张卡片消失。若后续觉得模型会滥用，再改成“有任一非法就整体失败”。

---

## 4. 服务端

### 4.1 新增 `server/file-report.ts`（或直接放 `chat.ts`）

```ts
export interface ReportedFile {
  /** 相对会话 cwd 的路径 */
  path: string;
  /** 展示名：basename 或相对路径 */
  display: string;
  description?: string;
  change?: 'created' | 'modified';
  importance: 'high' | 'normal' | 'low';
  line?: number;
  /** 全局引用地址，见第 7 节 */
  address: string;
}

export interface TurnFiles {
  turn: number;
  cwd: string;
  files: ReportedFile[];
  updatedAt: number;
}
```

职责：

- `normalizeReported(chat, raw)`：解析 + 校验 + 生成 `address`；
- `mergeTurnFiles(existing, incoming)`：按 `path` 合并，后到覆盖先到；
- sidecar 读写（见第 5 节）。

### 4.2 在 `Chat.init()` 注册

```ts
const reportFiles = { …schema…, async execute(toolCallId, params) {
  const result = await normalizeReported(this, params.files ?? []);
  const turn = this.session.getSessionStats?.().userMessages ?? this.turnCount;
  const payload = { turn, callId: toolCallId, files: result.files, rejected: result.rejected };
  if (result.files.length) {
    this.emit('presented', payload);
    await appendReportedFiles(this.sessionId, payload);
  }
  return { content: [{ type: 'text', text: renderReportText(payload) }] };
}};
```

加入 `customTools`，并把 `'report_files'` 加进 `desiredTools`，避免被 workspace allowlist 过滤（`cred_list` / `cred_use` 已有先例）。

### 4.3 轮次号

- `this.session.getSessionStats().userMessages` 就是当前轮（用户消息已落盘）；
- 与前端 `stats.turns` / “第 N 轮”一致；
- 同一轮多次调用 → 同一 `turn`，sidecar 里合并。

---

## 5. 事件与持久化

### 5.1 SSE 事件

```ts
// server/index.ts wire()
chat.on('presented', (payload) => fanout(chat, 'presented', payload));
```

payload：

```ts
{
  turn: number;
  callId: string;
  cwd?: string;
  files: ReportedFile[];
  rejected: { path: string; reason: string }[];
}
```

前端收到后挂到当前轮；`rejected` 可以在卡片里显示一行小警告，或只写进工具结果（推荐后者，卡片保持干净）。

### 5.2 sidecar

```
./sessions/.presented/<sessionId>.json
{
  "turns": {
    "3": { "turn": 3, "cwd": "/workspace/turn-pi", "files": [ … ], "updatedAt": 1760000000000 }
  }
}
```

- 与 `favoritesPath()` / `archivePath()` 同样的编码规则（sessionId 过滤 `[^A-Za-z0-9._-]` → `_`）；
- 原子写：写 `.tmp` 再 `rename`；
- 只保留最近 50 轮；
- 会话删除/归档时不必特殊处理，按 id 查找即可。

### 5.3 历史接口

`GET /api/session` 和 `GET /api/session/history` 的响应增加：

```ts
presentedByTurn: { [turn: number]: TurnFiles }
```

当前实现直接返回整个 sidecar（最多 50 轮，量很小）；若以后轮次变大，再按 `historyMeta.start/end` 裁剪。

### 5.4 前端合并顺序

两种顺序都要处理：

1. **实时**：`presented` 先到，当前轮 `TurnItem` 还没有 `stats.turns` → 挂到“最后一条 turn”，同时记住 `turn`；
2. **重绘**：`settled` 后 `refreshCurrent()` 用历史重画 → `historyToItems` 从 `presentedByTurn` 挂载；
3. **工具调用晚于 settled**（理论上不会，但重连/丢包可能）：`presented` 到达时如果 `turn` 与历史里某一轮匹配，按 `turn` 挂；否则暂存到 `pendingPresented`，下次重绘时消费。

---

## 6. 前端卡片

### 6.1 数据

`web/src/lib/types.ts`：

```ts
export interface ReportedFile { path; display; description?; change?; importance; line?; address }
export interface TurnFiles { turn; cwd; files: ReportedFile[]; updatedAt }
```

`Item` 的 turn 变体增加 `files?: TurnFiles`。

### 6.2 组件

新增 `web/src/components/deliverables/ReportedFilesCard.tsx`，插在 `TurnBlock` 的 `parts` 之后、`turn-stats` 之前：

```
┌──────────────────────────────────────────────┐
│ 📄 汇报了 3 个文件                            │  ← 多文件头部
├──────────────────────┬───────────────────────┤
│ server/chat.ts  修改  │ docs/file-cards.md 新建│
│ web/src/lib/fileRef.ts│ web/src/lib/types.ts  │
│ … 还有 2 个文件        │                       │  ← 超过 4 个折叠
└──────────────────────┴───────────────────────┘
```

单文件：

```
┌──────────────────────────────────────────────┐
│ 📄 docs/file-cards.md            新建         │
│    设计稿：文件卡片（agent 主动汇报）          │  ← description
└──────────────────────────────────────────────┘
```

规则：

- 多文件：头部显示数量；2 列网格（≤980px 单列）；每个格子显示 `display` + `修改/新建` + 行号引用（有 `line` 时）；
- 单文件：不渲染列表，头部直接显示 basename + 状态 + description；
- 超过 4 个折叠（2 列时是 2 行），展开后可从底部收起（和 dsh 一致）；
- 卡片只在 `files.length > 0` 时渲染；
- `streaming` 中也渲染（agent 汇报完就能看到），不要求等 `settled`；
- 每行右侧有下载按钮（悬停/聚焦加深，触屏常显），走 `/api/files/raw?ref=…&download=1`；单文件在头部右侧也有一个；
- 每行 `aria-label` / `title` 用完整路径；
- 点击行 → `openAddress(file.address)`（第 7 节），右栏打开并定位 `line`；
- 卡片本身没有关闭按钮；文件被删除后点击由右栏的 404 处理。

### 6.3 重要度与筛选

每个文件带一个 `importance`，默认 `normal`：

| 值 | 含义 | 默认展示 | 视觉 |
|---|---|---|---|
| `high` | 本轮主要交付 | 是，排最前 | 图标着色 + 字重 500（不用左竖线，避免多文件时像一排括号） |
| `normal` | 有价值的配套改动 | 是 | 常规 |
| `low` | 顺带产物 / 临时文件 | 折叠到「N 个次要文件」 | 文字降一档、图标灰 |

- 卡片内排序：`high` → `normal` → `low`，同档按 `display`；
- `low` 默认不占列表位置，底部一行「还有 N 个次要文件」可展开；展开后仍可点击；
- 只有 `low` 时，卡片仍渲染头部 + 折叠行，避免“明明汇报了却什么都看不到”；
- 通用设置加两项（localStorage + store）：
  - `fileCards.enabled`（默认开）：关掉后整张卡片不渲染；
  - `fileCards.minImportance`：`low` / `normal` / `high`，默认 `normal`；设为 `high` 时只显示主要交付，`low` 与 `normal` 都隐藏；
- 服务端不过滤，全部下发给前端，筛选只发生在展示层（切换设置即时生效，无需重取）。

### 6.4 样式

复用现有「历史摘要条 / 工具行」的视觉语言：

- 卡片圆角、边框、背景用 `var(--panel)` / `var(--line)` / `var(--bg)`；
- 新增/修改用两档低饱和色（例如 `var(--ok)` / `var(--warn)` 的 12% 背景），不引入新色板；
- 图标用 `lucide-react` 的 `FileText` / `FilePlus` / `FilePen`，与右栏文件树保持一致。

### 6.5 不做的 UI

- 不做 hover 预览；
- 不做点击展开 diff；
- 不做 review tab；
- 不做“在默认应用中打开”（P2）。

---

## 7. 全局文件资源内部 URL

即使不做 diff，统一地址仍然值得做：卡片、Markdown 正文、工具行、刷新后都需要把“某个文件”变成一个可点击目标，而不是各自拼 `(root, path)`。

### 7.1 语法

```
pi-resource://file/session/<sessionId>/<path>[#L<n>]
pi-resource://file/absolute/<path>[#L<n>]
```

示例：

```
pi-resource://file/session/01J8Z.../server/chat.ts#L1254
pi-resource://file/session/01J8Z.../docs/%E8%AE%BE%E8%AE%A1%20v2.md
pi-resource://file/absolute/tmp/report.pdf
```

规则：

- 每个 `sessionId` / path segment 单独 `encodeURIComponent`；`:` 保持字面量（Windows 盘符）；
- 反斜杠统一 `/`，去掉开头 `./`；
- `session` 作用域的 path 是相对 cwd 的路径（v1 只接受 cwd 内）；
- `absolute` 作用域不带 Session（v1 默认只允许落在已注册 root 内，或先不开放）；
- `#L24` 只用于导航，**不进入 tab 身份**；同一文件不同行复用同一个 tab；
- NUL / 控制字符拒绝；`..` 解析时消解，逃出 root 直接拒绝。

### 7.2 两端模块

```
server/file-ref.ts        # format / parse / resolve
web/src/lib/fileRef.ts    # format / parse（无 Node 依赖）
```

```ts
formatFileRef({ sessionId, path, line? }) -> string
parseFileRef(address) -> { sessionId, path, line? } | null
```

解析失败返回 `null`，调用方按普通文本渲染，不抛错。

### 7.3 服务端解析

新增 `GET /api/files/resolve?ref=<urlencoded>`：

1. 解析 address；
2. `session` 作用域：
   - 优先 `ChatRegistry.find(sessionId)` 拿活 Chat 的 `cwd` / `worktreeId` / `workspaceId`；
   - 否则 `findSessionInfo(sessionId)` 读会话 header 的 `cwd`；
3. 绝对路径在 cwd 下 → 转相对；不在 → 403（v1）；
4. `realpath` + containment（复用 `server/files.ts` 的 `within()`）；
5. 返回 `{ root, path, absolutePath, display, address, line? }`。

`read / stat / raw / list` 接受 `ref` 作为 `root + path` 的替代参数，内部先 resolve 再走原有分支。这样内容 URL 也是全局的：

```
/api/files/raw?ref=pi-resource%3A%2F%2Ffile%2Fsession%2F...%23L24
```

### 7.4 客户端使用点

| 场景 | 用法 |
|---|---|
| 文件卡片 | 服务端直接返回 `address`，点击 `openAddress(address)` |
| 右栏文件树 | 仍走 `openFile(root, path)`；可在 `nav` 里记录 address 便于复制 |
| Markdown 链接 | `resolveFileRef(href)` 返回 address；渲染成 `<a data-file-ref="…">`，点击 `openAddress` |
| Markdown 图片 | `resolveImage(src)` → `/api/files/raw?ref=…`（`<img src>` 不能用自定义 scheme） |
| 工具行路径 | P2：`HistoryTool.path/line` 填好后渲染成可点击 address |

`store.openAddress(address)`：

```ts
async openAddress(address) {
  // 统一走服务端：session 作用域要按会话 cwd 解析，跨会话/刷新后也一样
  const resolved = await api(`/api/files/resolve?ref=${encodeURIComponent(address)}`);
  get().openFile(resolved.path, { root: resolved.root, line: resolved.line });
}
```

### 7.5 安全

- `pi-resource://` 永远不写进真实 `href` / `src`，只用 `data-*` + click handler；
- 服务端 `realpath` + containment；
- `session` 作用域只能读该 Session cwd 所属 root 内的文件；
- `absolute` 作用域默认只允许已注册 root；
- `report_files` 复用同一个 resolver，不另写路径校验。

---

## 8. 实施顺序

### P0（本次范围）

1. `server/file-ref.ts` + `web/src/lib/fileRef.ts` + 单测（编码/解析/行号）。
2. `server/files.ts`：`resolve` 接口 + `ref` 参数。
3. `Chat.init()` 注册 `report_files`；校验、emit、sidecar。
4. `server/index.ts`：`presented` fanout；`/api/session`、`/api/session/history` 返回 `presentedByTurn`。
5. `web/src/lib/types.ts` + `store.ts`：`TurnFiles`、SSE、`openAddress`、历史挂载。
6. `ReportedFilesCard.tsx` + 插入 `TurnBlock`。
7. Markdown 的 `resolveFile` / `resolveImage` 接 address。

### P1（可选）

- 工具行路径可点击；
- 正文 inline-code 文件提及自动链接（只在“已汇报文件”里精确匹配）；
- 卡片支持“全部展开 / 复制路径”。

### P2（明确不做）

- 自动采集 / git 快照；
- diff / review tab / hover 预览；
- 任意绝对路径读取；
- 原生“用默认应用打开”。

---

## 9. 测试

**单元**

- `fileRef` round-trip：中文、空格、`#`、`?`、`%`、`..`、Windows 盘符、NUL；
- `report_files` 校验：缺失、目录、符号链接、cwd 外、超过 8 个、重复路径合并；
- sidecar 合并/裁剪/原子写。

**集成**

- 一轮里调用一次 → 卡片出现、点击打开正确文件并定位行；
- 不调用工具 → 该轮没有卡片；
- `files: []` → 当作 no-op，不产生卡片；
- `importance` 分级 → 默认 `low` 折叠；`minImportance=high` 时只显示 `high`；
- `fileCards.enabled=false` → 卡片不渲染，右栏现有文件不受影响；
- 一轮里调用两次 → 同一轮合并，后到的 description 覆盖；
- 部分非法 → 合法文件入卡，工具结果列出拒绝原因；
- 刷新 → 卡片从 `presentedByTurn` 还原；
- 跨会话地址 → `/api/files/resolve` 后打开；
- Markdown 相对链接 / 图片 → address / raw ref。

**Web smoke**

- 单文件 / 多文件 / 折叠 / 展开；
- 生成中调用 → 卡片即时出现，settle 后不重复；
- 文件被删除后点击 → 右栏 404，不崩；
- 深色/浅色主题下卡片颜色正常。

---

## 10. 风险与边界

| 风险 | 处理 |
|---|---|
| agent 忘记调用工具 → 没有卡片 | 工具描述 + `promptGuidelines` + 系统提示词一段短约定；这是产品取舍，接受 |
| agent 过度汇报 / 把噪音文件也报上来 | `importance` 分级 + 默认只突出 high/normal；`low` 折叠；工具描述明确“不要求每轮都报” |
| agent 报错路径 / 报不存在的文件 | 逐条校验，非法条目拒绝并回显原因 |
| agent 把只读过的文件也报进来 | 工具描述明确“只报创建/修改的文件”；卡片不做二次判断 |
| 符号链接逃逸 | `lstat` 拒绝最终符号链接 + `realpath` containment |
| 同一轮多次调用 | 按 `path` 合并，后到覆盖 |
| 轮次号对不上 | 统一用 `session.getSessionStats().userMessages`，与 `stats.turns` 同源 |
| sidecar 无限增长 | 只保留最近 50 轮，原子写 |
| 地址进 `href` 导致浏览器报错 | 只用 `data-file-ref` + click handler |
| 卡片和工具行重复 | v1 只渲染卡片；工具行仍是普通工具行，不额外展开 |

---

## 附：dsh 源码索引（容器内）

- `packages/deliverables/tool-present/` — `present` 工具（schema、校验、事件）
- `packages/client/ui-deliverables/` — present 卡片、单/多文件布局、折叠
- `packages/util/workspace-path/src/file-address.ts` — `dsh-resource://file/...` 语法
- `packages/client/ui-chat/src/client/apply.ts` — `openFile` → `fileAddressFor` → `sidebarRight.openResource`
- `docs/subsystems/deliverables.md` — 词汇与事件（我们只取 `PresentedFile` 部分）
