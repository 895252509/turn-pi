# MCP 接入（M1：工具可用 + 管理界面）

> 状态：**M0 + M1 已实现**（`server/mcp.ts`、`server/index.ts`、`server/session-config.ts`、`server/chat.ts`、`web/src/components/McpView.tsx`；验证 `scripts/check-mcp.mjs` + `web/scripts/smoke.mjs`）
> 范围：配置读盘 + 校验、会话装载、工具可达、reload 重连、只读工作区禁用、`#/mcp` 管理界面（增删改 / 启停 / 测试连接 / 应用到会话）
> 未做：`direct` exposure、OAuth 登录、MCP 日志尾巴（`mcp.log` 只能看文件）
> 关联：`docs/app-shell.md`（模块轴）、`docs/credential-manager.md`（凭据）、`docs/skills-integration.md`（同一套装载原则）

---

## 0. 一页结论

- **配置只认一份**：`$PI_RUNTIME_DIR/mcp.json`（默认 `/runtime/mcp.json`），形状与其他 MCP 客户端一致。
  不用 SDK 默认的 `$PI_AGENT_DIR/mcp.json` / 项目 `.pi/mcp.json`：前者在 compose 里没挂卷（重启就丢），后者要 project trust（会静默不生效）。
- **默认 exposure = `codemode`**：MCP 工具**不进**模型的工具声明，模型在 codemode 脚本里用 `tools.searchTools()` 找、`describeNamespace()` 读服务器说明。平台本来就强制 codemode，所以**工具白名单不用改**。
- **连接靠 `session_start`**：SDK 会话不会自动加载 MCP（`docs/sdk.md:116`），所以 `createSessionLoader` 注册 `createMcpExtension()`，`Chat.init` 里必须 `await session.bindExtensions({ onError })`。
- **`onError` 不能省**：`reload()` 只在 `hasBindings` 为真时重发 `session_start`（`agent-session.js:3040`）。传 `{}` 时 reload 后 MCP 永远不重连，改了配置对在跑会话不生效。
- **只读工作区整块关**：`readonly` 只按名字过滤 `WRITE_TOOLS`（`server/workspaces.ts:501`），`mcp__*` 不在名单里，接了就是绕过只读的通道。

---

## 1. 配置

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
      "description": "读写工作区文件"
    },
    "docs": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" },
      "exposure": "codemode"
    }
  }
}
```

- 文件不存在 = 没配服务器（不是错误）；坏条目单独跳过并报错，不影响其他服务器。
- 环境变量：`PI_MCP=0` 全局不接（排障用）；`PI_MCP_FILE` 换配置文件路径。
- `env` / `headers` 的值可以写 `${NAME}`（从 `process.env` 读）或 `!command`。凭据用**env 层**的 `credentials.json`：保存时写进 `process.env`，MCP 连接时自然拿得到。scoped 租约 + loopback 代理对 MCP **不适用**（请求由 MCP 客户端自己发，不经过我们的代理）。
- `stdio` 服务器的相对 `cwd` 相对会话工作目录；`command` 是一个可执行文件，不是 shell 命令串。
- `sse` 不支持，用 streamable HTTP（一般是 `/mcp` 端点）。

## 2. 数据流

```
/runtime/mcp.json
  └─ server/mcp.ts: readMcpFile() 校验 → loadPlatformMcpConfig()
      └─ session-config.ts: createMcpExtension({ loadConfig })  ← 每个真实会话一份
          └─ chat.ts: await session.bindExtensions({ onError })   ← 触发 session_start
              └─ SDK mcp 扩展后台连接（不阻塞首轮；只有 direct 工具等 10s）
                  └─ 工具注册为 mcp__<server>__<tool>，exposure=codemode
                      └─ 模型在 codemode 里 searchTools() 找到并调用
