# Agent 模板（CARD）· 已实现部分

> 状态：已落地（`#/agents` 模块 + `/api/agents/*` + 会话按 CARD 装载）
> 范围：手工组装岗位、预览、fork / 合并回、新对话选模板
> 未做（明确留白）：自动派活（dispatch）、岗位记忆与合并、lease / 多激活、订阅与线程
> 设计背景：`docs/agent-hub.md`（草案，本体论那部分**不要**按本文当成已实现）

---

## 0. 一页结论

- **唯一真相是磁盘上的 `CARD.md`**。页面只是它的编辑器，不建 `state.json`、不在内存里存"当前值"。
- **预览必须来自真实装载**：建一个 `SessionManager.inMemory()` 的 dry-run 会话，读 `session.systemPrompt` / `getActiveToolNames()` / `getAllTools()`。前端不重拼提示词 —— 拼两遍必然分叉，而分叉正是这个页面要消除的东西。
- **fork 有方向，合并只有一个方向**：`base → domain`（永不并回）、`domain|variant → variant`（可并回父模板）；`base` 永远不能作为合并目标，`main` 永远不能 fork。
- **合并只并配置**（工具 / 技能 / 提示词 / 模型 / 思考 / 说明 / 域）。岗位记忆还没有存储，所以不做记忆合并，也不假装能做。
- 工具的真相在代码里（`PI_TOOLS` + SDK 注册表），CARD 只是"选择"。两边会静默分叉 —— 由 `npm run check:agent-card` 兜住。
- **CARD.md 是 `docs/agent-spec.md` 那份 spec 的序列化格式**，不是第二套配置。翻译层 `server/agent-spec.ts` 已写好但未接线，靠 `npm run check:agent-spec` 与现有装配逐字节对比钉住等价（见 §6）。

## 1. 文件与接口

| 件 | 作用 |
|---|---|
| `server/agents.ts` | 发现 / 解析 / 校验 / 原子写 / fork / 合并 / dry-run 预览 / 工具注册表 |
| `server/session-config.ts` | **装载配置的唯一组装路径**：`appendSystemPrompt`、codemode 强制段、skillsOverride、扩展 |
| `server/chat.ts` | `Chat.create({ card })`：工具集 / 模型 / 思考 / 提示词 / 技能全部从 CARD 来；模板 id 写进 session custom entry |
| `web/src/components/AgentsView.tsx` | 三列：模板列表 / 编辑器 / 预览 |
| `scripts/check-agent-card.mjs` | CI：CARD 声明的工具必须真的注册过 |

| 接口 | 说明 |
|---|---|
| `GET /api/agents` | `{ agents, tools, skills, pinnedTools }`；`skills` 是技能库里的条目 |
| `POST /api/agents/preview` | 入参 `{ card }`，返回 dry-run 的 system / toolsText / skills / token 估算 / warnings |
| `POST /api/agents/save` | 入参 `{ card }`；写 `CARD.md`（`.tmp` + rename）；返回卡片 + warnings |
| `POST /api/agents/fork` | 入参 `{ id, name?, domain? }` |
| `POST /api/agents/merge-diff` | 与父模板比较，返回 `changes[]` 或 `blocked` |
| `POST /api/agents/merge` | 入参 `{ id, fields? }`，把选中字段写回父模板 |

## 2. CARD 字段

```yaml
---
id: agent-hr
kind: domain            # base | domain | variant | orchestrator（由 parent 推导，不由调用方指定）
domain: hr
appliesTo: [hr, payroll]
tools: [read, grep, find, ls, bash, edit, write]
skills: [pdf@sha256:9f2c…]   # 钉住的技能引用；空 = 不注入
model: opencode-go/deepseek-v4.1-flash
thinking: high
description: 薪酬分摊              # 新增：新对话选择器里的一行说明
parent: base
forkedAt: 2026-11-06T…
forkOffset: 0
expiresAt: null
external: false
maxActive: 1
status: active
---
岗位说明正文 = 追加到系统提示词的片段。
```

三处容易误解的地方：

1. **`tools` 是"模型可见的工具集"，不是"注册表"**。没出现在 `PI_TOOLS` 里的名字不会注册，CARD 里写了也没用（页面会标「未注册」，`check:agent-card` 会报错）。
2. **`skills` 为空 ≠ 没有技能**。为空时走原来的域自动授权（`applicableBundles(state, agentId, domain)`）；一旦钉住就只注入钉住的，并且做 `id@sha256` 校验 —— hash 不符时**跳过注入并告警**，不把替换后的内容当成原来那份。
3. **`cred_list / cred_use` 关不掉**。它们是产品固定出口，建会话时总会被加回 allowlist（页面显示「固定」）。

