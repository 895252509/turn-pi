# Workspace 与 Worktree 支持设计（Workspace v1 / Worktree v1 已落地）

> 状态：**Workspace v1、Worktree v1 已实现；merge 仅保留显式操作设计与命令，不自动合并**。
> 结论先行：**不要把 workspace 做成一个全局开关**；按「会话绑定不可变 cwd，workspace 只是 cwd 的注册表条目」来做。
> worktree 则是在 workspace 之上增加一种「物理检出（checkout）」类型，仍然落回同一个会话 cwd 模型。
>
> 当前实现：注册表在 `PI_RUNTIME_DIR/workspaces.json`（默认 `runtime/workspaces.json`）；启动和手动刷新时登记 `PI_WORKSPACE`、`/work`，并合并 `/workspace` 下的一级 git 仓库；工作区菜单也可以登记任意已存在目录，不要求 git。新对话空视图可选 workspace 和「隔离工作树」，会话列表按 workspace 分组，文件 API 支持 `root=<workspaceId|worktreeId>`。目录不存在的 workspace 标记 `available=false`，不能新建会话；`readonly` workspace 禁用 `bash/edit/write`。打开 cwd 不在注册表的历史会话时自动把该目录登记为 workspace。
> worktree 根目录是容器内 `PI_RUNTIME_DIR/worktrees`（默认 `/runtime/worktrees`），新会话 1 worktree : 1 session；宿主机 git/IDE 不参与 worktree 生命周期。
> `git worktree add` 不复制被 ignore 的依赖，`node_modules` 默认符号链接到主工作区（可写共享，安装会被拦），见 [`worktree-deps.md`](worktree-deps.md)。
> 仓库视角的只读总览（当前工作区 / 工作树 / 两层内子仓库 / 手动登记）在中间区：**每个仓库一个 Git tab**，内容是改动文件的目录树，见 [`git-panel.md`](git-panel.md)。

---

## 1. 现状与真正的约束

当前代码里 workspace 是**模块级单例**：

| 位置 | 现状 | 影响 |
|---|---|---|
| `server/chat.ts` | `const WORKSPACE = process.env.PI_WORKSPACE ?? '/workspace'`，创建/打开/ fork 会话、`SessionManager.list/open/findById` 全部写死它 | 所有会话只能同一个 cwd |
| `server/files.ts` | `const ROOT`，`root` 参数只接受 `'workspace'`，`rootReal()` 只缓存一个根 | 右栏文件 API 只能看一个根 |
| `server/index.ts` | `/api/sessions`、`/api/session/open` 不区分 workspace | 打开会话时可能用错 cwd |
| `web/src/lib/panel.ts` | `root` 默认 `'workspace'`，`normalizeWorkspacePath` 只会去掉 `workspace/` 前缀 | 文件 tab / 工具路径映射只认一个根 |
| `docker-compose.yml` | 同时挂了 `/workspace` 和 `/work`，但 `/work` 只是给 agent 用的别名 | README 说支持两个工作区，文件 API 实际只有一个 |

pi SDK 这边有一个关键事实，决定了方案：

- 会话的 cwd 存在 **session 文件 header 的 `cwd` 字段**里；
- `SessionManager.open(path, dir, cwdOverride)` 不传第三个参数时用 header cwd；
- `SessionManager.list(cwd, dir)` / `findById(cwd, id, dir)` 在显式传 `sessionDir` 时，**会按 cwd 过滤**；
- `SessionManager.listAll(sessionDir)` 才是不按 cwd 过滤的全量列表；
- `forkFrom(sourcePath, targetCwd, dir)` 可以带着历史换 cwd。

所以「一个会话一个 cwd」不是我们要不要支持的问题，而是 SDK 已经这样建模。**顺着它做，成本最低；对着它做（中途换 cwd）会到处漏。**

---

## 2. 概念模型

先把三个词定死，后面不再混用：

