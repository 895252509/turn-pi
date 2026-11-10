# skill 接入方案：全局存储 + 模板组合

> 状态：**v1 已实现**（store / 组合 / 审计 / loader 接线 / 左侧 rail 技能市场）。
> 技能注入只有一条通道：技能库 → `server/skill-blocks.ts` 的 `blocksForPinned`，
> AgentTemplate 只钉引用（`name` 或 `name@sha256:<前缀>`）。
> 范围：v1（外部 skill 来源接入 + 内容寻址 store + 有序组合；AgentTemplate 尚未落地，先用全局 selection 承载同一语义）
> 目标读者：接手实现的工程师
> 依据：pi SDK 1.5.0（skill / loader 接口与 1.4.0 一致；本仓库已升到 1.5.0）的 `dist/core/resource-loader.js`、`dist/core/skills.d.ts` + 本仓库现状（`server/chat.ts`、`server/skill-blocks.ts`）
> 关联：`docs/agent-templates.md`（AgentTemplate 的 `skills` 字段）

**目录**：[0. 一页结论](#0-一页结论) · [1. 目标与非目标](#1-目标与非目标) · [2. 现状](#2-现状) · [3. 数据模型](#3-数据模型) · [4. 架构](#4-架构) · [5. SDK 接口对照](#5-sdk-接口对照) · [6. 解析规则](#6-解析规则) · [7. 来源接入](#7-来源接入) · [8. 服务端 API](#8-服务端-api) · [9. 前端](#9-前端) · [10. 迁移路径](#10-迁移路径) · [11. 验收](#11-验收) · [12. 风险与坑](#12-风险与坑) · [13. 开放问题](#13-开放问题)

---

## 0. 一页结论

skill 不需要安装隔离（不像插件要 node_modules 和进程隔离），**只需要可见性隔离**：

- **存储全局一份**，内容寻址：`runtime/skillstore/<source>/<name>/<sha12>/`
- **生效按模板组合**：`AgentTemplate.preset.skills` 是**有序引用列表**，解析成绝对路径
- **注入用** `noSkills: true` + `additionalSkillPaths` —— 精确集合，不掺任何默认目录
- **收权用** `skillsOverride` —— 未审计 skill 翻转 `disableModelInvocation`，不进 prompt 但可手动 `/skill:name`
- **换模板用** `session.reload()` —— 不重启进程

四条规则一句话：**打包看内容寻址，生效看模板列表，收权看 override，升级看 reload。** 全部在 SDK 现有 API 内，不改上游。

**最关键的一条约束：全局存储位置绝不能是自动发现目录。** 放进 `~/.pi/agent/skills`、`<ws>/.pi/skills`、`.agents/skills` 就等于全局对所有会话生效，模板组合立刻破功，而且 `pi` CLI 也会看到。

---

## 1. 目标与非目标

### 目标

| # | 目标 | 判定 |
|---|---|---|
| G1 | 同一个 skill 全局只存一份，多个模板共享 | store 里同一 treeHash 只有一个目录 |
| G2 | 每个 AgentTemplate 只看到自己组合的 skill | 会话 system prompt 中的 skill 列表 == 模板列表（+ 模板启用插件贡献的） |
| G3 | 接外部市场：只要求对方是 `SKILL.md` 目录（Agent Skills 规范） | 装入 store 后 `loadSkillsFromDir` 无 error 诊断 |
| G4 | 未审计内容不进 system prompt | 未审计 skill 不在 prompt，`/skill:name` 仍可用 |
| G5 | 换组合不重启进程 | `session.reload()` 后新集合生效 |
| G6 | 每个 skill 可溯源到来源与内容哈希 | 组合面板显示来源 + hash 前 12 位 |

### 非目标（v1 明确不做）

- 不做公共市场（发现靠 npm registry / 外部站点，见 §7.1）
- 不做 skill 内的脚本沙箱（skill 的脚本走 `bash` 工具，等价于 agent 权限）
- 不做 skill 版本号语义化（内容哈希即版本）
- 不做跨进程隔离（那是插件方案的问题，不是 skill 的）

---

## 2. 现状

三个必须知道的事实（都带行号，实现前请自行核对）：

1. **pi 原生 skill 被整个关掉了**
   `server/chat.ts:1243-1252`：

   ```ts
   const loader = new DefaultResourceLoader({
     cwd: this.cwd,
     agentDir: AGENT_DIR,
     noSkills: true,              // ← skill 系统关闭
     noPromptTemplates: true,
     noThemes: true,
     noContextFiles: true,
     appendSystemPromptOverride: () => [],
     extensionFactories: [injector],
   });
   ```

2. **技能正文由 `skill-blocks.ts` 解析**
   `before_agent_start` 时按 CARD 钉住的引用读 `SKILL.md`（现读现算 sha256），
   拼成一段 custom message 注入；没钉就什么都不注入。

**结论**：技能来源只有技能库一处，模板只负责「钉哪几个」。

---

## 3. 数据模型

### 3.1 SkillSource（存储侧）

```ts
type SkillSource =
  | { kind: 'market'; id: string; url?: string }   // 外部市场 / 站点 / npm 包名
  | { kind: 'local'; path: string }                // 本地目录（不进 store，直接引用）
  | { kind: 'package'; package: string }           // pi 包自带的 skills/（由插件通道贡献）

interface SkillEntry {
  name: string;            // 目录名 + frontmatter.name（不一致时告警）
  source: SkillSource;
  treeHash: string;        // sha256(排序后的 (相对路径, 文件sha256)) —— 整个目录，不是只 SKILL.md
  dir: string;             // store 内绝对路径
  trust: 'audited' | 'unreviewed' | 'blocked';
  hasScripts: boolean;     // 目录内是否存在可执行脚本（scripts/ 或 *.sh/*.py/*.js）
  specFields: {            // 从 frontmatter 读出的规范字段（agentskills.io）
    description?: string;
    license?: string;
    compatibility?: string;
    allowedTools?: string[];
    disableModelInvocation?: boolean;
  };
  installedAt: number;
  installedBy: string;     // principal（现在恒为 'owner'）
  bytes: number;
}
```

**为什么是 treeHash 而不是 SKILL.md 的 hash**：skill 的行为由 `scripts/` + `references/` 一起决定。只 hash 正文会让"正文没变但脚本被换"这种投毒无法被审计发现。

### 3.2 AgentTemplate 侧（组合侧）

```jsonc
{
  "preset": {
    "skillsMode": "only",          // only | add
    "skills": [                    // 有序：先列出的优先级更高
      "market:pdf-tools@sha256:ab12cd34",
      "local:/workspace/x/skills/review"
    ],
    "skillsPolicy": {
      "onConflict": "template-order",  // template-order | error | last-wins
      "maxSkills": 30,                 // 超出的在 UI 标红，不静默截断
      "unreviewed": "manual-only"      // manual-only | prompt（默认 manual-only，见 §6.3）
    }
  }
}
```

`@sha256:...` 是可选的 pin：缺省时取 store 中该 name 的最新 hash，并在 UI 标注"未 pin"。

---

## 4. 架构

```
      ┌─────────────── 网络 / 本地 ───────────────┐
      │ npm registry · 市场站点 · 本地目录 · git   │
      └───────────────────┬───────────────────────┘
                          │ fetch（带 treeHash 计算）
                  ┌───────▼────────┐
                  │  Store（磁盘）  │  runtime/skillstore/<source>/<name>/<sha12>/
                  │  内容寻址、只读  │  ← 不在任何自动发现目录下
                  └───────┬────────┘
                          │ 索引：runtime/skills.json（name→entry[]，含 trust/pin）
                  ┌───────▼─────────┐
                  │  Registry（内存）│  查名字、查 hash、查 trust、找更新
                  └───────┬─────────┘
                          │ 组合：模板 preset.skills → 有序绝对路径
                  ┌───────▼─────────┐
                  │  Composer       │  去重 / 冲突 / 预算 / 插件贡献叠加
                  └───────┬─────────┘
                          │ additionalSkillPaths + skillsOverride
                  ┌───────▼─────────┐
                  │  Loader（每会话）│  noSkills:true
                  └───────┬─────────┘
                          │ session.reload()
                      系统提示中的 skill 列表
```

四层职责边界：**Store 不解释组合，Composer 不碰磁盘之外的网络，Loader 不知道来源**。这样加第 N 个市场只是加一个 fetcher，改组合规则只动 Composer。

---

## 5. SDK 接口对照

实现时只需要这六个入口，全部在 1.5.0 仍然可用（本仓库实际依赖版本）：

| 接口 | 语义 | 证据 |
|---|---|---|
| `new DefaultResourceLoader({ cwd, agentDir, noSkills, additionalSkillPaths, skillsOverride, ... })` | 每会话一份 | `dist/core/resource-loader.d.ts` |
| `noSkills: true` | `skillPaths = merge(cliEnabledSkills, additionalSkillPaths)` —— **只剩显式路径** | `resource-loader.js:424-427` |
| `loadSkills({ skillPaths, includeDefaults: false })` | loader 不做独立默认扫描；默认目录是通过 package 解析进 `enabledSkills` 的，因而同样被 `noSkills` 关掉 | `resource-loader.js:626-631`、`package-manager.js:2013-2023` |
| `skillsOverride(base)` | 后置改写：过滤 / 重排 / 翻转 `disableModelInvocation`；入参含 `name/description/filePath/baseDir/sourceInfo` | `resource-loader.js:637`、`skills.d.ts:9-16` |
| `extendResources({ skillPaths })` | **不受 `noSkills` 影响**，插件贡献的 skill 会叠加到组合之上 | `resource-loader.js:323-339` |
| `session.reload()` | 重载 settings + 资源 + 重建 runtime（`session_shutdown{reason:"reload"}` → `session_start{reason:"reload"}`） | `agent-session.js:2998-3032` |

两个来自 `docs/skills.md` 的硬规则：

- **同名冲突保留"先发现的"并告警** → 优先级只能靠数组顺序表达，且必须由我们显式排序（§6.2）
- `disable-model-invocation: true` 的 skill **不进 system prompt**，但手动 `/skill:name` 仍可用 → 这是"收权"的现成机制（§6.3）

---

## 6. 解析规则

### 6.1 顺序 = 优先级

`additionalSkillPaths` 是有序数组，`loadSkills` 按顺序发现，先发现的胜出。因此 **Composer 输出的数组顺序就是语义**：

```
模板显式列表（按列出顺序）
  → 模板启用插件贡献的 skills（extendResources，追加在后）
    → （skillsMode: add 时）全局默认目录
```

`onConflict`：

- `template-order`（默认）：按上面顺序先到先得，重复项丢弃，**UI 必须显示被谁压掉**
- `error`：解析阶段直接失败，模板不可用（适合团队模板，作者显式声明依赖）
- `last-wins`：反序（慎用，只用于"用户覆盖"场景）

### 6.2 去重在 Composer，不在 pi

理由：pi 的"first wins"取决于数组顺序，如果我们把顺序交给注册表遍历或市场返回顺序，冲突结果不可复现。**Composer 必须先按 name 去重，再交给 loader**，并且把冲突记进组合结果（供 API 和 UI 使用）。

### 6.3 信任分级

| 级别 | 进 prompt | 可手动调用 | 进入条件 |
|---|---|---|---|
| `audited` | ✅ | ✅ | 人工审计后标记（写审计记录：谁、何时、treeHash） |
| `unreviewed` | ❌（`disableModelInvocation` 被置 true） | ✅ | 新装入的默认状态 |
| `blocked` | ❌ | ❌ | 显式拉黑 / 审计发现风险 |

`unreviewed` 的实现：

```ts
skillsOverride: (base) => ({
  skills: base.skills.map((s) =>
    trustOf(s.filePath) === 'unreviewed' ? { ...s, disableModelInvocation: true } : s),
  diagnostics: base.diagnostics,
})
```

效果：市场里装了 200 个未审计 skill，模型完全看不见（不占 prompt），手动 `/skill:name` 照样能用。**unreviewed → audited 是人的动作，不是自动的。**

> 注意：`hasScripts: true` 的 skill 默认应为 `unreviewed`，哪怕来源自称可信。审计时至少要读一遍 `scripts/`。

### 6.4 预算

- 每个 skill 的 name + description 常驻 system prompt，约 100 token
- 模板默认 cap 30（≈3k token），超过 20 在 UI 提示，超过 30 拒绝保存（`error`，不静默截断）
- 组合面板显示实时估算；`CTX` 明细的 `skills` 桶应等于真实 prompt 中该段长度（见 §11 A6）

---

## 7. 来源接入

### 7.1 market

**不做自己的注册协议，把外部当货架。** 两种抓取方式：

1. **npm**：`registry.npmjs.org/-/v1/search?text=keywords:pi-package`（已验证可用，返回 name/version/description/monthly downloads）。包内 `pi.skills` 指向 `skills/` 目录 → 但注意 pi 的安装单位是包，我们只**解包取目录**，不执行 npm install（skill 是纯文本，无需依赖）。
2. **Agent Skills 站点 / git 仓库**：只接受"目录含 `SKILL.md`"的形态；git 源按 commit pin，不跟分支。

流程：

```
fetch → 校验目录结构（必须有 SKILL.md 且 frontmatter 有 name/description）
      → 计算 treeHash → 若 store 已有同 hash 则直接返回（去重）
      → 写 store（先写临时目录，再原子 rename）
      → 索引记 trust: 'unreviewed'、hasScripts、specFields
```

**市场目录（v1 前端）**：不预装技能，只收录几个公开仓库，打开技能页时拉目录：

| 仓库 | License | 技能数（约） |
|---|---|---|
| `obra/superpowers` | MIT | 15 |
| `mxyhi/ok-skills` | Apache-2.0 | 36 |
| `gamedev-skills/awesome-gamedev-agent-skills` | Apache-2.0 | 77 |
| `anthropics/skills` | Apache-2.0 + source-available 文档技能 | 19 |
| `openai/skills` | 每个技能各自的 LICENSE | 44；官方已标 deprecated |

目录来自 GitHub API（star/fork/commit），SKILL.md 正文来自 `raw.githubusercontent.com` 并按 commit 固定；
缓存 `runtime/skill-market.json` 15 分钟。OpenAI 官方仓库已标 deprecated，卡片/来源只做「弃用」提示，不阻断浏览和安装；
`openai/plugins` 的插件结构不在本版适配范围。卡片显示来源 / 分类 / star / fork / 本地安装数，
详情页左右对照原文与默认大模型生成的中文翻译（按内容 hash 缓存）。技能模块只读写技能库，不碰会话数据。

市场侧不需要版本号：**treeHash 就是版本**。升级 = 新 hash 目录并存，模板 pin 决定用哪个。这让"升级"天然可回滚。

### 7.2 local

直接引用绝对路径，不进 store、不复制。用于开发期自写 skill。约束：路径必须在某个已注册 workspace 内（避免任意读盘），且 `treeHash` 每次 resolve 现算（本地可变）。

### 7.3 package（插件贡献）

不需要我们做：模板启用插件后，包的 `skills/` 由 `extendResources` 自动叠加（`resource-loader.js:323-339`，绕过 `noSkills`）。

**但必须在 UI 标注来源**，否则会出现"我明明关了插件，怎么还有个 terminal 的 skill"。用 `Skill.sourceInfo` 渲染来源徽标。


## 8. 服务端 API

新增 `server/skills.ts`（store + registry + composer 三块，均为纯函数 + 一个薄 IO 层）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/skills` | 已安装列表（trust/hash/source/hasScripts）+ 当前组合 + 冲突 + token 估算 + 诊断 |
| GET | `/api/skills/market?refresh=1` | GitHub 市场目录：来源 star/fork、技能卡片、分类、本地安装数 |
| GET | `/api/skills/market/item?source=&path=` | 单个技能的 SKILL.md 原文 |
| POST | `/api/skills/market/translate` | `{ source, path }` → 默认大模型中文翻译（按内容 hash 缓存） |
| POST | `/api/skills/install` | `{ source, activate? }` → 本地目录 / npm 包 / git / 单个 `SKILL.md` URL；`activate` 时同时加入有序组合 |
| POST | `/api/skills/audit` | `{ name, treeHash, trust, note }` → 写审计记录（谁/何时/hash），`trust` = audited / unreviewed / blocked |
| POST | `/api/skills/select` | `{ refs, mode?, policy? }` → 改写有序组合；校验 cap 与 `onConflict: error` |
| POST | `/api/skills/refresh` | `{ name? }` → 现算本地来源的 treeHash；内容变了自动回到 unreviewed |
| POST | `/api/skills/remove` | 仅当组合未引用时允许删除；本地来源只出索引，不删源目录 |
| POST | `/api/session/:id/skills/apply` | 更新 loader 的 `additionalSkillPaths` → `session.reload()`；**前置：该会话 `busy === false`** |

v1 还没有 AgentTemplate：组合存在 `runtime/skills.json` 的 `selection`，语义与 `preset.skills` 相同（有序 refs + cap + conflict 策略）。
AgentTemplate 落地后，把 `selection` 换成模板的 `preset` 即可，Composer / loader 接线不用改。

---

## 9. 前端

**实现位置：左侧 icon rail 的「技能」入口**（`#/skills`），复用 app shell 的「模块 + 上下文列」两轴：

- 第二列：搜索、来源（star/fork/已装数）、分类、只看已安装
- 主面板：技能以**卡片**展示（名称 / 描述 / 来源 / 分类 / star / fork / 本地安装数 / 安装按钮）
- 点卡片打开详情：原文 SKILL.md 与默认大模型中文翻译左右对照；翻译按内容 hash 缓存
- 安装会写入内容寻址 store，并加入有序组合；未审计仍是 `unreviewed`，需审计后才进 prompt

- 左：可用 skill 列表（来源徽标 / trust 徽标 / hash 前 12 位 / 是否含脚本 / 大小）
- 右：当前模板的组合列表（可拖拽排序 = 优先级），底部显示 `估算 token / cap`
- 冲突：同名项就地标红，tooltip 说明"被第 N 项覆盖"
- 未审计：`unreviewed` 徽标 + 「仅手动调用」说明；`audit` 按钮写审计记录
- 顶部：`skillsMode`（only/add）切换 + 「应用到本会话」（调 `apply`，生成中禁用）

**只读 workspace**：skill 本身可读，但含脚本的 skill 在该 workspace 下会在徽标上标"脚本不可用（工具已禁用）"。别让用户点半天才发现跑不了。

---

## 10. 迁移路径

| 阶段 | 内容 | 可独立验收 |
|---|---|---|
| S1 ✅ | `server/skills.ts`：`skillstore` + `skills.json` 索引 + `install/audit/select/refresh/remove` API | store 里同 hash 只有一份；treeHash 稳定 |
| S2 ✅ | Composer + loader 接线：用全局 `selection` 当 v1 的模板组合，`noSkills:true + additionalSkillPaths + skillsOverride` | 未审计不进 prompt；apply 走 `session.reload()` |
| S4 ✅ | 左侧 rail 技能市场：卡片 / 搜索 / 分类 / star·fork·安装数 / 原文+中文对照 / 安装 / 应用到本会话 | `npm run check:web` + 手动全链路 |

每阶段结束跑 `npm run check:web`（typecheck + build + happy-dom smoke）。S2/S4 触到 UI 时补一条 smoke：组合两个 skill，断言构建产物里出现两个名字。

---

## 11. 验收

可测断言，实现时逐条钉进测试或手动清单：

- **A1** 同名不同 hash：store 下两个目录并存；两会话分别 pin，prompt 各自正确
- **A2** 全局去重：5 个模板引用同一 hash，`skillstore` 下只有 1 个目录（`du` 验证）
- **A3** 组合精确：`noSkills:true` 下，prompt 里的 skill 集合 == 模板列表（无默认目录泄漏）
- **A4** 未审计不进 prompt，但 `/skill:name` 可用
- **A5** 冲突按模板顺序：`A` 与 `B` 同名，模板写 `[A, B]` 得 A，写 `[B, A]` 得 B，且 API 报告冲突
- **A6** CTX `skills` 桶 ≈ 真实 prompt 中 skills 段字符数（误差 < 5%）
- **A7** `apply` 后不重启进程，新 skill 在下一轮可用；`busy` 时返回 409
- **A8** 插件贡献的 skill 在禁用插件后消失（`extendResources` 语义验证）

---

## 12. 风险与坑

1. **自动发现泄漏（最严重）**：store 一旦落在 `~/.pi/agent/skills`、`<ws>/.pi/skills`、`.agents/skills`，所有会话立刻全量可见。**store 必须在 `runtime/` 下，且加一条启动自检**：若 store 路径命中任一默认发现目录，启动即失败。
2. **插件 skill 偷偷叠加**：`extendResources` 绕过 `noSkills`。模板禁用插件前，UI 必须能回答"这个 skill 是谁给的"。
3. **prompt 膨胀**：name+description 常驻，市场装 200 个就是 2 万 token。cap + `unreviewed` 不进 prompt 两个机制必须同时有。
4. **`unreviewed` 不等于安全**：它只是不进 prompt。手动 `/skill:name` 之后仍是同一段文本，仍可能包含"把凭据贴出来"这类钓鱼指令。审计要看内容，不只是看有没有脚本。
5. **相对路径**：skill 正文里的相对路径按 `baseDir` 解析，pi 会把路径告诉模型。store 路径要稳定且可读（`<name>/<sha12>`，name 在前），否则报错信息人类看不懂。
6. **本地来源的哈希不稳定**：`local` 每次现算 treeHash，更新检测会频繁变动。建议本地来源在 UI 上标注"开发中，不参与审计"。
7. **`session.reload()` 语义**：它会重建扩展 runtime（`session_shutdown{reason:"reload"}`），扩展里的 session 级状态会丢。`apply` 只应在空闲时调用——这不只是"不打断对话"，也是"不丢扩展状态"。
8. **S3 迁移不是等价重构**：全文注入 → 按需读，会改变模型行为（可能少用 skill）。必须用轨迹对比，不能凭感觉宣布完成。

---

## 13. 开放问题

| # | 问题 | 现状倾向 |
|---|---|---|
| Q1 | market 的 `unreviewed` 是否允许"由 workspace owner 一次性批量审计"？ | 倾向允许，但记录 hash，内容一变回到 unreviewed |
| Q2 | 一个模板引用 30 个 skill 是否过多？ | 先按 cap 30 跑，用真实会话的"skill 使用率"数据再调 |
| Q3 | skill 与插件同名冲突（插件带的 skill 与你 pin 的同名）如何裁决？ | 倾向"模板显式项 > 插件贡献"，与 §6.1 顺序一致 |
| Q4 | 是否允许 skill 跨模板共享"已审计"状态？ | 是（审计的对象是 treeHash，不是引用关系），但审计记录要显示引用计数 |
