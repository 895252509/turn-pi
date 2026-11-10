# Git tabs（对话标题栏：每个仓库一个 tab）

> 状态：**已实现**。中间对话区标题下是 `对话 / 轨迹 / <仓库…> / ＋`：
> 只有当前 workspace 是 git 仓库（`kind === 'git'`）时才出现仓库 tab，**一个仓库一个 tab**。
> 关联：`server/git.ts`（API + 扫描）、`web/src/components/GitRepoView.tsx`、
> `web/src/components/GitAddView.tsx`、`docs/workspace-and-worktree.md`。

## 1. 为什么加这个 tab

会话实际改的是**磁盘上的仓库**，但界面上只有文件树和会话列表：
在 `libs/a`、`packages/b` 这类多仓库工作区里，agent 改了哪个仓库、有没有脏文件、
当前在哪个分支，都得靠 `bash git status` 自己问。这个 tab 把「本工作区有哪些仓库、
各自什么状态」摊开，省掉一轮工具调用。

## 2. 数据来源（每个仓库一个 tab）

| 来源 | `source` | 说明 |
|---|---|---|
| 工作区根 | `root` | `workspace.root` 自己就是 git 仓库时出现，排第一 |
| 当前工作树 | `worktree` | 会话跑在隔离 worktree 里时出现，路径在 workspace 外，来自注册表而非用户输入 |
| 手动登记 | `manual` | 用户在面板里添加的子目录仓库，持久化在运行态 |
| 自动发现 | `scanned` | 从工作区根往下扫 **2 层**目录，命中 `.git` 就算 |

去重按 `realpath`：同一仓库同时来自手动和扫描时，只保留一条，手动优先。
仓库 tab 按同一顺序排列；tab 条横向滚动（单个 tab 宽度封顶），太多了也不挤标题栏。
有未提交改动的仓库 tab 带一个小黄点。没有单独的「Git」总 tab——点仓库 tab 直接进内容。

**会话跑在隔离工作树里时只显示一条 tab**：就是那条工作树分支（主仓库、扫描/登记的子仓库都隐藏，
「＋」登记按钮也隐藏，因为登记的是工作区根的子目录）。理由：这时候 agent 改的是工作树里的那份仓库，
主仓库和其他子仓库跟这次会话无关，列出来只是噪音。

每个 tab 的内容（`GitRepoView`）**默认就是提交记录树**，没有二级 tab：

**分支列表（最左，208px）**

- 分组：`全部提交` / `本地分支` / `远端分支`（每个远端一组：`origin`、`upstream`…，远端可能不止一个）；
  本地按最近提交排、当前分支置顶并带对勾；行尾是 `↑领先 / ↓落后` 小标记，`title` 里带短 sha 与提交摘要；
- 远端分组默认折叠（云端仓库动辄几十条）；单个远端也保留分组标题，避免和本地分支混淆；
- 点一条分支 = 只看这条 ref 的提交（`git log <ref> --topo-order`），列表顶部出现「只看 xxx · 全部」，
  再点一次或点「全部提交」取消过滤；
- 分支数据来自 `git for-each-ref refs/heads refs/remotes`，只读、不建分支、不切分支。

**列表（中）**

- 头部：仓库名 / 来源 / 路径 / 分支（+ ahead/behind）/ 刷新；
- 有未提交改动时，列表顶部先有一条伪提交「未提交改动 · N 项」；
- 下面就是**分支泳道图**（`GitGraph`）：左边是 dot + 竖线/斜线，右边是 ref 徽标
  （`HEAD` / 分支 / 远端 / tag）、提交摘要、短 sha、作者、相对时间——IDE Git Graph 那种；
- 布局在服务端算（`layoutGraph`）：按 `git log --all --topo-order` 的顺序走一遍，
  记下每条泳道在等哪个父提交，得到每行的 `lane`（dot 泳道）、`top`（上方是否有线）、
  `through`（直接穿过的竖线）、`incoming`（别的泳道汇入）、`outgoing`（到父提交的连线）；
- `--topo-order` 是硬要求：父提交必须排在子提交之后，否则泳道会错位（同一秒的提交也不会乱）；
- 默认取 `--all` 最近 200 条（上限 500），更多时提示「只显示最近 N 条」；
- 进仓库 tab 就拉 `git log`（默认视图），切到别的仓库 tab 再回来会重新拉。

**详情（右，点一条提交才出现，列表变成两列）**

- 上块：ref 徽标、提交标题、多行正文、完整 sha、作者 `<邮箱>`、时间、父提交；
- 下块：这次提交改动的文件（相对**第一个父提交**算，合并提交也一样），
  `A/M/D` 标记 + 路径 + `+增/−删`；点文件打开现有内容预览（删除的文件只提示）；
  文件行数统计来自 `git diff --numstat`，`--no-renames` 保证文件名能对齐（重命名拆成 A+D）；
- 点列表顶部的「未提交改动」，右栏换成工作区改动：上块是分支/HEAD 概览，
  下块是**改动文件的目录树**（目录可折叠、目录行带改动数、`M/A/D/R/U` 标记），
  改动清单服务端最多给 2000 条（`MAX_CHANGES`），超出时页面会提示。

`＋` tab（`GitAddView`）负责手动登记子目录仓库，并列出/移除已登记的条目。