| 概念 | 定义 | 例子 |
|---|---|---|
| **Workspace** | 一个**逻辑项目根**，是持久化的注册表条目，有稳定 id、显示名、根路径、策略 | `/workspace/turn-pi`、`/work` |
| **Worktree** | 某个 git 仓库的一次**物理检出**，可以是主工作树，也可以是 `git worktree add` 出来的链接工作树 | `/workspace/turn-pi`、`/runtime/worktrees/pi-webchat/wt_abc123` |
| **Session** | 一段对话 + **不可变的 cwd**；cwd 在创建时确定，之后只读 | 一个会话的 cwd = 某个 worktree 路径 |

关系：

```
Workspace 1 ── N Worktree（主树 + 隔离树）
Workspace 1 ── N Session
Worktree  1 ── N Session（默认建议 1:1，见 §5.4）
Session   ── 1 cwd（不可变）
```

三个不变量：

1. **会话 cwd 不可变。** 中途「换 workspace」不是修改 cwd，而是「新会话 / fork 到目标 cwd」。
2. **客户端永远不传绝对路径。** 只传 `rootId + 相对路径`，服务端用注册表解析并做 realpath containment。
3. **workspace 不是安全沙箱。** 它只是 UI / 文件 API / 会话默认 cwd 的组织单位；agent 的 `bash` 仍然能跑出 cwd。真正的隔离靠容器挂载和权限，不能靠 workspace。

---

## 3. Workspace 方案取舍

### 方案 A：全局当前 workspace（切换后所有新会话都进去）

- 实现最小：一个 `currentWorkspace` 变量。
- 但后台会话、正在生成的轮次、文件 tab、fork 都会出现「会话属于 A，界面当前是 B」的歧义。
- 结论：**不采用**。它把「会话属性」误做成「界面状态」。

### 方案 B：会话级 cwd + workspace 注册表（推荐）

- 每个会话创建时从注册表选一个 workspace，cwd 写进 session header。
- 打开历史会话时，**以 session header 的 cwd 为准**，自动把 UI 的 workspace 选择器切过去。
- 文件 API 用 rootId 解析，rootId 可以指向 workspace，也可以指向 worktree。
- 结论：**采用**。改动集中，和 SDK 模型一致，后台会话不受影响。

### 方案 C：虚拟 workspace / 每会话 mount namespace / 容器内 chroot

- 隔离最彻底，但需要容器权限、路径映射、文件 API 与工具 cwd 全链路适配。
- 对当前单用户、本机/内网的定位来说收益不足。
- 结论：v1 不做，留作多租户阶段的选项。

---

## 4. Workspace v1 设计

### 4.1 注册表

新增 `server/workspaces.ts`（或并入未来 `server/config.ts`），负责：

```ts
interface Workspace {
  id: string;            // 稳定 slug：[a-z0-9][a-z0-9._-]*，如 pi-webchat
  label: string;         // 显示名
  root: string;          // 绝对路径，realpath 后保存
  kind: 'dir' | 'git';   // git 只用于 UI/后续 worktree，不要求必须有 .git
  readonly?: boolean;    // 策略提示，不替代文件系统权限
  source: 'config' | 'default';
}

interface WorkspaceRegistry {
  list(): Workspace[];
  get(id: string): Workspace | undefined;
  resolveCwd(cwd: string): Workspace | undefined; // 先精确匹配，再最长前缀
  resolveRoot(id: string): Workspace | undefined; // 'workspace' 作为默认别名
}
```

配置来源建议：

- 保留 `PI_WORKSPACE` 作为**默认 workspace**（兼容现有部署）。
- 新增 `PI_WORKSPACES_FILE`，默认 `runtime/workspaces.json`；首次启动如果不存在，生成：

```json
{
  "workspaces": [
    { "id": "workspace", "label": "工作区", "root": "/workspace" },
    { "id": "pi-agent", "label": "Pi Agent", "root": "/work" }
  ]
}
```

- 默认只扫描 `/workspace` 下的一级 **git 仓库**；`PI_WORKSPACE_DISCOVER=all` 改为一级目录，`none` 关闭自动发现。工作区菜单的 `＋` 可登记任意已存在的绝对路径（不要求 git），刷新按钮走 `POST /api/workspaces/reload`。
- `root` 必须是已存在目录；启动时 `realpath`，不接受 `/`、不接受文件、不接受不存在路径。
- 允许嵌套 workspace（例如 `/workspace` 和 `/workspace/turn-pi`），解析 cwd 时**最长前缀优先**。UI 要提示嵌套关系，避免用户以为内层是独立沙箱。

