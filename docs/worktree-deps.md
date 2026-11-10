# Worktree 依赖共享（P0：node_modules 链接）

> 状态：**P0 已实现**（`node_modules` 符号链接 + 本地 ignore + 记录/自愈/删除 + 安装拦截）。
> P1/P2（独立安装、只读挂载、多生态）见 §6，未实现。
> 关联：`docs/workspace-and-worktree.md`（worktree 生命周期）、`server/worktrees.ts`、`server/workspaces.ts`。

**结论**：`git worktree add` 不复制被 ignore 的依赖目录，所以新 worktree 里没有 `node_modules`。
P0 选择「**符号链接到主工作区**」：零成本、`npm ci` 删目录后能自动复活，代价是**可写共享**
（worktree 里的安装会写穿到主工作区），因此必须配 three-piece：ignore 处理、安装拦截、删除时 unlink。

---

## 0. 为什么要有这个东西

| 事实 | 数值 |
|---|---|
| 本仓库 `node_modules` | 337MB |
| 仓库总体积 | 847MB（依赖占约 40%） |
| `git worktree add` 是否复制 ignore 目录 | 否（这是 git 的设计，不是 bug） |

不共享的话，每个 worktree 要么装一遍依赖，要么 agent 一开始就 `npm install` 卡几十秒。

## 1. 实测出来的三个坑

### 1.1 符号链接不被 `node_modules/` 匹配

```
.gitignore:1   node_modules/        ← 带斜杠只匹配「目录」
git check-ignore -v node_modules    → exit 1（没命中）
git status --porcelain              → ?? node_modules
```

两个后果：

1. UI 里 worktree 永远是「有未提交改动」；
2. `removeWorktree()`（`server/worktrees.ts`）用 `git status --porcelain` 判脏树，**带链接的 worktree 删不掉**，除非显式 `force`。

P0 的解法同时做了两件事：

- 写一条 **repo 本地** ignore：`<git-common-dir>/info/exclude` 追加 `/node_modules`（带标记注释）。
  只是本地元数据，不入库，也不改用户 `.gitignore`；
- 判脏时**按记录过滤**链接路径（`withoutLinkNoise()`），不依赖 ignore 一定生效。

### 1.2 `git clean -xdf` 会删掉链接

agent 偶尔会跑。链接被删后 worktree 静默失去依赖，所以每次打开会话都会调
`ensureWorktreeLinks()` 自愈：缺了就补，多余的记录清掉。

### 1.3 本容器里没有 python

```
which python3 python uv pip → 全空；/usr/bin/python* 不存在（Debian 12 基础镜像）
/workspace/wiki/.venv/bin/python3 → /usr/bin/python3（宿主机的绝对路径）
```

所以 `.venv` **不能**靠链接解决：venv 里的解释器路径是宿主机绝对路径，容器里跑不起来。
python 工作流目前走 `host-exec-mcp`。P0 因此只处理 `node_modules`。

## 2. 三种语义，为什么选符号链接

| 方案 | 隔离性 | realpath | `git status` | `git clean -xdf` | 成本 |
|---|---|---|---|---|---|
| **符号链接**（P0） | 无（可写共享） | 指向主工作区 | 需要 ignore 处理 | 链接被删（可自愈） | 0 |
| 只读 bind mount | 只读 | 真实路径 | 干净 | 删内容 → EROFS | 需要 CAP_SYS_ADMIN、容器重启失效、缓存类工具会坏 |
| 每 worktree 独立安装 | 完全 | 真实路径 | 干净 | 无所谓 | 337MB + 构建缓存 / 次 |

- **不做硬链接**（`cp -al`）：npm 会原地改写文件，一改全脏；`npm ci` 删目录会留下悬空 inode。
- 只读 bind mount 更安全（`npm install` 直接失败），但它会弄坏 vite/esbuild 这类要写
  `node_modules/.vite`、`node_modules/.cache` 的工具，还要处理容器重启后重新挂载。
  P0 先不引入，留作 P2。

## 3. P0 行为定义

### 3.1 探测与前置条件

创建 worktree（`git worktree add` 成功之后）对每个候选路径做四道检查，**全满足才链接**：

1. 配置允许：`workspace.worktreeDeps.mode !== 'none'`；
2. 主工作区根部**存在且是目录**：`<workspace.root>/node_modules`；
3. worktree 里**不存在**同名路径（分支自带真的 `node_modules` 就不动）；
4. 路径不含 `..`、不是绝对路径（配置里写死，防越界）。

默认候选是 `['node_modules']`，可用 `worktreeDeps.include` / `exclude` 覆盖。

```jsonc
// workspaces.json（可选，不写就是默认 link + node_modules）
{
  "id": "turn-pi",
  "root": "/workspace/turn-pi",
  "worktreeDeps": { "mode": "link", "include": ["node_modules"], "exclude": [] }
}
```

`mode` 只支持 `link` / `none`：P0 没有 `install`，别让配置里出现"看起来能用其实没实现"的值
（`normalizeWorktreeDeps()` 会把无法识别的 mode 当未设置）。

### 3.2 记录

`Worktree` 新增 `links: WorktreeLink[]`：

```ts
interface WorktreeLink { path: string; target: string; createdAt: string }
```

落盘在 `runtime/worktrees.json`，好处是删除时**精确 unlink**、UI 可显示"依赖共享自 …"、
自愈时知道该补哪些。`snapshot()` 直接透出。

### 3.3 自愈

`ensureWorktreeLinks(id)`：

- 记录里存在、但 worktree 里已经不是链接 → 补；
- worktree 里已经是链接、但记录缺失（手工建的）→ 认领（adopt）；
- 记录里有、但配置已经不想要（`exclude`/`none`）→ 从记录里删掉（不主动删链接）。

