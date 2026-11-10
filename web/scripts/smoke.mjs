/**
 * 前端冒烟测试（无浏览器）：用 happy-dom 跑真实构建产物，验证主要 DOM/交互。
 *
 *   npm run build:web && node web/scripts/smoke.mjs
 *
 * 覆盖：启动渲染（会话/历史/工具/统计）、示例→发送、
 * SSE 流式增量与 settled、完成提醒（授权/后台通知/标题标记）、
 * 右栏折叠、分隔条键盘调整、旧 CSS 未被改动。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

const WEB = fileURLToPath(new URL('..', import.meta.url));
const errors = [];
const fail = (message) => {
	errors.push(message);
	console.error('FAIL:', message);
};
const ok = (message) => console.log('ok  :', message);

function assert(condition, message) {
	if (condition) ok(message);
	else fail(message);
}

// ---------- DOM 环境 ----------
const window = new Window({ url: 'http://localhost:44100/' });
// 默认视口对齐"桌面宽屏"：<1180 后上下文列会自动收起，那属于另一组用例，放到最后单独验
await window.happyDOM.setViewport({ width: 1440, height: 900 });
const globals = {
	window,
	document: window.document,
	navigator: window.navigator,
	location: window.location,
	history: window.history,
	HTMLElement: window.HTMLElement,
	Element: window.Element,
	Node: window.Node,
	Event: window.Event,
	CustomEvent: window.CustomEvent,
	File: window.File,
	FileReader: window.FileReader,
	Blob: window.Blob,
	KeyboardEvent: window.KeyboardEvent,
	MouseEvent: window.MouseEvent,
	PointerEvent: window.PointerEvent,
	DOMRect: window.DOMRect,
	Range: window.Range,
	MutationObserver: window.MutationObserver,
	ResizeObserver: window.ResizeObserver,
	getComputedStyle: window.getComputedStyle.bind(window),
	requestAnimationFrame: (cb) => setTimeout(() => cb(performance.now()), 0),
	cancelAnimationFrame: clearTimeout,
	matchMedia: window.matchMedia.bind(window),
	localStorage: window.localStorage,
	sessionStorage: window.sessionStorage,
};
for (const [key, value] of Object.entries(globals)) {
	try {
		Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
	} catch {
		globalThis[key] = value;
	}
}
window.document.body.innerHTML = '<div id="root"></div>';
// 模拟“上次打开过会话”的浏览器：boot 会走恢复分支
window.localStorage.setItem('turnpi-session', 'sess-1');

// ---------- 假 Notification：验证完成提醒的授权/系统通知 ----------
const notifications = [];
class MockNotification {
	static permission = 'default';
	static async requestPermission() {
		MockNotification.permission = 'granted';
		return 'granted';
	}
	constructor(title, options) {
		this.title = title;
		this.options = options;
		this.closed = false;
		notifications.push(this);
	}
	close() {
		this.closed = true;
	}
}
Object.defineProperty(window, 'Notification', { configurable: true, writable: true, value: MockNotification });
globalThis.Notification = MockNotification;

// ---------- 假 EventSource ----------
class MockEventSource {
	static instances = [];
	constructor(url) {
		this.url = url;
		this.listeners = new Map();
		MockEventSource.instances.push(this);
	}
	addEventListener(type, listener) {
		const list = this.listeners.get(type) ?? [];
		list.push(listener);
		this.listeners.set(type, list);
	}
	close() {}
	emit(type, data) {
		const event = { type, data: data === undefined ? undefined : JSON.stringify(data) };
		for (const listener of this.listeners.get(type) ?? []) listener(event);
	}
}
globalThis.EventSource = MockEventSource;
/** 向所有 mock SSE 实例广播 stats：不确定哪个实例是当前连接，全发一遍最稳 */
function broadcastStats(stats) {
	for (const instance of MockEventSource.instances) instance.emit('stats', { stats });
}

// ---------- 测试数据 ----------
const now = Date.now();
const history = [
	{ role: 'user', text: '你好' },
	{
		role: 'assistant',
		thinking: '先看看文件，再决定怎么改。\n这是思考的第二行。',
		text: '## 标题\n**加粗** 文本',
		tools: [{ id: 'h-tool-1', name: 'read', detail: 'a.ts', args: '{\n  "path": "a.ts"\n}', result: 'file contents', durationMs: 40 }],
		completedAt: now - 2000,
	},
	{ role: 'assistant', text: '第二轮说明', usage: { input: 10, output: 100, cacheRead: 0, total: 110 }, durationMs: 2000, completedAt: now - 1000 },
];
let currentThinking = 'off';
const baseStats = {
	sessionId: 'sess-1',
	sessionName: null,
	agentId: 'web-test',
	sessionPath: '/sessions/sess-1.jsonl',
	cwd: '/workspace',
	workspaceId: 'workspace',
	workspaceLabel: '工作区',
	workspaceRoot: '/workspace',
	worktreeId: null,
	worktreeBranch: null,
	worktreePath: null,
	model: 'opencode/beam-free',
	modelName: 'Beam Free',
	contextWindow: 100000,
	thinkingLevel: 'off',
	thinkingLevels: ['off', 'low', 'high'],
	supportsThinking: true,
	tools: ['read', 'record_method'],
	codemode: 'off',
	toolCatalog: [{ name: 'read' }, { name: 'bash' }, { name: 'cred_list' }],
	pinnedTools: ['cred_list', 'cred_use'],
	messages: 2,
	usage: { input: 2000, cacheRead: 500, cacheWrite: 0, output: 1200 },
	toolCalls: 1,
	turns: 1,
	steps: 1,
	context: {
		tokens: 5000,
		contextWindow: 100000,
		breakdown: { system: 1200, tools: 800, messages: 2500, other: 500, subtotal: 4500, toolCount: 2, messageCount: 2 },
	},
	busy: false,
	history,
};

const trajectorySnapshot = {
	sessionId: 'sess-1',
	busy: false,
	updatedAt: now,
	totals: {
		turns: 1,
		steps: 1,
		toolCalls: 1,
		usage: { input: 2000, output: 1200, cacheRead: 500, cacheWrite: 0, total: 3700 },
		startedAt: now,
		endedAt: now,
	},
	events: [
		{ id: 'ev-compact', kind: 'compaction', turn: 1, step: 1, time: now, title: '上下文压缩', text: '旧历史摘要' },
	],
	turns: [
		{
			index: 1,
			id: 'turn-1',
			user: { text: '你好', timestamp: now - 4000 },
			startedAt: now - 4000,
			endedAt: now,
			steps: [
				{
					id: 'step-1',
					index: 1,
					timestamp: now,
					startedAt: now - 2000,
					finishedAt: now,
					durationMs: 2000,
					text: '## 轨迹输出',
					thinking: '先分析一下。',
					usage: { input: 2000, output: 1200, cacheRead: 500, cacheWrite: 0, total: 3700 },
					model: 'opencode/beam-free',
					responseId: 'resp-step-1',
					call: {
						responseId: 'resp-step-1',
						startedAt: now - 2000,
						firstTokenAt: now - 1500,
						endedAt: now,
						durationMs: 2000,
						ttftMs: 500,
						generationMs: 1500,
						tps: 800,
						usage: { input: 2000, output: 1200, cacheRead: 500, cacheWrite: 0, total: 3700 },
						model: 'opencode/beam-free',
					},
					stopReason: 'stop',
					tools: [
						{
							id: 'tool-1',
							name: 'read',
							args: '{\n  "path": "a.ts"\n}',
							status: 'ok',
							result: 'file contents',
							startedAt: now - 1000,
							finishedAt: now - 960,
							durationMs: 40,
						},
					],
				},
			],
		},
	],
	live: null,
};

// /api/files/* 的 mock：覆盖 Guide → 文件树 → Markdown/图片/PDF 预览
const fileTexts = {
	'web/src/app.ts': 'export const commitFile = true;\n',
	'README.md': '# 工作区\n\n![logo](logo.png)\n\n[指南](docs/guide.md)\n',
	'docs/guide.md': '# 指南\n\n相对链接和图片。\n\n[返回说明](../README.md)\n',
	'notes.txt': '第一行\n第二行\n第三行\n',
	'demo.ts': 'export function demo() {\n\tconst value = 1;\n\treturn value;\n}\n',
	Dockerfile: 'FROM node:22-bookworm-slim\nRUN echo hi\n',
};
const fileKinds = {
	'README.md': 'markdown',
	'docs/guide.md': 'markdown',
	'notes.txt': 'text',
	'demo.ts': 'text',
	Dockerfile: 'text',
	'logo.png': 'image',
	'shot.png': 'image',
	'web/src/app.ts': 'text',
	'manual.pdf': 'pdf',
	'archive.bin': 'binary',
};
let docsListCalls = 0;
let docsListGate = null;
const fileEntries = {
	'': [
		{ name: 'docs', type: 'directory' },
		{ name: 'README.md', type: 'file' },
		{ name: 'logo.png', type: 'file' },
		{ name: 'manual.pdf', type: 'file' },
		{ name: 'archive.bin', type: 'file' },
		{ name: 'notes.txt', type: 'file' },
		{ name: 'demo.ts', type: 'file' },
		{ name: 'Dockerfile', type: 'file' },
		{ name: 'node_modules', type: 'directory' },
	],
	docs: [{ name: 'guide.md', type: 'file' }],
};
function fileStatOf(path) {
	const kind = fileKinds[path] ?? 'unknown';
	const content = fileTexts[path] ?? '';
	return {
		root: 'workspace',
		path,
		absolutePath: `/workspace/pi-webchat/${path}`,
		name: path.split('/').pop(),
		kind,
		size: content.length || 1024,
		mtimeMs: now,
		version: `v-${path}`,
	};
}

let renamedName = null;
let forkCalls = 0;
let forkTurn = null;
let favoriteTurnsMock = [];
let archivedIds = new Set(['sess-arch']);
const archiveCalls = [];
let workspaceReloadCalls = 0;
const workspaceReloadMethods = [];
const workspaceCreateCalls = [];
const workspacesMock = [
	{ id: 'workspace', label: '工作区', root: '/workspace', kind: 'dir', source: 'default' },
	{ id: 'pi-webchat', label: 'pi-webchat', root: '/workspace/pi-webchat', kind: 'git', source: 'discovered' },
];
let worktreesMock = [
	{
		id: 'wt_smoke01',
		workspaceId: 'workspace',
		path: '/runtime/worktrees/workspace/wt_smoke01',
		branch: 'pi/workspace/smoke01',
		baseRef: 'HEAD',
		baseCommit: 'deadbeef',
		sessionId: 'sess-arch',
		state: 'ready',
		createdAt: new Date(now - 120_000).toISOString(),
		lastUsedAt: new Date(now - 120_000).toISOString(),
		available: true,
		workspaceLabel: '工作区',
	},
];
worktreesMock.push({
	id: 'wt_gitdemo',
	workspaceId: 'pi-webchat',
	path: '/runtime/worktrees/pi-webchat/wt_gitdemo',
	branch: 'pi/pi-webchat/demo',
	baseRef: 'main',
	baseCommit: 'cafebabe',
	sessionId: null,
	state: 'ready',
	createdAt: new Date(now - 60_000).toISOString(),
	lastUsedAt: new Date(now - 60_000).toISOString(),
	available: true,
	workspaceLabel: 'pi-webchat',
});
const gitWorktreeRepoMock = {
	key: 'pi-webchat:worktree:/runtime/worktrees/pi-webchat/wt_gitdemo',
	name: 'pi/pi-webchat/demo',
	rel: '',
	path: '/runtime/worktrees/pi-webchat/wt_gitdemo',
	source: 'worktree',
	branch: 'pi/pi-webchat/demo',
	detached: false,
	upstream: null,
	ahead: 0,
	behind: 0,
	clean: true,
	changes: [],
	changesTotal: 0,
	lastCommit: null,
};
let worktreeRemoveCalls = [];
const jobsMock = {
	jobs: [
		{
			id: 'worktree-gc',
			name: 'Worktree 延迟回收',
			description: '回收已归档、无会话占用且干净的隔离工作树。',
			enabled: true,
			dryRun: true,
			intervalMs: 21_600_000,
			running: false,
			fields: [
				{ key: 'graceDays', label: '归档宽限期', type: 'number', default: 14, min: 0, max: 365, step: 1, unit: '天' },
				{ key: 'maxPerRun', label: '单次最多删除', type: 'number', default: 5, min: 1, max: 100, step: 1, unit: '个' },
				{ key: 'includeMissing', label: '清理目录缺失记录', type: 'boolean', default: true },
			],
			config: { graceDays: 14, maxPerRun: 5, includeMissing: true },
			state: {
				enabled: true,
				dryRun: true,
				intervalMs: 21_600_000,
				lastRunAt: new Date(now - 60_000).toISOString(),
				lastFinishedAt: new Date(now - 60_000).toISOString(),
				lastStatus: 'ok',
				lastSummary: '干跑：扫描 1 个，候选 1 个，将删除 1 个',
				nextRunAt: new Date(now + 21_540_000).toISOString(),
				totalRuns: 1,
			},
		},
	],
	runs: [
		{
			id: 'run_smoke01',
			jobId: 'worktree-gc',
			trigger: 'schedule',
			dryRun: true,
			startedAt: new Date(now - 60_000).toISOString(),
			finishedAt: new Date(now - 59_900).toISOString(),
			status: 'ok',
			summary: '干跑：扫描 1 个，候选 1 个，将删除 1 个',
			detail: { worktrees: 1, eligible: 1 },
		},
	],
};
const mcpStateMock = {
	enabled: true,
	file: '/runtime/mcp.json',
	exists: true,
	servers: [
		{
			name: 'filesystem',
			transport: 'stdio',
			config: {
				type: 'stdio',
				command: 'npx',
				args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
				description: '读写工作区文件',
				exposure: 'codemode',
				enabled: true,
			},
			raw: { command: 'npx', auth: { provider: 'docs' } },
		},
		{
			name: 'docs',
			transport: 'http',
			config: {
				type: 'http',
				url: 'https://example.com/mcp',
				headers: { Authorization: 'Bearer ${DOCS_TOKEN}' },
				description: '在线文档',
				exposure: 'deferred',
				enabled: false,
			},
			raw: {},
		},
	],
	errors: [],
};
const mcpSnapshotMock = () => ({ ok: true, ...mcpStateMock });
let mcpSaveCalls = [];
let mcpTestCalls = [];
let mcpApplyCalls = 0;
const mcpProbeMock = {
	ok: true,
	name: 'filesystem',
	transport: 'stdio',
	ms: 32,
	serverInfo: { name: 'fixture-fs', version: '1.0.0' },
	protocolVersion: '2025-06-18',
	tools: [
		{ name: 'read_file', description: 'read a file' },
		{ name: 'write_file', description: 'write a file' },
	],
};

