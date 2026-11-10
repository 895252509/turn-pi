/**
 * 回归检查：MCP 接线是否通（不连模型、不起 HTTP 服务）。
 *
 * 直接走平台真实的装配路径：createSessionLoader（server-config.ts）→ createAgentSession →
 * bindExtensions → SDK mcp 扩展连 stdio 服务器 → 工具以 `mcp__<server>__<tool>` 注册。
 *
 *   node scripts/check-mcp.mjs
 *
 * 验四件事：
 *   1. 配置读得出来（server/mcp.ts 的 readMcpFile）
 *   2. session_start 之后服务器真的连上、工具注册进来
 *   3. 默认 exposure=codemode：工具不在 active（不进模型工具声明），但在 callable（codemode 能调）
 *   4. 工具真的能执行（直接调注册的工具定义，绕过需要 assistant message 的嵌套调用管线）
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = resolve(fileURLToPath(new URL('..', import.meta.url)));
const serverDir = join(here, 'server');
const fixture = join(here, 'scripts', 'fixtures', 'mcp-echo-server.mjs');

const root = await mkdtemp(join(tmpdir(), 'pi-mcp-check-'));
const agentDir = join(root, 'agent');
const cwd = join(root, 'ws');
await mkdir(agentDir, { recursive: true });
await mkdir(cwd, { recursive: true });

const mcpFile = join(root, 'mcp.json');
await writeFile(
	mcpFile,
	JSON.stringify(
		{
			mcpServers: {
				check: {
					// 用当前 node 起 fixture：不依赖 npx / 网络
					command: process.execPath,
					args: [fixture],
					description: 'smoke check fixture',
				},
			},
		},
		null,
		2,
	),
);

const failures = [];
const ok = (message) => console.log(`  ok  ${message}`);
const fail = (message) => {
	failures.push(message);
	console.log(`  FAIL ${message}`);
};
const check = (condition, message) => (condition ? ok(message) : fail(message));

const { readMcpFile } = await import(join(serverDir, 'mcp.ts'));
const state = readMcpFile(mcpFile);
check(state.errors.length === 0, `配置无错误（${state.errors.join('；') || '无'}）`);
check(state.servers.length === 1 && state.servers[0].name === 'check', '配置里读到一个服务器 check');

const { createSessionLoader } = await import(join(serverDir, 'session-config.ts'));
const { createAgentSession, SessionManager } = await import('@earendil-works/pi-coding-agent');

const loader = createSessionLoader({
	cwd,
	agentDir,
	skillEntries: [],
	skillPaths: [],
	codemode: 'auto',
	// 与 chat.ts 一致：codemode 工具在、MCP 开
	mcp: { enabled: true, configFile: mcpFile },
});
await loader.reload();

const created = await createAgentSession({
	cwd,
	agentDir,
	// 平台真实的白名单形状：不含 mcp__ 前缀
	tools: ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write', 'codemode'],
	resourceLoader: loader,
	sessionManager: SessionManager.inMemory(),
});
const session = created.session;

const extensionErrors = [];
await session.bindExtensions({
	onError: (err) => extensionErrors.push(`${err?.extensionPath ?? '?'}: ${err?.error?.message ?? err?.error ?? err}`),
});

const TOOL = 'mcp__check__echo';
const deadline = Date.now() + 20_000;
let info;
while (Date.now() < deadline) {
	info = session.getAllTools().find((tool) => tool.name === TOOL);
	if (info) break;
	await new Promise((r) => setTimeout(r, 100));
}

check(Boolean(info), `服务器连上，工具 ${TOOL} 已注册（${((20_000 - (deadline - Date.now())) / 1000).toFixed(1)}s）`);
check(extensionErrors.length === 0, `扩展无错误（${extensionErrors.join('；') || '无'}）`);

if (info) {
	// SDK 把 codemode exposure 在 ToolInfo 里归并成 "deferred"（tools.js:25）：都是「不声明给模型」。
	check(info.exposure !== 'direct', `未直接声明给模型（exposure=${info.exposure}）`);
	check(!session.getActiveToolNames().includes(TOOL), '不在 active 工具里（不占模型工具声明）');
	const callable = session.getCallableToolNames();
	check(callable.includes(TOOL), '在 callable 工具里（codemode 脚本能调）');
	check(session.getActiveToolNames().includes('codemode'), 'codemode 仍处于 active');

	const registered = session.extensionRunner.getAllRegisteredTools().find((tool) => tool.definition.name === TOOL);
	check(Boolean(registered), '注册表里有可执行的定义');
	if (registered) {
		try {
			const result = await registered.definition.execute('check-call-1', { text: 'hello' }, undefined, undefined);
			const text = (result?.content ?? [])
				.filter((part) => part.type === 'text')
				.map((part) => part.text)
				.join('\n');
			check(text.includes('echo:hello'), `工具执行返回 echo:hello（实际 ${JSON.stringify(text)}）`);
		} catch (error) {
			fail(`工具执行抛错：${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

// 配置加一个服务器 → reload 必须重新连（这条就是 bindExtensions 要带 onError 的原因：
// hasBindings 为假时 reload 不重发 session_start，新服务器永远不出现）。
await writeFile(
	mcpFile,
	JSON.stringify(
		{
			mcpServers: {
				check: { command: process.execPath, args: [fixture] },
				check2: { command: process.execPath, args: [fixture] },
			},
		},
		null,
		2,
	),
);
await session.reload();
const reloadDeadline = Date.now() + 20_000;
let both = false;
while (Date.now() < reloadDeadline) {
	const callable = session.getCallableToolNames();
	both = callable.includes('mcp__check__echo') && callable.includes('mcp__check2__echo');
	if (both) break;
	await new Promise((r) => setTimeout(r, 100));
}
check(session.getCallableToolNames().includes('mcp__check2__echo'), 'reload 后新服务器 check2 已连上（session_start 重发了）');
check(session.getCallableToolNames().includes('mcp__check__echo'), 'reload 后原来的 check 工具还在');

/* -------------------- M1：管理界面的写盘 / 探测 -------------------- */

