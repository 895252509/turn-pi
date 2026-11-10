# 参与开发

先把项目跑起来（见 [README](README.md#快速开始)），然后：

```bash
npm install --include=dev
npm run build:web      # server 直接托管 web/dist
node server/index.ts   # 需要 Node >= 22.18（原生跑 TypeScript）
```

改 `server/**` 会由 `node --watch` 自动重启；改前端要 `npm run build:web` 后刷新（或用 `npm run dev:web` 起 Vite）。

## 提 PR 前跑这些

```bash
make check          # server 语法（Node 自带 TS 解析器）+ 搜索/抓取离线回归
make check-web      # tsc + 构建 + happy-dom 冒烟（不需要浏览器）
```

改到下面这些模块时，再跑对应的自检：

| 改了什么 | 跑什么 |
|---|---|
| `runtime/agents/*/CARD.md`、`server/agents.ts` | `npm run check:agent-card` |
| `server/agent-spec.ts` | `npm run check:agent-spec` |
| `server/mcp.ts`、`/api/mcp/*` | `npm run check:mcp`（会真连服务器，离线环境请加超时） |
| `server/git.ts`、Git tab | `npm run check:git-panel` |
| `server/worktrees.ts`、依赖共享 | `npm run check:worktree-deps` |
| 工具白名单 / 只读工作区 | `npm run check:workspace-tools` |
| worktree 提示词扩展 | `npm run check:worktree-guidance` |

`make check` 和 `check:web` 是 CI 必跑项，红了不会合并。

## 代码约定

- **缩进用 tab**，注释和 UI 文案目前是中文（保持一致，不要中英混着写同一个界面）。
- **不建第二份状态**：真相尽量只有一处（Agent 模板就是磁盘上的 `CARD.md`，会话就是 Pi 的 JSONL，技能就是 `runtime/skillstore`）。要加缓存可以，但要能一句话说清什么时候失效。
- **新的 `/api` 路径**必须同时出现在前端调用里（`scripts/check-routes.mjs` 会对照），否则 CI 红。
- 新增环境变量请同时写进 `.env.example` 与 README 的配置表。
- 依赖能不加就不加；要加请在 PR 里说明为什么现有依赖做不到。

## 提 PR

- 一个 PR 一件事，带着"为什么"（见 PR 模板）。
- 修 bug 请附复现步骤；改 UI 请贴截图。
- 提交信息用 `feat:` / `fix:` / `chore:` / `docs:` / `refactor:` / `test:` 前缀，正文写清影响面。

## 报 bug / 要功能

用 issue 模板。**别贴密钥和 `.env` 内容**——脱敏后再粘。

安全问题上 [SECURITY.md](SECURITY.md) 走私密渠道，别开公开 issue。