const skillHash = (char) => char.repeat(64);
const skillsSnapshot = {
	store: '/runtime/skillstore',
	indexFile: '/runtime/skills.json',
	engineVersion: 7,
	updatedAt: now,
	entries: [
		{
			name: 'review',
			source: { kind: 'local', path: '/workspace/skills/review' },
			treeHash: skillHash('a'),
			dir: '/workspace/skills/review',
			trust: 'audited',
			hasScripts: false,
			specFields: { description: '代码评审：先读 diff，再按清单逐项检查。' },
			installedAt: now - 60_000,
			installedBy: 'owner',
			bytes: 1280,
			available: true,
		},
		{
			name: 'pdf-tools',
			source: { kind: 'market', id: 'pi-skill-pdf-tools', package: 'pi-skill-pdf-tools' },
			treeHash: skillHash('b'),
			dir: '/runtime/skillstore/market/pdf-tools/bbbbbbbbbbbb',
			trust: 'unreviewed',
			hasScripts: true,
			specFields: { description: '读取 PDF、抽取表格并保留页码。' },
			installedAt: now - 30_000,
			installedBy: 'owner',
			bytes: 4096,
			available: true,
		},
		{
			name: 'bundle-1',
			source: { kind: 'market', id: 'bundle-1', url: 'https://example.com/skills/bundle-1' },
			treeHash: skillHash('c'),
			dir: '/runtime/bundles/bundle-1',
			trust: 'audited',
			hasScripts: false,
			specFields: { description: '从技能市场装的复用方法。' },
			installedAt: now - 90_000,
			installedBy: 'owner',
			bytes: 900,
			available: true,
		},
	],
	selection: {
		mode: 'only',
		refs: [`review@sha256:${skillHash('a')}`],
		policy: { onConflict: 'template-order', maxSkills: 30, unreviewed: 'manual-only' },
		updatedAt: now,
		updatedBy: 'owner',
	},
	composition: {
		skills: [
			{
				ref: `review@sha256:${skillHash('a')}`,
				name: 'review',
				treeHash: skillHash('a'),
				source: { kind: 'local', path: '/workspace/skills/review' },
				trust: 'audited',
				dir: '/workspace/skills/review',
				hasScripts: false,
				inPrompt: true,
				specFields: { description: '代码评审：先读 diff，再按清单逐项检查。' },
			},
		],
		conflicts: [],
		warnings: [],
		tokens: 42,
		maxSkills: 30,
		mode: 'only',
	},
	diagnostics: [],
};
const marketSources = [
	{
		id: 'superpowers', repo: 'obra/superpowers', url: 'https://github.com/obra/superpowers', label: 'Superpowers',
		license: 'MIT', category: '工程', ref: '22f0b463e7a5e579904dd6211a520321035526f7',
		stars: 12000, forks: 900, openIssues: 10, skillCount: 2, installed: 0,
	},
	{
		id: 'ok-skills', repo: 'mxyhi/ok-skills', url: 'https://github.com/mxyhi/ok-skills', label: 'OK Skills',
		license: 'Apache-2.0', category: '工程', ref: '91108cf5c608edd1f00a8c5ac635f16504e08a35',
		stars: 510, forks: 42, openIssues: 2, skillCount: 1, installed: 0,
	},
	{
		id: 'gamedev-skills', repo: 'gamedev-skills/awesome-gamedev-agent-skills', url: 'https://github.com/gamedev-skills/awesome-gamedev-agent-skills', label: 'GameDev Skills',
		license: 'Apache-2.0', category: '游戏', ref: '19d93f97c9c1ea0f8b306e77aa81e0d3e352d3e9',
		stars: 6947, forks: 300, openIssues: 8, skillCount: 1, installed: 0,
	},
];
const marketSkills = [
	{
		key: 'superpowers:skills/systematic-debugging', sourceId: 'superpowers', sourceLabel: 'Superpowers',
		repo: 'obra/superpowers', path: 'skills/systematic-debugging', name: 'systematic-debugging',
		description: 'Use when encountering any bug, test failure, or unexpected behavior, before proposing fixes.',
		category: '质量 / 调试', tags: ['Superpowers', 'systematic debugging'], license: 'MIT',
		ref: marketSources[0].ref, stars: marketSources[0].stars, forks: marketSources[0].forks,
		installs: 0, installed: false,
	},
	{
		key: 'ok-skills:find-docs', sourceId: 'ok-skills', sourceLabel: 'OK Skills',
		repo: 'mxyhi/ok-skills', path: 'find-docs', name: 'find-docs',
		description: 'Retrieves up-to-date documentation, API references, and code examples for any developer technology.',
		category: '研究 / 检索', tags: ['OK Skills', 'find docs'], license: 'Apache-2.0',
		ref: marketSources[1].ref, stars: marketSources[1].stars, forks: marketSources[1].forks,
		installs: 0, installed: false,
	},
	{
		key: 'gamedev-skills:skills/godot/godot-2d-movement', sourceId: 'gamedev-skills', sourceLabel: 'GameDev Skills',
		repo: 'gamedev-skills/awesome-gamedev-agent-skills', path: 'skills/godot/godot-2d-movement', name: 'godot-2d-movement',
		description: 'Godot 2D movement patterns for platformers and top-down games.',
		category: '游戏引擎', tags: ['GameDev Skills', 'godot', '2d movement'], license: 'Apache-2.0',
		ref: marketSources[2].ref, stars: marketSources[2].stars, forks: marketSources[2].forks,
		installs: 0, installed: false,
	},
];
const marketCatalog = {
	updatedAt: now,
	cached: true,
	refreshing: false,
	sources: marketSources,
	skills: marketSkills,
	categories: [
		{ id: '质量 / 调试', label: '质量 / 调试', count: 1 },
		{ id: '研究 / 检索', label: '研究 / 检索', count: 1 },
		{ id: '游戏引擎', label: '游戏引擎', count: 1 },
	],
	diagnostics: [],
};
const marketItem = {
	skill: marketSkills[0],
	content: '---\nname: systematic-debugging\ndescription: Debug systematically.\n---\n\n# Systematic Debugging\n\nFind the root cause before fixing.\n',
};
const marketTranslation = {
	translation: '# 系统化调试\n\n先找到根因，再修复。\n',
	cached: false,
	model: 'test/model',
};
let skillApplyCalls = 0;
/** Git tab 的 mock：根仓库（脏）+ 自动发现的子仓库，添加/移除走同一份列表 */
const gitRootMock = { id: 'pi-webchat', label: 'pi-webchat', path: '/workspace/pi-webchat', workspaceId: 'pi-webchat', workspaceLabel: 'pi-webchat' };
let gitReposMock = [
	{
		key: 'pi-webchat:root:', name: 'pi-webchat', rel: '', path: '/workspace/pi-webchat', source: 'root',
		branch: 'main', detached: false, upstream: 'origin/main', ahead: 1, behind: 0, clean: false,
		changes: [
			{ code: ' M', path: 'demo.ts', staged: false },
			{ code: ' M', path: 'server/git.ts', staged: false },
			{ code: '??', path: 'docs/git-panel.md', staged: false },
			{ code: 'A ', path: 'docs/guide/tree.md', staged: false },
		],
		changesTotal: 4,
		lastCommit: { sha: 'ccf93cc', subject: 'feat: git 面板', author: 'zx', date: new Date(now - 3_600_000).toISOString() },
	},
	{
		key: 'pi-webchat:scanned:tools/vitepress', name: 'vitepress', rel: 'tools/vitepress',
		path: '/workspace/pi-webchat/tools/vitepress', source: 'scanned',
		branch: 'main', detached: false, upstream: null, ahead: 0, behind: 0, clean: true,
		changes: [], changesTotal: 0,
		lastCommit: { sha: 'abc1234', subject: 'docs: init', author: 'zx', date: new Date(now - 86_400_000).toISOString() },
	},
];
const gitRepoAddCalls = [];
const gitRepoRemoveCalls = [];
let gitRepoLoads = 0;
const gitBranchLoads = [];
const gitBranchMock = {
	rel: '',
	path: '/workspace/pi-webchat',
	locals: [
		{
			short: 'main', full: 'refs/heads/main', remote: null, current: true, upstream: 'origin/main',
			ahead: 0, behind: 3, sha: 'm1m1m1m1', shortSha: 'm1m1m1',
			date: '2024-05-20T10:00:00+08:00', subject: "Merge branch 'feat/git-log' into main",
		},
		{
			short: 'feat/git-log', full: 'refs/heads/feat/git-log', remote: null, current: false, upstream: null,
			ahead: 2, behind: 0, sha: 'f1f1f1f1', shortSha: 'f1f1f1',
			date: '2024-05-19T18:00:00+08:00', subject: 'fix: 泳道颜色对齐',
		},
	],
	remotes: [
		{
			name: 'origin',
			branches: [
				{
					short: 'origin/main', full: 'refs/remotes/origin/main', remote: 'origin', current: false,
					upstream: null, ahead: 0, behind: 0, sha: 'm1m1m1m1', shortSha: 'm1m1m1',
					date: '2024-05-20T10:00:00+08:00', subject: "Merge branch 'feat/git-log' into main",
				},
				{
					short: 'origin/release/1.0', full: 'refs/remotes/origin/release/1.0', remote: 'origin',
					current: false, upstream: null, ahead: 0, behind: 0, sha: 'c0c0c0c0', shortSha: 'c0c0c0c0',
					date: '2024-05-18T10:00:00+08:00', subject: 'init',
				},
			],
		},
		{
			name: 'upstream',
			branches: [
				{
					short: 'upstream/main', full: 'refs/remotes/upstream/main', remote: 'upstream', current: false,
					upstream: null, ahead: 0, behind: 0, sha: 'c1c1c1c1', shortSha: 'c1c1c1c1',
					date: '2024-05-20T09:00:00+08:00', subject: 'feat: Git tab 支持提交记录树',
				},
			],
		},
	],
};
const gitLogLoads = [];
const gitCommitLoads = [];
const gitCommitMock = {
	sha: 'm1m1m1m1m1m1m1m1m1m1m1m1m1m1m1m1m1m1m1m1',
	short: 'm1m1m1',
	parents: ['c1c1c1c1', 'f1f1f1f1'],
	author: 'zhou',
	email: 'zhou@example.com',
	date: '2024-05-20T10:00:00+08:00',
	subject: "Merge branch 'feat/git-log' into main",
	body: '合并提交说明\n第二行：验证多行正文。',
	refs: [{ name: 'HEAD', kind: 'head' }, { name: 'main', kind: 'branch' }],
	files: [
		{ path: 'web/src/app.ts', status: 'M', additions: 12, deletions: 3 },
		{ path: 'docs/spec.md', status: 'A', additions: 40, deletions: 0 },
		{ path: 'old/legacy.ts', status: 'D', additions: 0, deletions: 80 },
	],
	additions: 52,
	deletions: 83,
	truncated: false,
};
const gitLogMock = {
	rel: '',
	path: '/workspace/pi-webchat',
	limit: 200,
	hasMore: false,
	commits: [
		{
			sha: 'm1m1m1m1m1m1m1m1m1m1m1m1m1m1m1m1m1m1m1m1', short: 'm1m1m1', parents: ['c1c1c1c1', 'f1f1f1f1'],
			author: 'zhou', date: '2024-05-20T10:00:00+08:00', subject: "Merge branch 'feat/git-log' into main",
			refs: [{ name: 'HEAD', kind: 'head' }, { name: 'main', kind: 'branch' }],
			lane: 0, laneCount: 2, top: false, through: [], incoming: [],
			outgoing: [{ from: 0, to: 0 }, { from: 0, to: 1 }],
		},
		{
			sha: 'c1c1c1c1', short: 'c1c1c1c1', parents: ['c0c0c0c0'],
			author: 'zhou', date: '2024-05-20T09:00:00+08:00', subject: 'feat: Git tab 支持提交记录树',
			refs: [], lane: 0, laneCount: 2, top: true, through: [1], incoming: [],
			outgoing: [{ from: 0, to: 0 }],
		},
		{
			sha: 'f1f1f1f1', short: 'f1f1f1f1', parents: ['c0c0c0c0'],
			author: 'guo', date: '2024-05-19T18:00:00+08:00', subject: 'fix: 泳道颜色对齐',
			refs: [{ name: 'feat/git-log', kind: 'branch' }], lane: 1, laneCount: 2, top: true, through: [0], incoming: [],
			outgoing: [{ from: 1, to: 1 }],
		},
		{
			sha: 'c0c0c0c0', short: 'c0c0c0c0', parents: [],
			author: 'zhou', date: '2024-05-18T10:00:00+08:00', subject: 'init',
			refs: [{ name: 'v1.0.0', kind: 'tag' }], lane: 0, laneCount: 2, top: true, through: [], incoming: [1],
			outgoing: [],
		},
	],
};
let compactCalls = 0;
let releaseCompact;
/** 非空时 /api/session 返回这个“运行中”快照，用于验证刷新后的去重 */
let busySessionStats = null;
/** 导航测试用的上一页历史响应 */
let olderHistoryPage = null;
let historyRequests = 0;
/** 自定义供应商保存请求体：验证只提交环境变量名，不提交真实 key */
let providerSaveBody = null;
let providerToggleBody = null;
let providerCustomEnabled = true;
const chatCalls = [];
const queueCalls = [];
/** Agent 模块：预览 / 保存的请求体 */
let agentPreviewCalls = 0;
const agentSaveCalls = [];
const agentsMock = [
	{
		id: 'base',
		description: '原型模板',
		kind: 'base',
		domain: 'general',
		tools: ['read', 'grep', 'bash'],
		skills: [],
		model: 'opencode-go/deepseek-v4.1-flash',
		thinking: 'high',
		status: 'active',
		parent: null,
		maxActive: 0,
		external: false,
		prompt: '原型说明',
		path: '/runtime/agents/base/CARD.md',
		writable: false,
		warnings: [],
	},
	{
		id: 'agent-hr',
		description: '薪酬分摊',
		kind: 'domain',
		domain: 'hr',
		tools: ['read', 'grep'],
		skills: ['bundle-a'],
		model: 'opencode-go/deepseek-v4.1-flash',
		thinking: 'high',
		status: 'active',
		parent: 'base',
		maxActive: 1,
		external: false,
		prompt: '你负责中汽 HR 项目的薪酬分摊域。',
		path: '/runtime/agents/agent-hr/CARD.md',
		writable: true,
		warnings: [],
	},
];
const agentToolsMock = [
	{ name: 'bash', label: 'Bash', description: 'run commands' },
	{ name: 'codemode', label: 'Codemode', description: 'script tool calls' },
	{ name: 'grep', label: 'Grep', description: 'search' },
	{ name: 'read', label: 'Read', description: 'read files' },
];
const agentSkillsMock = [{ id: 'bundle-a', state: 'active', version: '3', main: 'read → report', injected: true }];
const json = (body, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const providerBuiltinCards = () => [
	{
		id: 'opencode',
		name: 'OpenCode Zen',
		kind: 'builtin',
		apis: ['openai-completions', 'anthropic-messages'],
		auth: { configured: true, source: 'environment', label: 'OPENCODE_API_KEY' },
		modelCount: 2,
		modelTotal: 83,
		enabled: true,
	},
	{
		id: 'opencode-go',
		name: 'OpenCode Go',
		kind: 'builtin',
		apis: ['openai-completions', 'anthropic-messages'],
		auth: { configured: true, source: 'environment', label: 'OPENCODE_API_KEY' },
		modelCount: 2,
		modelTotal: 29,
		enabled: true,
	},
];

const providerCardsMock = (customEnabled = providerCustomEnabled) => {
	const custom = providerSaveBody
		? [
				{
					id: providerSaveBody.id,
					name: providerSaveBody.name,
					kind: 'custom',
					api: providerSaveBody.api,
					apis: [providerSaveBody.api],
					baseUrl: providerSaveBody.baseUrl,
					apiKeyEnv: providerSaveBody.apiKeyEnv,
					auth: { configured: true, source: 'environment', label: providerSaveBody.apiKeyEnv },
					modelCount: providerSaveBody.models.length,
					modelTotal: providerSaveBody.models.length,
					enabled: customEnabled,
					models: providerSaveBody.models,
				},
			]
		: [];
	return [...custom, ...providerBuiltinCards()];
};

globalThis.fetch = async (url, options = {}) => {
	const raw = String(url);
	const path = raw.split('?')[0];
	const method = options.method ?? 'GET';
	const body = options.body ? JSON.parse(options.body) : undefined;

	if (path === '/api/health') return json({ ok: true, port: 44100, engineVersion: 7, piVersion: '1.4.0', workspaces: 2 });
	if (path === '/api/workspaces' && method === 'POST') {
		workspaceCreateCalls.push(body);
		const root = String(body?.path ?? '');
		const label = root.split('/').filter(Boolean).pop() ?? 'workspace';
		return json({
			ok: true,
			workspace: { id: 'plain-dir', label, root, kind: 'dir', source: 'config' },
		});
	}
	if (path === '/api/workspaces/reload' && method === 'POST') {
		workspaceReloadCalls += 1;
		workspaceReloadMethods.push(method);
		return json({
			ok: true,
			workspaces: [
				...workspacesMock,
				{ id: 'pi-agent', label: 'Pi Agent', root: '/work', kind: 'dir', source: 'default', readonly: true },
			],
			count: 3,
		});
	}
	if (path === '/api/workspaces') return json({ workspaces: workspacesMock });
	if (path === '/api/worktrees' && method === 'GET') return json({ worktrees: worktreesMock });
	if (path === '/api/agents' && method === 'GET') {
		return json({
			agents: agentsMock,
			tools: agentToolsMock,
			skills: agentSkillsMock,
			pinnedTools: ['record_method', 'cred_list', 'cred_use'],
		});
	}
	if (path === '/api/agents/preview') {
		agentPreviewCalls += 1;
		const card = body?.card ?? {};
		const tools = Array.isArray(card.tools) ? card.tools : [];
		return json({
			id: card.id ?? 'preview',
			model: card.model ?? 'opencode-go/deepseek-v4.1-flash',
			thinking: card.thinking ?? 'high',
			contextWindow: 128000,
			system: `SDK 基线 + ${card.prompt ?? ''}`,
			toolsText: JSON.stringify(tools.map((name) => ({ name })), null, 2),
			tools: tools.map((name) => ({ name, tokens: 100 })),
			activeTools: tools,
			pinnedTools: ['record_method', 'cred_list', 'cred_use'],
			skills: [],
			skillsText: '',
			chars: { system: 40, tools: 40, skills: 0 },
			tokens: { system: 20, tools: 30, skills: 0, total: 50 },
			warnings: [],
		});
	}
	if (path === '/api/agents/save') {
		agentSaveCalls.push(body);
		return json({ ...agentsMock[1], ...body.card });
	}
	if (path === '/api/agents/merge-diff') {
		return json({
			changes: [],
			blocked: 'base 是原型，永不作为合并目标（I14）。想合并请从 domain fork 出 variant。',
		});
	}
	if (path === '/api/jobs') return json(jobsMock);
	if (path === '/api/mcp' && method === 'GET') return json(mcpSnapshotMock());
	if (path === '/api/mcp/test') {
		mcpTestCalls.push(body);
		const ok = !String(body?.name ?? '').includes('broken');
		return json({
			ok: true,
			enabled: true,
			probe: ok
				? { ...mcpProbeMock, name: body?.name ?? 'filesystem' }
				: { ok: false, name: body?.name, transport: 'stdio', ms: 12, tools: [], error: 'spawn broken ENOENT' },
		});
	}
	if (path === '/api/mcp/save') {
		mcpSaveCalls.push(body);
		const name = String(body?.name ?? '');
		const next = { name, transport: body?.config?.url ? 'http' : 'stdio', config: body?.config ?? {}, raw: body?.config ?? {} };
		const index = mcpStateMock.servers.findIndex((server) => server.name === name);
		if (index >= 0) mcpStateMock.servers[index] = next;
		else mcpStateMock.servers.push(next);
		return json(mcpSnapshotMock());
	}
	if (path === '/api/mcp/enable') {
		const server = mcpStateMock.servers.find((item) => item.name === body?.name);
		if (server) server.config = { ...server.config, enabled: body?.enabled !== false };
		return json(mcpSnapshotMock());
	}
	if (path === '/api/mcp/remove') {
		mcpStateMock.servers = mcpStateMock.servers.filter((server) => server.name !== body?.name);
		return json(mcpSnapshotMock());
	}
	if (path === '/api/mcp/apply') {
		mcpApplyCalls += 1;
		return json({ ok: true, applied: ['sess-1'], skipped: [], failed: [] });
	}
	if (path === '/api/git/repos' && method === 'GET') {
		gitRepoLoads += 1;
		// 真实服务端只在查询带了 worktree 时才把工作树仓库加进清单
		const withWorktree = new URL(raw, 'http://x').searchParams.get('worktree');
		const repos = withWorktree ? [gitWorktreeRepoMock, ...gitReposMock] : gitReposMock;
		return json({ root: gitRootMock, repos, scannedAt: now });
	}
	if (path === '/api/git/branches' && method === 'GET') {
		gitBranchLoads.push(raw);
		return json(gitBranchMock);
	}
	if (path === '/api/git/log' && method === 'GET') {
		gitLogLoads.push(raw);
		return json(gitLogMock);
	}
	if (path === '/api/git/commit' && method === 'GET') {
		gitCommitLoads.push(raw);
		return json(gitCommitMock);
	}
	if (path === '/api/git/repos' && method === 'POST') {
		gitRepoAddCalls.push(body);
		const rel = String(body?.path ?? '');
		gitReposMock = [
			...gitReposMock,
			{
				key: `pi-webchat:manual:${rel}`, name: rel.split('/').filter(Boolean).pop() ?? rel, rel,
				path: `/workspace/pi-webchat/${rel}`, source: 'manual',
				branch: 'main', detached: false, upstream: null, ahead: 0, behind: 0, clean: true,
				changes: [], changesTotal: 0, lastCommit: null,
			},
		];
		return json({ root: gitRootMock, repos: gitReposMock, scannedAt: now });
	}
	if (path === '/api/git/repos/remove' && method === 'POST') {
		gitRepoRemoveCalls.push(body);
		gitReposMock = gitReposMock.filter((repo) => repo.rel !== body?.path);
		return json({ root: gitRootMock, repos: gitReposMock, scannedAt: now });
	}
	if (path === '/api/worktrees/remove') {
		worktreeRemoveCalls.push(body);
		worktreesMock = worktreesMock.filter((worktree) => worktree.id !== body?.id);
		return json({ ok: true, worktree: { id: body?.id, state: 'removed' } });
	}
	if (path === '/api/credentials' && method === 'GET')
		return json({
			credentials: [
				{
					id: 'cred_gitea',
					name: 'gitea',
					label: 'Gitea',
					kind: 'bearer',
					tier: 'scoped',
					baseUrl: 'https://git.example.com',
					allowedHosts: ['git.example.com'],
					allowedPathPrefix: '/api/v1/repos/',
					allowedMethods: ['GET', 'POST'],
					scopes: ['gitea:issue:read', 'gitea:issue:write'],
					policy: 'ask',
					createdAt: 1,
					updatedAt: 1,
					useCount: 2,
					hasSecret: true,
				},
				{
					id: 'cred_mock_key',
					name: 'mock-key',
					label: 'Mock Key',
					kind: 'env',
					tier: 'env',
					envName: 'MOCK_KEY',
					envPresent: true,
					allowedHosts: [],
					allowedMethods: [],
					scopes: [],
					policy: 'ask',
					createdAt: 1,
					updatedAt: 1,
					useCount: 0,
					hasSecret: true,
					secretEnv: 'CRED_MOCK_KEY',
					secretEnvPresent: true,
				},
			],
			leases: 1,
			sessionGrants: 0,
			envHydrated: [],
			importableEnv: ['DEEPSEEK_API_KEY'],
			keySource: 'file',
		});
	if (path === '/api/credentials' && method === 'POST')
		return json({ ok: true, credentials: [], leases: 0, sessionGrants: 0, envHydrated: [], importableEnv: [], keySource: 'file' });
	if (path === '/api/credentials/decision') return json({ ok: true });
	if (path === '/api/models')
		return json([
			{ key: 'opencode/beam-free', provider: 'opencode', id: 'beam-free', name: 'Beam Free', contextWindow: 100000, reasoning: true, supportsImages: false },
			{ key: 'opencode/basic', provider: 'opencode', id: 'basic', name: 'Basic', contextWindow: 8000, reasoning: false, supportsImages: true },
			{ key: 'opencode-go/claude-haiku-5-5', provider: 'opencode-go', id: 'claude-haiku-5-5', name: 'Go Haiku', contextWindow: 200000, reasoning: true, supportsImages: false },
		]);
	if (path === '/api/providers' && method === 'POST') {
		providerSaveBody = body;
		providerCustomEnabled = true;
		return json({ provider: body, providers: providerCardsMock() });
	}
	if (path === '/api/providers/toggle') {
		providerToggleBody = body;
		providerCustomEnabled = body?.enabled !== false;
		return json({ ok: true, providers: providerCardsMock(providerCustomEnabled) });
	}
	if (path === '/api/providers/quota') {
		const providerId = new URL(raw, 'http://localhost').searchParams.get('id') ?? '';
		const balance = providerId === 'opencode';
		return json({
			providerId,
			status: 'ok',
			reachable: true,
			checkedAt: Date.now(),
			latencyMs: providerId === 'opencode' ? 42 : 31,
			balances: balance
				? [{ label: 'Credits', currency: 'USD', remaining: 12.5, total: 20, used: 7.5 }]
				: [],
			windows: balance
				? []
				: providerId === 'opencode-go'
					? [
							{ label: '5h', percent: 4, reset: '2026-11-04T10:40:42.000Z', limited: false },
							{ label: '7d', percent: 21, reset: '2026-11-09T00:00:00.000Z', limited: false },
							{ label: '30d', percent: 53, reset: '2026-11-21T06:21:54.000Z', limited: false },
						]
					: [{ label: '请求', limit: 100, remaining: 73, reset: '12s' }],
			plan: undefined,
			sources: ['https://mock.example/v1/models'],
			warnings: [],
		});
	}
	if (path === '/api/providers/test')
		return json({
			ok: true,
			latencyMs: 12,
			modelCount: 2,
			endpoint: 'https://mock.example/v1/models',
			envVar: 'MOCK_API_KEY',
			models: [{ id: 'mock-a', name: 'Mock A' }],
		});
	if (path === '/api/providers/models')
		return json({
			ok: true,
			models: [
				{ id: 'mock-a', name: 'Mock A', contextWindow: 128000 },
				{ id: 'mock-b', name: 'Mock B', reasoning: true },
			],
			endpoint: 'https://mock.example/v1/models',
			envVar: 'MOCK_API_KEY',
			latencyMs: 12,
		});
	if (path === '/api/providers') return json(providerCardsMock());
	if (path === '/api/sessions')
		return json([
			{ id: 'sess-1', path: '/sessions/sess-1.jsonl', name: renamedName, title: '测试会话', created: now, modified: now, messageCount: 2, busy: false, cwd: '/workspace', workspaceId: 'workspace', workspaceLabel: '工作区', workspaceRoot: '/workspace', archived: archivedIds.has('sess-1') },
			{ id: 'sess-arch', path: '/sessions/sess-arch.jsonl', title: '归档会话', created: now - 60_000, modified: now - 60_000, messageCount: 1, busy: false, cwd: '/workspace', workspaceId: 'workspace', workspaceLabel: '工作区', workspaceRoot: '/workspace', archived: archivedIds.has('sess-arch') },
		]);
	if (path === '/api/skills/market' && method === 'GET') return json(marketCatalog);
	if (path === '/api/skills/market/item' && method === 'GET') return json(marketItem);
	if (path === '/api/skills/market/translate') return json(marketTranslation);
	if (path === '/api/skills/install' && body?.activate) {
		const skill = marketSkills.find((item) => item.path === body?.source?.subdir);
		if (skill) { skill.installed = true; skill.installs = 1; skill.trust = 'unreviewed'; }
		return json({ ok: true, installed: [], snapshot: skillsSnapshot, entries: skillsSnapshot.entries, selection: skillsSnapshot.selection });
	}
	if (path === '/api/skills' && method === 'GET') return json(skillsSnapshot);
	if (path === '/api/skills/select') {
		skillsSnapshot.selection.refs = Array.isArray(body?.refs) ? body.refs : skillsSnapshot.selection.refs;
		return json({ ok: true, ...skillsSnapshot });
	}
	if (path === '/api/skills/install') return json({ ok: true, installed: [skillsSnapshot.entries[1]], ...skillsSnapshot });
	if (path === '/api/skills/audit') {
		const entry = skillsSnapshot.entries.find((item) => item.name === body?.name);
		if (entry) entry.trust = body?.trust;
		return json({ ok: true, ...skillsSnapshot });
	}
	if (path === '/api/skills/remove') return json({ ok: true, ...skillsSnapshot });
	if (path === '/api/skills/refresh') return json({ ok: true, ...skillsSnapshot });
	if (/^\/api\/session\/[^/]+\/skills\/apply$/.test(path)) {
		skillApplyCalls += 1;
		return json({ ok: true, paths: ['/workspace/skills/review'], skills: skillsSnapshot.composition.skills, diagnostics: [], stats: busySessionStats ?? { ...baseStats } });
	}
	if (path === '/api/files/roots')
		return json({
			roots: [
				{ id: 'workspace', label: '工作区', path: '/workspace', readonly: true },
				{ id: 'tmp', label: '临时文件', path: '/tmp', kind: 'dir', readonly: true, available: true },
			],
		});
	if (path.startsWith('/api/files/')) {
		const url = new URL(raw, 'http://localhost');
		const rel = url.searchParams.get('path') ?? '';
		if (path === '/api/files/list') {
			if (rel === 'docs') {
				docsListCalls += 1;
				if (docsListGate) await docsListGate;
			}
			const entries = fileEntries[rel];
			if (!entries) return json({ error: '目录不存在', code: 'files/not-found' }, 404);
			return json({
				root: 'workspace',
				path: rel,
				absolutePath: `/workspace/pi-webchat/${rel}`.replace(/\/$/, ''),
				entries,
				truncated: false,
			});
		}
		if (path === '/api/files/stat') {
			if (!(rel in fileKinds)) return json({ error: '文件不存在', code: 'files/not-found' }, 404);
			return json(fileStatOf(rel));
		}
		if (path === '/api/files/read') {
			if (!(rel in fileTexts)) return json({ error: '不是文本', code: 'files/not-text' }, 415);
			return json({ ...fileStatOf(rel), text: fileTexts[rel], truncated: false, eof: true });
		}
		if (path === '/api/files/raw') return new Response('raw', { status: 200 });
	}
	if (path === '/api/session/snapshot') {
		const sid = new URL(raw, 'http://localhost').searchParams.get('sessionId') || baseStats.sessionId;
		return new Promise((resolve) => {
			setTimeout(() => resolve(json({ ...baseStats, sessionId: sid, history: undefined, favorites: favoriteTurnsMock, sessionName: renamedName })), 60);
		});
	}
	if (path === '/api/session/open') {
		const sid = body?.sessionId || baseStats.sessionId;
		return new Promise((resolve) => {
			setTimeout(() => resolve(json({ ...baseStats, sessionId: sid, favorites: favoriteTurnsMock, sessionName: renamedName })), 80);
		});
	}
	if (path === '/api/session') return json(busySessionStats ?? { ...baseStats, favorites: favoriteTurnsMock, sessionName: renamedName });
	if (path === '/api/session/history') {
		historyRequests += 1;
		const url = new URL(raw, 'http://localhost');
		const hasBefore = url.searchParams.has('before');
		if (!hasBefore) {
			return json({
				ok: true,
				history: baseStats.history ?? [],
				historyMeta: baseStats.historyMeta,
				turnOverview: baseStats.turnOverview,
			});
		}
		return json(
			olderHistoryPage ?? {
				ok: true,
				history: [],
				historyMeta: { start: 0, end: 0, total: 0, hasMore: false, turnCount: 0, pageTurns: 0 },
			},
		);
	}
	if (path === '/api/trajectory/payload') {
		return json({
			sessionId: 'sess-1',
			stepId: 'step-1',
			targetFound: true,
			available: true,
			responseId: 'resp-1',
			at: now,
			model: 'test/model',
			bytes: 2048,
			payload: {
				model: 'test/model',
				temperature: 0,
				messages: [
					{ role: 'system', content: 'You are pi.' },
					{ role: 'user', content: '你好' },
				],
				tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }],
			},
		});
	}
	if (path === '/api/trajectory/context') {
		return json({
			sessionId: 'sess-1',
			stepId: 'step-1',
			targetFound: true,
			time: now,
			system: 'You are pi.\n<tools>read</tools>\nline3\nline4\nline5\nline6\nline7\nline8',
			tools: '[{"name":"read","description":"Read file"}]',
			skills: '### bundle-1\nUse read first.',
			messages: '[用户 · 10:00:00]\n你好\n\n[助手 · 10:00:01]\n思考：\n先读文件。',
			counts: { tools: 1, skills: 1, messages: 2 },
			chars: { system: 34, tools: 42, skills: 27, messages: 47, total: 150 },
			tokens: { system: 9, tools: 11, skills: 7, messages: 12, total: 38 },
			compacted: true,
			compactionAt: now - 1000,
		});
	}
	if (path === '/api/trajectory') return json(trajectorySnapshot);
	if (path === '/api/session/favorite') {
		const turn = Number(body?.turn);
		const set = new Set(favoriteTurnsMock);
		if (body?.favorite) set.add(turn);
		else set.delete(turn);
		favoriteTurnsMock = [...set].sort((a, b) => a - b);
		return json({ ok: true, sessionId: 'sess-1', turns: favoriteTurnsMock });
	}
	if (path === '/api/session/archive') {
		const id = String(body?.sessionId ?? '');
		const archived = body?.archived !== false;
		if (archived) archivedIds.add(id);
		else archivedIds.delete(id);
		archiveCalls.push({ id, archived });
		return json({ ok: true, sessionId: id, archived });
	}
	if (path === '/api/session/fork') {
		forkCalls += 1;
		forkTurn = body?.turn ?? null;
		return json({ ok: true, sessionId: 'sess-fork', parentSession: 'sess-1' });
	}
	if (path === '/api/session/rename') {
		renamedName = String(body?.name ?? '').trim() || null;
		return json({ ok: true, sessionId: 'sess-1', name: renamedName });
	}
	if (path === '/api/session/settings') {
		if (body?.thinking) currentThinking = String(body.thinking);
		const key = body?.model ?? baseStats.model;
		const name =
			key === 'opencode/basic'
				? 'Basic'
				: key === 'opencode/beam-free'
					? 'Beam Free'
					: key === 'opencode-go/claude-haiku-5-5'
						? 'Go Haiku'
						: key;
		return json({ ...baseStats, model: key, modelName: name, thinkingLevel: currentThinking });
	}
	if (path === '/api/session/compact') {
		compactCalls += 1;
		return new Promise((resolve) => {
			releaseCompact = () => resolve(json({ ...baseStats, context: { tokens: 9000, estimated: true } }));
		});
	}
	if (path === '/api/chat') {
		chatCalls.push(body);
		if (body.mode === 'steer' || body.mode === 'followUp') {
			const queue =
				body.mode === 'steer'
					? { steering: [body.text], followUp: [] }
					: { steering: [], followUp: [body.text] };
			return json({ ...baseStats, ok: true, agentId: 'web-test', sessionId: 'sess-1', busy: true, queue });
		}
		return json({ ok: true, agentId: 'web-test', sessionId: 'sess-1' });
	}
	if (path === '/api/queue/update') {
		queueCalls.push(body);
		const queue =
			body.placement === 'followUp'
				? { steering: [body.text], followUp: [] }
				: { steering: [], followUp: [] };
		return json({ ok: true, queue });
	}
	if (path === '/api/queue/clear') {
		return json({ ok: true, steering: [], followUp: [] });
	}
	if (path === '/api/abort') return json({ ok: true });
	return json({ error: `unmocked ${method} ${path}` }, 404);
};

// ---------- 启动真实构建产物 ----------
const assets = readdirSync(`${WEB}/dist/assets`);
const bundle = assets.find((name) => /^index-.*\.js$/.test(name)) ?? assets.find((name) => name.endsWith('.js'));
if (!bundle) {
	console.error('先跑 npm run build:web');
	process.exit(1);
}
await import(`${WEB}/dist/assets/${bundle}`);

const waitFor = async (label, predicate, timeout = 4000) => {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	fail(`超时等待：${label}`);
	return false;
};

const $ = (selector) => window.document.querySelector(selector);
const $$ = (selector) => [...window.document.querySelectorAll(selector)];
const text = (selector) => $(selector)?.textContent ?? '';
const setInput = (selector, value) => {
	const el = $(selector);
	if (!el) return;
	const proto = el instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
	Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
	el.dispatchEvent(new window.Event('input', { bubbles: true }));
};
const setInputAt = (selector, value, caret = value.length) => {
	const el = $(selector);
	if (!el) return;
	const proto = el instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
	Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
	el.focus();
	el.setSelectionRange(caret, caret);
	el.dispatchEvent(new window.Event('input', { bubbles: true }));
};

