# 安全策略

## 支持范围

只维护 `main` 分支的最新提交。旧版本不打补丁，升级方式就是拉新代码重启。

## 怎么报

**别开公开 issue。** 用 GitHub 的私密报告：

<https://github.com/895252509/turn-pi/security/advisories/new>

或者发邮件到 维护者的 [GitHub 主页](https://github.com/895252509)。请带上：

- 复现步骤与影响（能读什么、能写什么、能越权做什么）
- 版本（`git rev-parse --short HEAD`）与部署方式

## 先理解这个产品的威胁模型

Turn Pi 的**设计目的**就是让一个 AI agent 在你的机器上执行命令、改文件。所以下面这些**不是漏洞**：

- agent 按你的指令删了文件 / 改坏了仓库 / 跑了一个危险的 `bash` 命令
- 你自己把 `docker.sock` 挂进容器（`make up-docker`）——那等于把宿主 root 交给 agent，README 和 compose 里都写了
- 你把服务暴露到公网却没设 `PI_ACCESS_TOKEN`、没用反代做 TLS
- 你自己配置的 MCP server 执行了它自己的代码
- 你让 agent 拿到的凭据去做它能做的事（凭据的 scope 是审批标签，不是权限边界）

## 这些算漏洞，欢迎报

| 类别 | 具体例子 |
|---|---|
| 鉴权绕过 | 不带 token / 用过期 Cookie 访问到 `/api/*`；`?token=` 握手被重放利用 |
| 明文外泄 | 凭据明文出现在会话记录、工具结果、日志、审计流水里；`cred_use` 的代理 URL 可被 agent 复用成通用通道 |
| 出站绕过 | `web_fetch` 抓到环回/私网/云 metadata 地址；重定向到内网；`PI_FETCH_*` 策略被参数覆盖 |
| 路径穿越 | `/api/files/*` 读到 root 之外的文件；worktree / workspace 注册表被写到意外位置 |
| 沙箱逃逸 | codemode 脚本越过 QuickJS 沙箱读写宿主、绕过工具白名单 |
| MCP 管理面 | `/api/mcp/*` 写入任意命令；探测接口把 header 里的密钥回显 |
| git 凭据链路 | 租约过期后仍能用；host 校验可绕过（`host:port` 形式）；token 落进会话 |

## 默认安全姿态（供参考）

- 未设 `PI_ACCESS_TOKEN` 时**自动生成**并打印在启动日志，浏览器需 `?token=` 握手换 HttpOnly Cookie
- 凭据 vault 用 AES-256-GCM 加密，主密钥在 `runtime/credentials.key`；agent 只能拿租约 + loopback 代理
- `readonly` workspace 会摘掉 `bash` / `edit` / `write`；只读工作区不接 MCP
- `web_fetch` 默认拒绝私网与环回地址，出站策略每次调用重读
- 容器**默认不挂**宿主 `docker.sock`

如果你发现上面某一条实际不成立，那就是我们需要修的 bug。
