# 输入触发器：/ 命令与 @ 会话引用

> 状态：已落地 P1–P3。输入框现在共用一套 trigger 管线：`/` 命令、`@` 会话引用，以及后续的文件/工作区引用。

## 1. 结构

```text
Composer
  └─ useInputTriggers
       ├─ /  → createSlashCommandSource() → commandRegistry
       └─ @  → createSessionReferenceSource()
```

- `web/src/lib/input-trigger/`：token 检测、source 注册表、菜单状态、键盘、光标恢复。
- `web/src/lib/commands/`：命令注册表、内置命令、`/` source。
- `web/src/lib/references/`：`@` 会话 token 编解码与候选来源。
- `web/src/components/InputTriggerMenu.tsx`：通用菜单 UI。

## 2. 其他模块注册 / 命令

```ts
import { registerCommand } from '@/lib/commands';

const dispose = registerCommand({
  name: 'my-command',
  label: '我的命令',
  description: '做一件事',
  group: '扩展',
  argumentHint: '[参数]',
  available: (state) => Boolean(state.sessionId),
  run: async (ctx, args) => {
    ctx.toast(`收到：${args}`);
    return { kind: 'none' };
  },
});
```

- 返回 disposer；组件里放在 `useEffect` 的 cleanup 中。
- 同名默认抛错；核心命令用 `{ replace: true }`，外部模块不要依赖覆盖。
- `run` 的返回值：
  - `{ kind: 'none' }` / `{ kind: 'done', toast? }`
  - `{ kind: 'insert', text }`
  - `{ kind: 'submit', text }`
  - `{ kind: 'error', message }`
- 菜单选中不可用命令会提示；直接输入 `/name` 也会走同一套 `available` 校验。
- 未知但语法合法的 `/foo` 会提示“未知命令”并保留草稿；`/workspace/a` 这类路径语法不匹配，按普通文本发送。

## 3. @ 会话引用

插入的纯文本 token：

```text
@[会话标题](session:<sessionId>)
@[会话标题 · 第3轮](session:<sessionId>#turn=3)
```

- 第二个形式就是“引用会话中的某一轮”的预留口；解析、发送协议、server 注入都已支持 `turn`。
- 菜单当前列出活动会话，排除当前会话和已归档会话；按当前工作区/其他工作区分组。
- 发送时客户端解析 token，`/api/chat` 的 `references` 字段带 `{ kind: 'session', id, title?, turn? }`。
- Server 读取目标 session 的文本轮次，作为 `session-references` 隐藏 custom message 注入本轮上下文，不进入可见历史。

### 20k 硬顶

`server/chat.ts` 的 `MAX_REFERENCE_CONTEXT_TOKENS = 20_000`（字符预算 `MAX_REFERENCE_CONTEXT_CHARS` 取同一数值）：

- 按“1 字符 ≤ 1 token”的保守上界计算，因此实际注入不会超过 20k token。
- 最多 3 个引用，重复 `id + turn` 去重。
- 单个引用超预算时截断并标注 `[引用内容已截断]`。

## 4. 交互约定

- `/` 只认行首，避免和绝对路径冲突。
- `@` 可以行内触发；已插入的 `@[...](session:...)` 内部不会再次弹出菜单。
- 菜单打开：`↑↓` 选择，`Enter`/`Tab` 确认，`Esc`/`Shift+Tab` 关闭。
- `Esc` 后同一个 token/query 不自动重开；查询变化后重新出现。
- 菜单、行高亮、分组标题全部使用主题变量，亮暗主题一致。

## 5. 后续扩展

- `@文件` / `@工作区`：新增一个 `InputTriggerSource`，注册到 `inputTriggerRegistry`。
- 轮次选择 UI：调用 `formatSessionReference({ id, title, turn })` 生成 token；server 已按 `turn` 读取。
- 后端模块命令：在 `CommandDefinition` 上增加 `source: 'server'` 和 HTTP 执行通道；当前 v1 只跑客户端命令。