await waitFor('SSE 实例', () => MockEventSource.instances.length > 0);
MockEventSource.instances[0].emit('open');
await waitFor('会话列表', () => text('#sessions').includes('测试会话'));
await waitFor('历史消息', () => text('.messages').includes('加粗'));

// ---------- 已完成轮次默认折叠：摘要行 → 展开后才看到思考/工具 ----------
assert($('.history-summary') !== null, '已完成的轮次出现折叠摘要');
assert($('.history-summary')?.getAttribute('aria-expanded') === 'false', '摘要默认收起');
assert(text('.history-summary').includes('2 步'), '摘要显示步数');
assert($('.turn-part.open') === null, '折叠时执行步骤容器收起');
assert($('.turn-part[aria-hidden="true"]') !== null, '折叠时思考/工具保留 DOM 供动画使用');
$('.history-summary')?.click();
await waitFor('展开已完成轮次', () => $('.history-summary')?.getAttribute('aria-expanded') === 'true');
assert($('.turn-part.open .think') !== null, '展开后显示思考行');

// ---------- 思考过程：🧠 默认一行，点击展开 ----------
assert($('.msg.assistant .think') !== null, '历史思考块出现');
assert(text('.think-icon').includes('🧠'), '思考块使用 🧠 图标');
assert(text('.think-label') === '思考', '思考块标题');
assert($('.think-head')?.getAttribute('aria-expanded') === 'false', '思考默认收起');
assert($('.think-body') === null, '收起时只露一行，不渲染全文');
assert($('.think-preview')?.textContent.includes('先看看文件'), '收起时显示一行预览');
$('.think-head')?.click();
await waitFor('展开历史思考', () => $('.think-body') !== null);
assert($('.think-head')?.getAttribute('aria-expanded') === 'true', '点击后展开思考');
assert(text('.think-body').includes('这是思考的第二行'), '展开后显示完整思考');
$('.think-head')?.click();
await waitFor('收起历史思考', () => $('.think-body') === null);
assert($('.think-head')?.getAttribute('aria-expanded') === 'false', '再次点击收起');
await waitFor('模型列表加载', () => $('#model-switch')?.disabled === false);

assert($$('.session-row').length === 1, '历史会话渲染 1 条');
assert($('.session-row.active') !== null, '当前会话高亮');
assert($('.archive-toggle') !== null, '历史列表有已归档入口');
assert(text('.archive-toggle').includes('已归档') && text('.archive-toggle').includes('1'), '已归档入口显示数量');
assert($('.session-row.archived') === null, '归档会话默认收起');
assert($('.worktree-row .worktree-flag.archived') !== null, '隔离工作树显示“绑定会话已归档”标识');
assert(text('.worktree-flag.archived').includes('会话已归档'), '归档标识文案');
assert(
	($('.worktree-flag.archived')?.getAttribute('title') ?? '').includes('归档会话'),
	'归档标识 title 带上会话名',
);
assert($('.worktree-row.archived-session') !== null, '归档工作树行带 archived-session 状态类');
$('.archive-toggle')?.click();
await waitFor('展开已归档', () => $('.session-row.archived') !== null);
assert(text('.session-row.archived .session-title').includes('归档会话'), '归档会话在归档区显示');
assert($('.session-row.archived .session-action') !== null, '归档会话带恢复按钮');
$('.session-row.archived .session-action')?.click();
await waitFor(
	'恢复归档会话',
	() => !archivedIds.has('sess-arch') && $('.session-row.archived') === null && text('#sessions').includes('归档会话'),
);
await waitFor('恢复后归档标识消失', () => $('.worktree-flag.archived') === null);
assert($('.worktree-flag.archived') === null, '会话恢复后隔离工作树不再显示归档标识');
assert($('.worktree-row.archived-session') === null, '会话恢复后状态类一并移除');
assert(archiveCalls.at(-1)?.archived === false, '恢复请求 archived=false');
const restoredArchived = $$('.session-row').find((row) => row.textContent.includes('归档会话'));
restoredArchived?.querySelector('.session-action')?.click();
await waitFor('重新归档会话', () => archivedIds.has('sess-arch') && $$('.session-row.archived').length === 1);
await waitFor('重新归档后标识回来', () => $('.worktree-flag.archived') !== null);
assert(archiveCalls.at(-1)?.archived === true, '归档请求 archived=true');

// ---------- 归档后的顶部提示：10s、可撤销 ----------
const toastEl = $('.toast');
assert(toastEl?.classList.contains('top'), '撤销提示浮在页面顶部');
assert(toastEl?.classList.contains('has-action'), '撤销提示可交互（pointer-events 放开）');
assert(toastEl?.getAttribute('data-timeout') === '10000', '撤销提示停留 10s');
assert(toastEl?.getAttribute('data-placement') === 'top', 'data-placement 与样式一致');
assert(text('.toast').includes('已归档'), '提示说明刚做了什么');
assert(text('.toast').includes('历史会话') && text('.toast').includes('恢复'), '提示告诉用户去哪恢复');
assert(text('.toast-action') === '撤销', '撤销按钮文案');
assert($('.toast-action')?.tagName === 'BUTTON', '撤销是可点的按钮');

$('.toast-action')?.click();
await waitFor('撤销后会话回到未归档列表', () => !archivedIds.has('sess-arch'));
assert(archiveCalls.at(-1)?.archived === false, '撤销发出 archived=false');
assert($('.toast-action') === null, '撤销后按钮消失（避免连点）');
await waitFor('撤销后换成普通底部提示', () => $('.toast.top') === null && text('.toast').includes('已恢复'));
assert($('.toast')?.getAttribute('data-timeout') === '2600', '普通提示还是 2.6s');

// 再归档一次，把状态还原成本用例后续步骤期望的样子
await waitFor('撤销后归档区收回', () => $('.session-row.archived') === null);
$$('.session-row')
	.find((row) => row.textContent.includes('归档会话'))
	?.querySelector('.session-action')
	?.click();
await waitFor('再次归档会话', () => archivedIds.has('sess-arch') && $('.session-row.archived') === null);
// 归档区在列表清空时会自动收起，这里展开回去，保持后续「点一次就收起」的预期
if ($('.session-row.archived') === null) $('.archive-toggle')?.click();
await waitFor('已归档区重新展开', () => $('.session-row.archived') !== null);
$('.archive-toggle')?.click();
await waitFor('收起已归档', () => $('.session-row.archived') === null);
assert($$('.session-row').length === 1, '归档后只显示未归档会话');
assert($('.session-group-toggle') !== null, '工作区标题可折叠');
assert($('.session-group-toggle')?.getAttribute('aria-expanded') === 'true', '工作区默认展开');
assert($('.session-group-add') !== null, '工作区标题有新建加号');
$('.session-group-toggle')?.click();
await waitFor('折叠工作区', () => $('.session-row:not(.archived)') === null);
assert($('.session-group-toggle')?.getAttribute('aria-expanded') === 'false', '折叠后 aria-expanded=false');
assert(
	window.localStorage.getItem('turnpi-collapsed-workspaces')?.includes('workspace'),
	'折叠状态写入 localStorage',
);
$('.session-group-toggle')?.click();
await waitFor('展开工作区', () => $('.session-row:not(.archived)') !== null);
assert($('.session-group-toggle')?.getAttribute('aria-expanded') === 'true', '展开后恢复会话列表');

// ---------- 历史会话搜索（抽取 SessionList 后新增） ----------
assert($('#sessions #sessions-search') !== null, '历史会话带搜索框');
assert($('#sessions-search')?.getAttribute('aria-label') === '搜索历史会话', '搜索框有无障碍名称');
setInput('#sessions-search', '归档会话');
await waitFor(
	'搜索命中已归档会话',
	() => $$('.session-row').length === 1 && $$('.session-row.archived').length === 1,
);
assert($('.session-row.archived') !== null, '搜索能命中已归档会话并自动展开');
assert(text('#sessions').includes('归档会话') && !text('#sessions').includes('测试会话'), '搜索只留匹配项');
assert(text('.session-search-count') === '1', '搜索框显示匹配数量');
setInput('#sessions-search', '不存在的会话');
await waitFor('搜索空态', () => $('.session-empty') !== null);
assert(text('.session-empty').includes('没有匹配的会话'), '没有匹配时给出空态文案');
assert($$('.session-row').length === 0, '空态下不渲染会话行');
$('.session-search-clear')?.click();
await waitFor(
	'清空搜索',
	() => ($('#sessions-search')?.value ?? '') === '' && $$('.session-row').length === 1,
);
assert($('.session-search-clear') === null, '清空后隐藏清除按钮');
assert($('.session-row.archived') === null, '清空后归档区收回');
assert(text('.msg.user .body') === '你好', '用户消息文本');
assert($('.msg.assistant .body strong')?.textContent === '加粗', 'markdown 粗体渲染');
assert($('.msg.assistant .body h2')?.textContent === '标题', 'markdown 标题渲染');
assert($$('.msg.assistant').length === 1, '一轮只渲染一个 PI 标题');
assert(text('.msg.assistant .tools .tool .name') === 'read', '历史工具行渲染');
assert($('.msg.assistant .tools .tool.ok') !== null, '工具状态 ok');
const historyTool = $$('.msg.assistant .tools .tool').find((node) => node.textContent.includes('read'));
assert(historyTool?.querySelector('.tool-expand')?.textContent.includes('a.ts'), '工具收起时显示一行预览');
assert(historyTool?.querySelector('.tool-chevron') !== null, '历史工具行可展开');
assert(historyTool?.querySelector('.tool-body') == null, '工具行默认收起');
historyTool?.querySelector('.tool-expand')?.click();
await waitFor('展开历史工具', () => historyTool?.querySelector('.tool-body') != null);
assert(text('.msg.assistant .tools .tool .tool-body').includes('"path"'), '展开后显示完整参数');
assert(text('.msg.assistant .tools .tool .tool-body').includes('file contents'), '展开后显示工具结果');
historyTool?.querySelector('.tool-expand')?.click();
await waitFor('收起历史工具', () => historyTool?.querySelector('.tool-body') == null);
assert(historyTool?.querySelector('.tool-expand')?.getAttribute('aria-expanded') === 'false', '再次点击收起工具');

assert(text('#chat-model') === 'Beam Free', '头部模型名');

// ---------- 会话级 codemode 策略：只回显，会话内不可改 ----------
assert(text('.codemode-chip') === 'codemode 禁用', '头部回显会话的 codemode 策略');
assert(
	($('.codemode-chip')?.getAttribute('title') ?? '').includes('不能改'),
	'codemode 策略 chip 说明会话内不可改',
);
assert($('.codemode-chip button') === null, 'codemode 策略 chip 不可交互');

// ---------- 发送按钮左侧快速切换模型 ----------
assert($('#model-switch') !== null, '发送按钮左侧有模型切换按钮');
assert(text('#model-switch .composer-model-switch-name') === 'Beam Free', '模型切换按钮显示当前模型');
assert(text('#model-switch .composer-model-switch-provider') === 'opencode', '模型胶囊上边框显示提供商');
assert($('#model-switch')?.getAttribute('aria-expanded') === 'false', '模型菜单默认收起');
$('#model-switch')?.click();
await waitFor('打开模型菜单', () => $('#model-switch-menu') !== null);
assert($('#model-switch')?.getAttribute('aria-expanded') === 'true', '点击后展开模型菜单');
const modelMenuEl = $('#model-switch-menu');
const modelSearchEl = modelMenuEl?.querySelector('.composer-model-search');
const modelListEl = modelMenuEl?.querySelector('.composer-model-list');
assert(modelSearchEl !== null && modelListEl !== null, '模型菜单把搜索框和列表分开');
assert(!modelListEl?.contains(modelSearchEl), '搜索框不在滚动列表里，滚动时不会被带着走');
assert($$('#model-switch-menu .composer-model-option').length === 3, '模型菜单列出可选模型');
assert(text('#model-switch-menu .composer-model-option.selected').includes('Beam Free'), '当前模型标记为选中');
const beamOption = $$('#model-switch-menu .composer-model-option').find((node) => node.textContent.includes('Beam Free'));
const basicOption = $$('#model-switch-menu .composer-model-option').find((node) => node.textContent.includes('Basic'));
assert(beamOption?.textContent.includes('纯文本') === true, '模型菜单标记非视觉模型');
assert(basicOption?.textContent.includes('视觉') === true, '模型菜单标记视觉模型');
basicOption?.click();
await waitFor('切换到 Basic', () => text('#model-switch .composer-model-switch-name') === 'Basic');
assert(text('#chat-model') === 'Basic', '切换后头部模型名同步');
$('#model-switch')?.click();
await waitFor('重新打开模型菜单', () => $('#model-switch-menu') !== null);
const goModel = $$('#model-switch-menu .composer-model-option').find((node) => node.textContent.includes('Go Haiku'));
goModel?.click();
await waitFor('切换到 Go Haiku', () => text('#model-switch .composer-model-switch-name') === 'Go Haiku');
assert(text('#model-switch .composer-model-switch-provider') === 'opencode-go', '切换模型后提供商名称同步');
await waitFor('订阅额度环出现', () => $('#ring-quota') !== null);
assert($('#balance-chip') === null, '订阅制供应商不显示余额数字');
assert($$('#ring-quota .ring-fill').length === 3, '订阅额度环分 30d/7d/5h 三层');
assert(text('#ring-quota .ring-val') === '53', '订阅额度环中心显示最高用量');
assert($('#ring-quota')?.getAttribute('title').includes('30d 已用 53%'), '订阅额度环标题含 30d 用量');
$('#ring-quota')?.click();
await waitFor('订阅额度浮层', () => $('#quota-pop') !== null);
assert($$('#quota-pop .quota-row').length === 3, '订阅额度浮层列出三个窗口');
assert(text('#quota-pop').includes('30 天') && text('#quota-pop').includes('7 天') && text('#quota-pop').includes('5 小时'), '订阅额度浮层标注 30 天/7 天/5 小时');
assert(text('#quota-pop .quota-row.q30').includes('53%'), '订阅额度浮层显示 30 天用量');
assert(text('#quota-pop .quota-row.q7').includes('21%'), '订阅额度浮层显示 7 天用量');
assert(text('#quota-pop .quota-row.q5').includes('4%'), '订阅额度浮层显示 5 小时用量');
assert(/剩余 \d+d\d+h/.test(text('#quota-pop .quota-row.q30')), '30 天 / 7 天显示 xdxh 剩余时间');
assert(/剩余 \d+h\d+m/.test(text('#quota-pop .quota-row.q5')), '5 小时显示 xhxm 剩余时间');
$('#quota-pop .ctx-pop-close')?.click();
await waitFor('关闭订阅额度浮层', () => $('#quota-pop') === null);
$('#model-switch')?.click();
await waitFor('再次打开模型菜单', () => $('#model-switch-menu') !== null);
const beamModel = $$('#model-switch-menu .composer-model-option').find((node) => node.textContent.includes('Beam Free'));
beamModel?.click();
await waitFor('切回 Beam Free', () => text('#model-switch .composer-model-switch-name') === 'Beam Free');
assert(text('#model-switch .composer-model-switch-provider') === 'opencode', '切回后提供商名称同步');
assert(text('#chat-model') === 'Beam Free', '切回后头部模型名恢复');
await waitFor('订阅额度环消失', () => $('#ring-quota') === null);
await waitFor('余额显示恢复', () => text('#balance-chip') === '$12.50');
assert($('#balance-chip') !== null, '切回余额制供应商恢复余额显示');

// ---------- 模型左侧的思考等级切换 ----------
assert($('#thinking-switch') !== null, '模型左侧有思考等级切换');
assert(text('#thinking-switch').includes('关闭'), '思考等级显示当前值');
assert($('#thinking-switch')?.disabled === false, '多档思考等级可切换');
$('#thinking-switch')?.click();
await waitFor('打开思考等级菜单', () => $('#thinking-switch-menu') !== null);
assert($$('#thinking-switch-menu .composer-model-option').length === 3, '思考等级菜单列出可选档位');
assert(text('#thinking-switch-menu .composer-model-option.selected').includes('关闭'), '当前思考等级标记为选中');
const highThinking = $$('#thinking-switch-menu .composer-model-option').find((node) => node.textContent.includes('high'));
highThinking?.click();
await waitFor('切换思考等级', () => text('#thinking-switch') === '高');
assert(text('#thinking-switch') === '高', '切换后思考等级按钮显示新值');
assert(text('#conn') === '已连接', 'SSE 连接徽标');

// ---------- 左栏底栏 + 设置弹窗 ----------
assert($('.rail-head #new-chat') !== null, '新对话按钮在左栏固定头部');
assert($('.rail-head .brand') !== null, '标题在左栏固定头部');
assert($$('.rail-head .brand svg.brand-mark').length >= 1, '左栏品牌位是标记');
assert($('.rail-foot #conn') !== null, '连接状态在左栏固定底栏');
assert($('.rail-foot #rail-settings-toggle') !== null, '设置按钮在底栏左侧');
assert($('.rail-foot a') === null, '底栏不再显示 API 链接');
const settingsToggle = $('#rail-settings-toggle');
assert(settingsToggle?.getAttribute('aria-expanded') === 'false', '设置弹窗默认未打开');
assert($('#settings-dialog') === null, '初始不渲染设置弹窗');
settingsToggle?.click();
await waitFor('打开设置弹窗', () => $('#settings-dialog') !== null);
assert(settingsToggle?.getAttribute('aria-expanded') === 'true', '点击设置按钮后弹窗打开');
assert(document.body.classList.contains('settings-open'), '设置弹窗打开时锁定页面滚动');
assert($$('.settings-tabs .settings-tab').length === 5, '设置弹窗左侧有 5 个 tab（定时任务已迁到 rail）');
assert($('#settings-tab-jobs') === null, '设置弹窗里不再有定时任务 tab');
assert(text('.settings-tab.active') === '通用设置', '默认打开通用设置');
assert($('#settings-panel-general') !== null, '通用设置面板渲染');
assert($('#settings-notify-enabled') !== null, '通用设置包含完成提醒');
assert($('#settings-notify-sound')?.disabled === true, '关闭完成提醒时提示音禁用');
assert($('#settings-notify-preview') !== null, '通用设置提供试听按钮');
assert($('#settings-approval-sound')?.checked === true, '审核提示音默认开启');
assert($('#settings-approval-preview') !== null, '审核提示音提供试听');
$('#settings-approval-sound')?.click();
await waitFor('关闭审核提示音', () => $('#settings-approval-sound')?.checked === false);
assert(
	JSON.parse(window.localStorage.getItem('turnpi-notify') ?? '{}').approvalSound === false,
	'审核提示音开关写入 localStorage',
);
$('#settings-approval-sound')?.click();
await waitFor('重新开启审核提示音', () => $('#settings-approval-sound')?.checked === true);
assert($$('.settings-theme-option').length === 3, '通用设置包含主题切换');
assert($('#theme-system')?.getAttribute('aria-checked') === 'true', '主题默认跟随系统');
assert(document.documentElement.dataset.themeMode === 'system', '初始主题模式为 system');
$('#theme-dark')?.click();
await waitFor('切换到暗色主题', () => document.documentElement.dataset.theme === 'dark');
assert($('#theme-dark')?.getAttribute('aria-checked') === 'true', '暗色主题按钮选中');
assert(window.localStorage.getItem('turnpi-theme') === 'dark', '暗色主题写入 localStorage');
$('#theme-light')?.click();
await waitFor('切换到亮色主题', () => document.documentElement.dataset.theme === 'light');
assert($('#theme-light')?.getAttribute('aria-checked') === 'true', '亮色主题按钮选中');
assert(document.documentElement.style.colorScheme === 'light', '亮色主题同步 color-scheme');
$('#theme-system')?.click();
await waitFor('切回跟随系统', () => document.documentElement.dataset.themeMode === 'system');
assert(window.localStorage.getItem('turnpi-theme') === 'system', '跟随系统写入 localStorage');
$('#settings-tab-credentials')?.click();
await waitFor('凭据 tab', () => $('#settings-panel-credentials') !== null);
assert(text('.settings-tab.active') === '凭据', '切换到凭据 tab');
await waitFor('凭据卡片', () => $$('.credential-card').length === 2);
assert(text('.credential-card').includes('Gitea'), '凭据卡片显示展示名');
assert(text('.credential-card').includes('gitea:issue:write'), '凭据卡片显示 scope');
assert(text('#settings-panel-credentials').includes('CRED_MOCK_KEY'), '凭据卡片显示环境变量引用');
assert($$('.credential-card-actions .provider-card-btn').length === 8, '凭据卡片操作按钮使用紧凑样式');
assert($('.credential-card-actions .ghost') === null, '凭据卡片不再使用全宽 ghost 按钮');
assert($('#settings-panel-credentials .credential-import') !== null, '凭据页提供从环境导入');
$('#settings-tab-providers')?.click();
await waitFor('模型供应商 tab', () => $('#settings-panel-providers') !== null);
assert(text('.settings-tab.active') === '模型供应商', '切换到模型供应商 tab');
await waitFor('供应商卡片', () => $$('.provider-card').length === 2);
assert($('#providers-add') !== null, '模型供应商页有添加按钮');
assert($$('.provider-card.custom').length === 0, '当前只有内置供应商卡片');
assert(text('.provider-card[data-provider-id="opencode"]').includes('OpenCode Zen'), '内置供应商以卡片显示');
assert($('.provider-card[data-provider-id="opencode"] .provider-mark-art svg') !== null, '内置供应商卡片显示品牌 logo');
$('#providers-add')?.click();
await waitFor('供应商编辑表单', () => $('#provider-editor') !== null);
assert($('#provider-api') !== null, '添加供应商包含 API 协议选择');
assert(($('#provider-api')?.options.length ?? 0) >= 2, 'API 协议包含多个选项');
assert($('#provider-env') !== null, '供应商表单只填 API Key 环境变量名');
assert($('#provider-test') !== null, '供应商表单提供测试连接');
assert($('#provider-fetch-models') !== null, '供应商表单提供获取模型列表');
assert($('#provider-preset-openai') !== null, '添加供应商提供常用内置供应商');
assert($$('.provider-preset .provider-mark').length >= 13, '常用供应商预设带品牌图标');
assert($('#provider-preset-openai .provider-mark-art svg') !== null, 'OpenAI 预设显示品牌 logo');
$('#provider-preset-openai')?.click();
await waitFor('套用 OpenAI 预设', () => $('#provider-env')?.value === 'OPENAI_API_KEY');
assert($('#provider-api')?.value === 'openai-completions', '预设自动填好 API 协议');
assert($('#provider-base-url')?.value === 'https://api.openai.com/v1', '预设自动填好 Base URL');
assert(text('.provider-preset-note').includes('模型目录'), '内置预设说明沿用模型目录');
$('#provider-preset-custom')?.click();
await waitFor('切回自定义供应商', () => $('#provider-env')?.value === '');
setInput('#provider-name', 'Mock Gateway');
setInput('#provider-base-url', 'https://mock.example/v1');
assert($('#provider-env')?.getAttribute('role') === 'combobox', '供应商表单项既能输入也能选凭据');
$('#provider-env')?.dispatchEvent(new window.FocusEvent('focusin', { bubbles: true }));
await waitFor('凭据组合框展开', () => $$('.credential-env-option').length >= 1);
assert($('.credential-env-menu') !== null, '组合框展开 env 层凭据列表');
assert(text('.credential-env-option').includes('MOCK_KEY'), '组合框列出 env 层凭据');
const credentialOption = $$('.credential-env-option').find((node) => node.textContent?.includes('MOCK_KEY'));
credentialOption?.click();
await waitFor('从凭据选择环境变量', () => $('#provider-env')?.value === 'MOCK_KEY');
assert($('#provider-env')?.value === 'MOCK_KEY', '选择凭据后自动填入环境变量名');
setInput('#provider-env', 'MOCK_API_KEY');
assert($('#provider-env')?.value === 'MOCK_API_KEY', '同一个输入框也可以手动填写变量名');
await new Promise((resolve) => setTimeout(resolve, 30));
$('#provider-test')?.click();
await waitFor('供应商连接测试', () => text('#provider-notice').includes('连接成功'));
$('#provider-fetch-models')?.click();
await waitFor('供应商模型列表', () => $$('#provider-model-list .provider-model-row').length === 2);
assert($$('.provider-model-row.selected').length === 2, '小模型列表默认全选');
$('#provider-save')?.click();
await waitFor('保存供应商', () => $('#provider-editor') === null);
assert(providerSaveBody?.apiKeyEnv === 'MOCK_API_KEY', '保存时只提交 API Key 环境变量名');
assert(!('apiKey' in (providerSaveBody ?? {})), '保存请求不包含真实 API Key');
assert(providerSaveBody?.models.length === 2, '保存请求包含勾选的模型');
assert($$('.provider-card.custom').length === 1, '保存后出现自定义供应商卡片');
assert(text('.provider-card.custom').includes('Mock Gateway'), '自定义供应商卡片显示名称');
await waitFor(
	'供应商余额探测',
	() => $('.provider-card[data-provider-id="opencode"] .provider-quota-chip.balance') !== null,
);
assert(text('.provider-card[data-provider-id="opencode"] .provider-quota-chip.balance').includes('$12.50'), '卡片显示余额额度');
assert($$('.provider-card[data-provider-id="opencode-go"] .provider-quota-chip.window').length === 3, 'OpenCode Go 显示 5h/7d/30d 三个额度窗口');
assert(text('.provider-card[data-provider-id="opencode-go"] .provider-quota-chip.window').includes('4%'), 'OpenCode Go 显示使用百分比');
assert($('.provider-card[data-provider-id="opencode-go"] .provider-quota-meter-fill') !== null, 'OpenCode Go 额度带进度条');
assert(text('.provider-card[data-provider-id="opencode"] .provider-connectivity').includes('42ms'), '卡片显示连接延迟');
const customEnable = $('.provider-card.custom .provider-enable input');
customEnable?.click();
await waitFor('停用自定义供应商', () => text('.provider-card.custom .provider-badge') === '已停用');
assert(providerToggleBody?.id === providerSaveBody?.id, '启停请求带上供应商 ID');
assert(providerToggleBody?.enabled === false, '启停请求带上目标状态');
assert($('.provider-card.custom.disabled') !== null, '停用后卡片显示 disabled 状态');
assert($('#quota-ring-settings') !== null, '供应商卡片下面有订阅额度环设置');
assert($('#quota-ring-preview') !== null, '订阅额度环设置带预览环');
assert($('#quota-ring-order-30d')?.getAttribute('aria-pressed') === 'true', '默认外 30d / 内 5h');
$('#quota-ring-order-5h')?.click();
await waitFor('切换外 5h', () => $('#quota-ring-order-5h')?.getAttribute('aria-pressed') === 'true');
assert(window.localStorage.getItem('turnpi-quota-ring')?.includes('5h-outer') === true, '环顺序写入 localStorage');
assert($('#quota-ring-preview .ring-fill.q5')?.getAttribute('r') === '15.7', '预览外圈切为 5h');
$('#quota-ring-metric-remaining')?.click();
await waitFor('切换余量', () => $('#quota-ring-metric-remaining')?.getAttribute('aria-pressed') === 'true');
assert(window.localStorage.getItem('turnpi-quota-ring')?.includes('remaining') === true, '显示用量/余量写入 localStorage');
assert(text('#quota-ring-preview .ring-val') === '46', '余量预览显示最低余量');
$('#quota-ring-order-30d')?.click();
$('#quota-ring-metric-used')?.click();
await waitFor('恢复默认环设置', () => $('#quota-ring-order-30d')?.getAttribute('aria-pressed') === 'true' && $('#quota-ring-metric-used')?.getAttribute('aria-pressed') === 'true');
$('#settings-tab-runtime')?.click();
await waitFor('模型与工具 tab', () => $('#settings-panel-runtime') !== null);
assert(text('.settings-tab.active') === '模型与工具', '切换到模型与工具 tab');
assert(($('#model')?.options.length ?? 0) >= 2, '模型与工具页有模型下拉');
assert($('#thinking')?.disabled === false, '多档思考级别可选');
assert($('#thinking')?.value === 'high', '设置页思考级别与输入框选择同步');
assert($('#tools .tool-toggle') !== null, '模型与工具页包含工具开关');
assert($('#tools .tool-toggle.pinned') !== null, '凭据工具固定不可关');
$('#settings-tab-about')?.click();
await waitFor('关于 tab', () => $('#settings-panel-about') !== null);
assert(text('.settings-tab.active') === '关于', '切换到关于 tab');
assert(text('#agent-id') === 'web-test', '关于页显示会话 agentId');
assert($$('.settings-about-brand img.settings-about-mark').length === 1, '关于页品牌位是 128px 图标而不是蓝点');
assert($$('.dot').length === 0, '界面上不再有任何蓝色圆点');
assert(text('#pi-version') === 'v1.4.0', '关于页显示 Pi 版本');
$('#settings-close')?.click();
await waitFor('关闭设置弹窗', () => $('#settings-dialog') === null);
assert(settingsToggle?.getAttribute('aria-expanded') === 'false', '关闭后设置按钮恢复');
assert(!document.body.classList.contains('settings-open'), '关闭设置弹窗后恢复页面滚动');
settingsToggle?.click();
await waitFor('重新打开设置弹窗', () => $('#settings-dialog') !== null);
document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await waitFor('Esc 关闭设置弹窗', () => $('#settings-dialog') === null);
assert(!document.body.classList.contains('settings-open'), 'Esc 关闭后恢复页面滚动');
assert(text('#turn-n') === '1' && text('#step-n') === '1', '轮/步统计');
assert(text('#in-miss') === '2.0' && text('#u-miss') === 'k', '输入 token 格式化');
assert(text('#ring-ctx .ring-val') === '5', '上下文环');
assert(text('#ring-cache .ring-val') === '20', '缓存命中环');
assert($('#ring-cache')?.tagName === 'BUTTON', '缓存命中环可点击');
$('#ring-cache')?.click();
await waitFor('缓存命中浮层', () => $('#cache-pop') !== null);
assert(text('#cache-pop').includes('缓存命中') && text('#cache-pop').includes('命中率'), '缓存浮层显示命中率');
assert(text('#cache-pop .ctx-row.cache-hit').includes('500'), '缓存浮层显示命中 token');
assert(text('#cache-pop .ctx-row.cache-miss').includes('2.0k'), '缓存浮层显示未命中 token');
assert($$('#cache-pop .ctx-row').length === 2, '无缓存写入时不显示写入行');
$('#cache-pop .ctx-pop-close')?.click();
await waitFor('关闭缓存浮层', () => $('#cache-pop') === null);
assert($('#ring-quota') === null, '非订阅制供应商不显示订阅额度环');
assert(text('#balance-chip') === '$12.50', '余额制供应商显示币种符号和余额');
assert($('#balance-chip')?.getAttribute('title').includes('Credits'), '余额显示附带余额说明');
assert(text('#tps-value') === '50', '历史本轮平均 TPS 回显');