### 4.2 会话绑定

- 新建会话：请求体带 `workspaceId`（缺省用默认 workspace），`Chat` 用该 workspace 的 `root` 作为 cwd。
- 打开会话：
  1. 先按 sessionId 找 session 文件；
  2. 读 header `cwd`；
  3. `registry.resolveCwd(cwd)` 得到 workspace（worktree 阶段则是 worktree 记录）；
  4. 用该 cwd 调 `SessionManager.open(path, SESSION_DIR)`，**不要再传 `WORKSPACE` 覆盖**。
- 列表：用 `SessionManager.listAll(SESSION_DIR)`，然后给每条补 `cwd`、`workspaceId`、`worktreeId`（如有）、`workspaceLabel`。
- fork：
  - 同 workspace fork：目标 cwd = 源 cwd；
  - 「fork 到另一个 workspace」：`forkFrom(sourcePath, targetCwd, SESSION_DIR)`，这是**唯一**推荐的跨 workspace 迁移方式；
  - 手动按轮 fork 的分支里，新 header 的 `cwd` 必须写目标 cwd，而不是源 header 的 `cwd`。
- rename / favorite / compact 等按 session 操作的能力，都通过 `listAll` 找路径，不再用 `list(WORKSPACE)`。

**不要**做「同一会话中途切 workspace」：工具缓存、系统提示里的 cwd、bash 历史、文件 tab、相对路径都会错位。

### 4.3 文件 API

把「一个 ROOT」改成「root 注册表」：

- `GET /api/files/roots` 返回工作区 + worktree（worktree 阶段），每项：

```json
{
  "id": "turn-pi",
  "label": "Turn Pi",
  "path": "/workspace/turn-pi",
  "kind": "workspace",
  "readonly": true
}
```

- 所有 `/api/files/*` 的 `root` 参数改成 rootId；**`workspace` 作为默认 workspace 的别名继续可用**，避免旧 localStorage 文件 tab 失效。
- 每个 root 单独缓存 `realpath`，并做同样的 containment 检查；`..`、NUL、符号链接逃逸逻辑保持不变。
- 响应里的 `root` 返回请求的 id，而不是固定 `'workspace'`；`absolutePath` 仍是实际路径。
- `files.ts` 里 `parseRoot`、`rootReal`、`fileStat`、`list`、`raw` 都要改成按 root 解析。注意当前 `rootRealPromise` 是模块级单例，必须换掉。

### 4.4 UI

- 左栏顶部加 **workspace 选择器**：只控制「新对话默认进哪个 workspace」，不控制已打开会话。
- 会话列表按 workspace 分组或加 badge；至少要在每项上显示 workspace 名，否则两个同名会话无法区分。
- 打开历史会话时，workspace 选择器自动切到该会话的 workspace；顶部显示 `workspace / cwd`。
- 新对话按钮：在当前选中的 workspace 下创建；若当前会话有未发送内容，先按现有逻辑处理。
- 空会话（还没有第一条消息）允许直接切 workspace：本质是丢弃这个空会话并新建，不需要 mutation。
- 右栏 Files：
  - 文件 tab 打开时绑定 `rootId`，切换会话不改变已打开 tab 的 root；
  - 没有文件 tab 时，文件树默认用当前会话的 workspace；
  - Files tab 工具栏加 root 下拉，用于手动浏览其他注册根；
  - 工具路径点击：按「绝对路径 → 最长匹配 root → 相对路径」映射；映射不到就 toast「不在已注册工作区内」，不要静默打开默认根。
- `normalizeWorkspacePath` 需要升级为 `normalizePathForRoot(rootId, path)` 或先做绝对路径 → `{rootId, rel}` 的解析。旧的 `workspace/` 前缀逻辑保留兼容。

### 4.5 HTTP API