```

日志：服务器通知写 `$PI_AGENT_DIR/mcp.log`（默认 `/root/.pi/agent/mcp.log`）；配置问题启动时写一次 stderr。

## 3. 边界（刻意这样定）

| 场景 | 行为 | 原因 |
|---|---|---|
| 只读工作区 | 不注册 MCP 扩展 | 否则 `mcp__*` 绕过 `WRITE_TOOLS` 过滤 |
| 工具清单 / agent 预览（dry-run 会话） | 不注册 | 为了看一眼工具就起子进程不划算 |
| `direct` exposure | 不支持（会被工具白名单挡掉） | 需要两处改动：白名单加 `mcp__*`，且 `applyToolAllowlist`（`chat.ts` 的 `setActiveToolsByName`）会按精确名把 direct MCP 工具踢掉。管理界面里直接拒绝这个选项 |
| OAuth 服务器（401） | 不支持 | 回调是 `127.0.0.1` loopback + "打开系统浏览器"；容器里两者都没有。要用就自己实现 `openUrl` / `promptForRedirectUrl` 的 Web 化（端口转发或中转页） |
| python MCP 服务器（`uvx`） | 跑不了 | 镜像只有 `node:22-slim` + git，没有 python/uv。要跑就改 Dockerfile（同 `docs/worktree-deps.md:165` 的结论） |

已知成本：MCP 是**每会话**一份连接（会话里 N 个 stdio 服务器 = N 个子进程），冷启动取决于 server 自身。会话关掉时 SDK 会收掉子进程。

## 4. 验证

```bash
node scripts/check-mcp.mjs     # 或 npm run check:mcp
```

不连模型、不起 HTTP 服务，走真实装配路径，验：

1. 配置读得出来；
2. `session_start` 之后服务器连上、`mcp__check__echo` 注册；
3. 默认 `codemode`：不在 active（不占工具声明）、在 callable（脚本能调）、`codemode` 仍 active；
4. 工具真能执行（`echo:hello`）；
5. 配置加一个服务器后 `session.reload()` 能重连（这条正是 `onError` 的作用）；
6. M1 写盘：`saveMcpServer` / `setMcpServerEnabled` / `deleteMcpServer` 保留顶层与未知键、非法名字报 400、删除不存在的报 404；
7. M1 探测：`probeMcpServer` 能列工具，坏 command 返回可读的 `error`。

在真实平台里手测：写好 `/runtime/mcp.json` → 重启服务进程（改的是 `server/**`）→ 新会话里问 agent
「用 codemode 的 ALL_TOOLS 看看有没有 `mcp__` 开头的工具，然后调用它」。

## 5. 管理界面（M1，`#/mcp`）

`web/src/components/McpView.tsx` + `web/src/lib/mcp.ts`（独立 zustand store）+ `web/src/styles/mcp.css`。

| 动作 | 接口 | 说明 |
|---|---|---|
| 读配置 | `GET /api/mcp` | 返回 `servers[{name,transport,config,raw}]`、坏条目 `errors`、文件路径、`enabled`（`PI_MCP`） |
| 新建 / 编辑 | `POST /api/mcp/save` | 条目走与 `readMcpFile` 同一套 `validateServer`；文件用 tmp+rename 写，保留顶层其他键 |
| 启停 | `POST /api/mcp/enable` | 只改 `enabled`，其他字段原样保留 |
| 删除 | `POST /api/mcp/remove` | 不存在返回 404；删除前 UI 要二次确认 |
| 测试连接 | `POST /api/mcp/test` | 带 `config` 测草稿（不写盘），只带 `name` 测已保存条目；返回 `{ok,serverInfo,protocolVersion,instructions,tools,ms,error,stderr}` |
| 应用到会话 | `POST /api/mcp/apply` | 对 `chats.all()` 逐个 `session.reload()`；`busy` 的会话跳过并返回原因 |

几个刻意的决定：

- **`raw` 一起回传**：UI 编辑时把 `raw` 合进提交的 config，`auth` 之类前端不认识的键不会被一次保存抹掉。
- **测试不复用会话连接**：直接 `@earendil-works/pi-mcp` 的 `McpClient` + transport 连一次、`tools/list`、关掉。
  好处是能测未保存的草稿，也不碰在跑的会话；坏处是 `env` / `headers` 的 `${NAME}` 必须在本进程环境里存在
  （与真实连接同一套解析规则，见第 1 节）。stdio 失败时把 stderr 尾巴一起回给前端。
- **改配置 ≠ 生效**：新会话自动读；已经在跑的会话要「应用到会话」，因为 `reload()` 才会重发 `session_start`。
- **`direct` 在表单里直接拒绝**，不让用户配出一个会被白名单静默过滤掉的条目。