// ---------- 上下文环：点击查看 token 明细 ----------
assert($('#ring-ctx')?.tagName === 'BUTTON', '上下文环是可点击按钮');
assert($('#ring-ctx')?.getAttribute('aria-expanded') === 'false', '上下文明细默认收起');
$('#ring-ctx')?.click();
await waitFor('上下文明细弹出', () => $('#ctx-pop') !== null);
assert($('#ring-ctx')?.getAttribute('aria-expanded') === 'true', '点击后展开上下文明细');
assert(text('#ctx-pop .ctx-total b') === '5k', '上下文明细总量按 k 显示');
assert(text('#ctx-pop .ctx-total span') === '/ 100k', '上下文窗口按 k 显示');
assert(text('#ctx-pop .ctx-row.ctx-system b') === '1.2k', '系统提示词估算');
assert(text('#ctx-pop .ctx-row.ctx-tools b') === '0.8k', '工具定义估算');
assert(text('#ctx-pop .ctx-row.ctx-tools .ctx-meta') === '2 个', '工具数量');
assert(text('#ctx-pop .ctx-row.ctx-messages b') === '2.5k', '对话消息估算');
assert(text('#ctx-pop .ctx-row.ctx-messages .ctx-meta') === '2 条', '消息数量');
assert(text('#ctx-pop .ctx-row.ctx-other .ctx-name') === '估算差异', '差异行明确标为估算差异');
assert(text('#ctx-pop .ctx-row.ctx-other b') === '0.5k', '估算差异');
assert(text('#ctx-pop .ctx-note').includes('不是漏算内容'), '差异说明不是漏算');
window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await waitFor('Escape 关闭上下文明细', () => $('#ctx-pop') === null);
assert($('#ring-ctx')?.getAttribute('aria-expanded') === 'false', '关闭后 aria-expanded 复位');

// ---------- 对话 / 轨迹 tab ----------
assert($('#tab-chat')?.getAttribute('aria-selected') === 'true', '默认在对话 tab');
assert($('.chat-tab-git') === null && $('#tab-git-add') === null, '非 git 工作区不显示 Git tab');
$('#tab-trajectory')?.click();
await waitFor('轨迹 tab 渲染', () => $('.trajectory') !== null && $$('.traj-row').length === 5);
assert($('#tab-trajectory')?.getAttribute('aria-selected') === 'true', '切到轨迹 tab');
assert($('#messages')?.hidden === true, '轨迹 tab 隐藏对话列表');
assert($('.traj-waterfall') !== null, '轨迹顶部有时间线');
assert($('.trajectory-inner')?.firstElementChild?.classList.contains('traj-waterfall'), '时间线在轨迹最上面');
assert($$('.traj-waterfall-lane').map((lane) => lane.classList[1]).join(',') === 'traj-lane-input,traj-lane-think,traj-lane-tool', '时间线顺序为输入/思考/工具');
assert($$('.traj-waterfall-lane.traj-lane-input .traj-bar').length === 1, '时间线输入轨');
assert($$('.traj-waterfall-lane.traj-lane-tool .traj-bar').length === 1, '时间线工具轨');
assert($$('.traj-waterfall-lane.traj-lane-think .traj-bar').length === 1, '时间线思考轨');
assert($('.traj-waterfall-plot') !== null, '时间线绘图区在（网格线由 CSS 画）');
assert(
	[...$$('.traj-bar')].every((bar) => ['traj-lane-input', 'traj-lane-think', 'traj-lane-tool'].some((n) => bar.classList.contains(n))),
	'每个色块都带车道类（配色靠车道 token，不写死）',
);
$('.traj-bar.traj-lane-think')?.click();
await waitFor('时间线点击选中', () => $('.traj-bar.traj-lane-think.selected') !== null);
assert($('.traj-bar.traj-lane-think.selected') !== null, '点击时间线色块可选中');
await waitFor('思考行展开加载上下文', () => $('.traj-context') !== null);
assert($('.traj-call') !== null, '思考行显示本次调用统计');
assert(text('.traj-call-grid').includes('首 token 延迟'), '调用统计含首 token 延迟');
assert(text('.traj-call-grid').includes('命中 500') && text('.traj-call-grid').includes('未命中 2,000'), '调用统计含缓存命中/未命中');
assert(text('.traj-call-grid').includes('800.0 tok/s'), '调用统计含 TPS');
assert(text('.traj-context-title') === '本步上下文', '步骤行有本步上下文入口');
assert(text('.traj-context-meta').includes('系统'), '上下文入口显示分类统计');
$('.traj-context-toggle')?.click();
await waitFor('上下文展开', () => $$('.traj-context-section').length === 4);
assert($$('.traj-context-section').map((section) => section.querySelector('.traj-context-section-head span')?.textContent).join(',') === '系统提示词,工具定义 · 1 个,Skills · 1 个,对话消息 · 2 条', '上下文按系统/工具/skill/消息分段');
assert(text('.traj-context-note').includes('压缩'), '上下文提示已按压缩裁剪');
assert($('.traj-context-more') !== null, '长上下文默认只显示预览并可展开全部');
assert(text('.traj-raw-title') === 'API 原始 payload', '思考行有原始 payload 入口');
$('.traj-raw-toggle')?.click();
await waitFor('原始 payload 加载', () => $('.traj-json') !== null);
assert($$('.traj-json-key').some((node) => node.textContent === '"model"'), '原始 payload 按 JSON key 格式化');
assert($$('.traj-json-toggle').length >= 3, '原始 payload 对象/数组可折叠');
const jsonTogglesBefore = $$('.traj-json-toggle').length;
$$('.traj-json-toggle')[1]?.click();
await waitFor('原始 payload 嵌套展开', () => $$('.traj-json-toggle').length > jsonTogglesBefore);
assert($$('.traj-json-toggle').length > jsonTogglesBefore, '点击 JSON 节点可展开子项');
assert($('.traj-turn') === null, '轨迹不再使用轮次嵌套框');
assert($('.traj-turn-divider')?.textContent.includes('第 1 轮'), '轨迹有轮次分割信息');
assert($('.traj-row')?.classList.contains('traj-kind-input'), '第一行是输入，不是压缩事件');
assert(text('.traj-row.traj-kind-event .traj-row-badge') === '压缩', '压缩事件按时间排在行里');
assert(text('.traj-row.traj-kind-tool .traj-row-preview').startsWith('read'), '轨迹显示工具名');
$('.traj-row.traj-kind-tool .traj-row-head')?.click();
await waitFor('轨迹工具展开', () => text('.traj-row.traj-kind-tool .traj-row-body').includes('"path"'));
assert(text('.traj-row.traj-kind-tool .traj-row-body').includes('file contents'), '轨迹工具显示结果');
$('#tab-chat')?.click();
await waitFor('切回对话 tab', () => $('#messages')?.hidden === false);
assert($('#tab-chat')?.getAttribute('aria-selected') === 'true', '切回对话 tab');

// ---------- 切换会话：底部统计立即归零，拿到新 stats 后恢复 ----------
$('.session-row:not(.archived) .session-open')?.click();
await waitFor('历史消息加载中输入框禁用', () => $('textarea#input')?.disabled === true);
assert($('#send')?.disabled === true, '历史消息加载中禁用发送按钮');
assert($('.composer-add')?.disabled === true, '历史消息加载中禁用附件按钮');
assert($('.composer.locked') !== null, '历史消息加载中给输入区挂 locked 状态');
await waitFor(
	'切会话立即清空统计',
	() => text('#turn-n') === '0' && text('#step-n') === '0' && text('#ring-ctx .ring-val') === '0',
);
assert(text('#in-miss') === '0' && text('#out-k') === '0', '切会话清空 token 统计');
assert(text('#ring-cache .ring-val') === '0', '切会话清空缓存环');
assert(text('#tps-value') === '—', '切会话清空 TPS');
await waitFor('切会话后恢复统计', () => text('#turn-n') === '1' && text('#ring-ctx .ring-val') === '5');
assert(text('#ring-ctx .ring-val') === '5' && text('#ring-cache .ring-val') === '20', '切会话后显示目标会话统计');
await waitFor('切会话后恢复平均 TPS', () => text('#tps-value') === '50');
assert(text('#tps-value') === '50', '切会话后回显本轮平均 TPS');

// ---------- 压缩上下文：按钮禁用、上下文环动画、完成后刷新 ----------
await waitFor('会话打开完成，发送按钮恢复', () => $('#send').disabled === false);
assert($('#send').disabled === false, '压缩前发送按钮可用');
assert($('textarea#input')?.disabled === false, '历史消息加载完成后输入框恢复');
assert($('.composer-add')?.disabled === false, '历史消息加载完成后附件按钮恢复');
$('#compact').click();
await waitFor('发起压缩', () => compactCalls === 1 && releaseCompact);
await waitFor('压缩中禁用发送', () => $('#send').disabled === true);
assert($('#compact').disabled === true, '压缩中禁用压缩按钮');
assert($('#compact').classList.contains('compacting'), '压缩中压缩按钮有旋转动画 class');
assert($('#ring-ctx').classList.contains('compacting'), '压缩中上下文环有动画 class');
releaseCompact();
await waitFor('压缩完成', () => $('#compact').disabled === false);
assert($('#send').disabled === false, '压缩完成后发送按钮恢复');
assert(!$('#compact').classList.contains('compacting'), '压缩完成后按钮动画 class 移除');
assert(!$('#ring-ctx').classList.contains('compacting'), '压缩完成后动画 class 移除');
assert(text('#ring-ctx .ring-val') === '9', '压缩后上下文环更新为 9000/100000');

// ---------- 实时 stats 事件：服务端每个 assistant/工具/压缩结束推送，状态栏不用等 settled ----------
const liveSource = MockEventSource.instances[MockEventSource.instances.length - 1];
liveSource.emit('stats', {
	stats: {
		...baseStats,
		turns: 2,
		steps: 2,
		toolCalls: 2,
		usage: { input: 2000, cacheRead: 500, cacheWrite: 0, output: 1200 },
		context: { tokens: null, contextWindow: 100000 },
		busy: true,
	},
});
await waitFor('实时统计先更新轮次', () => text('#turn-n') === '2');
assert(text('#ring-ctx .ring-val') === '9', 'tokens 暂时为 null 时不把压缩后估算覆盖成 0');
liveSource.emit('stats', {
	stats: {
		...baseStats,
		turns: 2,
		steps: 3,
		toolCalls: 4,
		usage: { input: 1000, cacheRead: 3000, cacheWrite: 0, output: 1500 },
		context: { tokens: 12000, contextWindow: 100000, estimated: false },
		busy: true,
	},
});
await waitFor('实时统计刷新上下文/缓存环', () => text('#ring-ctx .ring-val') === '12' && text('#ring-cache .ring-val') === '75');
assert(text('#step-n') === '3', '实时统计更新步数');
assert(text('#in-miss') === '1.0' && text('#u-miss') === 'k', '实时统计更新输入 token');

// ---------- 右栏：默认 Guide → 文件树 → 预览 ----------
const guideCard = (title) => $$('.guide-card').find((card) => card.textContent.includes(title));
const panelTab = (title) =>
	$$('.panel-tab').find((tab) => tab.querySelector('.panel-tab-name')?.textContent === title || tab.getAttribute('aria-label') === title);
const fileRow = (name) =>
	$$('.file-row').find((row) => row.querySelector('.file-name')?.textContent === name);

assert($('.app.no-panel') === null, '桌面端右栏默认可见');
assert($('#panel') !== null, '右栏挂载');
assert($('.guide') !== null, '默认显示 Guide，而不是文件树');
assert($$('.guide-card').length === 2, 'Guide 有文件/检索两个入口');
assert(guideCard('文件') !== undefined, 'Guide 卡片标题');
assert(guideCard('检索') !== undefined, 'Guide 里有检索入口');
assert($('.guide-icon.guide-icon-files') !== null && $('.guide-icon.files') === null, 'Guide 文件图标不再与文件树 .files 样式冲突');
assert($('#toggle-panel')?.textContent?.trim() === '', '右栏按钮只显示图标');
assert($('.panel-tab.panel-tab-guide .panel-tab-close') === null, 'Guide 唯一时没有关闭按钮');

guideCard('文件')?.click();
await waitFor('文件 tab', () => panelTab('文件') !== undefined && $('.files-body .file-row') !== null);
assert($('.guide') === null, '打开文件后 Guide tab 被替换');
assert($('.panel-tab.panel-tab-guide') === null, 'Guide tab 已消失');
assert(fileRow('README.md') !== null, '文件树加载根目录');
assert(fileRow('node_modules') == null, '默认隐藏 node_modules');
assert(fileRow('docs') !== null && fileRow('docs')?.classList.contains('directory'), '目录行');

let releaseDocsList;
docsListGate = new Promise((resolve) => {
	releaseDocsList = resolve;
});
fileRow('docs')?.click();
await waitFor('docs 请求中', () => docsListCalls >= 1);
assert(fileRow('docs')?.querySelector('.file-icon .file-spin') != null, '目录加载中文件夹图标转圈');
assert(!text('.files-body').includes('加载中'), '目录加载中不显示加载中占位');
assert(fileRow('guide.md') == null, '加载未返回前不展开目录');
releaseDocsList();
docsListGate = null;
await waitFor('展开 docs', () => fileRow('guide.md') != null);
assert(fileRow('guide.md') != null, '点击目录懒加载子项');
assert(fileRow('docs')?.querySelector('.file-icon .file-spin') == null, '加载完成后图标恢复为文件夹');
fileRow('docs')?.click();
await waitFor('折叠 docs', () => fileRow('guide.md') == null);
assert(fileRow('guide.md') == null, '再次点击目录折叠');

fileRow('README.md')?.click();
await waitFor('Markdown 预览', () => $('.preview-markdown') !== null && text('.preview-markdown').includes('工作区'));
assert($$('.panel-tab-name').some((node) => node.textContent === 'README.md'), '点击文件新增预览 tab');
assert($('.preview-markdown img')?.getAttribute('src')?.startsWith('/api/files/raw?'), 'Markdown 相对图片走 raw URL');
assert($('.preview-markdown [data-file-href="docs/guide.md"]') !== null, 'Markdown 相对链接标记为文件跳转');
$('.preview-markdown [data-file-href="docs/guide.md"]')?.click();
await waitFor(
	'Markdown 相对链接在右栏打开',
	() => panelTab('guide.md') !== undefined && $$('.preview-markdown').some((node) => node.textContent.includes('相对链接和图片')),
);
assert($('.panel-tab.active .panel-tab-name')?.textContent === 'guide.md', '点击 md 链接打开正确文件，而不是重复拼目录');
$('.preview-markdown [data-file-href="README.md"]')?.click();
await waitFor(
	'嵌套 Markdown 的相对链接按所在目录解析',
	() => $('.panel-tab.active .panel-tab-name')?.textContent === 'README.md',
);
assert($('.panel-tab.active .panel-tab-name')?.textContent === 'README.md', '嵌套 md 的 ../ 链接不会重复拼目录');

panelTab('文件')?.click();
await waitFor('回到文件 tab', () => $('.files') !== null && $('.files')?.offsetParent !== null);
fileRow('demo.ts')?.click();
await waitFor('CodeMirror 代码预览', () => $('.code-preview .cm-editor') !== null && text('.cm-content').includes('function demo'));
assert($('.cm-lineNumbers') !== null, '代码预览显示行号');
assert($('.cm-foldGutter') !== null, '代码预览显示折叠栏');
assert($('.cm-editor')?.getAttribute('contenteditable') === null, 'CodeMirror 代码预览不是编辑器');

panelTab('文件')?.click();
fileRow('Dockerfile')?.click();
await waitFor('Dockerfile 代码预览', () => $('.panel-page.active .cm-content')?.textContent?.includes('FROM node') === true);
await waitFor('Dockerfile 语法高亮', () => $$('.panel-page.active .cm-content span').length > 0);
assert($$('.panel-page.active .cm-content span').length > 0, 'Dockerfile 使用 basename 匹配到语言包并高亮');

panelTab('文件')?.click();
fileRow('logo.png')?.click();
await waitFor('图片预览', () => $('.image-preview img') !== null);
assert($('.image-preview img')?.getAttribute('src')?.startsWith('/api/files/raw?'), '图片 src 指向 raw');

panelTab('文件')?.click();
fileRow('manual.pdf')?.click();
await waitFor('PDF 预览', () => $('.pdf-frame') !== null);
assert($('.pdf-frame')?.getAttribute('src')?.startsWith('/api/files/raw?'), 'PDF iframe src 指向 raw');

// ---------- 点击标题改名 ----------
$('#chat-title button').click();
await waitFor('标题进入编辑', () => $('.chat-title-input') !== null);
const titleInput = $('.chat-title-input');
titleInput.focus();
const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
valueSetter.call(titleInput, '重命名后的会话');
titleInput.dispatchEvent(new window.Event('input', { bubbles: true }));
titleInput.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }));
await waitFor('标题更新', () => text('#chat-title') === '重命名后的会话');
assert(text('#chat-title') === '重命名后的会话', '标题显示新名称');
assert(renamedName === '重命名后的会话', 'rename API 收到名称');
await waitFor('会话列表同步名称', () => text('#sessions').includes('重命名后的会话'));
assert(text('#sessions').includes('重命名后的会话'), '左侧会话列表显示自定义名');

// ---------- 新对话 → 示例 → 发送 ----------
// 从轨迹 tab 新建会话：应该回到对话起始页，而不是继续停在轨迹
$('#tab-trajectory')?.click();
await waitFor('从新对话前打开轨迹 tab', () => $('#tab-trajectory')?.getAttribute('aria-selected') === 'true');
$('#new-chat').click();
await waitFor('新对话空视图', () => $('.samples button') !== null);
assert($('#tab-chat')?.getAttribute('aria-selected') === 'true', '从轨迹新建会话回到对话 tab');
assert($$('.msg').length === 0, '新对话清空消息');
assert($('.workspace-picker-btn') !== null, '新对话显示工作区选择器');
assert(text('.workspace-picker-name') === '工作区', '默认工作区回显');
$('.workspace-picker-btn')?.click();
await waitFor('工作区菜单', () => $$('.workspace-option').length === 2);
assert($$('.workspace-option').length === 2, '工作区菜单列出注册表');
assert($('.workspace-menu-refresh') !== null, '工作区菜单有刷新按钮');
$('.workspace-menu-refresh')?.click();
await waitFor(
	'刷新工作区',
	() => workspaceReloadCalls === 1 && $$('.workspace-option').length === 3,
);
assert(workspaceReloadCalls === 1, '刷新按钮触发 /api/workspaces/reload');
assert(workspaceReloadMethods[0] === 'POST', '刷新按钮用 POST 调 /api/workspaces/reload');
assert($$('.workspace-option').length === 3, '刷新后出现新发现的工作区');
assert($$('.workspace-option .lucide-lock').length === 1, '只读工作区显示锁图标');
$$('.workspace-option')[1]?.click();
await waitFor('切换工作区', () => text('.workspace-picker-name') === 'pi-webchat');
assert(text('.workspace-picker-name') === 'pi-webchat', '工作区选择器切换成功');
assert($('.worktree-option input') !== null, 'git 工作区显示隔离工作树开关');
assert($('.worktree-option input')?.checked === false, '隔离工作树默认关闭');
$('.worktree-option input')?.click();
await waitFor('开启隔离工作树', () => $('.worktree-option input')?.checked === true);
assert(
	window.localStorage.getItem('turnpi-worktree-workspaces')?.includes('pi-webchat'),
	'隔离工作树选择按工作区记忆',
);
assert($$('.mode-slider-option').length === 3, 'codemode 是三档滑块');
assert($('.mode-slider.mode-auto') !== null, 'codemode 默认自动（中间档）');
assert($('[data-codemode-mode="auto"]')?.classList.contains('active'), '中间档高亮为自动');
assert(text('[data-codemode-mode="off"]') === '禁用' && text('[data-codemode-mode="on"]') === '启用', '左禁用 / 右启用');
$('[data-codemode-mode="off"]')?.click();
await waitFor('codemode 切到禁用', () => $('.mode-slider.mode-off') !== null);
assert($('[data-codemode-mode="off"]')?.classList.contains('active'), '点左侧切到禁用');
assert(text('.empty-hint').includes('不提供 codemode'), '禁用档在提示行说明');
$('[data-codemode-mode="on"]')?.click();
await waitFor('codemode 切到启用', () => $('.mode-slider.mode-on') !== null);
assert($('[data-codemode-mode="on"]')?.classList.contains('active'), '点右侧切到启用');
$('[data-codemode-mode="auto"]')?.click();
await waitFor('codemode 回到自动', () => $('.mode-slider.mode-auto') !== null);

