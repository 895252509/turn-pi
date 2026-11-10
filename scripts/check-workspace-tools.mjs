/**
 * 回归检查：工作区运行期改 readonly（reload）后，已打开会话的工具白名单必须重算。
 *
 * 直接用假 session 驱动 Chat，不连模型、不起服务：
 *   node scripts/check-workspace-tools.mjs
 *
 * 背景见 docs/issues/workspace-readonly-tools-stale.md。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = await mkdtemp(join(tmpdir(), 'pi-ws-check-'));
const wsRoot = join(root, 'ws');
await mkdir(join(wsRoot, 'sub'), { recursive: true });

process.env.PI_RUNTIME_DIR = join(root, 'runtime');
process.env.PI_WORKSPACES_FILE = join(root, 'workspaces.json');
process.env.PI_WORKSPACE = wsRoot;
process.env.PI_WORKSPACE_DISCOVER = 'none';

const serverDir = join(resolve(fileURLToPath(new URL('..', import.meta.url))), 'server');

const writeRegistry = async (readonly) => {
	await writeFile(
		process.env.PI_WORKSPACES_FILE,
		JSON.stringify({
			version: 1,
			workspaces: [{ id: 'workspace', label: 'ws', root: wsRoot, kind: 'dir', source: 'config', readonly }],
		}),
	);
};

await writeRegistry(false);

const workspaces = await import(join(serverDir, 'workspaces.ts'));
await workspaces.initWorkspaces();
const { Chat } = await import(join(serverDir, 'chat.ts'));

/** 只实现白名单 + stats 需要的最小表面。 */
const fakeSession = () => ({
	names: ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write', 'cred_list'],
	messages: [],
	sessionId: 'fake',
	sessionName: null,
	thinkingLevel: 'off',
	model: { provider: 'p', id: 'm', name: 'm', contextWindow: 1000 },
	getSessionStats: () => ({ userMessages: 0, assistantMessages: 0, toolCalls: 0, tokens: {} }),
	getContextUsage: () => ({ tokens: 0, contextWindow: 1000 }),
	getAvailableThinkingLevels: () => [],
	supportsThinking: () => false,
	getAllTools: () => [],
	getActiveToolNames() {
		return [...this.names];
	},
	setActiveToolsByName(names) {
		this.names = [...names];
	},
});

const chat = Object.create(Chat.prototype);
chat.cwd = join(wsRoot, 'sub');
chat.busy = false;
chat.desiredTools = ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write', 'cred_list'];
chat.session = fakeSession();
chat.emitStats = () => {};

const active = () => chat.session.getActiveToolNames();
const has = (name) => active().includes(name);
let failed = 0;
const check = (ok, message) => {
	if (ok) return;
	failed += 1;
	console.error(`FAIL: ${message} → ${JSON.stringify(active())}`);
};

// 1. 可写工作区：写工具可用
check(has('bash') && has('edit') && has('write'), '初始应包含写工具');

// 2. 运行期改成 readonly → reload → 白名单收缩
await writeRegistry(true);
await workspaces.reloadWorkspaces();
check(chat.refreshToolAllowlist(), '只读后 refreshToolAllowlist 应返回 true');
check(!has('bash') && !has('edit') && !has('write'), '只读后不该保留写工具');
check(has('read') && has('ls'), '只读工具不该被误删');

// 3. 反向：改回可写 → reload → 写工具恢复
await writeRegistry(false);
await workspaces.reloadWorkspaces();
chat.refreshToolAllowlist();
check(has('bash') && has('edit') && has('write'), '解除只读后写工具应恢复');

// 4. 生成中不打断本轮，下一轮开始前（prompt 内）再对齐
await writeRegistry(true);
await workspaces.reloadWorkspaces();
chat.busy = true;
check(!chat.refreshToolAllowlist(), 'busy 时不应直接改工具');
check(has('bash'), 'busy 时工具不该被提前改掉');
chat.busy = false;
chat.applyToolAllowlist();
check(!has('bash'), '下一轮开始前应已收缩');

// 5. 只读期间客户端回传的工具集缺写工具 → 解除只读后仍能恢复
chat.setTools(['read', 'grep', 'find', 'ls', 'cred_list']);
await writeRegistry(false);
await workspaces.reloadWorkspaces();
chat.refreshToolAllowlist();
check(has('bash') && has('write'), '只读期间 setTools 不该丢掉写工具');

// 6. 可写状态下用户主动关掉 bash → 只读再恢复后仍尊重用户选择
chat.setTools(['read', 'grep', 'find', 'ls', 'edit', 'write', 'cred_list']);
await writeRegistry(true);
await workspaces.reloadWorkspaces();
chat.refreshToolAllowlist();
await writeRegistry(false);
await workspaces.reloadWorkspaces();
chat.refreshToolAllowlist();
check(!has('bash'), '用户主动关掉的 bash 不该被补回');

await rm(root, { recursive: true, force: true });
if (failed) {
	console.error(`workspace-tools check: ${failed} 项失败`);
	process.exit(1);
}
console.log('workspace-tools check: ok (6/6)');