## 2.1 base 的正文是**岗位基线**，不是维护说明

`runtime/agents/base/CARD.md` 的正文会被 fork **原样继承**（`forkAgent` 是 `{...parent}` 复制），
而正文 = 写进系统提示词的 `<addendum>`。所以 base 的正文必须是**给模型看的岗位通用规则**。

它曾经写的是"这个文件该怎么改""只允许被 fork"之类的维护说明 —— 那 249 字符会让**每一个**
新岗位的系统提示词都带上一段描述 base 自己的元信息（约 63 tokens 纯噪声，语义还是错的）。
现在挪到这里：

| base 的规则 | 属于 |
|---|---|
| 只读、不可激活（`maxActive: 0`）、只能被 fork、记忆恒为空 | **本文**（维护约束） |
| 从 base fork 出的子模板 `kind=domain`，永不 merge-back | **本文** + `docs/agent-governance.md` §3 |
| 改 base 等于改所有**未来**岗位的默认值，已派生岗位持有副本不自动跟 | **本文** |
| 先读再改 / 口径只认已记录 / 留下可复用做法 / 说清边界 / 解释改动 | **CARD 正文**（模型可见） |

判定"新建岗位默认 fork base"是安全的：线上 `runtime/agents/` 只有 `base`，`kind=base` 全库唯一，
且 `maxActive: 0` 表明它不可激活。fork 后 `kind` 自动变 `domain`、`maxActive` 变 1。

## 3. 会话怎么用上 CARD

```ts
// server/index.ts —— POST /api/chat
const card = requestedAgent ? await cardById(requestedAgent) : undefined;
if (requestedAgent && !card) return 400;          // 选了但不存在 = 报错，不静默回退
```

- 没选模板 = 老行为（`PI_TOOLS` + 设置勾选），完全不变。
- 选了模板：`desiredTools = card.tools + 固定出口`；模型 / 思考级别 / 系统提示词 / 技能都按 CARD。
- 模板 id 作为 `agent-template` custom entry 写进 session（不参与上下文），**重开 / 服务重启后按它恢复**；否则重开一个 CARD 会话会悄悄退回环境默认工具集。
- 会话内改不了模板：换工具集等于重建提示词，prompt cache 全掉。要换就新建会话。

## 4. 预览的降级

dry-run 会话建不起来（模型不可用、凭据缺失）时，预览不会假装成功：`degraded` 字段会说明"下面是按文本长度估算的"，页面用黄色条显示。

## 5. 已知留白（别顺手补成半套）

- **dispatch / 多智能体派活**：`mainAgent/CARD.md` 里写的 `dispatch / send / status / remember` 目前**不存在**。`npm run check:agent-card` 就是用来把这件事显性化的 —— 在实现之前它一直会是红的。
- **岗位记忆**：`memory/journal.jsonl` 还没接，所以合并只并配置。
- **lease / 多激活 / 订阅**：属于 `agent-hub.md` 的本体，等有真实岗位跑起来再定。
- **新对话选择器的能力摘要**（工具数 / token）：只有 `N 工具 · M 技能`，token 要等选完才在预览里看。

## 6. 与 AgentSpec 的关系

同一个东西的两个视角，不是两份配置：

| | 回答什么 | 在哪 |
|---|---|---|
| `docs/agent-spec.md` | **这个 agent 怎么装**（字段 → pi 入参） | `server/agent-spec.ts`（纯翻译，未接线） |
| `docs/agent-governance.md` | **谁从谁来、怎么并回去、版本怎么管** | `server/agents.ts`（fork / merge）+ 待做的基线 |
| 本文 | **谁可以 fork 谁、并回哪里、页面怎么编辑** | `server/agents.ts` + `#/agents` |

CARD frontmatter 里 `kind / domain / appliesTo / parent / expiresAt / maxActive / status` 属于编排元数据，
pi 不认识；`prompt / tools / skills / model / thinking` 才是 spec 字段。新增字段时两边都要动：
`parseCard` / `serializeCard` / `mergeDiff`（漏一处 = 保存一次就抹掉），再同步 spec 的翻译与对比用例。

`npm run check:agent-spec` 的三组断言（映射 / 未注册名字报错 / 逐字节对比）就是为了让"配置写了"和
"会话真的装了"这两件事在对不上时立刻红 —— 和 `check:agent-card` 同一套思路，只是管的是另一段。