// ---------- Git tabs（git 工作区：每个仓库一个 tab，默认就是提交树） ----------
await waitFor('仓库清单加载出 Git tab', () => $$('.chat-tab-git').length === 2);
assert(gitRepoLoads === 1, '进入 git 工作区只拉一次仓库清单');
assert($$('.chat-tab-git').length === 2, '每个仓库一个 Git tab');
assert(text('.chat-tab-git').includes('pi-webchat'), '根仓库 tab 用仓库名');
assert($$('.chat-tab-dirty').length === 1, '有未提交改动的仓库 tab 带黄点');

$$('.chat-tab-git')[0]?.click();
await waitFor('提交树默认渲染', () => $$('.git-graph .git-commit').length === 4);
assert($('.chat-tab-git.active') !== null, '点仓库 tab 切过去');
assert($('#messages')?.hidden === true, 'Git tab 隐藏消息列表');
assert($('.git-switch') === null, '仓库页里没有 改动/提交记录 子 tab');
assert($('#tab-git') === null, '没有那个点了没反应的总 Git tab');
assert(gitLogLoads.length === 1, '进仓库 tab 直接拉提交记录');
assert(gitLogLoads[0].includes('rel=') && gitLogLoads[0].includes('root=pi-webchat'), '请求带上 root 与 repo rel');

const commitRows = () => $$('.git-graph .git-commit');
const rowText = (index) => commitRows()[index].textContent;
assert($$('.git-graph-svg').length === 4, '每条提交一行分支图');
assert(commitRows()[0].querySelector('.git-graph-svg').getAttribute('width') === '28', '两条泳道时图宽 28px');
// happy-dom 里对 svg 用后代选择器会串到全局，这里直接数子节点
const graphPaths = (index) =>
	Array.from(commitRows()[index].querySelector('svg').children).filter(
		(node) => node.tagName.toLowerCase() === 'path',
	).length;
assert(graphPaths(0) === 2, '合并行画两条父边');
assert(graphPaths(1) === 3, '中间行画穿过泳道 + 上方 + 下方');
assert(graphPaths(3) === 2, '汇合行画上方 + 汇入');
assert(rowText(0).includes('Merge branch'), '第一行是最新提交');
assert(rowText(1).includes('feat: Git tab 支持提交记录树'), '提交摘要可见');
assert($$('.git-graph .git-ref.head').length === 1, 'HEAD 徽标只在 HEAD 那行');
assert($$('.git-graph .git-ref.branch').some((ref) => ref.textContent.includes('feat/git-log')), '分支 ref 挂在对应提交上');
assert($$('.git-graph .git-ref.tag').some((ref) => ref.textContent.includes('v1.0.0')), 'tag 徽标单独着色');
assert(
	$$('.git-graph .git-ref').every((ref) => ref.querySelector('.git-ref-name') !== null),
	'ref 徽标的名字单独包一层（省略号只作用于名字）',
);
assert(rowText(2).includes('guo'), '提交行显示作者');
assert($('.git-detail') === null, '没点提交时右侧不分列');
assert(text('.git-dirty-row').includes('未提交改动'), '列表顶部有一条未提交改动');

// ---------- 点提交 → 右栏分列（上：提交信息 / 下：改动文件） ----------
commitRows()[0].click();
await waitFor('提交详情', () => $('.git-detail') !== null && $$('.git-commit-file').length === 3);
assert($('.git-body').classList.contains('split'), '点提交后分成两列');
assert($$('.git-detail-block').length === 2, '右栏上下两块');
assert(gitCommitLoads.length === 1, '点提交只拉一次详情');
assert(gitCommitLoads[0].includes('sha=m1m1m1') && gitCommitLoads[0].includes('rel='), '详情请求带上 sha 与 rel');
assert(commitRows()[0].classList.contains('selected'), '选中的提交行高亮');

const blocks = $$('.git-detail-block');
assert(text('.git-detail-title').includes('Merge branch'), '上块是提交信息标题');
assert(blocks[0].textContent.includes('第二行：验证多行正文'), '上块显示提交正文');
assert(blocks[0].textContent.includes('zhou@example.com'), '上块显示作者与邮箱');
assert(blocks[0].textContent.includes('m1m1m1'), '上块显示提交号');
assert(
	text('.git-detail-refs .git-ref-name') === 'HEAD' || text('.git-detail-refs .git-ref-name') === 'main',
	'详情里的 ref 徽标名字完整',
);
assert(blocks[0].textContent.includes('c1c1c1c') && blocks[0].textContent.includes('f1f1f1f'), '上块列出父提交');

assert(blocks[1].textContent.includes('改动文件'), '下块是改动文件');
assert($$('.git-commit-file').length === 3, '列出这次提交改动的文件');
assert(blocks[1].textContent.includes('+52') && blocks[1].textContent.includes('−83'), '下块显示增删统计');
assert($$('.git-commit-file .git-code.modified').length === 1, '修改文件用 M 标记');
assert($$('.git-commit-file .git-code.added').length === 1, '新增文件用 A 标记');
assert($$('.git-commit-file .git-code.deleted').length === 1, '删除文件用 D 标记');
assert(text('.git-commit-file').includes('+12'), '文件行显示行内增删');

// 点文件 → 右栏打开预览
$$('.git-commit-file').find((row) => row.textContent.includes('web/src/app.ts'))?.click();
await waitFor(
	'点提交里的文件打开预览',
	() => $('.panel-page.active .cm-content')?.textContent?.includes('commitFile') === true,
);
assert($('.panel-page.active .cm-content')?.textContent?.includes('commitFile') === true, '提交里的文件能打开内容');

// ---------- 左栏分支列表：本地 + 每个远端一组 ----------
assert($('.git-branches') !== null, '提交树左侧有分支列表');
assert(gitBranchLoads.length === 1, '进仓库 tab 只拉一次分支列表');
assert(
	gitBranchLoads[0].includes('rel=') && gitBranchLoads[0].includes('root=pi-webchat'),
	'分支请求带上 root 与 rel',
);
assert($$('.git-branch-row').length === 2, '本地分支全部列出（远端默认折叠）');
assert($('.git-branch-row.current') !== null, '当前分支有标记');
assert(text('.git-branch-row.current').includes('main'), '当前分支是 main');
assert($('.git-branch-row.current .git-branch-current') !== null, '当前分支带对勾');
assert($('.git-branch-row .git-branch-track') !== null, '落后上游时显示 ↓ 标记');
assert(
	text('.git-branches').includes('本地分支') && text('.git-branches').includes('远端分支'),
	'分本地/远端两组',
);

// 展开远端分支：两个远端各自一组
const remoteHead = $$('.git-branch-group-head').find((head) => head.textContent.includes('远端分支'));
remoteHead?.click();
await waitFor('展开远端分支', () => $$('.git-branch-remote').length === 2);
assert($$('.git-branch-remote').length === 2, '两个远端各一组');
assert($$('.git-branch-remote').some((group) => group.textContent.includes('origin')), '一个远端是 origin');
assert($$('.git-branch-remote').some((group) => group.textContent.includes('upstream')), '另一个远端是 upstream');
assert($$('.git-branch-remote .git-branch-row').length === 3, '远端分支共三条');

// 点远端分支 → 只按这条 ref 拉提交
const upstreamRow = $$('.git-branch-row').find((row) => row.textContent.includes('main') && row.closest('.git-branch-remote')?.textContent.includes('upstream'));
assert(upstreamRow !== undefined, '远端分支行可点');
upstreamRow?.click();
await waitFor('按分支过滤提交', () => $('.git-filter-chip') !== null);
const filteredUrl = decodeURIComponent(gitLogLoads.at(-1));
assert(filteredUrl.includes('ref=refs/remotes/upstream/main'), '过滤时把完整 ref 传给 git log', filteredUrl);
assert(text('.git-filter-chip').includes('upstream/main'), '列表顶部提示只看哪条分支');
assert($('.git-branch-row.active') !== null, '选中的分支高亮');

// 点「全部提交」取消过滤
$('.git-branch-all')?.click();
await waitFor('取消分支过滤', () => $('.git-filter-chip') === null);
assert(!decodeURIComponent(gitLogLoads.at(-1)).includes('ref='), '取消过滤后不再带 ref');
assert($('.git-branch-row.active') === null, '取消后没有高亮的分支');

// ---------- 未提交改动：同一块右栏里看目录树 ----------
$('.git-dirty-row')?.click();
await waitFor('工作区改动树', () => $$('.git-detail .git-file-row').length === 4);
assert($$('.git-detail .git-dir-row').length === 3, '改动按目录分组（docs / docs/guide / server）');
assert($$('.git-detail .git-file-row').length === 4, '改动文件全部列出（不止最近几条）');
assert($$('.git-detail .git-file-row').some((row) => row.textContent.includes('demo.ts')), '根目录文件直接挂在顶层');
assert($$('.git-detail .git-code.modified').length === 2, '修改文件用 M 标记');
assert($$('.git-detail .git-code.added').length === 1, '新增文件用 A 标记');
assert($$('.git-detail .git-code.untracked').length === 1, '未跟踪文件用 U 标记');
assert(text('.git-detail').includes('HEAD'), '未提交改动块显示 HEAD');

// 折叠目录：docs 子树收起后文件行减少，再点回来
const docsDir = $$('.git-detail .git-dir-row').find((row) => row.textContent.includes('docs'));
docsDir?.click();
await waitFor('折叠 docs 目录', () => $$('.git-detail .git-file-row').length === 2);
assert($$('.git-detail .git-file-row').length === 2, '折叠目录后只显示外层文件');
docsDir?.click();
await waitFor('展开 docs 目录', () => $$('.git-detail .git-file-row').length === 4);

const demoRow = $$('.git-detail .git-file-row').find((row) => row.textContent.includes('demo.ts'));
demoRow?.click();
await waitFor(
	'点改动文件打开预览',
	() => $('.panel-page.active .cm-content')?.textContent?.includes('export function demo') === true,
);
assert($('.panel-page.active .cm-content')?.textContent?.includes('export function demo') === true, '点击改动文件看到内容');

// ---------- 「＋」页：手动登记 / 移除 ----------
$('#tab-git-add')?.click();
await waitFor('添加子仓库视图', () => $('#tab-git-add')?.getAttribute('aria-selected') === 'true');
assert($('.git-add input') !== null, '＋ 页有添加表单');
const gitInput = $('.git-add input');
const gitValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
gitValueSetter.call(gitInput, 'libs/tool');
gitInput.dispatchEvent(new window.Event('input', { bubbles: true }));
$('.git-add button[type="submit"]')?.click();
await waitFor('登记子仓库并切到它的 tab', () => gitRepoAddCalls.length === 1 && $$('.chat-tab-git').length === 3);
assert(gitRepoAddCalls[0]?.path === 'libs/tool', '添加请求带上子目录路径');
assert(text('.chat-tab-git.active').includes('tool'), '登记后自动切到新仓库的 tab');

$('#tab-git-add')?.click();
await waitFor('手动登记列表', () => $$('.git-manual-list li').length === 1);
const originalConfirm = window.confirm;
window.confirm = () => true;
$('.git-manual-list .git-remove')?.click();
await waitFor('移除手动登记', () => gitRepoRemoveCalls.length === 1 && $$('.chat-tab-git').length === 2);
window.confirm = originalConfirm;
assert(gitRepoRemoveCalls[0]?.path === 'libs/tool', '移除请求带上登记路径');
await waitFor('移除后列表清空', () => $('.git-manual-list') === null);
assert($('.git-manual-list') === null, '移除后手动登记列表为空');

// 从 Git tab 新建会话：同样回到对话起始页
$$('.chat-tab-git')[0]?.click();
await waitFor('新对话前停在 Git tab', () => $('.chat-tab-git.active') !== null);
$('#new-chat').click();
await waitFor('从 Git tab 新建会话回到对话', () => $('#tab-chat')?.getAttribute('aria-selected') === 'true');
assert($('#tab-chat')?.getAttribute('aria-selected') === 'true', '从 Git tab 新建会话回到对话 tab');
assert($('.samples button') !== null, '从 Git tab 新建会话显示起始页');

assert(text('#in-miss') === '0' && text('#out-k') === '0', '新对话重置 token');
assert(text('#ring-ctx .ring-val') === '0' && text('#ring-cache .ring-val') === '0', '新对话重置上下文/缓存环');
assert(text('#tps-value') === '—', '新对话重置 TPS');
assert($('.composer-field #send') !== null, '发送按钮悬浮在输入框内部');
assert($('#send svg.lucide-send-horizontal') !== null, '发送按钮使用水平纸飞机图标');

// ---------- 输入触发器：/ 命令与 @ 会话引用 ----------
setInputAt('#input', '/');
await waitFor('输入 / 打开命令菜单', () => $('.input-trigger-menu') !== null);
await waitFor('命令候选加载', () => $$('.input-trigger-item').length > 0);
assert($$('.input-trigger-item').length >= 10, '命令菜单列出内置命令（含当前不可用）');
assert(text('.input-trigger-menu').includes('/compact'), '命令菜单包含 /compact');
assert(text('.input-trigger-menu').includes('/model'), '命令菜单包含 /model');
assert(text('.input-trigger-menu').includes('/help'), '命令菜单包含 /help');
assert(text('.input-trigger-menu').includes('/stop'), '非 busy 时 /stop 仍显示但标记不可用');
assert(text('.input-trigger-menu').includes('不可用'), '不可用命令有标记');

setInputAt('#input', '/help');
await waitFor('命令过滤到 /help', () => $$('.input-trigger-item').length === 1 && text('.input-trigger-item').includes('/help'));
$('#input')?.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
await waitFor('/help 执行并清空草稿', () => $('#input')?.value === '' && text('.toast').includes('输入 /'));
assert($('.input-trigger-menu') === null, '/help 执行后菜单关闭');

setInputAt('#input', '/mod');
await waitFor('/mod 菜单', () => text('.input-trigger-item').includes('/model'));
$('#input')?.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
await waitFor('Escape 关闭命令菜单', () => $('.input-trigger-menu') === null);
setInputAt('#input', '/mod');
await new Promise((resolve) => setTimeout(resolve, 80));
assert($('.input-trigger-menu') === null, '同一个 token 被 Escape 后不自动重开');
setInputAt('#input', '/ne');
await waitFor('查询变化后重新打开菜单', () => $('.input-trigger-menu') !== null && text('.input-trigger-item').includes('/new'));
setInputAt('#input', '');

setInputAt('#input', '@');
await waitFor('输入 @ 打开会话引用菜单', () => $('.input-trigger-menu') !== null && text('.input-trigger-menu').includes('重命名后的会话'));
assert(text('.input-trigger-menu').includes('工作区'), '@ 会话按工作区分组');
$('#input')?.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
await waitFor('选择会话插入引用 token', () => ($('#input')?.value ?? '').startsWith('@[重命名后的会话](session:sess-1)'));
assert($('.input-trigger-menu') === null, '插入 @ 引用后菜单关闭');
setInputAt('#input', '');

setInputAt('#input', '/nope');
await waitFor('未知命令菜单空态', () => $('.input-trigger-menu') !== null && text('.input-trigger-menu').includes('没有匹配项'));
$('#input')?.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
await waitFor('未知命令提示', () => text('.toast').includes('未知命令'));
assert($('#input')?.value === '/nope', '未知命令保留草稿，不降级发送');
setInputAt('#input', '');

$('.samples button')?.click();
await waitFor('示例写入输入框', () => $('textarea#input')?.value.length > 0);
const sample = $('textarea#input').value;
assert(sample.includes('读一下') || sample.includes('找出') || sample.includes('server'), `示例文案：${sample.slice(0, 12)}…`);

// 新会话还没有 Chat：首条消息前切模型只能记在本地，不能打 /api/session/settings
assert($('#model-switch') !== null, '新对话也能切换模型');
$('#model-switch')?.click();
await waitFor('新对话打开模型菜单', () => $('#model-switch-menu') !== null);
const newChatBasic = $$('#model-switch-menu .composer-model-option').find((node) => node.textContent.includes('Basic'));
newChatBasic?.click();
await waitFor('新对话切换模型', () => text('#model-switch .composer-model-switch-name') === 'Basic');
assert(text('.toast').includes('模型：Basic'), '新对话切换模型给出提示，不报 session not found');

$('#composer').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await waitFor('发送后出现用户消息', () => $$('.msg.user').length === 1);

// 用户气泡下面：发送时间 + 复制
assert($('.msg.user .msg-meta') !== null, '用户气泡下面有元信息行');
assert(/^\d{2}:\d{2}$/.test(text('.msg.user .msg-time')), `气泡时间是 HH:mm（实际 ${text('.msg.user .msg-time')}）`);
assert((text('.msg.user .msg-time') ?? '').length === 5, '今天的消息不塞日期前缀（和轮次状态条一致）');
assert(($('.msg.user .msg-time')?.getAttribute('title') ?? '').startsWith('发送于 '), '悬停看完整发送时间');
assert($('.msg.user .msg-copy') !== null, '气泡下有复制按钮');
assert(text('.msg.user .msg-copy').trim() === '', '复制按钮只有图标、不带文字');
assert($('.msg.user .msg-copy')?.getAttribute('aria-label') === '复制这条消息', '看不见文字时靠 aria-label 说明');
const copiedClip = [];
Object.defineProperty(window.navigator, 'clipboard', {
	value: { writeText: async (value) => { copiedClip.push(value); } },
	configurable: true,
});
$('.msg.user .msg-copy').click();
await waitFor('复制后给出反馈', () => $('.msg.user .msg-copy')?.getAttribute('aria-label') === '已复制');
assert(copiedClip.length === 1 && copiedClip[0] === chatCalls[0].text, '复制的是这条消息的原文');
assert($('.msg.user .msg-copy.copied') !== null, '复制按钮进入已复制态');
assert($('.msg.user .msg-copy svg.lucide-check') !== null, '复制成功后图标换成对勾（不靠文字）');

assert(chatCalls.length === 1, '提交一次 /api/chat');
assert(chatCalls[0].text === sample, '/api/chat 收到输入文本');
assert(chatCalls[0].workspaceId === 'pi-webchat', '/api/chat 带上新对话选择的工作区');
assert(chatCalls[0].worktree?.enabled === true, '/api/chat 带上隔离工作树开关');
assert(chatCalls[0].codemode === 'auto', '/api/chat 带上 codemode 策略');
assert(chatCalls[0].model === 'opencode/basic', '/api/chat 带上首条消息前选好的模型');
assert($('.msg.assistant .stream-tail .caret') !== null, '发送后光标挂在流末尾');
assert(text('.msg.assistant .thinking') === '思考中 · · ·', '等待模型时显示思考中');
assert(text('#tps-value') !== '—', '生成中 TPS 不显示 —');

// ---------- 输入框上方的毛玻璃条：名句 + 本轮总计时 ----------
assert($('.composer-wrap .turn-verse') !== null, '毛玻璃条顶部出现本轮计时');
assert($('.turn-verse.running') !== null, '计时在跑时挂 running（扫光动效只在这里生效）');
const verseLine = text('.turn-verse-line');
// 名句是随机一句（一轮固定一句），不再写死文本：只校验「有句子 + 后面跟计时」
const verseMatch = verseLine.match(/^(.+?)\s+(\d+分)?\d{2}秒\s+·\s+·\s+·$/);
assert(verseMatch !== null && (verseMatch[1] ?? '').length >= 4, `名句完整显示（实际 ${verseLine}）`);
// 名句和计时在同一个文本节点里——扫光才是一道光整行扫过，计时也在范围内
assert($('.turn-verse-line .turn-verse-clock') === null, '计时和名句共用一个文本节点（同一道扫光）');
const clockText = `${verseMatch?.[2] ?? ''}${verseMatch ? /(\d{2}秒)/.exec(verseLine)?.[1] ?? '' : ''}`;
assert(/^(\d+分)?\d{2}秒$/.test(clockText), `计时格式 xx分xx秒（实际 ${clockText}）`);
assert(/\d{2}秒 /.test(verseLine), '计时跟在名句后面');

// 末尾三个点是纯展示：不是按钮，也没有菜单
assert(verseLine.trimEnd().endsWith('· · ·'), '时间后面跟着三个点');
assert($('#turn-verse-more') === null && $('.turn-verse-more') === null, '三个点没有做成按钮');
assert($('.turn-verse button') === null, '这一行里没有任何按钮');
// 名句自带一层小毛玻璃：贴边滚动时后面的字必须被糊掉
assert($('.turn-verse-glass') !== null, '名句外面套了一层毛玻璃');
assert($('.turn-verse-glass .turn-verse-line') !== null, '扫光文字在毛玻璃里面');

assert($('.turn-verse-menu') === null, '没有弹出菜单');
assert($('.turn-verse')?.getAttribute('role') === 'timer', '计时用 timer 角色（不打断读屏）');
assert(Number($('.turn-verse')?.getAttribute('data-elapsed')) >= 0, 'data-elapsed 是真实毫秒数');
const firstElapsed = Number($('.turn-verse')?.getAttribute('data-elapsed'));
await waitFor('计时会走', () => Number($('.turn-verse')?.getAttribute('data-elapsed')) > firstElapsed, 2500);
assert(Number($('.turn-verse')?.getAttribute('data-elapsed')) > firstElapsed, '计时随时间增长（不是静态文案）');
assert($('#compact')?.disabled === true, '生成中禁用压缩上下文按钮');
assert($('#compact')?.className.includes('compacting') === false, '生成中压缩按钮不显示压缩动画');

// ---------- SSE 思考增量 ----------
const source = MockEventSource.instances[MockEventSource.instances.length - 1];

// 自动重试：错误 + 倒计时；倒计时结束后回到「思考中」。
source.emit('retry', {
	state: 'waiting',
	attempt: 1,
	maxAttempts: 3,
	delayMs: 10000,
	errorMessage: '429 Too Many Requests: rate limit exceeded',
	until: Date.now() + 10000,
});
await waitFor('重试提示出现', () => $('.msg.assistant .retry-notice') !== null);
assert(text('.msg.assistant .retry-error').includes('429'), '重试提示显示 provider 错误（429）');
assert(text('.msg.assistant .retry-countdown').includes('秒后重试'), '重试提示显示倒计时');
assert(text('.msg.assistant .retry-countdown').includes('第 1/3 次'), '重试提示显示第几次重试');
assert($('.msg.assistant .thinking') === null, '倒计时期间不再显示思考中');
source.emit('retry', {
	state: 'waiting',
	attempt: 1,
	maxAttempts: 3,
	delayMs: 0,
	errorMessage: '429 Too Many Requests: rate limit exceeded',
	until: Date.now() - 1,
});
await waitFor('倒计时结束后回到思考中', () => text('.msg.assistant .thinking') === '重试中 · 思考中 · · ·');
assert($('.msg.assistant .retry-notice') === null, '倒计时结束后隐藏错误条');

source.emit('thinking', { text: '先分析一下问题。\n' });
await waitFor('思考增量渲染', () => text('.msg.assistant .think-label') === '思考中');
assert($('.msg.assistant .think') !== null, '实时思考块出现');
assert($('.msg.assistant .think-body') === null, '实时思考默认收起');
assert(text('.msg.assistant .think-preview').includes('先分析一下问题。'), '思考中实时显示最新一行');
assert(text('.msg.assistant .think-label') === '思考中', '思考中显示静态 label');
assert($('.msg.assistant .think.live') !== null, '思考流式时图标有 live 动画');
source.emit('thinking', { text: '继续分析。' });
await waitFor('思考预览跟随最新行', () => text('.msg.assistant .think-preview') === '继续分析。');
assert(text('.msg.assistant .think-preview') === '继续分析。', '思考预览逐行变化到最新一行');
$('.msg.assistant .think-head')?.click();
await waitFor('展开实时思考', () => $('.msg.assistant .think-body') !== null);
assert(text('.msg.assistant .think-body').includes('先分析一下问题。'), '实时思考展开后显示全文');
assert(text('.msg.assistant .think-body').includes('继续分析。'), '连续思考增量拼接在同一块');
console.log('THINKBODY', JSON.stringify(text('.msg.assistant .think-body')));

// ---------- SSE 增量 / 工具 / settled ----------
source.emit('delta', { text: '流式输出' });
await waitFor('delta 渲染', () => text('.messages').includes('流式输出'));
assert(text('.messages').includes('流式输出'), 'SSE delta 追加到当前气泡');

// ---------- 凭据审批栈：从输入框后面向上展开，支持多条 ----------
source.emit('credential_request', {
	requestId: 'req-1',
	credential: { name: 'gitea', label: 'Gitea', kind: 'bearer', hosts: ['git.example.com'], scopes: ['gitea:issue:write'] },
	reason: '提交 issue',
	scopes: ['gitea:issue:write'],
	sessionId: 'sess-1',
	expiresAt: Date.now() + 120000,
});
source.emit('credential_request', {
	requestId: 'req-2',
	credential: { name: 'gitea', label: 'Gitea', kind: 'bearer', hosts: ['git.example.com'], scopes: ['gitea:issue:read'] },
	reason: '读取仓库',
	scopes: ['gitea:issue:read'],
	sessionId: 'sess-1',
	expiresAt: Date.now() + 120000,
});
await waitFor('凭据审批栈', () => $$('.credential-request').length === 2);
await waitFor('审批请求让左侧会话闪动', () => $('.session-row.approval-pending') !== null);
assert($('.session-row.approval-pending .session-approval') !== null, '待审批会话行有铃铛/盾牌标记');
assert(text('.session-row.approval-pending .session-meta').includes('待审批'), '待审批会话行显示提示文字');
assert($('.composer-wrap .composer-card-stack .credential-request') !== null, '审批栈位于输入区容器内（层级在消息区之上）');
assert($('.messages .credential-request') === null, '审批栈不再放在消息区里');
assert(text('.credential-request').includes('Gitea'), '审批卡头部显示凭据名');
assert(text('.credential-request').includes('gitea:issue:write'), '审批卡头部显示 scope');
assert($('.credential-request')?.getAttribute('data-tone') === 'approval', '审批卡使用审批主题色');
assert(
	$('.credential-request .composer-card-summary')?.lastElementChild?.classList.contains('composer-card-chevron'),
	'展开箭头贴在卡片最右边（所有卡片共用）',
);
assert($('.credential-request .composer-card-content .credential-request-actions') !== null, '审批按钮属于卡片内容');
assert($('.credential-request .credential-request-detail') === null, '审批卡默认只露头部');
$('.credential-request-summary')?.click();
await waitFor('展开审批详情', () => $('.credential-request .credential-request-detail') !== null);
assert(text('.credential-request .credential-request-detail').includes('git.example.com'), '展开后显示目标 host');
assert(text('.credential-request .credential-request-detail').includes('提交 issue'), '展开后显示原因');
$('.credential-request-summary')?.click();
await waitFor('审批卡再点收到细条', () => $('.credential-request[data-state="peek"]') !== null);
assert($('.credential-request .composer-card-peek') !== null, '完整形态再点一次只留 2px 细条');
$('.credential-request .composer-card-peek')?.click();
await waitFor('细条恢复默认形态', () => $('.credential-request[data-state="default"]') !== null);
assert($('.credential-request .credential-request-actions') !== null, '细条点一下恢复默认形态和按钮');
const approveFirst = $('.credential-request-actions button');
approveFirst?.click();
await waitFor('收起一条审批', () => $$('.credential-request').length === 1);
assert($$('.credential-request').length === 1, '审批一条后其余请求保留在栈里');
const approveLast = $('.credential-request-actions button');
approveLast?.click();
await waitFor('审批栈清空', () => $('.credential-request') === null);
assert($('.credential-request') === null, '全部审批完成后卡片收起，输入区高度回落');
await waitFor('审批完成后停止闪动', () => $('.session-row.approval-pending') === null);
assert($('.session-row.approval-pending') === null, '审批完成后左侧会话行停止闪动');