建议新增/调整：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/workspaces` | 注册表列表 + 可选运行时状态（是否存在、是否 git） |
| POST | `/api/workspaces` | 登记任意已存在目录为 workspace（`path`，可选 `label`/`readonly`） |
| POST | `/api/workspaces/reload` | 重新读取注册表并合并自动发现结果 |
| GET | `/api/files/roots` | 文件根列表（workspace + worktree） |
| GET | `/api/sessions?workspaceId=` | 可选过滤；默认全部，返回带 workspaceId |
| POST | `/api/session/open` | 忽略客户端传的 workspace，以 session header cwd 为准 |
| POST | `/api/chat` | 新会话接受 `workspaceId`；已有会话忽略该字段 |
| POST | `/api/session/fork` | 接受可选 `targetWorkspaceId`，走 `forkFrom` |

`/api/session/new` 目前只是空操作。v1 可以继续由前端 `newChat()` 维护，不必改成服务端创建空会话。

### 4.6 安全与边界

- root 注册表是**服务端配置**，不是任意客户端可写；v1 不提供 UI 添加 workspace。
- 文件 API 的每个 root 都做 realpath + containment，不能再出现「先按字符串 startsWith 判断、后 realpath」的顺序问题。
- 允许 `PI_WORKSPACE` 之外的根时，要明确这是运维配置行为；浏览器端只能读注册过的根。
- 再次强调：agent 工具不经过文件 API，workspace 注册表不会限制 `bash` 的写入范围。

### 4.7 迁移

- 现有 session header 的 cwd 都是 `/workspace`，默认 workspace id 保持 `workspace`，可无缝打开。
- 旧 localStorage 里的文件 tab `root=workspace` 继续解析为默认 workspace。
- `PI_WORKSPACE` 仍生效；`PI_WORKSPACES_FILE` 不存在时自动生成单条默认配置，不强迫用户改 compose。
- 如果历史会话的 cwd 已不在注册表：会话仍可打开（工具用 header cwd），但文件 API / workspace badge 显示「未注册」；不要为了「看起来整齐」而偷偷改写历史 header。

---

## 5. Worktree v1 设计（已实现）

### 5.1 为什么用 git worktree，而不是 clone / 切分支

| 方案 | 优点 | 问题 |
|---|---|---|
| `git worktree add`（推荐） | 共享对象库，创建快；主工作树不受影响；可并行跑多个会话 | 需要路径对齐、分支/清理规则 |
| 独立 clone | 隔离彻底 | 磁盘和拉取成本高；与主仓同步麻烦 |
| 同一目录 `git switch` | 实现最简单 | 会打断正在跑的会话，未提交改动互相踩；直接排除 |

结论：**worktree 用 `git worktree`**，但只作为「会话 cwd 的一种来源」，不引入第二套会话模型。

### 5.2 路径不变量：只在容器内使用

git worktree 的元数据（主仓 `.git/worktrees/<name>/gitdir`）记录的是 **worktree 的绝对路径**。当前部署里：

- 宿主机 `/workspace` ↔ 容器 `/workspace`，路径一致；
- 宿主机 `/workspace/pi-agent/workspace` ↔ 容器 `/work`，**路径不一致**；
- 宿主机 `runtime/` ↔ 容器 `/runtime`，路径不一致。

本项目明确 **worktree 只在容器内使用**，因此不再要求宿主机路径一致：

- 默认 `PI_WORKTREE_ROOT=$PI_RUNTIME_DIR/worktrees`（容器内 `/runtime/worktrees`）；
- 不放在 `/workspace` 项目树下，避免污染工作区文件树；
- 宿主机 `git worktree list` 可能看到 `/runtime/...` 不存在，这是预期行为；
- 宿主机不要执行 `git worktree prune`，否则可能清掉容器内 worktree 的元数据；
- 合并分支不依赖 worktree 目录，宿主机仍可直接 merge 分支，但 worktree 的创建/删除只在容器内做。

### 5.3 数据模型与生命周期

```ts
interface Worktree {
  id: string;              // wt_<short id>
  workspaceId: string;     // 逻辑所属 workspace
  path: string;            // 容器内绝对路径
  branch: string;          // refs/heads/pi/<workspaceId>/<short>
  baseRef: string;         // 创建时的起点，如 HEAD
  baseCommit: string;      // 创建时 commit，用于后续判断是否还能快进/合并
  sessionId?: string;      // 新会话 1:1 绑定；fork 例外
  state: 'creating' | 'ready' | 'missing' | 'removing' | 'removed';
  createdAt: string;
  lastUsedAt: string;
}
```

持久化到 `runtime/worktrees.json`，启动时只做对账：

- 记录有、目录在 → `ready`
- 记录有、目录不在 → `missing`（不自动删记录）
- 已删除 → `removed`（保留审计，不出现在列表）
- 不自动接管手工创建的 git worktree，也不自动 `prune`

### 5.4 会话绑定与并发

推荐默认 **1 worktree : 1 session**，当前实现对新会话严格 1:1，fork 是例外：

- 新会话勾选「隔离工作树」时，首次发送才创建 worktree，再以它的路径创建 session；
- session 的 cwd 仍然写 header，重启后靠 cwd 找回 worktree；
- 同一 worktree 已绑定其他 session 时明确拒绝；
- fork 会话默认留在同一 worktree（代码状态一致，但两个会话可能同时写）。如果坚持严格隔离，应新建 worktree；v1 不复制未提交改动。
- 同一 worktree 的并发写风险由“一个 worktree 只绑一个新建会话”控制；fork 出来的会话需要用户自己避免同时生成。

### 5.5 创建 / 删除 / 回收

创建（串行，带锁）：

```bash
git -C <workspace.root> worktree add -b <branch> <worktree.path> <baseRef>
```

- 分支名先过 `git check-ref-format --branch`，并限制在 `pi/` 命名空间；
- 分支已存在时直接报错，不用 `-B` 覆盖；
- baseRef 默认 `HEAD`，可通过 API 传 `baseRef`；
- 创建前检查 `workspace.kind === 'git'`、目标路径不存在、`PI_WORKTREE_ROOT` 可写；
- 命令一律用 `execFile('git', [...])`，不拼 shell，不接收任意路径。

删除：

1. 找到绑定 session；如果 `busy` 拒绝；
2. `git -C <path> status --porcelain`，有未提交改动默认拒绝，除非显式 `force: true`；
3. `git -C <workspace.root> worktree remove <path>`；失败再提示人工处理；
4. 记录标 `removed`，保留审计；不要自动 `worktree prune` 掉用户可能还想恢复的东西。

GC：

- 启动时只做**对账**，不自动删除；
- 进程内定时任务 `worktree-gc` 提供延迟 GC：只回收已归档、无会话占用、干净且超过宽限期的 worktree；默认**干跑**、默认宽限 14 天、单次限量；脏树/打开中的会话/未归档 fork 一律跳过；
- 仍不执行 `git worktree prune`，也不自动删分支；需要时人工确认后执行。

### 5.6 diff / 合并

v1 实现**只读状态**：

- `GET /api/worktrees`：列表、状态、绑定会话；
- `GET /api/worktrees/status?id=`：`git status --porcelain`、`git diff --stat`、base..HEAD 提交数；
- UI 显示分支、工作区、目录缺失状态；删除前检查未提交改动。

合并仍必须是显式动作，当前不自动执行。推荐命令：

```bash
# 在 worktree 内解决冲突并 rebase
git -C <worktree.path> rebase main
# 主工作树干净、没有 busy 会话时快进
git -C <workspace.root> merge --ff-only <branch>
```

self-hosting 项目 merge 到主工作树会触发热加载重启，必须等所有会话 idle。

**绝不做**「agent 自己 merge 回主分支」。这是权限和审计问题，不是功能问题。

### 5.7 Worktree UI

- 新对话入口只有 `kind=git` 且非 readonly 的 workspace 显示「隔离工作树」开关；按 workspace 记忆，默认关闭；
- 首次发送才创建，失败不留下空 worktree；
- 会话头部显示 workspace + branch badge；
- 左栏会话项显示 worktree 分支；
- 左栏底部列出隔离工作树，支持删除（有未提交改动时服务端拒绝）；
- 工作树绑定的会话被归档时，该行显示「会话已归档」标识（归档状态从会话列表现查，归档/恢复后立即更新）；
- 文件树把 worktree 当成一个 root，`rootId = wt_<id>`；切会话时文件 tab 不跳根。

### 5.7.1 工作流程提示

worktree 创建时服务端已经开好分支（`git worktree add -b pi/<workspaceId>/<id>`），但模型仍会
习惯性 `git checkout -b` / `git switch -c`，甚至再嵌套一层 `git worktree add`：分支越积越多、
1 worktree : 1 session 的绑定被绕开、删 worktree 时留下孤儿分支。

实现：`server/worktree-guidance.ts` 一个会话级扩展，在 `before_agent_start` 里判断
**cwd 是否落在已登记 worktree 内**，是就把一段工作流程说明追加到本轮 systemPrompt 末尾；
不是就完全静默（普通会话零影响）。注入块首句是固定标记，本轮已有就不再追加（幂等）。

内容逐会话渲染真实 `path / branch / baseRef` / 主工作区，覆盖：分支已存在；禁止
`checkout -b`、`switch -c`、`branch <name>`、`worktree add|prune`；何时才 commit；
异常脏树先报告不要 checkout/reset；临时文件用 `/tmp`；`node_modules` 是链接所以不在
worktree 里装依赖。worktree 状态不是 `ready` 时额外提示"目录可能缺失，报告而不是重建"。

检查：`npm run check:worktree-guidance`。

已知留白：提示词是软约束，没有 bash 层硬拦截；也还没有会话级开关（策略值由调用方给定）。

---

## 6. 代码落点清单

### Workspace 阶段

| 文件 | 改动 |
|---|---|
| `server/workspaces.ts`（新） | 注册表、配置加载、root 校验、cwd → workspace 解析 |
| `server/chat.ts` | 去掉模块级 `WORKSPACE`；`Chat` 持有 `cwd`；create/open/fork/rename/list 全部按 cwd；`SessionManager.listAll` |
| `server/files.ts` | `ROOT` → registry；`parseRoot` 支持 rootId；每 root 缓存 realpath；响应 root 用 id |
| `server/index.ts` | 新 `/api/workspaces`；`/api/chat` 接收 workspaceId；session/open 以 header cwd 为准 |
| `web/src/lib/store.ts` | `workspaceId` 状态、新会话绑定、打开会话自动切 workspace、sessions 带 workspace |
| `web/src/lib/types.ts` | `WorkspaceSummary`、`SessionSummary.workspaceId/cwd`、文件 root 类型 |
| `web/src/lib/panel.ts` | 多 root 的 path 规范化与 tab 去重 |
| `web/src/components/Sidebar.tsx` | workspace 选择器、会话分组/badge |
| `web/src/components/ChatPane.tsx` | 头部显示 workspace / cwd |
| `web/src/components/files/FilesView.tsx` | root 下拉、按 root 加载 |
| `README.md` / `docs/right-panel.md` | 更新「v1 只有一个根」的旧描述 |

### Worktree 阶段

| 文件 | 改动 |
|---|---|
| `server/worktrees.ts`（新） | git worktree 创建/删除/对账/状态；1:1 绑定；串行锁 |
| `server/index.ts` | `/api/worktrees`、`/api/worktrees/status`、`/api/worktrees/remove`；`/api/chat` 接收 worktree |
| `server/chat.ts` | worktree 会话创建、cwd 反查、session 绑定、fork 保持 cwd |
| `server/files.ts` | worktree 作为文件 root |
| `web/src/...` | 隔离开关、worktree badge、侧栏管理、diff 状态 |
| `scripts/` | 可选：worktree 对账/清理 CLI，便于运维而不是只靠 UI |

---

## 7. 测试矩阵

Workspace：

- 两个 workspace 各建会话，列表/打开/fork/rename 不串 cwd；
- 打开旧会话时，session header cwd 覆盖客户端传入的 workspace；
- 嵌套 workspace（`/workspace` 与 `/workspace/turn-pi`）解析到最长前缀；
- `SessionManager.listAll(SESSION_DIR)` 能列出所有 cwd 的会话，`list` 不会漏；
- 文件 API：合法 root、未知 root、`..`、NUL、绝对路径、符号链接逃逸、跨 root symlink；
- 旧 `root=workspace` 的 localStorage 文件 tab 仍能打开；
- 重启后 workspace 配置、会话列表、文件根全部恢复；
- agent 在 A workspace 会话里点击 B workspace 的文件路径 → 映射失败提示，而不是打开错误文件。

Worktree：

- 在干净/脏主工作树上创建 worktree 都成功，主树不受影响；
- 并发创建同名分支：一个成功，另一个明确报错，不产生半成品；
- 分支已存在、baseRef 不存在、目标路径已存在、非 git 仓库；
- 容器内创建后，容器内 `git worktree list` 能识别，路径为 `/runtime/...`；宿主机不要求识别
- 删除有未提交改动 → 拒绝；`force` 后才删除；
- 删除时绑定的会话 busy → 拒绝；
- 重启后记录与目录对账正确（ready/missing/removed）；
- 同一 worktree 已绑定会话时再新建会话 → 明确拒绝；
- worktree 会话的 fork / 文件树 / 工具路径映射。

---

## 8. 实施顺序

1. **Workspace 配置与注册表**：只读、默认单条，先不接 UI。
2. **Chat cwd 改造**：会话创建/打开/列表/fork/rename 全部去 `WORKSPACE` 单例；这是风险最高的一步，先补回归测试。
3. **文件 API 多 root**：`root=workspace` 别名兼容。
4. **前端 workspace 选择器与会话分组**：空会话可切，历史会话自动跟随。
5. **文件 tab 多 root**：路径映射、root 下拉、旧 tab 迁移。
6. **文档与部署**：`PI_WORKSPACES_FILE`、`/work` 的真实行为、迁移说明。
7. **Worktree 只读生命周期**：创建/列表/删除/对账，先不做合并。
8. **Worktree 会话绑定**：首次发送创建、cwd 反查、1:1 绑定。
9. **diff / 合并预检**（可选，独立评审）。

每一步都应该能单独上线；不要一次性把 workspace 和 worktree 混在一个 PR 里。

---

## 9. 待确认的问题

1. **workspace 是否需要 UI 添加？**
   建议 v1 只读配置文件；如果要从 UI 加，必须限制在 `PI_WORKSPACE_ROOTS` 允许的父目录内，并做 realpath 校验。
2. **`/work` 和 `/workspace` 是同一棵树的别名，还是两个独立 workspace？**
   当前 compose 里 `/work` 指向 `/workspace/pi-agent/workspace`，是 `/workspace` 的子目录。注册成嵌套 workspace 可以，但要在 UI 明确提示「不是隔离环境」。
3. **默认是否把所有 `/workspace/*` 项目自动注册？**
   建议不自动。自动注册会让选择器不可控，也让「新建会话」的默认值不稳定。
4. **fork 到另一个 workspace 是否允许？**
   技术上 `forkFrom` 支持，建议允许，但 UI 明确写「会换 cwd，旧路径可能失效」。
5. **worktree 是否严格 1:1 会话？**
   已实现：新会话 1:1；fork 默认共享同一 worktree，作为已知例外。若要 fork 也隔离，应新建 worktree，而不是复制未提交改动。
6. **worktree 放在项目仓库内还是仓库外？**
   已定：容器内 `PI_RUNTIME_DIR/worktrees`，不要求宿主机路径一致；宿主机不管理 worktree 生命周期。
7. **是否自动合并？**
   建议永远不自动。只提供 diff、状态和显式合并命令；当前 v1 未实现 merge API。

---

## 10. 一句话版本

- **Workspace v1**：注册表 + 会话 cwd 不可变 + 文件 API 多 root + 左栏选择器；先做「会话各自属于哪个 workspace」，不做「全局切换」。
- **Worktree v1**：在 workspace 上增加 `git worktree` 物理检出，容器内 `/runtime/worktrees`，新会话 1 worktree : 1 session，删除/合并都要显式确认；不自动 merge、不自动 prune。
- 最大的两个坑：`SessionManager.list(cwd, dir)` 会按 cwd 过滤；`SessionManager.open(..., WORKSPACE)` 会覆盖 header cwd。改造时先把这两处拆掉。