const { deleteMcpServer, probeMcpServer, saveMcpServer, setMcpServerEnabled, validateServer } = await import(join(serverDir, 'mcp.ts'));

// 顶层不认识的键要在保存后原样保留（比如将来 SDK 加的字段 / 手写注释性字段）
const draftFile = join(root, 'mcp-crud.json');
await writeFile(draftFile, JSON.stringify({ mcpServers: {}, customTopLevel: { keep: true } }, null, 2));
saveMcpServer('crud', { command: process.execPath, args: [fixture], description: 'draft', auth: { provider: 'docs' } }, draftFile);
const written = JSON.parse(await readFile(draftFile, 'utf8'));
check(written.mcpServers?.crud?.command === process.execPath, 'saveMcpServer 写入 stdio 条目');
check(written.mcpServers?.crud?.type === 'stdio', '保存时补上 type: stdio');
check(written.mcpServers?.crud?.auth?.provider === 'docs', '保存保留不认识的键（auth）');
check(written.customTopLevel?.keep === true, '保存保留顶层其他键');

// 响应脱敏会把已知凭据值变成 `***`；原样提交回来时不能把真值写没
const maskedFile = join(root, 'mcp-masked.json');
await writeFile(
	maskedFile,
	JSON.stringify({ mcpServers: { masked: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer real-secret' } } } }, null, 2),
);
saveMcpServer('masked', { url: 'https://example.com/mcp', headers: { Authorization: '***' } }, maskedFile);
const masked = JSON.parse(await readFile(maskedFile, 'utf8')).mcpServers?.masked;
check(masked?.headers?.Authorization === 'Bearer real-secret', '回写 *** 时从原条目恢复真值');

const savedState = (await import(join(serverDir, 'mcp.ts'))).readMcpFile(draftFile);
check(savedState.servers.length === 1 && savedState.servers[0].name === 'crud', '写盘后能被 readMcpFile 读回');
check(savedState.rawServers.crud?.description === 'draft', 'rawServers 带回原始条目（UI 编辑用）');

const toggled = setMcpServerEnabled('crud', false, draftFile);
check(toggled.servers[0]?.config.enabled === false, 'setMcpServerEnabled 只改 enabled');
check(toggled.servers[0]?.config.command === process.execPath, 'enabled 开关不动其他字段');

const rejected = validateServer('bad name', { command: 'x' });
check('error' in rejected, '非法服务器名被拒');

let removed = false;
try {
	deleteMcpServer('missing', draftFile);
} catch (error) {
	removed = error?.status === 404;
}
check(removed, '删除不存在的服务器报 404');
check(deleteMcpServer('crud', draftFile).servers.length === 0, 'deleteMcpServer 删掉条目');

// 探测：连一次、列工具、关掉。成功和失败都要给出可读原因。
const goodProbe = await probeMcpServer({ name: 'crud', config: { type: 'stdio', command: process.execPath, args: [fixture] }, source: draftFile });
check(goodProbe.ok, `probe 成功（${goodProbe.ms}ms）`);
check(goodProbe.serverInfo?.name === 'check-echo', 'probe 带回 serverInfo');
check(goodProbe.tools.some((tool) => tool.name === 'echo'), 'probe 列出工具 echo');

const badProbe = await probeMcpServer(
	{ name: 'broken', config: { type: 'stdio', command: join(root, 'no-such-binary') }, source: 'draft' },
	{ timeoutMs: 3000 },
);
check(!badProbe.ok && Boolean(badProbe.error), `probe 失败时给出原因（${badProbe.error}）`);

session.dispose?.();
await rm(root, { recursive: true, force: true });

if (failures.length) {
	console.log(`\n${failures.length} 项失败`);
	process.exit(1);
}
console.log('\nMCP 接线正常');