// 审批超时：默认卡自动收成细条，留下“这里曾经有过审核”的痕迹
for (const instance of MockEventSource.instances) {
	instance.emit('credential_request', {
		requestId: 'req-timeout',
		credential: { name: 'gitea', label: 'Gitea', kind: 'bearer', hosts: ['git.example.com'], scopes: ['gitea:issue:read'] },
		reason: '超时测试',
		scopes: ['gitea:issue:read'],
		sessionId: 'sess-1',
		expiresAt: Date.now() + 60,
	});
}
await waitFor('审批超时收成细条', () => $('.credential-request-timeout[data-state="peek"]') !== null);
assert($('.credential-request-timeout .composer-card-peek') !== null, '超时审批只露 2px 细条');
await waitFor('超时后停止闪动', () => $('.session-row.approval-pending') === null);
assert($('.session-row.approval-pending') === null, '超时后左侧会话行不再闪动');
$('.credential-request-timeout .composer-card-peek')?.click();
await waitFor('点细条展开超时审批', () => $('.credential-request-timeout[data-state="default"]') !== null);
assert(text('.credential-request-timeout').includes('审批已超时'), '超时卡标题说明已超时');
assert(text('.credential-request-timeout').includes('已超时，自动拒绝'), '超时卡内容说明自动拒绝');
assert($('.credential-request-timeout .credential-request-timeout-actions button') !== null, '超时卡有关闭按钮');
$('.credential-request-timeout .credential-request-timeout-actions button')?.click();
await waitFor('关闭超时记录', () => $('.credential-request-timeout') === null);
assert($('.credential-request-timeout') === null, '关闭后超时细条消失');
assert($('.msg.assistant .body.cursor') !== null, '文字流式时贴着文字的光标');
assert($('.msg.assistant .thinking') === null, '出字后不再显示思考中');
await waitFor(
	'思考结束回到第一行',
	() => $('.msg.assistant .think-body') === null && text('.msg.assistant .think-preview').includes('先分析'),
);
assert($('.msg.assistant .think-body') === null, '思考结束后自动收起');
assert(text('.msg.assistant .think-preview').includes('先分析一下问题。'), '思考结束后默认显示第一行');
assert(text('.msg.assistant .think-label') === '思考', '思考结束后 label 恢复为「思考」');

source.emit('tool', { id: 't1', name: 'grep', args: { pattern: 'TODO' }, status: 'running' });
await waitFor('工具行出现', () => $$('.tool').some((node) => node.textContent.includes('grep')));
const running = $$('.tool').find((node) => node.textContent.includes('grep'));
assert(running?.className === 'tool running', '工具 running 状态');
// codemode 单独给图标（像思考行的 🧠 一样），直连工具不加
assert($('.tool .tool-icon') === null, '普通工具行没有额外图标');
assert(text('.msg.assistant .thinking') === '调用工具 · · ·', '工具执行时显示调用工具');
const stream = $('.msg.assistant .stream');
const order = [...stream.children];
assert(order.findIndex((n) => n.classList.contains('tools')) < order.findIndex((n) => n.classList.contains('stream-tail')), '光标在工具行的下一行');
source.emit('tool', { id: 't1', name: 'grep', status: 'ok', detail: '3 matches', result: '3 matches\nTODO demo.ts' });
await waitFor('工具结束', () => running?.className === 'tool ok');
await waitFor('工具后进入思考', () => text('.msg.assistant .thinking') === '思考中 · · ·');
assert(text('.msg.assistant .thinking') === '思考中 · · ·', '工具结束后显示思考中');
assert(running?.querySelector('.tool-chevron') !== null, '实时工具行可展开');
running?.querySelector('.tool-expand')?.click();
await waitFor('展开实时工具', () => running?.querySelector('.tool-body') != null);
assert(text('.msg.assistant .tools .tool .tool-body').includes('"pattern": "TODO"'), '实时工具展开显示参数');
assert(text('.msg.assistant .tools .tool .tool-body').includes('TODO demo.ts'), '实时工具展开显示结果');
running?.querySelector('.tool-expand')?.click();
await waitFor('收起实时工具', () => running?.querySelector('.tool-body') == null);

// 工具批次结束后的第一段输出 = 新的一步，底部步数应实时 +1
const stepBefore = Number(text('#step-n'));
source.emit('delta', { text: '第二段输出' });
await waitFor('工具批次后步数实时更新', () => Number(text('#step-n')) === stepBefore + 1);
assert(Number(text('#step-n')) === stepBefore + 1, '工具批次后步数实时 +1');

// ---------- 工具行里的路径：能落到已注册 root 才画「打开」箭头 ----------
// /tmp 下的截图模型能读、也能写进思考里；文件 API 把 /tmp 当只读 root 提供，
// 所以这种行应该能点开。没有 root 认领的绝对路径（/etc/passwd）不画箭头。
source.emit('tool', { id: 't-tmp', name: 'read', args: { path: '/tmp/shot.png' }, status: 'running' });
await waitFor('/tmp 工具行', () => $$('.tool').some((node) => node.textContent.includes('/tmp/shot.png')));
const tmpTool = $$('.tool').find((node) => node.textContent.includes('/tmp/shot.png'));
const tmpOpen = tmpTool?.querySelector('.tool-open');
assert(tmpOpen != null, '/tmp 截图在只读 tmp root 下可以点开');
tmpOpen?.click();
await waitFor('打开 tmp 截图 tab', () => panelTab('shot.png') !== undefined);
assert(panelTab('shot.png') !== undefined, '/tmp 截图能在右栏打开');
source.emit('tool', { id: 't-tmp', name: 'read', status: 'ok', detail: 'image/png', result: 'image/png' });

source.emit('tool', { id: 't-out', name: 'read', args: { path: '/etc/passwd' }, status: 'running' });
await waitFor('/etc 工具行', () => $$('.tool').some((node) => node.textContent.includes('/etc/passwd')));
const outTool = $$('.tool').find((node) => node.textContent.includes('/etc/passwd'));
assert(outTool?.querySelector('.tool-open') === null, '没有 root 认领的路径不画「打开」箭头');
source.emit('tool', { id: 't-out', name: 'read', status: 'ok', detail: 'permission denied', result: 'permission denied' });

source.emit('tool', { id: 't-ws', name: 'read', args: { path: 'demo.ts' }, status: 'running' });
await waitFor('工作区工具行', () => $$('.tool').some((node) => node.textContent.includes('demo.ts')));
const wsTool = $$('.tool').find((node) => node.textContent.includes('demo.ts'));
const wsOpen = wsTool?.querySelector('.tool-open');
assert(wsOpen != null, '工作区内的文件保留「打开」箭头');
wsOpen?.click();
await waitFor('箭头打开文件 tab', () => panelTab('demo.ts') !== undefined);
assert(panelTab('demo.ts') !== undefined, '箭头能把工作区文件打开到右栏');
source.emit('tool', { id: 't-ws', name: 'read', status: 'ok', detail: 'demo.ts', result: 'export function demo() {}' });

// ---------- 轮末文件汇报卡片（report_files -> presented） ----------
source.emit('presented', {
	turn: 1,
	cwd: '/workspace/pi-webchat',
	files: [
		{
			path: 'server/chat.ts',
			display: 'server/chat.ts',
			importance: 'high',
			change: 'modified',
			address: 'pi-resource://file/session/sess-1/server/chat.ts',
		},
		{
			path: 'docs/notes.md',
			display: 'docs/notes.md',
			importance: 'low',
			change: 'created',
			address: 'pi-resource://file/session/sess-1/docs/notes.md',
		},
	],
});
await waitFor('文件汇报卡片', () => $('.msg.assistant .report-files') !== null);
assert(text('.report-files').includes('汇报了 2 个文件'), '文件卡片显示汇报数量');
assert(text('.report-files').includes('server/chat.ts'), '高重要度文件默认展示');
assert(!text('.report-files').includes('docs/notes.md'), '低重要度文件默认折叠');
const lowToggle = $('.report-files-toggle-low');
assert(lowToggle !== null, '低重要度文件有展开入口');
lowToggle?.click();
await waitFor('展开次要文件', () => text('.report-files').includes('docs/notes.md'));
assert(text('.report-files').includes('docs/notes.md'), '展开后显示次要文件');

// ---------- 生成中插话 / 排队 ----------
const beforeSteer = chatCalls.length;
const input = $('textarea#input');
const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
setValue?.call(input, '插话测试');
input.dispatchEvent(new window.Event('input', { bubbles: true }));
await waitFor('插话草稿进入状态', () => $('#send')?.getAttribute('title')?.includes('插话发送'));
input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
await waitFor('生成中 Enter 提交插话', () => chatCalls.length === beforeSteer + 1);
assert(chatCalls.at(-1)?.mode === 'steer', '生成中 Enter 走 steer 而不是停止');
assert(input.value === '', '插话提交后清空输入框');
await waitFor('待发送插话 dock', () => text('.composer-card-stack .queue-card.steering').includes('插话测试'));
assert($('.composer-card-stack .queue-card.steering') !== null, '待发送队列显示插话中');

source.emit('queue', { steering: [], followUp: [] });
source.emit('user', { text: '插话测试' });
await waitFor('插话进入对话流', () => $$('.msg.user').length === 2 && text('.messages').includes('插话测试'));
assert($$('.msg.user').length === 2, '插话消息进入对话流');

const beforeQueue = chatCalls.length;
setValue?.call(input, '排队测试');
input.dispatchEvent(new window.Event('input', { bubbles: true }));
await waitFor('排队草稿进入状态', () => $('#send')?.getAttribute('title')?.includes('插话发送'));
input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
await waitFor('生成中 Ctrl+Enter 提交排队', () => chatCalls.length === beforeQueue + 1);
assert(chatCalls.at(-1)?.mode === 'followUp', '生成中 Ctrl+Enter 走 followUp 排队');
await waitFor('排队行出现', () => text('.composer-card-stack .queue-card.followUp').includes('排队测试'));
$('.composer-card-stack .queue-card.followUp .queue-action.steer')?.click();
await waitFor('排队项强制插话', () => queueCalls.length === 1);
assert(queueCalls[0]?.placement === 'followUp' && queueCalls[0]?.kind === 'steer', '排队行插话请求打到 queue/update');
await waitFor('排队项变为插话中', () => text('.composer-card-stack .queue-card.steering').includes('排队测试'));
source.emit('queue', { steering: [], followUp: [] });

source.emit('delta', { text: '插话后的输出' });
await waitFor('插话后开新 turn', () => $$('.msg.assistant').length >= 2 && text('.messages').includes('插话后的输出'));
assert($$('.msg.assistant').length >= 2, '插话后的输出进入新 turn');

// ---------- 刷新/切回运行中会话：live 不能和历史重复 ----------
// 服务端的 live 是整轮累积快照，history 已经包含落盘的前两步；刷新后只应看到
// 3 条 bash（历史 2 + 未落盘 1），且第一步的思考不重复。
const runningHistory = [
	{ role: 'user', text: '回归：刷新去重' },
	{ role: 'assistant', thinking: 'step1 think', tools: [{ name: 'bash', detail: 'echo 1' }] },
	{ role: 'assistant', thinking: 'step2 think', tools: [{ name: 'bash', detail: 'echo 2' }] },
];
busySessionStats = {
	...baseStats,
	sessionName: renamedName,
	busy: true,
	history: runningHistory,
	live: {
		text: '',
		thinking: 'step1 thinkstep2 thinkstep3 think',
		tools: [
			{ id: 't-a', name: 'bash', status: 'ok' },
			{ id: 't-b', name: 'bash', status: 'ok' },
			{ id: 't-c', name: 'bash', status: 'running' },
		],
		startedAt: now,
	},
};
// 让 store 处于 busy，再模拟断线重连；open 会走 refreshConversation。
source.emit('user', { text: '回归：刷新去重' });
source.emit('error');
source.emit('open');
await waitFor('重连后按运行中快照重绘', () => text('.messages').includes('回归：刷新去重'));
// ---------- 计时跟着会话走：切到运行中的会话，用这个会话自己的 startedAt ----------
const verseAfterSwitch = $('.turn-verse');
assert(verseAfterSwitch !== null, '运行中的会话显示本轮计时');
const elapsedAfterSwitch = Number(verseAfterSwitch?.getAttribute('data-elapsed'));
// 这个会话的起点是夹具里的 live.startedAt(=now)，计时应该约等于「现在 - now」
const expectedElapsed = Date.now() - now;
assert(
	Math.abs(elapsedAfterSwitch - expectedElapsed) < 3000,
	`计时用的是当前会话自己的起点（${elapsedAfterSwitch}ms ≈ ${expectedElapsed}ms）`,
);

const runningTools = $$('.tool');
assert(runningTools.length === 3, `运行中刷新工具不重复（实际 ${runningTools.length} 条）`);
assert(runningTools.at(-1)?.className === 'tool running', '运行中刷新保留最后一条 running 状态');
assert((text('.messages').match(/step1 think/g) ?? []).length === 1, '运行中刷新思考过程不重复');
// 刷新后的后续增量必须继续接在同一个气泡里
source.emit('delta', { text: '刷新后继续流式' });
await waitFor('刷新后继续流式', () => text('.messages').includes('刷新后继续流式'));
assert(text('.messages').includes('刷新后继续流式'), '刷新后仍能接收后续流式增量');
busySessionStats = null;

source.emit('settled', {});
await waitFor('settled 后光标消失', () => $('.msg.assistant .body.cursor') === null && $('.msg.assistant .stream-tail') === null);
assert($('.msg.assistant .caret') === null && $('.msg.assistant .thinking') === null, 'settled 后光标/思考中清除');
await waitFor('settled 后重绘历史', () => text('.messages').includes('## 标题') || text('.messages').includes('标题'));
await waitFor('每轮结束出现状态条', () => $('.turn-stats') !== null);
assert($('.turn-stats') !== null, '每轮结束出现状态条');
await waitFor('本轮完成后计时消失', () => $('.turn-verse') === null, 2500);
assert($('.turn-verse') === null, '本轮结束就不再显示计时（不留在最终时长上）');
assert($('.turn-verse.running') === null, '结束后不再有扫光');
assert($('.history-summary')?.getAttribute('aria-expanded') === 'false', '生成结束后自动折叠');
assert($('.turn-part.open') === null, '生成结束后思考/工具行收起');
await waitFor('生成结束后恢复压缩按钮', () => $('#compact')?.disabled === false);
assert($('#compact')?.disabled === false, '生成结束后压缩上下文按钮恢复可用');
assert(text('.turn-stats').includes('第 1 轮'), '状态条显示轮次');
assert(/^\d{2}:\d{2}$/.test(text('.turn-stats .turn-finished')), '状态条显示今天的完成时间 HH:mm');
assert(text('.turn-stats .turn-finished').length === 5, '完成时间不塞日期前缀');
assert($('.turn-fork') !== null, '状态条带 fork 按钮');
$('.turn-fork').click();
await waitFor('fork 请求', () => forkCalls === 1);
await waitFor('fork toast', () => text('.toast').includes('fork'));
assert(forkCalls === 1, '点击 fork 调用 /api/session/fork');
assert(forkTurn === 1, 'fork 请求带上当前轮次');

// ---------- 右栏折叠 / 分隔条 ----------
$('#toggle-panel').click();
await waitFor('右栏折叠', () => $('.app.no-panel') !== null);
assert($('#panel')?.isConnected === true, '右栏仍在 DOM（display:none）');
assert($('.splitter[data-target="panel"]') === null, '折叠后分隔条隐藏');

$('#toggle-panel').click();
await waitFor('右栏恢复', () => $('.app.no-panel') === null);
assert($('.splitter[data-target="panel"]') !== null, '恢复后分隔条出现');
assert($$('.panel-tab').length > 0, '收起再打开保留 tab');

const splitter = $('.splitter[data-target="panel"]');
const before = $('.app').style.getPropertyValue('--panel-w');
splitter.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
await waitFor('分隔条键盘调整', () => $('.app').style.getPropertyValue('--panel-w') !== before);
const after = $('.app').style.getPropertyValue('--panel-w');
assert(parseInt(after, 10) > 0 && after !== before, `ArrowLeft 加宽：${before || '(默认)'} -> ${after}`);
splitter.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
await waitFor('Home 恢复默认', () => $('.app').style.getPropertyValue('--panel-w') === '');

// ---------- 最左模块 rail / 上下文列 ----------
assert($('.rail-nav') !== null, '桌面端有最左模块导航');
assert($$('.rail-nav-btn[data-module]').length === 5, '模块导航有 5 个模块');
assert($('.rail-nav-btn[data-module="chat"]')?.getAttribute('aria-current') === 'page', '对话模块高亮');
assert($('.rail-nav #rail-settings-toggle') !== null, '设置入口在 rail 底部');
assert($('.rail-nav #conn') !== null, '连接状态在 rail 底部');
assert($('.rail .rail-foot') === null, '桌面端抽屉里不重复渲染底栏');
assert($('.splitter[data-target="context"]') !== null, '上下文列有拖拽分隔条');

const ctxSplitter = $('.splitter[data-target="context"]');
const ctxBefore = $('.app').style.getPropertyValue('--ctx-w');
ctxSplitter.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
await waitFor('上下文列键盘变宽', () => $('.app').style.getPropertyValue('--ctx-w') !== ctxBefore);
assert(parseInt($('.app').style.getPropertyValue('--ctx-w'), 10) > 0, 'ArrowRight 加宽上下文列');
assert(window.localStorage.getItem('turnpi:context-width:chat') !== null, '上下文列宽度按模块写入 localStorage');
ctxSplitter.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
await waitFor('上下文列恢复默认宽度', () => $('.app').style.getPropertyValue('--ctx-w') === '');

$('#rail-collapse').click();
await waitFor('收起会话列表', () => $('.app.ctx-collapsed') !== null);
assert($('.rail') !== null, '收起后上下文列仍挂载（收起/展开才有动画）');
assert($('.rail')?.hasAttribute('inert'), '收起时上下文列 inert（不可聚焦）');
assert($('.rail')?.getAttribute('aria-hidden') === 'true', '收起时对读屏隐藏');
assert($('.rail')?.classList.contains('collapsed'), '收起时 aside 带 collapsed 状态类');
assert($('.splitter[data-target="context"]') === null, '收起后上下文分隔条隐藏');
assert(window.localStorage.getItem('turnpi:context-collapsed:chat') === '1', '折叠状态写入 localStorage');
assert($('#rail-new-chat') !== null, '收起后 rail 上有新对话入口');
assert($('#new-chat') !== null, '收起后侧栏仍在 DOM（inert），里面的新对话按钮不可点');
assert($('.rail')?.hasAttribute('inert'), '收起后侧栏整体 inert');
$('.rail-nav-btn[data-module="chat"]').click();
await waitFor('展开会话列表', () => $('.app.ctx-collapsed') === null);
assert($('.rail') !== null, '已选中对话时再点图标 = 展开会话列表');
assert($('#rail-new-chat')?.classList.contains('rail-nav-slot'), '展开后新对话入口只隐藏、仍占位（不顶动下面的图标）');
assert($('#rail-new-chat')?.getAttribute('aria-hidden') === 'true', '占位时对新对话入口对读屏隐藏');
assert($('#rail-new-chat')?.getAttribute('tabindex') === '-1', '占位时新对话入口不可聚焦');
assert(window.localStorage.getItem('turnpi:context-collapsed:chat') === '0', '展开状态写入 localStorage');

$('.rail-nav-btn[data-module="skills"]').click();
await waitFor('点 rail 切到技能', () => $('#skills-view') !== null);
await waitFor('技能市场加载', () => $('#skills-list .skills-source-row') !== null && $('.skill-card') !== null);
assert(window.location.hash === '#/skills', 'rail 切换写回 hash');
assert($('.rail-nav-btn[data-module="skills"]')?.getAttribute('aria-current') === 'page', '技能模块高亮');
assert($('.rail-nav-btn[data-module="chat"]')?.getAttribute('aria-current') === null, '对话不再高亮');
assert($('.rail-nav-btn[data-module="skills"]')?.getAttribute('title')?.includes('已展开'), '技能 rail 提示语反映列表状态');
assert($('#skills-view .skills-head h1') !== null, '技能市场主面板已渲染');
assert($$('.skill-card').length === 3, '技能以卡片显示（3 个 mock 技能）');
assert($('#skills-list .skills-source-row') !== null, '上下文列渲染技能库来源');
assert($('#skills-list .skills-category-row') !== null, '上下文列渲染分类');
assert($('.skill-card-stats') !== null, '卡片显示 star/fork/安装数');
assert(text('.skill-card-stats').includes('12.0k'), '卡片显示 GitHub star');
assert($('.session-row') === null, '技能模块不渲染历史会话列表');

// 卡片详情：原文 + 中文对照
$('.skill-card').click();
await waitFor('打开技能详情', () => $('.skill-detail') !== null);
await waitFor('技能原文加载', () => text('.skill-detail-pane').includes('Systematic Debugging'));
await waitFor('中文翻译加载', () => text('.skill-detail-pane.translated').includes('系统化调试'));
assert($('.skill-detail-panes') !== null && $$('.skill-detail-pane').length === 2, '详情左右两栏：原文 + 中文对照');
assert($('.skill-detail-meta')?.textContent?.includes('stars'), '详情显示 star');
assert($('.skill-detail-meta')?.textContent?.includes('forks'), '详情显示 fork');
$('.skill-detail-close')?.click();
await waitFor('关闭技能详情', () => $('.skill-detail') === null);

// 搜索 + 分类筛选
setInput('#skills-search', 'godot');
await waitFor('搜索过滤卡片', () => $$('.skill-card').length === 1);
assert($('.skill-card h3')?.textContent?.includes('godot'), '搜索命中技能名');
setInput('#skills-search', '');
await waitFor('清空搜索恢复卡片', () => $$('.skill-card').length === 3);
$$('#skills-list .skills-category-row')[1]?.click();
await waitFor('分类过滤卡片', () => $$('.skill-card').length === 1);
assert(text('.skill-card').includes('systematic-debugging'), '分类筛选生效');
$$('#skills-list .skills-category-row')[0]?.click();
await waitFor('恢复全部分类', () => $$('.skill-card').length === 3);

$('.rail-nav-btn[data-module="skills"]').click();
await waitFor('再次点技能图标收起列表', () => $('.app.ctx-collapsed') !== null);
assert($('#skills-list')?.closest('.rail')?.hasAttribute('inert'), '技能列表收起时 inert');
$('.rail-nav-btn[data-module="skills"]').click();
await waitFor('再点技能图标展开列表', () => $('.app.ctx-collapsed') === null);
$('.rail-nav-btn[data-module="chat"]').click();
await waitFor('点 rail 回到对话', () => $('.chat') !== null);
assert($('.session-row') !== null, '回到对话后会话列表还在');

// ---------- rail：小字标签 / 宽条切换 ----------
assert($$('.rail-nav-btn[data-module]').length === 5, 'rail 有 5 个模块按钮');
assert(text('.rail-nav-btn[data-module="chat"] .rail-nav-label') === '对话', '模块按钮带小字标签');
assert(text('.rail-nav-btn[data-module="skills"] .rail-nav-label') === '技能', '技能标签文案');
assert(text('.rail-nav-btn[data-module="jobs"] .rail-nav-label') === '定时任务', '长标签也完整渲染（靠省略号兜底）');
assert(text('#rail-new-chat .rail-nav-label') === '新对话', '新对话槽位也有标签');
assert($('.rail-nav-mark .rail-nav-title') !== null, '宽条时才显示的标题节点存在（窄条由 CSS 隐藏）');
assert($('#rail-wide-toggle')?.getAttribute('aria-pressed') === 'false', '默认是窄条');
$('#rail-wide-toggle').click();
await waitFor('展开宽条 rail', () => $('.app.rail-wide') !== null);
assert($('#rail-wide-toggle')?.getAttribute('aria-pressed') === 'true', '宽条状态写进 aria-pressed');
assert(window.localStorage.getItem('turnpi:rail-expanded') === '1', '宽条状态落盘');
$('#rail-wide-toggle').click();
await waitFor('收起宽条 rail', () => $('.app.rail-wide') === null);
assert(window.localStorage.getItem('turnpi:rail-expanded') === '0', '收起状态落盘');

