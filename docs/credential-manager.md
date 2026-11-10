# 凭据管理器：动态存取，不重启

> 状态：**已实现 P0–P2**（P3 未做；实现入口：`server/credentials.ts`、`server/auth.ts`、设置 → 凭据）
> 范围：v1（加密 vault + provider 环境凭据热更新 + agent 按需申请 scoped 凭据走代理）
> 目标读者：接手实现的工程师
> 依据：pi SDK 1.4.0（`dist/auth/context.js`、`core/model-runtime.js`）+ 本仓库现状
> 关联：`server/providers.ts`、`server/quota.ts`、`server/chat.ts`、`server/index.ts`

**目录**：[0. 一页结论](#0-一页结论) · [0.1 访问控制](#01-访问控制bootstrap-token--cookie) · [1. 问题](#1-问题) · [2. 目标与非目标](#2-目标与非目标) · [3. 关键事实](#3-关键事实) · [4. 两层凭据](#4-两层凭据) · [5. 数据模型](#5-数据模型) · [6. 存储与加密](#6-存储与加密) · [7. 服务端 API](#7-服务端-api) · [8. agent 工具与代理](#8-agent-工具与代理) · [9. 审批与 UI](#9-审批与-ui) · [10. 热更新路径](#10-热更新路径) · [11. 审计与脱敏](#11-审计与脱敏) · [12. 示例：Gitea 提 issue](#12-示例gitea-提-issue) · [13. 实施阶段](#13-实施阶段) · [14. 验收](#14-验收) · [15. 风险与开放问题](#15-风险与开放问题)

---

## 0. 一页结论

现在的问题是**凭据只存在于进程环境**：`server/providers.ts:479` 的 `resolveEnvKey()` 只读 `process.env`，所以加一个 key 必须改 `.env` + 重启。

v1 用**一个加密 vault + 两条使用路径**解决，核心是「值在服务端，agent 只拿能力」：

| 层 | 给谁用 | 怎么生效 | 是否可见于 agent |
|---|---|---|---|
| **env 层** | 模型供应商（`OPENCODE_API_KEY` 等） | 保存时写 `process.env[NAME]`，SDK 每次请求都重读，**不用重启** | 会（bash 继承环境；与现状一致） |
| **scoped 层** | 任意 API（Gitea、GitHub、内部服务） | `cred_use` 申请租约 → 换一个 **代理 URL**，服务端注入真实密钥 | **不会**，agent 只拿到短期租约 |

一句话：**env 层解决「改 key 不重启」，scoped 层解决「agent 能干活但看不到密钥」。**

必须先补的前置条件：**当前 web 服务没有任何认证**（`server/index.ts` 直接监听 `0.0.0.0:44100`）。凭据管理器上线前至少要加 `PI_ACCESS_TOKEN`（或强制反代鉴权），否则同网段任何人都能提交 issue、消耗额度。具体做法见 §0.1。

---

## 0.1 访问控制：bootstrap token → cookie

目标：启动后自动生成 token，人第一次访问 `/?token=xxx` 就能进；之后靠 Cookie，刷新/多标签/SSE 都不用再带 token。

### 启动

```
PI_ACCESS_TOKEN 有值   → 用它（适合 Docker secret / 反代统一注入）
否则 runtime/access-token 存在 → 读它（0600，容器重建后不失效）
否则生成 32 字节 base64url → 写 runtime/access-token 并打印到 stdout
```

日志只打印一次（不要每请求打印）：

```
[auth] open http://localhost:44100/?token=J1x...
[auth] token file: /runtime/access-token
```

`docker compose logs webchat | grep '\[auth\]'` 就能找回。**不要把 token 写进 `docker-compose.yml` 或 README**，否则等于没有认证。

### 首次访问

```
GET /?token=<token>
  → 常数时间比较（timingSafeEqual）
  → Set-Cookie: pi_access=<token>; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000
  → 302 Location: /            （不带 token，保留其他 query）
  → Cache-Control: no-store, Referrer-Policy: no-referrer
```

为什么必须跳转剥掉 token：

- 浏览器历史、书签会长期保存 URL；
- 页面里点外链时 `Referer` 会把 query 带出去；
- 反代/网关访问日志默认记录完整 URL。

### 后续请求

- 中间件按顺序判断：Cookie 有效 → 放行；`?token=` 有效 → 换 Cookie 后 302；否则 `/api/*` 返回 401，静态页返回一个只有“输入 token”的最小页面。
- SSE（`/api/events`）同源请求会自动带 Cookie，不用改 `EventSource`。
- POST 额外校验 `Origin`/`Sec-Fetch-Site`，防 CSRF；`SameSite=Lax` 是第二道。
- 登录尝试按 IP 限速（如 10 次/分钟），32 字节 token 本身不可暴破，限速只是防日志刷屏。

### 例外路径

| 路径 | 认证方式 | 原因 |
|---|---|---|
| `/api/health` | 不认证 | Docker healthcheck |
| `/api/cred/:lease/proxy` | 租约 + 仅允许 loopback 来源 | agent 的 `bash` 在容器内访问 `127.0.0.1:44100`，没有 Cookie；租约本身就是能力令牌 |
| 根目录静态壳：`/manifest.webmanifest`、`/icon*.svg`、`/*.png`、`/*.ico` | 不认证 | 浏览器取 PWA 清单和图标时按规范可以不带 Cookie（默认 credentials mode = omit），不生效就会在控制台刷 401；内容本身不含私密信息 |

其它 `/api/*` 一律要 Cookie；`/assets/*.js|.css`（应用本体）也仍然要 Cookie。`web/index.html` 的 manifest link 另写了 `crossorigin="use-credentials"`，正常浏览器会带 Cookie，这条豁免只是兜底。

### 轮换与持久化

- `PI_ACCESS_TOKEN` 固定：改环境变量并重启即轮换；
- 文件模式：删除 `runtime/access-token` 并重启即重新生成；
- Token 换了之后旧 Cookie 自然失效（Cookie 存的就是 token 本身，常数时间比较）。

### 诚实边界

agent 与 server 同容器同 uid，`bash` 能读 `/runtime/access-token`（也能读 `/proc/1/environ`）。所以这层认证**防的是同网段的其他人**，不是防 agent。要防 agent 得把 token 放到 agent 读不到的地方，或把 agent 工具移出该容器（§15）。

---

## 1. 问题

用户场景：让 agent 往 Gitea 提一个 issue。

今天只能：

1. 编辑 `.env` 加 `GITEA_TOKEN=...`
2. `docker compose up -d` 重启
3. agent 才能通过 `bash curl` 看到这个变量

三个问题：

- **不可动态**：改一次 key 重启一次，正在跑的会话被中断。
- **不可控**：一旦进了 `process.env`，agent 的每一条 `bash` 都能 `env | grep TOKEN` 拿到；所有凭据一视同仁。
- **不可审计**：谁在什么时候用了哪个凭据、访问了哪个 host，没有记录。

provider 侧已经有半个答案：自定义供应商只存**变量名**不存值（`server/providers.ts:5`）。v1 把「变量名 → 值」这一段补上，并且把值从「进程环境」升级为「加密 vault + 运行时解析」。

---

## 2. 目标与非目标

### 目标

| # | 目标 | 判定 |
|---|---|---|
| G1 | 在 UI 里增删改凭据，**立即生效，进程 PID 不变** | 保存后立刻 `POST /api/providers/test` 成功，`kill -0` 不变 |
| G2 | 模型供应商 key 不再依赖 `.env` | vault 里有 env 层条目时，删掉 `.env` 仍可用 |
| G3 | agent 能按名字申请使用凭据，但**看不到明文** | 会话 JSONL / SSE / 工具结果中搜不到 secret |
| G4 | 每次使用可审计、可撤销 | `runtime/credential-audit.jsonl` 有记录；租约可即时 revoke |
| G5 | 凭据有作用域 | 只能访问声明的 host / path 前缀 / 方法 |
| G6 | 容器重启后配置还在，租约全部失效 | vault 落盘；租约只在内存 |

### 非目标（v1 明确不做）

- **不做对恶意 agent 的强隔离**。agent 和 server 同容器同 uid，`bash` 能读 `/runtime`。vault 加密只防「宿主机磁盘/备份泄露」，不防「agent 主动翻文件」。强隔离要把 agent 工具放进独立容器/uid，见 §15。
- 不做 OAuth 授权码/设备码流程（v2 再加）。
- 不做 SSH agent 转发、数据库凭据代填（v2）。
- 不做多用户与权限模型（当前是单用户工具）。
- 不允许 agent 自己创建/修改凭据。
- 不在 v1 暴露 `cred_reveal`（把明文交给 agent）——一旦交给 agent 就永久进了会话记录。

---

## 3. 关键事实

实现前请核对这三条，它们决定「不重启」是否成立：

1. **SDK 每次请求都重新解析环境变量**
   `node_modules/@earendil-works/pi-ai/dist/auth/context.js`：

   ```js
   async env(name) {
     const value = getProcessEnv()?.[name];
     return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
   }
   ```

   `core/model-runtime.js:453 prepareRequest()` 每次请求调 `getAuth()`，`getModel()` 返回的 model 对象**不缓存 apiKey**。
   ⇒ 运行中改 `process.env[NAME]`，**已有会话的下一轮请求就会用新 key**。

2. **仓库里所有凭据读取都走 `process.env`**
   - `server/providers.ts:479` `resolveEnvKey()`
   - `server/providers.ts:350` 卡片 `auth.configured`
   - `server/quota.ts:617` 额度探测兜底
   ⇒ 三处统一换成 `resolveSecret(name)`，热更新就贯通了。

3. **agent 的 `bash` 继承 server 的 `process.env`**
   ⇒ env 层密钥对 agent 可见；scoped 层**绝不能**写进 `process.env`。

---

## 4. 两层凭据

### 4.1 env 层（`tier: 'env'`）

用途：模型供应商 key、以及确实需要以环境变量形式传给 CLI 的 key。

- 记录字段：`envName`（如 `OPENCODE_API_KEY`）。
- 保存/删除时同步 `process.env[envName]`（保存：赋值；删除：`delete`）。
- 启动时 `hydrateEnvTier()` 在 `initCustomProviders()` 之前跑一遍，容器重建也能自动恢复。
- 优先级：**vault > `.env`**。UI 标注来源（`vault` / `environment`），并提供「从环境导入」把现有 `.env` 值搬进 vault。
- 读取入口：

  ```ts
  export async function resolveSecret(name: string): Promise<string | undefined> {
    return (await vaultEnvValue(name)) ?? process.env[name];
  }
  ```

- 注意：env 层是「方便」，不是「保密」。审批弹窗里要明确写「此凭据会进入所有 bash 子进程环境」。

### 4.2 scoped 层（`tier: 'scoped'`）

用途：Gitea / GitHub / 内部 HTTP API 等按次使用的凭据。

- 记录字段：`baseUrl`、`allowedHosts`、`allowedPathPrefix`、`allowedMethods`、`scopes`、`headerName`、`headerPrefix`、`username`（basic）。
- **永不进 `process.env`**。
- agent 通过 `cred_use` 拿一个**租约 + 代理 URL**，真实密钥由服务端在转发时注入。
- 租约是随机 32 字节，内存 Map，绑定 `{ credentialId, sessionId, scopes, expiresAt }`，默认 TTL 10 分钟；会话结束/服务重启即失效。用户选「本会话允许」时 `expiresAt = null`，租约不按时间过期，直到会话结束或手动撤销。

---

## 5. 数据模型

```ts
type CredentialKind = 'bearer' | 'api-key' | 'basic' | 'query' | 'env';
type CredentialTier = 'env' | 'scoped';

interface CredentialRecord {
  id: string;                 // cred_<random>
  name: string;               // 唯一 slug，如 gitea
  label?: string;             // 展示名
  kind: CredentialKind;
  tier: CredentialTier;

  // 密文，任何 API 都不返回；环境变量引用模式下为空
  secret?: { v: 1; iv: string; tag: string; data: string };
  // 以 CRED_ 开头的环境变量名；有值时运行时从 process.env 解析，vault 只存名字
  secretEnv?: string;

  // 注入方式
  headerName?: string;        // bearer 默认 Authorization；api-key 默认 X-API-Key
  headerPrefix?: string;      // bearer 默认 "Bearer "
  username?: string;          // basic
  queryParam?: string;        // kind=query
  envName?: string;           // tier=env

  // 作用域（tier=scoped）
  baseUrl?: string;
  allowedHosts: string[];
  allowedPathPrefix?: string;
  allowedMethods: string[];   // 默认 ['GET']
  scopes: string[];           // 语义标签，审批时展示，如 ['gitea:issue:write']；不参与 HTTP 代理校验

  policy: 'ask' | 'auto-read';// auto-read 仅允许 GET 且 host/path 命中
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
  useCount: number;
}
```

约束：

- `name` 全局唯一，`^[a-z][a-z0-9-]{1,31}$`，避免和 env 名混淆。
- `tier=env` 必须有 `envName`（`^[A-Z][A-Z0-9_]*$`）；`tier=scoped` 必须有 `baseUrl` + 非空 `allowedHosts`。
- `allowedHosts` 用精确 host（可含 `*.` 前缀通配），不接受空值或 `*`。
- 保存时校验 `baseUrl` 的 host 必须在 `allowedHosts` 内。

> `scopes` 只用于审批展示、租约记录和 `auto-read`/git 判断；HTTP 代理**不会**按 scope 限制路径。真正的边界是 `allowedHosts` + `allowedPathPrefix` + `allowedMethods`。

---

## 6. 存储与加密

- 文件：`$PI_RUNTIME_DIR/credentials.json`（默认 `runtime/credentials.json`）。
- 写入：`mkdir -p` → 临时文件 → `rename` 原子替换，0600。
- 加密：Node 内置 `crypto`，AES-256-GCM，每条记录独立 IV；AAD 用 `id|name|v` 防记录互换。
- 主密钥优先级：
  1. `PI_CREDENTIAL_KEY`（base64 32 字节，适合 Docker secret）
  2. `$PI_RUNTIME_DIR/credentials.key`（首启自动生成，0600）
- 换 key：`rotateMasterKey()` 全量重加密；旧 key 只在内存中完成一次迁移。
- **诚实说明**：同 uid 的 agent 能读 key 文件，所以这是「静态加密」，不是「对 agent 保密」。真正的边界在 §8 的代理：密钥只在 server 进程内被解析，scoped 层从不落进 `process.env` / 会话 / 工具结果。

---

## 7. 服务端 API

所有响应都**不含密文与明文**，只返回 `hasSecret: true/false`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/credentials` | 列表（脱敏）+ `leases` 数量 + `envHydrated` |
| POST | `/api/credentials` | 新建/更新；body 含 `secret`（仅此一次） |
| POST | `/api/credentials/delete` | `{ id }`；同时 revoke 其全部租约 |
| POST | `/api/credentials/rotate` | `{ id, secret }` |
| POST | `/api/credentials/test` | `{ id }` 或临时 `{ kind, baseUrl, secret }`，发一个只读探测 |
| POST | `/api/credentials/import-env` | 把 `process.env[envName]` 搬进 vault |
| GET | `/api/credentials/audit?limit=200` | 审计尾部 |
| POST | `/api/credentials/lease/revoke` | `{ lease }` 或 `{ sessionId }` |
| POST | `/api/credentials/decision` | `{ requestId, decision: 'once'\|'session'\|'deny' }` |
| POST | `/api/cred/:lease/proxy` | 代理转发，见 §8.2 |

改动点：

- `server/index.ts` 增加路由（照 `providers` 那组写，`server/index.ts:380` 附近）。
- `server/providers.ts`：`resolveEnvKey` / 卡片状态 / `saveCustomProvider` 改为 `resolveSecret`。
- `server/quota.ts:617` 改为 `resolveSecret(record.apiKeyEnv)`。
- `server/chat.ts`：`customTools` 增加 `cred_list` / `cred_use`（照 `recordMethod` 的写法，`server/chat.ts:1255`）。

---

## 8. agent 工具与代理

### 8.1 工具

**`cred_list`**（只读，不需要审批）

```json
{ "credentials": [
  { "name": "gitea", "label": "Gitea", "kind": "bearer",
    "hosts": ["git.example.com"], "scopes": ["gitea:issue:write"],
    "usage": "cred_use({name:'gitea', reason, scope})" }
]}
```

不返回 secret、不返回 baseUrl 之外的内部字段。

**`cred_use`**（需要审批）

参数：

```ts
{
  name: string;                 // 凭据名
  reason: string;               // 给审批人看的一句话
  scope?: string;               // 必须是记录 scopes 的子集
  ttlSeconds?: number;          // 上限 600
}
```

返回（批准后）：

```json
{
  "lease": "cr_...",            // 短期能力令牌
  "proxy": "http://127.0.0.1:44100/api/cred/cr_.../proxy",
  "target": "https://git.example.com",
  "expiresAt": 1730000000000,   // 「本会话允许」时为 null，随会话结束失效
  "sessionBound": false,         // true = 不按时间过期
  "usage": "POST $proxy，带 x-pi-target: <完整 URL>。不要在命令里写真实 token。"
}
```

拒绝/超时（默认 120s）返回结构化错误，agent 应停止并告知用户，不得重试刷屏。

### 8.2 代理

请求：

```
POST /api/cred/<lease>/proxy
x-pi-target: https://git.example.com/api/v1/repos/o/r/issues
content-type: application/json

{ "title": "...", "body": "..." }
```

> 代理使用请求本身的方法作为上游方法；`GET` / `HEAD` 不发送 body。只读探测示例：

```
GET /api/cred/<lease>/proxy
x-pi-target: https://git.example.com/api/v1/version
```

服务端流程：

1. 查租约 → 过期/不存在 → 401。
2. 解析 `x-pi-target`；必须 `https`（`http` 仅允许 loopback 或显式开启）。
3. 校验 host ∈ `allowedHosts`、path 以 `allowedPathPrefix` 开头、method ∈ `allowedMethods`、scope 命中。
4. 删除入站 `authorization` / `cookie` / `host` / `x-pi-target`，按 `kind` 注入真实凭据。
5. 手动跟随重定向（最多 3 跳），每跳重新校验 host。
6. 流式回传；剥离 `set-cookie`，超时 30s，响应体上限 2 MB。
7. 写审计；`lastUsedAt` / `useCount` 更新。

关键点：**agent 传进来的任何 header 都不能覆盖注入的凭据**，否则等于把 token 骗出来。

### 8.3 为什么用代理而不是给明文

- 明文一旦进工具结果，就会进 SSE、会话 JSONL、前端状态、日志，无法回收。
- 代理可以做**方法/路径/host 级授权**，明文做不到。
- 租约可撤销、可过期、可审计；明文不可。
- 代价是 agent 必须走 HTTP。HTTPS `git push` 走 §8.4 的 helper；SSH、数据库等仍不支持（见 §15）。

### 8.4 git push：租约 + credential helper

HTTP 代理无法承载 git 智能 HTTP（路径是 `/owner/repo.git/git-receive-pack`，而且 git 不会带 `x-pi-target`）。给凭据加 `*:git:write` scope 后，`cred_use` 会额外返回：

```json
"git": {
  "helper": "scripts/git-credential-pi.mjs",
  "env": { "PI_CRED_LEASE": "cr_…", "PI_BASE_URL": "http://127.0.0.1:44100" },
  "usage": "PI_CRED_LEASE=… PI_BASE_URL=… git -c credential.helper='!node scripts/git-credential-pi.mjs' push <remote> <branch>"
}
```

用法：

```bash
PI_CRED_LEASE=cr_… PI_BASE_URL=http://127.0.0.1:44100 \
git -c credential.helper='!node scripts/git-credential-pi.mjs' \
  push origin HEAD
```

- `helper` 的解析顺序：`PI_GIT_HELPER` → 主 checkout `/workspace/turn-pi/scripts/...` → server 同级 `scripts/` → 相对当前 checkout。旧 worktree 没有 `scripts/` 时会用主 checkout 的绝对路径；需要固定位置时设 `PI_GIT_HELPER`
- 实际命令用 `cred_use` 返回的 `git.helper` 值（上面的相对路径只是示例）
- helper 调 `POST /api/cred/<lease>/git-credential`；服务端校验租约、host、`*:git:*` scope 后返回 `username/password`
- git 的 credential 请求可能带端口（`git.example.com:8443`）；服务端按 hostname 比对 `allowedHosts`
- 这个端点的 JSON 响应**不做脱敏**（token 必须原样交给 git）；仅 loopback + 租约可访问
- token 只进 git 子进程，不写进工具结果/会话记录
- 只支持 HTTPS（Gitea 的 4343 端口）；SSH 仍需 SSH key/agent
- 审计 action=`git-credential`

> **scope 不是路径限制**：`gitea:issue:write` 只是审批标签；HTTP 代理真正校验的是 `allowedHosts` + `allowedPathPrefix` + `allowedMethods`。issue 凭据要把路径前缀收到 `/api/v1/repos/<owner>/<repo>/issues`，否则它能建分支、写文件。

---

## 9. 审批与 UI

### 设置 → 凭据（新 tab）

- 卡片/表格：名称、类型、层级、host、scopes、来源（vault/env）、最后使用、使用次数。
- 操作：新建、编辑（secret 留空=不修改）、轮换、删除、测试、查看审计。
- 新建时按 kind 切换字段；`tier=env` 只填变量名；`tier=scoped` 必须填 baseUrl + allowedHosts。
- 顶部固定提示：env 层对 bash 可见；scoped 层看不到明文。

### 会话内审批卡片

当 `cred_use` 挂起时，向该会话 SSE 推 `credential_request`：

```
🔐 agent 请求使用凭据「gitea」
   目标：git.example.com
   范围：gitea:issue:write
   原因：用户要求提交 issue #123
   [仅本次] [本会话允许] [拒绝]
```

- 决策走 `POST /api/credentials/decision`。
- 超时 120s 自动拒绝。
- `session` 决策只对该会话 + 该 scope 生效，会话结束清除。
- 没有前端在线时一律拒绝（不给「静默批准」留后门）。

审批卡和待发送队列共用 `web/src/components/ComposerCard.tsx` 外壳：所有卡片右上角都有同一个展开箭头，按 `peek（只露 2px 上边框）/ default（标题 + 摘要 + 功能按钮）/ expanded（完整详情）` 三态循环；审批按钮、队列计数、全部收回等由各功能自己在卡片体内渲染，外壳不管理。颜色主题走 `data-tone` → CSS `--card-tone`，新增主题只需加一个 tone 和一条 `--card-tone` 覆盖。

审批超时不会直接消失：前端按 `expiresAt` 计时，到点自动把审批卡从默认形态收到 `peek` 细条，留下「这里曾经有过审核」的痕迹；点细条可重新展开查看凭据 / scope / 原因，点「知道了」清除。用户主动批准或拒绝时正常移除，不保留细条。

---

## 10. 热更新路径

```
UI 保存
  → vault.write(encrypted)
  → tier=env ? process.env[envName] = secret : noop
  → invalidateQuotaCache()            // server/quota.ts:73
  → 返回列表（脱敏）
```

- **provider key**：下一次 `prepareRequest()` 读 `process.env`，已有会话立即用新 key；无需重启、无需重建 session。
- **scoped key**：下一次代理请求实时从 vault 解密；租约不需要重建。
- **删除**：env 层 `delete process.env[envName]`，scoped 层 revoke 所有租约；后续请求立即失败。
- **容器重启**：启动时 `hydrateEnvTier()` 先于 `initCustomProviders()`；租约 Map 为空。

不需要 `node --watch` 重启。

---

## 11. 审计与脱敏

审计文件：`$PI_RUNTIME_DIR/credential-audit.jsonl`，append-only。

```json
{"ts":1730000000000,"actor":"agent","sessionId":"...","credential":"gitea",
 "action":"proxy","method":"POST","host":"git.example.com",
 "path":"/api/v1/repos/o/r/issues","status":201,"decision":"once","lease":"cr_…"}
```

- 不记录请求/响应体，不记录 secret。
- 记录 `decision`（`auto-read` / `once` / `session` / `deny`）便于回看。

脱敏：

- 所有凭据明文只存在于 `SecretBox` 解密的局部变量中，用完即弃。
- SSE 出口加 `redact(text)`：对已知 secret 值做替换（`***`），覆盖 `delta` / `thinking` / `tool.args` / `tool.result`。
- `console` 日志禁止打印 body；错误信息统一走 `errorMessage()` 并脱敏。
- 已知局限：SDK 自己写 session JSONL，服务端无法逐字改写；因此 **绝不能把明文交给 agent** 是 v1 的硬约束。

---

## 12. 示例：Gitea 提 issue

1. 设置 → 凭据 → 新建：
   - 名称 `gitea`，类型 `bearer`，层级 `scoped`
   - baseUrl `https://git.example.com`
   - allowedHosts `git.example.com`
   - allowedPathPrefix `/api/v1/repos/`
   - allowedMethods `GET,POST`
   - scopes `gitea:issue:read,gitea:issue:write`
   - secret：Gitea token
2. 对话里说：「给 org/repo 提一个 issue，标题 …」。
3. agent 调 `cred_list` → 看到 `gitea`。
4. agent 调 `cred_use({name:'gitea', reason:'提交 issue', scope:'gitea:issue:write'})`。
5. UI 弹审批 → 点「仅本次」。
6. agent 执行：

   ```bash
   curl -sS -X POST "$PROXY" \
     -H "x-pi-target: https://git.example.com/api/v1/repos/org/repo/issues" \
     -H 'content-type: application/json' \
     -d '{"title":"...","body":"..."}'
   ```

   其中 `$PROXY` 是工具返回的租约 URL；真实 token 由服务端注入。
7. 审计出现一条 `action=proxy, method=POST, status=201`。
8. 会话记录里只有租约 URL，没有 token；租约 10 分钟后失效。

---

## 13. 实施阶段

| 阶段 | 内容 | 产出 |
|---|---|---|
| **P0** | 访问控制（bootstrap token → Cookie）+ 加密 vault + env 层 + 设置页 CRUD | 供应商 key 不重启即可换 |
| **P1** | scoped 层 + `cred_list` / `cred_use` + 审批卡片 + 代理 + 审计 | Gitea 场景跑通 |
| **P2** | 轮换、租约撤销、会话级授权、从环境导入、SSE 脱敏、测试连接 | 可日常使用 |
| **P3** | OAuth 设备码、SSH / git push 支持、独立 sidecar 隔离 | 真实安全边界 |

P0 可以独立上线，且立刻解决「改 key 要重启」这个最痛的点。

实现状态：P0 / P1 / P2 已完成，代码见 `server/credentials.ts`、`server/auth.ts`、`web/src/components/CredentialSettings.tsx`。P2 的审计滚动按单文件 5 MB 保留一份 `.1`。

---

## 14. 验收

1. **热更新**：UI 保存 `OPENCODE_API_KEY`，记录当前 server PID；`POST /api/providers/test` 成功；PID 不变；正在生成的会话下一轮正常。
2. **删除即失效**：删除该 env 条目，下一次请求返回未配置；`.env` 里的同名值按优先级说明生效。
3. **不泄露**：完整跑一遍 Gitea 流程后，`grep <token>` 会话 JSONL / server 日志 / SSE 抓包 / `GET /api/credentials` 均为 0 命中；`bash -lc 'env'` 里没有 scoped token。
4. **作用域**：把 `x-pi-target` 改成非白名单 host / 非白名单 path / 未授权 method，均返回 403 且写审计。
5. **审批**：拒绝后工具返回结构化失败；无前端在线时 120s 超时拒绝；`session` 授权只在该会话有效。
6. **重启**：容器重启后 env 层自动恢复、scoped 凭据仍在、所有旧租约 401。
7. **访问控制**：无 Cookie 访问 `/api/credentials` 返回 401；`/?token=xxx` 后 302 到 `/` 且浏览器有 `pi_access` Cookie；刷新、SSE、多标签均正常；`/api/health` 仍可无认证访问。
8. **方法转发**：`GET` 与 `POST` 都能通过代理到达上游；只允许 `GET` 的凭据可用；未在 `allowedMethods` 中的方法返回 403；代理层不支持的方法返回 405。

---

## 15. 风险与开放问题

1. **同容器同 uid = 没有硬边界**。agent 的 `bash` 可以读 `runtime/credentials.key` 和 vault 文件，也可以 `ptrace` 同 uid 进程。v1 的定位是「防误泄露 + 可审计 + 好用」，不是「防恶意 agent」。
   真正的隔离需要：
   - agent 工具跑在独立容器/独立 uid，只挂 workspace；
   - vault 跑在 server 容器，只暴露带租约的代理端口；
   - 或者用 Docker secret / 外部 KMS 让 key 不进容器文件系统。
2. **访问控制已实现，但不是对 agent 的硬边界**。P0 的 bootstrap token → Cookie 挡住了同网段的其他浏览器/脚本；agent 与 server 同 uid，仍能读 `runtime/access-token`，也能读 vault key（见 §0.1、§6）。
3. **env 层对 agent 可见**。审批文案要写清楚；能走 scoped 的尽量不要用 env 层。
4. **git/SSH 支持有限**。HTTPS `git push` 走 §8.4 的 credential helper；SSH key、数据库、gRPC 暂不支持，v2 可加 ssh-agent 转发。
5. **多实例部署**：vault 是本地文件 + 进程内租约，多副本会不一致。当前单容器部署没问题；要横向扩展得换共享存储 + 共享租约表。
6. **密钥轮换**：换 `PI_CREDENTIAL_KEY` 需要一次性迁移；迁移中途崩溃要能回滚（保留旧文件 `.bak`）。
7. **审计体量**：jsonl 已按 5 MB 滚动（旧文件保留为 `.1`）；仍不会无限增长，但要长期留存需外部日志采集。
8. **租约泄露**：租约 URL 会进会话记录，拿到它的人可在 TTL 内使用（受 host/path/method 限制）。缓解：短 TTL、会话绑定、可撤销、审计告警。