调用点：`Chat.init()` 解析出 worktree 之后。失败只告警，不影响会话创建。

### 3.4 删除

`removeWorktree()` 在 `git worktree remove` 之前 unlink recorded links：

- 只删**符号链接**（`lstat().isSymbolicLink()`），绝不删真目录；
- 只删**指向 worktree 之外**的链接（`readlink` 解析后仍在 worktree 内就跳过）；
- `cleanupFailedCreate()` 同样先 unlink 再回滚。

### 3.5 安装拦截

链接是**可写共享**，在 worktree 里跑安装会直接改主工作区的 `node_modules`（还会让
`package.json` 的改动留在 worktree —— 一半在 A 一半在 B，最难查）。所以注册一个
`tool_call` 拦截（`server/chat.ts` 的 inline extension）：

- 只拦 `bash`；
- 命中安装类命令（`npm|pnpm|yarn|bun` 的 `i/install/add/ci/update/up/dedupe/prune/rebuild/link`，
  以及 `pip/uv/poetry`、`composer/bundle` 的安装子命令）；
- 且 `cwd/node_modules` 或 `cwd/.venv` 是符号链接；
- → `{ block: true, reason }`，提示回主工作区安装；
- **逃生阀**：命令里含 `PI_ALLOW_SHARED_DEPS=1` 就放行（给人用，不给 agent 默认用）。

拦截的是"在 worktree 里安装"，不拦运行、不拦 `npm run build`。

## 4. 代码落点

| 文件 | 改动 |
|---|---|
| `server/workspaces.ts` | `WorktreeDeps` 类型 + `normalizeWorkspace()` 保留该字段 |
| `server/worktrees.ts` | `WorktreeLink`、`depPathsFor()`、`ensureLocalIgnore()`、`linkDep()`、`linkWorktreeDeps()`、`unlinkWorktreeDeps()`、`ensureWorktreeLinks()`、`withoutLinkNoise()`、`sharedDepsInstallBlock()` |
| `server/chat.ts` | `Chat.init()` 里 `ensureWorktreeLinks()`；inline extension 里 `tool_call` 拦截 |
| `scripts/check-worktree-deps.mjs` | 回归：创建/链接/ignore/自愈/删除/拦截 |

## 5. 验收

`npm run check:worktree-deps`（真起一个临时 git 仓库，不连服务、不碰真实工作区）：

1. 建 worktree → `node_modules` 是符号链接，指向主工作区；
2. `git status --porcelain` 为空（ignore 生效）；
3. 删掉链接 → `ensureWorktreeLinks()` 补回；
4. `removeWorktree()` → 链接消失、**主工作区 `node_modules` 完好**；
5. 拦截函数：只读链接 + `npm i` 命中，`npm run build` 不命中，`PI_ALLOW_SHARED_DEPS=1` 放行。

## 6. 未做 / 下一步

- **P1**：`worktreeDeps.mode: 'install'` —— 后台 `npm ci`，非阻塞，UI 显示进度；给"必须隔离"的仓库。
- **P2**：只读 bind mount 选项（配合 `cacheDir` 重定向）；多生态候选（`vendor/`、`target/` 的判定表）。
- **P2**：UI 徽标（"依赖共享中"）+ "改为独立安装"按钮。
- **python**：等镜像装 python3/uv，或明确 python 一律走 `host-exec-mcp`；在此之前不碰 `.venv`。

## 6.1 在 worktree 里加新依赖：会顶掉符号链接（2026-11 实测）

`PI_ALLOW_SHARED_DEPS=1 npm install <pkg>` 走的是 npm 自己的 reify：它会先把 `node_modules`
这个**符号链接当成"非目录"删掉**，再在 worktree 里装一整套（实测 `added 194 packages`），
结果是这个 worktree 从此脱离共享、且缺 dev 依赖（vite/react/tsc 都不在），`npm run build:web` 直接挂。

正确姿势（新增依赖时）：

```bash
# 1) 主工作区装，但不改它的 package.json / lock（--no-save --no-package-lock）
cd /workspace/turn-pi
PI_ALLOW_SHARED_DEPS=1 npm install --no-save --no-package-lock <pkg>@<range>

# 2) 回 worktree 只更新 lock（--package-lock-only 不 reify，不会碰 node_modules）
cd /runtime/worktrees/pi-webchat/<wt>
npm install --package-lock-only <pkg>@<range>

# 3) 确认链接还在
ls -ld node_modules   # 必须是 -> /workspace/turn-pi/node_modules
```

代价：这两个包在主工作区是 `extraneous`（`npm ls --depth=0` 会标出来），主工作区跑一次
`npm ci` 就会被清掉——等分支合并、主工作区的 `package.json` 带上依赖后就正常了。

如果已经踩了（链接被换成真目录）：`rm -rf node_modules && ln -s /workspace/turn-pi/node_modules node_modules`，
再按上面第 1、2 步补救。

## 7. 已知限制

- 共享 = 可写共享：agent 在 worktree 里仍能通过 `sed -i node_modules/...`、`node -e` 等方式改主工作区依赖。
  拦截只覆盖常见安装命令，是**防手滑**，不是安全边界；要真隔离得上只读挂载。
- `node_modules/.vite`、`node_modules/.cache`、`node_modules/.prisma` 这类**运行期写进依赖目录**的缓存
  也会被共享，两个 worktree 并发跑可能互相覆盖。当前仓库没用到这些工具；一旦用到，应改为独立安装。
- 只处理 worktree 根部一层，不扫 monorepo 的 `apps/*/node_modules`。
- 拦截只看**会话 cwd** 那一层：`cd sub && npm i`、`npm --prefix .. i` 这类绕法拦不到。