// ---------- Agent 模块：列表 / 编辑器 / dry-run 预览 / 合并守卫 ----------
$('.rail-nav-btn[data-module="agents"]').click();
await waitFor('切到 Agent 模块', () => $('#module-agents') !== null);
await waitFor('Agent 模板列表加载', () => $$('.agents-pick').length > 0);
assert(window.location.hash === '#/agents', 'Agent 模块写回 hash');
assert($$('.agents-pick').length === 2, '列出 base 与岗位两个模板');
assert($('.agents-pick.on') !== null, '默认选中第一个可编辑模板');
await waitFor('dry-run 预览返回', () => $('.agents-budget p') !== null, 4000);
assert(agentPreviewCalls > 0, '打开 Agent 页就会请求 dry-run 预览');
assert(text('.agents-budget p').includes('tokens'), '预览给出首轮 token 预算');
assert($$('.agents-preview-block').length >= 3, '预览分块展示工具/技能/提示词');
assert(text('.agents-kind') === '岗位', '选中模板的 kind 显示在标题上');
const previewsBefore = agentPreviewCalls;
// React 受控 textarea：必须走原生 setter + input 事件，直接赋 value 不会进入 state
const setAgentText = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
setAgentText?.call($('#agent-prompt'), '新的岗位说明');
$('#agent-prompt').dispatchEvent(new window.Event('input', { bubbles: true }));
await waitFor('改提示词后重新预览', () => agentPreviewCalls > previewsBefore, 4000);
// 控件必须复用站内既有件，不能退化成浏览器默认控件（丑且不跟明暗主题）
assert($('#agent-thinking')?.className.includes('select'), '思考级别下拉复用 .select（和设置页同一套）');
assert($('#agent-desc')?.className.includes('agents-input'), '文本输入复用 .agents-input');
assert($('#agent-prompt')?.className.includes('agents-textarea'), '系统提示词复用 .agents-textarea');
assert($$('#module-agents select').every((el) => el.className.includes('select')), 'Agent 页没有裸 select');
assert($('.tools-toggle .tool-toggle') !== null, '工具/技能胶囊复用设置页的 .tool-toggle');
assert($('.agents-head-actions button.primary') !== null, '主按钮复用 .primary');
const firstTool = $('.tools-toggle .tool-toggle.on input:not(:disabled)');
if (firstTool) {
	firstTool.click();
	await waitFor('改工具后重新预览', () => agentPreviewCalls > previewsBefore + 1, 4000);
}
assert(text('.agents-dirty') === '未保存', '编辑后出现未保存标记');
const saveButton = $$('.agents-head-actions button').find((button) => button.textContent.includes('保存'));
saveButton.click();
await waitFor('保存 CARD', () => agentSaveCalls.length === 1, 4000);
assert(agentSaveCalls[0].card.prompt === '新的岗位说明', '保存提交的是编辑后的提示词');
assert(agentSaveCalls[0].card.id === 'agent-hr', '保存目标是选中的模板');
const mergeButton = $$('.agents-head-actions button').find((button) => button.textContent.includes('合并回'));
mergeButton.click();
await waitFor('合并差异返回', () => $('.agents-merge') !== null, 4000);
assert(text('.agents-merge').includes('base 是原型'), '父模板是 base 时合并被明确拒绝');
const useButton = $$('.agents-head-actions button').find((button) => button.textContent.includes('开新对话'));
useButton.click();
await waitFor('回到对话模块', () => $('.chat') !== null);
assert(window.localStorage.getItem('turnpi-agent') === 'agent-hr', '选中的 Agent 模板落盘（下一条新对话用它）');
await waitFor('对话 rail 高亮回来', () => $('.rail-nav-btn[data-module="chat"]')?.getAttribute('aria-current') === 'page');

// ---------- 长历史：所有已完成轮次都折叠成一行，点击展开 ----------
const longHistory = [];
for (let i = 1; i <= 6; i++) {
	longHistory.push({ role: 'user', text: `历史问题 ${i}` });
	longHistory.push({
		role: 'assistant',
		thinking: `第 ${i} 轮思考`,
		text: `答案 ${i}`,
		tools: [{ name: 'read', detail: `f${i}.ts` }],
		usage: { input: 100, output: 10, cacheRead: 50, total: 160 },
		durationMs: 1000,
	});
	longHistory.push({ role: 'assistant', text: `补充 ${i}`, durationMs: 1000, completedAt: now - (7 - i) * 24 * 60 * 60 * 1000 });
}
baseStats.history = longHistory;
$('.session-row:not(.archived) .session-open')?.click();
await waitFor('长历史重绘', () => text('.messages').includes('历史问题 6'));
assert($$('.turn-stats').length === 6, '每轮状态条从历史持久化');
assert(text('.msg.assistant .turn-stats').includes('第 1 轮'), '历史状态条显示轮次');
assert(/^\d{2}-\d{2} \d{2}:\d{2}$/.test(text('.turn-stats .turn-finished')), '今天以前的完成时间显示 MM-dd HH:mm');
assert($$('.turn-fork').length === 6, '每轮状态条都带 fork 按钮');
assert($$('.history-summary').length === 6, `已完成轮次全部折叠（实际 ${$$('.history-summary').length}）`);
assert(text('.history-summary').includes('2 步'), '摘要显示步数');
assert(text('.history-summary').includes('1 次思考'), '摘要显示思考次数');
assert(text('.history-summary').includes('1 次工具'), '摘要显示工具次数');
assert($('.history-summary .history-summary-icon') !== null, '摘要带窄屏图标');
assert(text('.history-summary .history-summary-hint-short') === '展开', '窄屏展开文案为「展开」');
assert(!text('.history-summary').includes('缓存'), '摘要去掉「缓存」字样');
assert(text('.history-summary').includes('2.0s'), '摘要显示耗时');
const summaryText = text('.history-summary');
assert(summaryText.includes('↑100/50'), '摘要 token 去掉空格并紧凑显示');
assert(summaryText.includes('↓10'), '摘要输出 token 去掉空格');
assert(summaryText.indexOf('2.0s') > summaryText.indexOf('2 步'), '摘要先显示步数再显示耗时');
assert(summaryText.indexOf('1 次思考') > summaryText.indexOf('2.0s'), '耗时在思考次数之前');
assert(summaryText.indexOf('1 次工具') > summaryText.indexOf('1 次思考'), '思考次数在工具次数之前');
const toolsBeforeExpand = $$('.msg.assistant .turn-part.open .tools .tool').length;
const thinksBeforeExpand = $$('.msg.assistant .turn-part.open .think').length;
assert(toolsBeforeExpand === 0 && thinksBeforeExpand === 0, '折叠轮次不渲染思考和工具行');
assert($$('.msg.assistant .body.exec-text').length === 6, '折叠轮次中的过程文字使用淡色');
$('.history-summary')?.click();
await waitFor('展开折叠轮次', () => $('.history-summary')?.getAttribute('aria-expanded') === 'true');
assert($$('.msg.assistant .turn-part.open .tools .tool').length === toolsBeforeExpand + 1, '展开后显示该轮工具行');
assert($$('.msg.assistant .turn-part.open .think').length === thinksBeforeExpand + 1, '展开后显示该轮思考行');
assert($$('.msg.assistant .body.exec-text').length === 5, '展开后该轮过程文字恢复正常颜色');

// ---------- 收藏联动：星标持久化 + 导航短线变金色 ----------
assert($('.turn-stats .turn-star') !== null, '状态条带收藏星标');
$('.turn-stats .turn-star')?.click();
await waitFor('收藏写入', () => favoriteTurnsMock.includes(1));
assert(favoriteTurnsMock.includes(1), '收藏请求写到服务端');
assert($$('.turn-nav-line.favorite').length === 1, '收藏轮次在导航条用不同颜色');

// ---------- 右侧轮次导航：当前/已加载/未加载三种长度，点击未加载会补齐并跳转 ----------
const navOverview = Array.from({ length: 6 }, (_, i) => ({
	index: i + 1,
	start: i * 3,
	end: i * 3 + 3,
	text: `历史问题 ${i + 1}`,
}));
baseStats.turnOverview = navOverview;
baseStats.history = longHistory.slice(9);
baseStats.historyMeta = { start: 9, end: 18, total: 18, hasMore: true, turnCount: 6, pageTurns: 3 };
olderHistoryPage = {
	ok: true,
	history: longHistory.slice(0, 9),
	historyMeta: { start: 0, end: 9, total: 18, hasMore: false, turnCount: 6, pageTurns: 3 },
};
$('.session-row:not(.archived) .session-open')?.click();
await waitFor('导航条渲染', () => $$('.msg.user').length === 3 && $$('.turn-nav-line').length === 6 && $$('.turn-nav-line.unloaded').length === 3);
assert($$('.turn-nav-line.unloaded').length === 3, '未加载轮次显示为短线');
assert($$('.turn-nav-line.loaded, .turn-nav-line.current').length === 3, '已加载轮次显示为中等线');
assert($$('.turn-nav-line.current').length === 1, '当前轮次显示为最长线');
const unloadedLine = $$('.turn-nav-line')[1];
assert(unloadedLine.classList.contains('unloaded'), '第 2 轮此时未加载');
unloadedLine.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
await waitFor('导航 hover 浮层', () => $('.turn-nav-tip') !== null);
assert(text('.turn-nav-tip-head').includes('第 2 轮'), '浮层显示轮次');
assert(text('.turn-nav-tip-text').includes('历史问题 2'), '浮层显示用户输入');
unloadedLine.click();
await waitFor('点击导航补齐并跳转', () => text('.messages').includes('历史问题 2') && $$('.turn-nav-line.unloaded').length === 0);
assert($$('.turn-nav-line.loaded, .turn-nav-line.current').length === 6, '点击后目标及缺口轮次全部加载');
assert($$('.turn-nav-line.current').length === 1, '跳转后仍有唯一当前轮次');

// ---------- 短历史：没有滚动条时自动补载上一页 ----------
const shortBox = $('#messages');
Object.defineProperty(shortBox, 'clientHeight', { configurable: true, get: () => 700 });
Object.defineProperty(shortBox, 'scrollHeight', {
	configurable: true,
	get: () => ($$('.msg.user').length <= 3 ? 300 : 900),
});
const historyBeforeShort = historyRequests;
$('.session-row:not(.archived) .session-open')?.click();
await waitFor(
	'短历史自动补载',
	() => historyRequests > historyBeforeShort && $$('.msg.user').length === 6,
);
assert(historyRequests > historyBeforeShort, '内容不足一屏时自动请求更早历史');
assert($$('.msg.user').length === 6, '自动补载后历史轮次增加');
delete shortBox.clientHeight;
delete shortBox.scrollHeight;

// ---------- 完成提醒：授权、后台通知、标题标记 ----------
$('#new-chat').click();
await waitFor('提醒测试的新对话', () => $('.samples button') !== null);
assert($('#notify-toggle')?.getAttribute('aria-pressed') === 'false', '完成提醒默认关闭');
$('#notify-toggle')?.click();
await waitFor('完成提醒授权', () => MockNotification.permission === 'granted' && $('#notify-toggle')?.getAttribute('aria-pressed') === 'true');
assert($('#notify-toggle')?.getAttribute('aria-pressed') === 'true', '点击铃铛后完成提醒开启');
assert($('#notify-toggle.on') !== null, '开启后铃铛高亮');
assert(text('.toast').includes('完成提醒已开启'), '开启提醒有 toast 反馈');

// 切到后台：本轮结束应该系统通知 + 标题未读标记，而不是只弹 toast
Object.defineProperty(window.document, 'hidden', { configurable: true, value: true });
Object.defineProperty(window.document, 'visibilityState', { configurable: true, value: 'hidden' });
$('.samples button')?.click();
await waitFor('提醒测试输入框', () => $('textarea#input')?.value.length > 0);
$('#composer').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await waitFor('提醒测试发送', () => $$('.msg.user').length === 1);
const notifySource = MockEventSource.instances[MockEventSource.instances.length - 1];
notifySource.emit('settled', {});
await waitFor('后台完成通知', () => notifications.length === 1);
assert(notifications[0]?.title === 'pi · 本轮已完成', '系统通知标题');
assert(notifications[0]?.options?.body?.includes('轮已完成'), '系统通知正文包含完成信息');
assert(notifications[0]?.options?.silent === true, '系统通知静音（页面自己播提示音）');
assert(window.document.title.startsWith('(1)'), '后台完成后标题出现未读标记');

Object.defineProperty(window.document, 'hidden', { configurable: true, value: false });
Object.defineProperty(window.document, 'visibilityState', { configurable: true, value: 'visible' });
window.dispatchEvent(new window.Event('focus'));
window.document.dispatchEvent(new window.Event('visibilitychange'));
await waitFor('回前台清除标题标记', () => window.document.title === 'pi · webchat');
assert(window.document.title === 'pi · webchat', '回到前台后标题恢复');
$('#notify-toggle')?.click();
await waitFor('完成提醒关闭', () => $('#notify-toggle')?.getAttribute('aria-pressed') === 'false');
assert($('#notify-toggle')?.getAttribute('aria-pressed') === 'false', '再次点击关闭完成提醒');

// ---------- 图片上传：加号菜单、文件选择、附件预览、随消息发送 ----------
$('#new-chat').click();
await waitFor('图片测试的新对话', () => $('.samples button') !== null);
assert($('.composer-model-warning') === null, '未上传图片时不显示读图警告');
const addButton = $('.composer-add');
assert(addButton !== null, '输入框左侧有加号按钮');
addButton?.click();
await waitFor('加号菜单弹出', () => $('.composer-menu') !== null);
assert(text('.composer-menu').includes('上传图片'), '加号菜单包含上传图片');
assert(addButton?.getAttribute('aria-expanded') === 'true', '菜单打开时 aria-expanded=true');
$('.composer-menu button')?.click();
await waitFor('选择文件后菜单关闭', () => $('.composer-menu') === null);

const fileInput = $('.composer-field input[type="file"]');
const imageFile = new window.File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'photo.png', {
	type: 'image/png',
});
Object.defineProperty(fileInput, 'files', { configurable: true, value: [imageFile] });
fileInput.dispatchEvent(new window.Event('change', { bubbles: true }));
await waitFor('图片附件预览', () => $('.composer-attachment img') !== null);
assert($('.composer-attachment img')?.getAttribute('src')?.startsWith('data:image/png;base64,'), '附件显示图片预览');
assert($('.composer-model-warning') !== null, '不支持读图的模型上传后出现提示');
assert(text('.composer-model-warning').includes('不支持读图'), '提示说明当前模型不可读图');
assert(text('.composer-model-warning').includes('仍可发送'), '提示说明图片仍可发送');
assert($('.composer-attachment-remove') !== null, '附件带移除按钮');

const pasteData = new window.DataTransfer();
pasteData.items.add(new window.File([new Uint8Array([137, 80, 78, 71])], 'paste.png', { type: 'image/png' }));
$('textarea#input')?.dispatchEvent(
	new window.ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: pasteData }),
);
await waitFor('粘贴图片进入附件区', () => $$('.composer-attachment').length === 2);
assert($$('.composer-attachment').length === 2, '粘贴图片进入附件区');

const dragData = {
	types: ['Files'],
	files: [new window.File([new Uint8Array([137, 80, 78, 71])], 'drop.png', { type: 'image/png' })],
	dropEffect: 'copy',
};
const dragEnter = new window.DragEvent('dragenter', { bubbles: true, cancelable: true });
Object.defineProperty(dragEnter, 'dataTransfer', { configurable: true, value: dragData });
$('.composer-field')?.dispatchEvent(dragEnter);
await waitFor('拖拽进入显示提示', () => $('.composer-drop-hint') !== null);
assert(text('.composer-drop-hint').includes('松开以添加图片'), '拖拽时显示投放提示');
const dropEvent = new window.DragEvent('drop', { bubbles: true, cancelable: true });
Object.defineProperty(dropEvent, 'dataTransfer', { configurable: true, value: dragData });
$('.composer-field')?.dispatchEvent(dropEvent);
await waitFor('拖拽图片进入附件区', () => $$('.composer-attachment').length === 3);
assert($$('.composer-attachment').length === 3, '拖拽图片进入附件区');
assert($('.composer-drop-hint') === null, '投放后拖拽提示消失');
assert($('.composer-input-box .composer-attachments') !== null, '图片附件显示在输入框范围内');
assert($('#send.stop') === null, '只有图片时发送按钮不是停止键');

const attachmentSrc = $('.composer-attachment-open img')?.getAttribute('src');
$('.composer-attachment-open')?.click();
await waitFor('附件图片放大', () => $('.image-lightbox img') !== null);
assert($('.image-lightbox img')?.getAttribute('src') === attachmentSrc, '点击附件打开大图');
assert($('.image-lightbox-close svg.lucide-x') !== null, '关闭大图按钮使用居中的 X 图标');
assert(window.document.body.style.overflow === 'hidden', '大图打开时锁定页面滚动');
$('.image-lightbox-close')?.click();
await waitFor('关闭附件大图', () => $('.image-lightbox') === null);
assert(window.document.body.style.overflow !== 'hidden', '关闭大图后恢复页面滚动');

$('#composer').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await waitFor('图片消息进入对话', () => $('.msg.user .user-images img') !== null);
assert(chatCalls.at(-1)?.images?.[0]?.mimeType === 'image/png', '发送请求带上图片');
assert(chatCalls.at(-1)?.images?.length === 3, '粘贴和拖拽的图片一起发送');
assert(chatCalls.at(-1)?.images?.[0]?.data?.length > 0, '发送请求带上 base64 图片数据');
assert($('.msg.user .user-images img')?.getAttribute('src')?.startsWith('data:image/png;base64,'), '用户消息显示已发送图片');
$('.msg.user .user-image-open')?.click();
await waitFor('消息图片放大', () => $('.image-lightbox img') !== null);
assert($('.image-lightbox img') !== null, '点击已发送图片打开大图');
$('.image-lightbox')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await waitFor('点击遮罩关闭大图', () => $('.image-lightbox') === null);
assert($('.image-lightbox') === null, '点击遮罩关闭大图');

// ---------- 工作区加号：直接创建该 workspace 的新会话 ----------
assert($('.session-group-add') !== null, '工作区标题有新建加号');
$('.session-group-add')?.click();
await waitFor(
	'工作区加号新建会话',
	() => $('.samples button') !== null && text('.workspace-picker-name') === '工作区',
);
assert(text('.workspace-picker-name') === '工作区', '加号进入对应工作区的新会话');
assert($$('.msg').length === 0, '加号新建后清空消息');

// ---------- 工作区菜单：任意路径添加 ----------
$('.workspace-picker-btn')?.click();
await waitFor('工作区菜单打开', () => $('.workspace-menu-add') !== null);
$('.workspace-menu-add')?.click();
await waitFor('工作区添加表单', () => $('.workspace-add-form') !== null);
setInput('.workspace-add-input', '/workspace/plain-dir');
$('.workspace-add-form')?.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await waitFor(
	'添加任意路径工作区',
	() => workspaceCreateCalls.length === 1 && text('.workspace-picker-name') === 'plain-dir',
);
assert(workspaceCreateCalls[0]?.path === '/workspace/plain-dir', '添加工作区提交绝对路径');
assert(text('.workspace-picker-name') === 'plain-dir', '添加后自动选中新工作区');

function currentForTextareaCSS() {
	const css = readFileSync(`${WEB}/src/styles/app.css`, 'utf8');
	return css.includes('flex: 0 0 auto; display: block; width: 100%') && css.includes('padding: 11px 14px 58px');
}

// ---------- 输入框随内容增高（模拟 scrollHeight，happy-dom 不做布局） ----------
const growInput = $('textarea#input');
Object.defineProperty(growInput, 'scrollHeight', { configurable: true, get: () => 240 });
const textareaValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
textareaValueSetter.call(growInput, '第一行\n第二行\n第三行\n第四行');
growInput.dispatchEvent(new window.Event('input', { bubbles: true }));
await waitFor('输入框随内容增高', () => parseFloat(growInput.style.height) >= 200);
assert(parseFloat(growInput.style.height) >= 200, '输入框随内容自动增高');
assert(currentForTextareaCSS(), '输入框高度不被 flex 覆盖');

// ---------- 归档当前会话：视图应回到新对话 ----------
const rowByTitle = (title, scope = '.session-row') =>
	$$(scope).find((row) => row.querySelector('.session-title')?.getAttribute('title')?.includes(title));
rowByTitle('测试会话')?.querySelector('.session-open')?.click();
await waitFor(
	'重新打开测试会话',
	() => rowByTitle('测试会话', '.session-row.active') !== undefined && $$('.msg').length > 0,
);
rowByTitle('测试会话')?.querySelector('.session-action')?.click();
await waitFor('归档当前会话后回到新对话', () => archivedIds.has('sess-1') && $('.samples button') !== null);
assert(archivedIds.has('sess-1'), '归档当前会话的请求已发出');
assert($$('.msg').length === 0, '归档当前会话后消息区清空');
assert($('.session-row.active') === null, '归档后没有会话保持选中');
assert($('.workspace-picker-btn') !== null, '归档后回到新对话页（工作区选择器）');
assert(text('#turn-n') === '0' && text('#step-n') === '0', '归档后统计归零');

// 恢复，保持用例前后状态一致；恢复是列表操作，不应该把视图切回该会话
if ($('.session-row.archived') === null) $('.archive-toggle')?.click();
await waitFor('展开已归档（含当前会话）', () => rowByTitle('测试会话', '.session-row.archived') !== undefined);
rowByTitle('测试会话', '.session-row.archived')?.querySelector('.session-action')?.click();
await waitFor('恢复测试会话', () => !archivedIds.has('sess-1'));
assert($('.samples button') !== null, '恢复会话不把视图切走');