## 3. API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/git/repos?root=<workspaceId\|worktreeId>&worktree=<wtId>&refresh=1` | 仓库清单 + 只读状态；`refresh=1` 跳过扫描缓存 |
| POST | `/api/git/repos?root=…` `{ path }` | 手动登记子目录仓库，返回最新清单 |
| POST | `/api/git/repos/remove?root=…` `{ path }` | 只删手动登记，不动目录 |
| GET | `/api/git/log?root=…&worktree=…&rel=<仓库相对路径>&limit=200` | 单仓库提交记录 + 泳道布局；`rel` 同样做 realpath containment |
| GET | `/api/git/commit?root=…&rel=…&sha=<4~40 位十六进制>` | 单条提交详情：提交信息 + 相对第一个父的改动文件与行数 |
| GET | `/api/git/branches?root=…&worktree=…&rel=…` | 本地分支 + 按远端名分组的远端分支（含 ahead/behind、当前分支标记） |
| GET | `/api/git/log?…&ref=refs/heads/<name>` | 同上，但只走某条 ref；`ref` 只收 `refs/heads|refs/remotes` 下真实存在的引用 |

`POST` 返回的也是完整清单，前端不必再拉一次。

## 4. 扫描与安全边界

- 扫描深度 **2 层**（`ws/a`、`ws/a/b`），`MAX_SCAN_ENTRIES=3000`、`MAX_REPOS=40`；
- 跳过隐藏目录（`.` 开头）与 `node_modules/dist/build/.next/target/venv/...`；
- 只跟真实目录（符号链接一律跳过，避免指到工作区外/成环）；进入一个仓库后不再往里扫；
- 扫描结果有 15s 缓存（只缓存「哪些目录是仓库」），**仓库状态每次现读**；
- 手动登记只接受工作区内的路径：相对路径按工作区根解析，绝对路径必须落在根内，
  `..` 逃逸直接 403；填仓库内部子目录会通过 `git rev-parse --show-toplevel` 归一到仓库根；
- git 命令只有 `symbolic-ref / rev-parse / status / log / rev-list`，全部 `execFile`，
  不拼 shell、不接收任意参数，`GIT_TERMINAL_PROMPT=0`；
- 唯一的写盘是 `PI_RUNTIME_DIR/git-repos.json`（`PI_GIT_REPOS_FILE` 可覆盖），不进 git。

## 5. 明确不做（当前的限制）

- **只读**：不提供 stage / commit / branch 切换 / push，避免 agent 与人在同一仓库上互相踩；
  要操作仍走工具调用，人工确认；
- **没有 diff 页**：点击文件只打开现有文件预览（右栏），看不了「改了什么」；
  删除的文件只会提示，暂不展示；diff 视图留待后续（见 §5.1）；
- 不监听文件系统：状态变化靠仓库 tab 里的「刷新」按钮（**不自动轮询**，避免大仓库反复 `git status`）；
- 自动扫描不跟随符号链接、不扫 3 层以上；更深的仓库用「添加子仓库」手动登记；
- 非 git 工作区（`kind === 'dir'`）不显示这个 tab。


## 5.1 后续：diff 页（未做）

计划：点文件时打开「改动 diff」而不是当前内容，数据从 `git diff`（含 staged）或
`git show HEAD:path` + 工作区内容生成；只读展示，不提供 hunk 级暂存。
删除文件用 `git show HEAD:path` 渲染旧内容，仍不写入。

## 6. 代码落点

| 位置 | 说明 |
|---|---|
| `server/git.ts` | 根解析、2 层扫描、状态汇总、手动登记持久化、`gitLog` + `layoutGraph` + `gitCommit` + `gitBranches`、`handleGit` |
| `server/index.ts` | 挂载 `/api/git/*`（在静态文件兜底之前） |
| `web/src/lib/git.ts` | 前端请求封装 |
| `web/src/lib/store.ts` | `gitPanel` 状态 + `loadGitPanel/addGitRepo/removeGitRepo`（按 workspace+worktree 缓存） |
| `web/src/components/GitRepoView.tsx` | 单个仓库：头部 + 改动目录树 + 点击文件打开预览 |
| `web/src/components/GitAddView.tsx` | `＋` tab：手动登记表单 + 已登记条目管理 |
| `web/src/components/GitGraph.tsx` | 提交记录树：按服务端给的泳道坐标画 SVG（竖线 / 汇入 / 分叉 / dot），整行可点 |
| `web/src/components/GitBranches.tsx` | 左栏分支列表：本地 / 每个远端一组，点一条按它过滤提交 |
| `web/src/lib/git-tabs.ts` | 纯函数：绑了工作树时标题栏只留工作树那条 tab（`check:git-panel` 里单测） |
| `web/src/components/ChatPane.tsx` | 每个仓库一个 tab + `＋` tab，按 `workspace.kind === 'git'` 显示 |
| `web/src/styles/chat.css` | `.git-*`（定位方式与 `.trajectory` 一致） |
| `scripts/check-git-panel.mjs` | 回归脚本：发现/深度/跳过目录/去重/越界/工作树卡片/提交记录泳道 |

## 7. 验收

```bash
npm run check:git-panel   # 84 项：扫描边界、去重、越界、手动登记、工作树卡片、提交记录泳道、提交详情、分支列表与 ref 过滤、tab 过滤规则
npm run check:web         # typecheck + build + happy-dom 冒烟（含 Git tab 交互）
```

冒烟里用 mock 覆盖：非 git 工作区没有 tab → git 工作区每个仓库一个 tab →
**默认就是提交树**（一条合并历史的泳道宽度 / 父边 / 汇入 / ref 徽标）→
点提交后右栏分列（上块标题/正文/作者/父提交，下块 `A/M/D` 文件 + 增删统计）→
点提交里的文件打开预览 → 点「未提交改动」看改动目录树（分组、折叠、`M/A/U`、点文件预览）→
`＋` 页添加子仓库（自动切到新 tab）→ 移除登记 → 切回对话。