// ---------- 样式保真 ----------
const current = readFileSync(`${WEB}/src/styles/app.css`, 'utf8');
assert(current.includes('.panel {') && current.includes('.app.no-panel'), 'app.css 包含右栏工作台样式');
assert(current.includes('width: min(960px, calc(100vw - 48px))'), 'PC 设置弹窗宽度加宽');
const chatCss = readFileSync(`${WEB}/src/styles/chat.css`, 'utf8');
assert(
	chatCss.includes('button.ring {') && chatCss.includes('button.ring:hover .ring-track') && !chatCss.includes('button.ring.ctx {'),
	'订阅额度环复用 button.ring 样式重置',
);
assert(chatCss.includes('stroke-opacity: 0.45') && !chatCss.includes('stroke: #46505f'), '环 hover 使用浅色描边');
assert(chatCss.includes('grid-template-columns: repeat(2, minmax(0, 1fr))'), '文件卡片多文件桌面两列');
assert(
	/@media \(max-width: 980px\)[\s\S]{0,160}\.report-files-list[\s\S]{0,160}grid-template-columns: minmax\(0, 1fr\)/.test(chatCss),
	'文件卡片移动端单列',
);
const themeCss = readFileSync(`${WEB}/src/styles/theme.css`, 'utf8');
assert(themeCss.includes('html[data-theme="light"]'), '亮色主题样式存在');
assert(themeCss.includes('.turn-nav-line.favorite'), '亮色主题保留收藏短线颜色');
// 轨迹横道图：之前阴影/网格线/思考车道写死深色值，亮色主题下是黑糊糊一圈 + 网格线消失
assert(
	chatCss.includes('var(--traj-shadow-lg)') &&
		chatCss.includes('var(--traj-grid)') &&
		chatCss.includes('var(--traj-lane-think)'),
	'横道图阴影/网格线/车道色走主题变量',
);
assert(!/\.traj-waterfall\s*\{[^}]*rgba\(0,\s*0,\s*0,\s*0\.7\)/.test(chatCss), '横道图不再写死深色阴影');
assert(
	themeCss.includes('--traj-grid: rgba(20, 28, 45, 0.09)') &&
		themeCss.includes('--traj-shadow-lg: rgba(20, 28, 45, 0.16)') &&
		themeCss.includes('--traj-lane-think: #7a5c9e'),
	'亮色主题覆盖横道图网格线/阴影/思考车道',
);
assert(
	themeCss.includes('html[data-theme="light"] .traj-waterfall { background: var(--panel); }'),
	'亮色下横道图换成白底才浮得起来',
);
assert(themeCss.includes('html[data-theme="light"] .traj-bar { opacity: 0.95; }'), '亮色下色块不被透明度冲淡');
assert(
	!/\.job-input-wrap input[^}]*#101217/s.test(current) && !/\.job-run-detail pre[^}]*#101217/s.test(current),
	'定时任务输入框/详情不写死深色背景',
);
const messageListSource = readFileSync(`${WEB}/src/components/MessageList.tsx`, 'utf8');
assert(
	messageListSource.includes('isScript ? (') && messageListSource.includes('className="tool-icon"'),
	'codemode 脚本调用有自己的图标',
);
assert(/.tool-icon svg { width: 12px/.test(current), '工具图标尺寸跟思考行图标一致');
const textPreviewSource = readFileSync(`${WEB}/src/components/previews/TextPreview.tsx`, 'utf8');
assert(textPreviewSource.includes('light: {') && textPreviewSource.includes('themeCompartment.reconfigure'), '文件代码预览跟随亮暗主题');
assert(current.includes('.balance-chip {') && current.includes('.balance-chip.empty'), '余额显示样式存在');
assert(current.includes('.composer textarea::placeholder { font-size: 14px; line-height: 1.45; }'), '移动端 placeholder 字号缩小避免被按钮遮挡');
// 毛玻璃：模糊和底色都挂在伪元素上并被 mask 淡出，否则矩形上沿会在文字上切出一条硬边
assert(current.includes('.composer-wrap::before'), '毛玻璃放在伪元素上（内容不会被一起淡掉）');
assert(
	/\.turn-verse-glass \{[^}]*backdrop-filter: blur\(12px\)/s.test(current),
	'名句毛玻璃真的开了模糊（不是只换个底色）',
);
assert(
	/\.turn-verse-glass \{[^}]*max-width: 100%/s.test(current),
	'名句毛玻璃不会撑破一行',
);
assert(
	/mask-image: linear-gradient\(\s*to top/.test(current) && current.includes('-webkit-mask-image'),
	'模糊 + 底色在顶部按不透明度淡出，没有硬边',
);
assert(
	/inset: calc\(-1 \* var\(--glass-lift, 26px\)\) 0 0/.test(current) && current.includes('--glass-lift: 26px'),
	'毛玻璃向上多盖一圈（--glass-lift），消息可以滑到玻璃底下',
);
assert(
	current.includes('calc(var(--composer-h, 132px) + var(--glass-lift, 26px) + 4px)'),
	'消息区底部内边距要把玻璃多盖的高度让出来（不然轮次统计被盖住）',
);
assert(
	/\.composer-wrap::before \{[^}]*backdrop-filter: blur\(14px\)/s.test(current),
	'模糊仍然在（只是被 mask 收边）',
);
assert(
	!/html\[data-theme="light"\] \.composer-wrap\s*\{/.test(themeCss),
	'亮色主题不再为毛玻璃写死第二套渐变（底色统一走 var(--bg)）',
);
assert(current.includes('align-items: flex-end; justify-content: flex-end; gap: 7px;'), '模型/思考胶囊底部与发送按钮对齐');
assert(current.includes('height: 28px; padding: 0 8px;'), '桌面模型/思考胶囊缩小');
assert(current.includes('.app, .app.no-panel {'), '移动端收起右栏时仍保持单列布局');
const splitterCss = readFileSync(new URL('../src/styles/splitter.css', import.meta.url), 'utf8');
assert(splitterCss.includes('@property --ctx-f'), '--ctx-f 注册成可插值属性（会话列收放动画）');
assert(splitterCss.includes('@property --rail-w'), '--rail-w 注册成可插值属性（rail 宽窄动画）');
assert(
	splitterCss.includes('transition: --ctx-f 0.22s ease, --rail-w 0.22s ease'),
	'两处宽度过渡都挂在 .app 上',
);
assert(
	current.includes('transition: font-size 0.22s ease, gap 0.22s ease, padding 0.22s ease,'),
	'rail 内部字号/间距跟着宽度缓动',
);

// ---------- 视图路由（hash） ----------
assert($('.chat') !== null, '默认停在对话视图');
assert($('.app.view-module') === null, '对话视图是三栏布局');
window.location.hash = '#/skills';
await waitFor('hash 切到技能视图', () => $('#skills-view') !== null);
await waitFor('hash 切到技能后列表加载', () => $('#skills-list .skills-source-row') !== null && $('.skill-card') !== null);
assert(text('#skills-view').includes('技能'), '技能视图显示模块名');
assert($('.chat') === null, '技能视图不渲染对话主面板');
assert($('.app.view-skills') !== null, '技能视图保留上下文列（rail + 市场筛选 + 卡片）');
assert($('#rail-settings-toggle') !== null, '左栏在技能视图里保留');
window.location.hash = '#/chat';
await waitFor('hash 回到对话', () => $('.chat') !== null);
assert(window.location.hash === '#/chat', 'hash 回到 #/chat');

// ---------- 定时任务：设置弹窗 → rail 模块 ----------
window.location.hash = '#/jobs';
await waitFor('hash 切到定时任务模块', () => $('#module-jobs') !== null);
assert($('.chat') === null, '定时任务模块不渲染对话主面板');
assert($('.app.view-module') !== null, '定时任务模块同样收成一列');
assert($('.module-view-head h1')?.textContent === '定时任务', '模块视图有自己的标题');
await waitFor('定时任务卡片', () => $('.job-card') !== null);
assert($('.job-badge.on') !== null, '定时任务显示启用状态');
assert($('.job-badge.dry') !== null, '定时任务显示干跑状态');
assert($$('.job-field').length >= 4, '定时任务配置项渲染');
await waitFor('执行记录', () => $('.job-run') !== null);
assert(text('.job-run-status') === '成功', '执行记录显示成功');
assert($('.job-run-detail') !== null, '执行记录可展开详情');
assert($('.rail-nav-btn[data-module="jobs"]')?.getAttribute('aria-current') === 'page', 'rail 高亮定时任务');
assert($('#module-jobs #rail-mods') === null, '桌面端定时任务模块不渲染移动模块条');
window.location.hash = '#/chat';
await waitFor('从定时任务回到对话', () => $('.chat') !== null);
assert($('#module-jobs') === null, '回到对话后定时任务模块卸载');

// ---------- MCP 模块：列表 → 测试 → 编辑保存 → 应用 → 删除 ----------
window.location.hash = '#/mcp';
await waitFor('hash 切到 MCP 模块', () => $('#module-mcp') !== null);
await waitFor('MCP 服务器列表', () => $$('.mcp-server').length === 2);
// 主操作（新建 / 保存）必须是组件库的 primary 按钮：旧 .primary class 在 app.css 里
// 从来没有定义，用它会退化成浏览器默认按钮
const mcpButton = (scope, label) => $$(`${scope} button`).find((el) => el.textContent.includes(label));
const isLibraryPrimary = (el) => el?.className.includes('tw-bg-primary') === true;
// 并且盒子要用旧站刻度（12px 字 / 8px+11px 内边距 + ≤980px 加大），
// 而不是 shadcn 默认的 px-4 / py-2 / text-sm：那套在 PC 上比旁边的 .ghost 高 7px、字大 2px
const usesAppScale = (el) =>
	el?.className.includes('tw-text-[12px]') === true &&
	el.className.includes('tw-px-[11px]') === true &&
	el.className.includes('max-[980px]:tw-py-[10px]') === true &&
	!el.className.includes('tw-text-sm');
assert(text('#module-mcp').includes('mcp.json'), 'MCP 页显示配置文件位置');
assert(text('.mcp-server[data-server="filesystem"]').includes('mcp__filesystem__'), '卡片标注工具前缀');
assert(
	$$('.mcp-server[data-server="docs"] .badge').some(
		(el) => el.textContent === '停用' && !el.classList.contains('on'),
	),
	'停用的服务器标签显示「停用」且不带 on',
);
assert(text('.mcp-server[data-server="docs"] .mcp-command').includes('https://example.com/mcp'), 'http 服务器显示 url');
assert($('.mcp-server[data-server="filesystem"] .mcp-command')?.tagName === 'CODE', 'stdio 服务器显示命令行');

// 测试连接：走 /api/mcp/test，不碰会话
$$('.mcp-server[data-server="filesystem"] .mcp-action')[0].click();
await waitFor('MCP 测试结果', () => $('.mcp-server[data-server="filesystem"] .mcp-probe') !== null);
assert($('.mcp-server[data-server="filesystem"] .mcp-probe.ok') !== null, '测试成功显示 ok 样式');
assert(text('.mcp-server[data-server="filesystem"] .mcp-tools').includes('read_file'), '测试结果列出工具');
assert(mcpTestCalls.length === 1 && mcpTestCalls[0].config === undefined, '测已保存条目不带 config（不测草稿）');

// 编辑：raw 里前端不认识的键（auth）要一起提交回去
$$('.mcp-server[data-server="filesystem"] .mcp-action')[1].click();
await waitFor('打开 MCP 编辑器', () => $('.mcp-editor') !== null);
assert($('.mcp-editor .field-input')?.disabled === true, '编辑已有服务器时名字只读');
assert($$('.mcp-editor select').every((el) => el.className.includes('select')), 'MCP 表单没有裸 select');
setInput('.mcp-editor .field-input[placeholder="读写工作区文件"]', '读写工作区文件（新）');
const saveDraftButton = mcpButton('.mcp-form-actions', '保存');
assert(isLibraryPrimary(saveDraftButton), '「保存」用组件库 primary 按钮');
assert(usesAppScale(saveDraftButton), '「保存」跟旁边 .ghost 同一套控件刻度');
saveDraftButton.click();
await waitFor('MCP 保存调用', () => mcpSaveCalls.length === 1);
assert(mcpSaveCalls[0].name === 'filesystem', '保存提交服务器名');
assert(mcpSaveCalls[0].config.description === '读写工作区文件（新）', '保存提交改过的 description');
assert(mcpSaveCalls[0].config.auth?.provider === 'docs', '保存保留 raw 里不认识的键（auth）');
assert(mcpSaveCalls[0].config.exposure === 'codemode', '保存保留 exposure');
await waitFor('保存后编辑器关闭', () => $('.mcp-editor') === null);

// 新建：只填名字和 command 也能存
const newServerButton = mcpButton('.mcp-head-actions', '新建服务器');
assert(isLibraryPrimary(newServerButton), '「新建服务器」用组件库 primary 按钮');
assert(usesAppScale(newServerButton), '「新建服务器」跟旁边 .ghost 同一套控件刻度');
newServerButton.click();
await waitFor('打开新建编辑器', () => $('.mcp-editor') !== null);
assert($('.mcp-editor .field-input')?.disabled === false, '新建时名字可编辑');
setInput('.mcp-editor .field-input', 'echo');
setInput('.mcp-editor .field-input[placeholder="npx"]', 'node');
const saveNewButton = mcpButton('.mcp-form-actions', '保存');
assert(isLibraryPrimary(saveNewButton), '新建表单的「保存」也用组件库 primary 按钮');
assert(usesAppScale(saveNewButton), '新建表单的「保存」同样吃旧站刻度');
saveNewButton.click();
await waitFor('MCP 新建保存', () => mcpSaveCalls.length === 2);
assert(mcpSaveCalls[1].config.type === 'stdio' && mcpSaveCalls[1].config.command === 'node', '新建保存 stdio 配置');
await waitFor('新建后编辑器关闭', () => $('.mcp-editor') === null);

// 应用到运行中的会话
$$('.mcp-head-actions button').find((el) => el.textContent.includes('应用到会话')).click();
await waitFor('MCP 应用到会话', () => mcpApplyCalls === 1);
assert(mcpApplyCalls === 1, '点「应用到会话」会调 /api/mcp/apply');

// 删除要二次确认
await waitFor('新服务器卡片', () => $('.mcp-server[data-server="echo"]') !== null);
$$('.mcp-server[data-server="echo"] .mcp-action').at(-1).click();
await waitFor('删除确认', () => $('.mcp-confirm') !== null);
$('.mcp-confirm .danger').click();
await waitFor('删除后卡片消失', () => $('.mcp-server[data-server="echo"]') === null);
assert($$('.mcp-server').length === 2, '删除后剩两台服务器');

window.location.hash = '#/chat';
await waitFor('从 MCP 回到对话', () => $('.chat') !== null);
assert($('#module-mcp') === null, '回到对话后 MCP 模块卸载');

window.location.hash = '#/unknown-view';
await waitFor('未知 hash 回落', () => $('.chat') !== null);
assert($('.chat') !== null, '未知 hash 回落到对话视图');
window.location.hash = '#/chat';

// ---------- 断点：桌面窄屏自动收起上下文列 ----------
// 1280：上下文列本来展开；把 rail 展成宽条后要让位（宽条与列二选一）
await window.happyDOM.setViewport({ width: 1280, height: 800 });
await waitFor('1280 上下文列展开', () => $('.app.ctx-collapsed') === null && $('.rail') !== null);
$('#rail-wide-toggle').click();
await waitFor('宽条时 1280 让出上下文列', () => $('.app.rail-wide') !== null && $('.app.ctx-collapsed') !== null);
assert($('.app.ctx-collapsed') !== null && $('.rail')?.hasAttribute('inert'), '宽条 + 1280：上下文列自动收起且不可聚焦');
$('#rail-wide-toggle').click();
await waitFor('收回宽条后上下文列回来', () => $('.app.ctx-collapsed') === null && $('.rail') !== null);

await window.happyDOM.setViewport({ width: 1024, height: 800 });
await waitFor('窄屏自动收起会话列表', () => $('.app.ctx-collapsed') !== null);
assert($('.app.ctx-collapsed') !== null && $('.rail')?.hasAttribute('inert'), '窄屏（1024）默认收起且不可聚焦');
assert($('#rail-new-chat') !== null, '窄屏自动收起时 rail 上也有新对话入口');
assert($('.rail-nav-btn[data-module="chat"]')?.getAttribute('title')?.includes('已收起'), 'rail 提示语反映真实收起状态');
assert($('.rail-nav') !== null, '窄屏仍保留模块 rail');
assert($('#rail-wide-toggle') !== null, '窄屏下也能展开宽条 rail');
assert($('.chat') !== null && $('.panel') !== null, '窄屏下聊天区和右栏都在');
assert($('#rail-collapse')?.closest('.rail')?.hasAttribute('inert'), '列已收起时折叠按钮被 inert 挡住');
$('.rail-nav-btn[data-module="chat"]').click();
await waitFor('窄屏手动展开会话列表', () => $('.app.ctx-collapsed') === null);
assert($('.rail') !== null, '窄屏点对话图标可以展开');
await window.happyDOM.setViewport({ width: 1440, height: 900 });
await waitFor('回到宽屏', () => $('.app.ctx-collapsed') === null);
assert($('.rail') !== null, '变宽后会话列表仍然是展开的');
await window.happyDOM.setViewport({ width: 1024, height: 800 });
await waitFor('再次变窄', () => $('.app.ctx-collapsed') !== null);
assert($('.app.ctx-collapsed') !== null, '重新变窄时忘掉上次的临时展开');
await window.happyDOM.setViewport({ width: 1440, height: 900 });
await waitFor('恢复宽屏', () => $('.rail') !== null);

// ---------- 断点：移动端模块条 ----------
await window.happyDOM.setViewport({ width: 390, height: 844 });
await waitFor('切到移动端', () => $('.rail-nav') === null);
assert($('.rail-nav') === null, '移动端不渲染常驻 rail');
assert($('#rail-mods') !== null, '移动端抽屉里有模块条');
assert($$('#rail-mods .rail-mods-btn').length === 5, '模块条有 5 个模块');
assert($$('#rail-settings-toggle').length === 1, '设置入口全屏只渲染一份（无重复 id）');
assert($('.rail-foot #rail-settings-toggle') !== null, '移动端设置入口在抽屉底部');
$('#menu').click();
await waitFor('打开移动端抽屉', () => $('.rail.open') !== null);
$('#rail-mods .rail-mods-btn[data-module="skills"]').click();
await waitFor('移动端从模块条切到技能', () => $('#skills-view') !== null);
await waitFor('移动端技能列表加载', () => $('#skills-list .skills-source-row') !== null && $('.skill-card') !== null);
assert($('.rail.open') === null, '切模块后抽屉自动关上');
assert($('#skills-view #rail-mods') !== null, '移动端技能模块也有模块条（能走回去）');
assert($$('#skills-view #rail-mods .rail-mods-btn').length === 5, '技能页模块条同样是 5 项');
assert(window.location.hash === '#/skills', '移动端模块条也写 hash');
assert($('#skills-view .skills-rail') === null, '移动端市场筛选在抽屉里，不占主面板');
window.location.hash = '#/jobs';
await waitFor('移动端切到定时任务模块', () => $('#module-jobs') !== null);
assert($('#module-jobs #rail-mods') !== null, '移动端定时任务模块也有模块条（能走回去）');
assert($('#rail-mods .rail-mods-btn[data-module="jobs"]')?.getAttribute('aria-current') === 'page', '模块条高亮定时任务');
$('#module-jobs #rail-mods .rail-mods-btn[data-module="chat"]').click();
await waitFor('移动端回到对话', () => $('.chat') !== null);
assert($('#rail-mods') !== null, '回到对话后模块条还在');
assert($('#rail-mods .rail-mods-btn[data-module="chat"]')?.getAttribute('aria-current') === 'page', '模块条高亮对话');
await window.happyDOM.setViewport({ width: 1440, height: 900 });
await waitFor('回到桌面宽度', () => $('.rail-nav') !== null);
assert($('#rail-mods') === null, '回到桌面后模块条收回');
assert($$('#rail-settings-toggle').length === 1, '桌面端设置入口也只有一份');

// ---------- 中断：计时同样停在点中断的那一刻 ----------
setValue?.call($('textarea#input'), '中断计时用例');
$('textarea#input').dispatchEvent(new window.Event('input', { bubbles: true }));
$('#composer').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await waitFor('中断用例开始生成', () => $('.turn-verse.running') !== null);
assert($('#send')?.className.includes('stop'), '生成中发送键变成停止键');
$('#send').click();
await waitFor('中断后计时消失', () => $('.turn-verse') === null, 2500);
assert($('.turn-verse') === null, '点中断后计时也收起（和完成一致）');

// ---------- @ 会话引用：发送协议带上 references ----------
$('#rail-new-chat')?.click();
await waitFor('引用测试回到新对话', () => $('#input')?.value === '');
const beforeReferenceSend = chatCalls.length;
setInputAt('#input', '@');
await waitFor('引用测试会话候选', () => $('.input-trigger-menu') !== null && text('.input-trigger-menu').includes('重命名后的会话'));
$('#input')?.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
await waitFor('插入 @ 会话 token', () => ($('#input')?.value ?? '').startsWith('@['));
const referenceToken = $('#input')?.value ?? '';
setInputAt('#input', `${referenceToken} 继续`);
$('#composer').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await waitFor('发送 @ 引用', () => chatCalls.length === beforeReferenceSend + 1);
const referenceBody = chatCalls.at(-1);
assert(referenceBody?.text === `${referenceToken} 继续`, '@ 引用原样进入消息文本');
assert(referenceBody?.references?.[0]?.kind === 'session', '发送协议带 session references');
assert(referenceBody?.references?.[0]?.id === 'sess-1', 'references 带稳定 session id');
assert(referenceBody?.references?.[0]?.turn === undefined, '普通会话引用不带 turn');

// turn 引用口：手工 token 也应该解析并进入发送协议
$('#rail-new-chat')?.click();
await waitFor('轮次引用测试回到新对话', () => $('#input')?.value === '');
const beforeTurnReferenceSend = chatCalls.length;
setInputAt('#input', '@[重命名后的会话](session:sess-1#turn=2) 继续');
$('#composer').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await waitFor('发送轮次引用', () => chatCalls.length === beforeTurnReferenceSend + 1);
const turnReferenceBody = chatCalls.at(-1);
assert(turnReferenceBody?.references?.[0]?.id === 'sess-1', '轮次引用带 session id');
assert(turnReferenceBody?.references?.[0]?.turn === 2, '轮次引用带 turn');

// ---------- 打开归档会话：输入区保持只读 ----------
if ($('.session-row.archived') === null) $('.archive-toggle')?.click();
await waitFor('展开已归档会话', () => $('.session-row.archived .session-open') !== null);
const archivedOpen = $$('.session-row.archived').find((row) => row.textContent.includes('归档会话'));
archivedOpen?.querySelector('.session-open')?.click();
await waitFor(
	'归档会话打开',
	() => $('.session-row.archived.active') !== null && $('.history-loading') === null,
);
assert($('textarea#input')?.disabled === true, '归档会话禁用输入框');
assert($('#send')?.disabled === true, '归档会话禁用发送按钮');
assert(
	($('textarea#input')?.getAttribute('placeholder') ?? '').includes('已归档'),
	'归档会话提示恢复后才能发送',
);
$('.session-row.archived.active .session-action')?.click();
await waitFor('恢复归档会话后解锁输入', () => $('textarea#input')?.disabled === false);
assert($('#send')?.disabled === false, '恢复归档会话后发送按钮恢复');
$('#new-chat')?.click();
await waitFor('归档测试后回到新对话', () => $('.samples button') !== null);

// ---------- 文件汇报卡片：下载按钮 ----------
const cardSource = readFileSync(`${WEB}/src/components/deliverables/ReportedFilesCard.tsx`, 'utf8');
assert(cardSource.includes('className="report-files-download"'), '文件卡片渲染下载按钮');
assert(cardSource.includes('fileRefRawUrl(file.address, { download: true })'), '多文件下载走 raw attachment');
assert(cardSource.includes('fileRefRawUrl(single.address, { download: true })'), '单文件下载走 raw attachment');
const chatCssNew = readFileSync(`${WEB}/src/styles/chat.css`, 'utf8');
assert(
	chatCssNew.includes('.report-files-download') && chatCssNew.includes('@media (hover: none)'),
	'下载按钮有触屏常显样式',
);
const appCss = readFileSync(`${WEB}/src/styles/app.css`, 'utf8');
assert(/\.app\s*\{[^}]*height:\s*var\(--app-height, 100dvh\)/s.test(appCss), '应用高度优先用可见视口，避开地址栏');
const narrowGridRules = appCss.match(/@media \(max-width: 1439px\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
assert(
	narrowGridRules.includes('calc(var(--ctx-w, 220px) * var(--ctx-f))'),
	'窄桌面收起上下文列时仍保留空轨，右栏不会被挤到第二行',
);
assert(
	!/\.app\.ctx-collapsed\s*\{[^}]*grid-template-columns/s.test(narrowGridRules),
	'窄桌面不再把上下文列从网格模板里删掉',
);
assert(!/\.composer-model-search\s*\{[^}]*position:\s*sticky/s.test(appCss), '模型搜索框不再用 sticky 跟着列表滚');
assert(/\.composer-model-list\s*\{[^}]*overflow-y:\s*auto/s.test(appCss), '模型列表自己负责滚动');
assert(appCss.includes('-webkit-tap-highlight-color: transparent'), '触屏点击不出现默认方块高亮');
// 轮次导航在聊天区右边缘：整条竖栏不能吃掉点击，否则会盖住消息右下角的复制按钮
const turnNavCss = readFileSync(`${WEB}/src/styles/chat.css`, 'utf8');
assert(
	/\.turn-nav-lines\s*\{[^}]*pointer-events:\s*none/s.test(turnNavCss),
	'轮次导航的竖栏本身不拦截点击',
);
assert(
	/\.turn-nav-line\s*\{[^}]*pointer-events:\s*auto/s.test(turnNavCss),
	'只有轮次短线本身可点',
);
assert(/\.tool\.script\s*\{[^}]*border-left:\s*0/s.test(appCss), 'codemode 行不再带状态色左竖条');
assert(/\.tool\.script\s*\{[^}]*font:\s*12px\/1\.5 var\(--sans\)/s.test(appCss), 'codemode 行和思考行同一套字号/字体');
assert(/\.tool\.script \.tool-children\s*\{[^}]*border-left:\s*2px solid/s.test(appCss), 'codemode 子调用列表用实线');
assert(
	appCss.includes('.tool.script.running .tool-icon') &&
		appCss.includes('.tool.script.running .name::after') &&
		appCss.includes('@keyframes codemode-pulse') &&
		appCss.includes('@keyframes codemode-dot'),
	'codemode 执行中：图标与标签后的点都在闪',
);
assert(
	/prefers-reduced-motion: reduce[\s\S]*?content: '运行中'/.test(appCss),
	'关动画的环境用「运行中」文字兜底',
);
assert(
	/\.tool\.script \.tool-expand\s*\{[^}]*gap:\s*6px/s.test(appCss) &&
		/\.tool\.script \.tool-icon\s*\{[^}]*font-size:\s*12px/s.test(appCss),
	'codemode 图标尺寸/间距对齐思考行（12px + gap 6px）',
);
assert(/button\.ring:focus-visible \{[^}]*outline: none/s.test(chatCssNew), '环焦点圈不用方框 outline');

// ---------- 共通卡片栈：待发送消息和凭据审批用同一套卡片 ----------
const stackSources = MockEventSource.instances;
for (const instance of stackSources) {
	instance.emit('queue', { steering: ['插话卡测试'], followUp: ['排队卡测试'] });
}
await waitFor(
	'待发送卡片渲染',
	() => $$('.composer-card-stack .queue-card').length === 1 && $$('.composer-card-stack .queue-row').length === 2,
);
assert($('.composer-card-stack-head') === null, '计数 / 全部收回不再跑到卡片上面');
assert($('.queue-card.steering .queue-row.steering') !== null, '插话行进同一张待发送卡');
assert($('.queue-card .queue-row.followUp') !== null, '排队行进同一张待发送卡');
assert(text('.queue-row.steering .queue-row-copy strong') === '插话中', '插话行标题为插话中');
assert(text('.queue-row.followUp .queue-row-copy strong') === '排队中', '排队行标题为排队中');
assert(text('.queue-card .queue-card-count').includes('插话 1'), '卡片内部显示插话条数');
assert(text('.queue-card .queue-card-count').includes('排队 1'), '卡片内部显示排队条数');
assert($('.queue-card .queue-card-clear') !== null, '全部收回在卡片内部');
assert($('.queue-row.steering')?.getAttribute('data-tone') === 'steering', '插话行使用插话主题色');
assert($('.queue-row.followUp')?.getAttribute('data-tone') === 'followUp', '排队行使用排队主题色');
assert($('.queue-card')?.getAttribute('data-tone') === 'steering', '混合队列卡按插话主题着色');
$('.queue-card .composer-card-summary')?.click();
await waitFor('插话卡展开全文', () => text('.queue-row.steering .composer-card-fulltext').includes('插话卡测试'));
assert($('.queue-row.steering .composer-card-fulltext') !== null, '点击插话卡展开完整消息');
$('.queue-card .composer-card-summary')?.click();
await waitFor('队列卡再点收到细条', () => $('.queue-card[data-state="peek"]') !== null);
assert($('.queue-card .composer-card-peek') !== null, '队列卡完整形态再点一次只留细条');
$('.queue-card .composer-card-peek')?.click();
await waitFor('队列卡细条恢复默认', () => $('.queue-card[data-state="default"]') !== null);

for (const instance of stackSources) {
	instance.emit('credential_request', {
		requestId: 'req-stack',
		credential: {
			name: 'gitea',
			label: 'Gitea',
			kind: 'bearer',
			hosts: ['git.example.com'],
			scopes: ['gitea:issue:read'],
		},
		reason: '同栈测试',
		scopes: ['gitea:issue:read'],
		sessionId: 'sess-1',
		expiresAt: Date.now() + 120000,
	});
}
const buildErrors = errors.length;
console.log(`\n${buildErrors ? `${buildErrors} failure(s)` : 'all checks passed'}`);
process.exit(buildErrors ? 1 : 0);
