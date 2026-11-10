/**
 * AgentTemplate（CARD.md）的读写层：发现 / 校验 / 保存 / fork / 合并 / 预览。
 *
 * 唯一真相是磁盘上的 CARD.md —— 可 `git diff`、可 review、可以手工改。
 * 这里**不建第二份状态**：没有 state.json、没有内存里的"当前值"缓存，
 * 每次读文件。之所以强调这点，是因为本仓库已经出现过两次
 * "配置在一处、生效在另一处"的分叉（`PI_TOOLS` vs 设置勾选；mainAgent 的 CARD）。
 *
 * 目录约定（docs/agent-hub.md §3）：
 *   <runtime>/mainAgent/CARD.md       主脑：单例、永不 fork
 *   <runtime>/agents/<id>/CARD.md     执行岗位；base 是只读原型
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createAgentSession, parseFrontmatter, SessionManager } from '@earendil-works/pi-coding-agent';
import { AGENT_DIR, getRuntime, skillInjectionText, TOOLS } from './chat.ts';
import { createSessionLoader } from './session-config.ts';
import { availableSkills, blocksForPinned } from './skill-blocks.ts';

export { availableSkills };

const RUNTIME_DIR = resolve(process.env.PI_RUNTIME_DIR ?? join(import.meta.dirname ?? '.', '..', 'runtime'));
export const AGENTS_DIR = resolve(process.env.PI_AGENTS_DIR ?? join(RUNTIME_DIR, 'agents'));
const MAIN_DIR = resolve(process.env.PI_MAIN_AGENT_DIR ?? join(RUNTIME_DIR, 'mainAgent'));
const PROVIDER = process.env.PI_PROVIDER ?? 'opencode-go';
const MODEL_ID = process.env.PI_MODEL ?? 'deepseek-v4.1-flash';

/** 产品固定出口：CARD 关不掉，建会话时总会被加回 allowlist。 */
export const PINNED_TOOLS = ['cred_list', 'cred_use'];

export type AgentKind = 'base' | 'domain' | 'variant' | 'orchestrator';

export interface AgentCard {
	id: string;
	description: string;
	kind: AgentKind;
	domain: string;
	appliesTo: string[];
	tools: string[];
	/** `id` 或 `id@sha256`；空 = 走域自动授权 */
	skills: string[];
	model: string;
	thinking: string;
	parent: string | null;
	forkedAt: string | null;
	forkOffset: number;
	expiresAt: string | null;
	external: boolean;
	maxActive: number;
	status: string;
	/** CARD 正文 = 岗位说明 = 追加到系统提示词的片段 */
	prompt: string;
	path: string;
	writable: boolean;
	warnings: string[];
}

export interface AgentToolInfo {
	name: string;
	label?: string;
	description?: string;
	pinned?: boolean;
}

export interface AgentPreview {
	id: string;
	model: string;
	thinking: string;
	contextWindow: number;
	/** 真实生效的系统提示词（SDK 基线 + CARD 正文 + codemode 强制段） */
	system: string;
	toolsText: string;
	tools: { name: string; tokens: number }[];
	activeTools: string[];
	pinnedTools: string[];
	skills: { id: string; sha256: string; tokens: number; text: string }[];
	skillsText: string;
	chars: { system: number; tools: number; skills: number };
	tokens: { system: number; tools: number; skills: number; total: number };
	warnings: string[];
	/** 没走 SDK 真实装载时的降级说明；正常情况为空 */
	degraded?: string;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function asString(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

function asStringList(value: unknown): string[] {
	const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
	return raw.map((item) => String(item).trim()).filter(Boolean);
}

function asNumber(value: unknown, fallback: number): number {
	const n = Number(value);
	return Number.isFinite(n) ? n : fallback;
}

function asBool(value: unknown, fallback = false): boolean {
	if (typeof value === 'boolean') return value;
	if (value === 'true') return true;
	if (value === 'false') return false;
	return fallback;
}

function normalizeKind(value: unknown, parent: string | null): AgentKind {
	const kind = asString(value);
	if (kind === 'base' || kind === 'domain' || kind === 'variant' || kind === 'orchestrator') return kind;
	return parent ? 'domain' : 'domain';
}

function cardPath(id: string): string {
	return id === 'main' ? join(MAIN_DIR, 'CARD.md') : join(AGENTS_DIR, id, 'CARD.md');
}

/** 单行标量：CARD 的字段都是短字符串，不做完整 YAML 序列化。 */
function yamlScalar(value: string): string {
	if (!value) return '""';
	if (/^[\w./:-]+$/.test(value) && !/^(true|false|null|\d)/.test(value)) return value;
	return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function yamlList(values: string[]): string {
	return `[${values.map(yamlScalar).join(', ')}]`;
}

function serializeCard(card: AgentCard): string {
	const lines = [
		'---',
		`id: ${yamlScalar(card.id)}`,
		`kind: ${card.kind}`,
		`domain: ${yamlScalar(card.domain)}`,
		`appliesTo: ${yamlList(card.appliesTo)}`,
		`tools: ${yamlList(card.tools)}`,
		`skills: ${yamlList(card.skills)}`,
		`model: ${yamlScalar(card.model)}`,
		`thinking: ${yamlScalar(card.thinking)}`,
		`description: ${yamlScalar(card.description)}`,
		`parent: ${card.parent ? yamlScalar(card.parent) : 'null'}`,
		`forkedAt: ${card.forkedAt ?? 'null'}`,
		`forkOffset: ${card.forkOffset}`,
		`expiresAt: ${card.expiresAt ? yamlScalar(card.expiresAt) : 'null'}`,
		`external: ${card.external}`,
		`maxActive: ${card.maxActive}`,
		`status: ${yamlScalar(card.status)}`,
		'---',
		'',
	];
	return `${lines.join('\n')}\n${card.prompt.trim()}\n`;
}

function parseCard(id: string, text: string, path: string): AgentCard {
	const { frontmatter, body } = parseFrontmatter(text);
	const parent = asString(frontmatter.parent) || null;
	const warnings: string[] = [];
	const kind = normalizeKind(frontmatter.kind, parent);
	if (kind === 'base') warnings.push('base 是只读原型：只能被 fork，不能直接激活');
	return {
		id: asString(frontmatter.id) || id,
		description: asString(frontmatter.description),
		kind,
		domain: asString(frontmatter.domain) || 'general',
		appliesTo: asStringList(frontmatter.appliesTo),
		tools: asStringList(frontmatter.tools),
		skills: asStringList(frontmatter.skills),
		model: asString(frontmatter.model),
		thinking: asString(frontmatter.thinking),
		parent,
		forkedAt: asString(frontmatter.forkedAt) || null,
		forkOffset: asNumber(frontmatter.forkOffset, 0),
		expiresAt: asString(frontmatter.expiresAt) || null,
		external: asBool(frontmatter.external),
		maxActive: asNumber(frontmatter.maxActive, kind === 'orchestrator' ? 3 : 1),
		status: asString(frontmatter.status) || 'active',
		prompt: body.trim(),
		path,
		writable: kind !== 'base',
		warnings,
	};
}

/** 读一个目录下的 CARD.md；目录不存在就当空。 */
async function readCards(dir: string): Promise<AgentCard[]> {
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch {
		return [];
	}
	const cards: AgentCard[] = [];
	for (const name of entries) {
		if (name.startsWith('.')) continue;
		const path = join(dir, name, 'CARD.md');
		try {
			const info = await stat(path);
			if (!info.isFile()) continue;
			cards.push(parseCard(name, await readFile(path, 'utf8'), path));
		} catch {
			// 没有 CARD.md 的目录不是模板，跳过
		}
	}
	return cards;
}

export async function listAgents(): Promise<AgentCard[]> {
	const main = await (async () => {
		try {
			return [parseCard('main', await readFile(join(MAIN_DIR, 'CARD.md'), 'utf8'), join(MAIN_DIR, 'CARD.md'))];
		} catch {
			return [];
		}
	})();
	const agents = await readCards(AGENTS_DIR);
	// base 排最前（它是所有新岗位的起点），主脑其次，其余按 id。
	const rank = (card: AgentCard) => (card.kind === 'base' ? 0 : card.id === 'main' ? 1 : 2);
	return [...agents, ...main].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
}

export async function cardById(id: string): Promise<AgentCard | undefined> {
	if (!ID_RE.test(id)) return undefined;
	const path = cardPath(id);
	try {
		return parseCard(id, await readFile(path, 'utf8'), path);
	} catch {
		return undefined;
	}
}

/** 工具注册表：建一个 dry-run 会话问 SDK 要，别在这里抄一份名单。 */
let registryCache: { at: number; tools: AgentToolInfo[] } | undefined;

export async function toolRegistry(force = false): Promise<AgentToolInfo[]> {
	if (!force && registryCache && Date.now() - registryCache.at < 60_000) return registryCache.tools;
	try {
		const runtime = await getRuntime();
		const model = runtime.getModel(PROVIDER, MODEL_ID);
		if (!model) throw new Error('模型不可用');
		const loader = createSessionLoader({
			cwd: process.cwd(),
			agentDir: AGENT_DIR,
			skillEntries: [],
			skillPaths: [],
			codemode: 'auto',
		});
		await loader.reload();
		const created = await createAgentSession({
			cwd: process.cwd(),
			agentDir: AGENT_DIR,
			modelRuntime: runtime,
			model,
			tools: [...TOOLS, ...PINNED_TOOLS],
			customTools: [],
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(),
		});
		const all: any[] = created.session.getAllTools?.() ?? [];
		created.session.dispose?.();
		const tools = all
			.map((tool) => ({
				name: String(tool.name),
				label: tool.label ? String(tool.label) : undefined,
				description: tool.description ? String(tool.description) : undefined,
			}))
			.sort((a, b) => a.name.localeCompare(b.name));
		registryCache = { at: Date.now(), tools };
		return tools;
	} catch (error) {
		process.stderr.write(
			`[agents] 工具注册表读取失败，退回环境白名单：${error instanceof Error ? error.message : String(error)}\n`,
		);
		const tools = [...new Set([...TOOLS, ...PINNED_TOOLS])]
			.map((name) => ({ name }))
			.sort((a, b) => a.name.localeCompare(b.name));
		registryCache = { at: Date.now(), tools };
		return tools;
	}
}


/** 校验并补全要写盘的值；返回 warnings（不阻断保存，只提示）。 */
async function normalizeForWrite(input: Partial<AgentCard> & { id: string }): Promise<AgentCard> {
	const id = asString(input.id);
	if (!ID_RE.test(id)) throw Object.assign(new Error(`模板 id 不合法：${id || '(空)'}（字母数字开头，最多 64 位）`), { status: 400 });
	if (id === 'main') throw Object.assign(new Error('main 是保留字：主脑只能编辑，不能作为新岗位创建'), { status: 400 });
	const existing = await cardById(id);
	const kind = normalizeKind(input.kind ?? existing?.kind, asString(input.parent) || null);
	if (kind === 'base' && existing) throw Object.assign(new Error('base 是只读原型，不允许保存修改'), { status: 400 });
	const tools = [...new Set(asStringList(input.tools))];
	const warnings: string[] = [];
	const registry = await toolRegistry();
	const known = new Set(registry.map((tool) => tool.name));
	for (const name of tools) {
		if (!known.has(name) && !PINNED_TOOLS.includes(name)) warnings.push(`工具 ${name} 不在 SDK 注册表里，会话里不会出现`);
	}
	const model = asString(input.model) || `${PROVIDER}/${MODEL_ID}`;
	const [provider, ...rest] = model.split('/');
	const runtime = await getRuntime();
	if (!runtime.getModel(provider, rest.join('/'))) warnings.push(`模型 ${model} 当前不可用`);
	return {
		id,
		description: String(input.description ?? existing?.description ?? '').replace(/\s+/g, ' ').trim(),
		kind,
		domain: asString(input.domain) || existing?.domain || 'general',
		appliesTo: asStringList(input.appliesTo),
		tools,
		skills: [...new Set(asStringList(input.skills))],
		model,
		thinking: asString(input.thinking) || 'high',
		parent: asString(input.parent) || null,
		forkedAt: asString(input.forkedAt) || null,
		forkOffset: asNumber(input.forkOffset, 0),
		expiresAt: asString(input.expiresAt) || null,
		external: asBool(input.external),
		maxActive: asNumber(input.maxActive, kind === 'orchestrator' ? 3 : 1),
		status: asString(input.status) || 'active',
		prompt: String(input.prompt ?? existing?.prompt ?? '').trim(),
		path: cardPath(id),
		writable: true,
		warnings,
	};
}

/** 原子写：先写同目录 .tmp 再 rename，避免读到半个 CARD。 */
export async function saveAgent(input: Partial<AgentCard> & { id: string }): Promise<AgentCard> {
	const card = await normalizeForWrite(input);
	await mkdir(card.path.replace(/\/CARD\.md$/, ''), { recursive: true });
	const tmp = `${card.path}.tmp-${process.pid}`;
	await writeFile(tmp, serializeCard(card), 'utf8');
	await rename(tmp, card.path);
	return card;
}

function slug(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 40);
}

/**
 * fork 一个新岗位。
 *
 * - `base` → `domain`：新岗位，**永不合并回 base**（base 必须保持为空原型）
 * - `domain` / `variant` → `variant`：临时工，可以合并回父模板
 * - `main` 不可 fork（E_MAIN_NOT_FORKABLE），`orchestrator` 也不 fork
 */
export async function forkAgent(id: string, options: { name?: string; domain?: string } = {}): Promise<AgentCard> {
	const parent = await cardById(id);
	if (!parent) throw Object.assign(new Error(`模板不存在：${id}`), { status: 404 });
	if (parent.kind === 'base') {
		// 允许，但目标 kind 是 domain
	} else if (parent.kind === 'orchestrator') {
		throw Object.assign(new Error('主脑（orchestrator）不 fork：要分化就 fork 出一个 agent-<domain>'), { status: 400 });
	}
	const targetKind: AgentKind = parent.kind === 'base' ? 'domain' : 'variant';
	const baseName = slug(options.name || options.domain || parent.domain || parent.id) || 'agent';
	const prefix = baseName.startsWith('agent-') ? '' : 'agent-';
	let candidate = `${prefix}${baseName}`;
	let serial = 2;
	while (await extraIdExists(candidate)) candidate = `${prefix}${baseName}-${serial++}`;

	const card: AgentCard = {
		...parent,
		id: candidate,
		kind: targetKind,
		domain: options.domain ? slug(options.domain) : parent.domain,
		parent: parent.kind === 'base' ? 'base' : parent.id,
		forkedAt: new Date().toISOString(),
		forkOffset: 0,
		// base 的 maxActive=0 是"原型不可激活"，fork 出来的岗位必须能开班。
		maxActive: parent.kind === 'base' ? 1 : parent.maxActive,
		expiresAt: targetKind === 'variant' ? new Date(Date.now() + 24 * 3600 * 1000).toISOString() : null,
		status: 'active',
		path: cardPath(candidate),
		writable: true,
		warnings: [],
	};
	await mkdir(card.path.replace(/\/CARD\.md$/, ''), { recursive: true });
	await writeFile(card.path, serializeCard(card), 'utf8');
	return card;
}

async function extraIdExists(id: string): Promise<boolean> {
	return Boolean(await cardById(id));
}

export interface MergeChange {
	field: 'tools' | 'skills' | 'prompt' | 'model' | 'thinking' | 'description' | 'domain';
	label: string;
	from: string;
	to: string;
}

/** 合并预览：只比配置，不比记忆（岗位记忆还没有存储，别假装能合）。 */
export async function mergeDiff(id: string): Promise<{ parent: AgentCard; child: AgentCard; changes: MergeChange[]; blocked?: string }> {
	const child = await cardById(id);
	if (!child) throw Object.assign(new Error(`模板不存在：${id}`), { status: 404 });
	const parent = child.parent ? await cardById(child.parent) : undefined;
	if (!parent) throw Object.assign(new Error('这个模板没有父模板，无法合并'), { status: 400 });
	if (parent.kind === 'base') {
		return {
			parent,
			child,
			changes: [],
			blocked: 'base 是原型，永不作为合并目标（I14）。想合并请从 domain fork 出 variant。',
		};
	}
	if (child.kind !== 'variant') {
		return { parent, child, changes: [], blocked: '只有 variant（临时工）能合并回父模板；domain 是独立岗位。' };
	}
	const changes: MergeChange[] = [];
	const listDiff = (field: 'tools' | 'skills', label: string, a: string[], b: string[]): MergeChange | undefined => {
		const add = b.filter((item) => !a.includes(item));
		const remove = a.filter((item) => !b.includes(item));
		if (!add.length && !remove.length) return undefined;
		return {
			field,
			label,
			from: a.join(', ') || '(空)',
			to: b.join(', ') || '(空)',
		};
	};
	const tools = listDiff('tools', '工具', parent.tools, child.tools);
	if (tools) changes.push(tools);
	const skills = listDiff('skills', '技能', parent.skills, child.skills);
	if (skills) changes.push(skills);
	if (parent.prompt.trim() !== child.prompt.trim()) {
		changes.push({ field: 'prompt', label: '岗位说明', from: parent.prompt.trim(), to: child.prompt.trim() });
	}
	for (const field of ['model', 'thinking', 'description', 'domain'] as const) {
		if (parent[field] !== child[field]) {
			changes.push({ field, label: field, from: String(parent[field] ?? ''), to: String(child[field] ?? '') });
		}
	}
	return { parent, child, changes };
}

/** 应用选中的字段到父模板；不传 fields = 全并。父模板是 base 时拒绝。 */
export async function mergeApply(id: string, fields?: MergeChange['field'][]): Promise<AgentCard> {
	const { parent, child, changes, blocked } = await mergeDiff(id);
	if (blocked) throw Object.assign(new Error(blocked), { status: 400 });
	const picked = fields?.length ? changes.filter((change) => fields.includes(change.field)) : changes;
	const next = { ...parent };
	for (const change of picked) {
		switch (change.field) {
			case 'tools':
				next.tools = child.tools;
				break;
			case 'skills':
				next.skills = child.skills;
				break;
			case 'prompt':
				next.prompt = child.prompt;
				break;
			case 'model':
				next.model = child.model;
				break;
			case 'thinking':
				next.thinking = child.thinking;
				break;
			case 'description':
				next.description = child.description;
				break;
			case 'domain':
				next.domain = child.domain;
				break;
		}
	}
	return saveAgent(next);
}

const previewCache = new Map<string, AgentPreview>();

function estimate(chars: number): number {
	return Math.ceil(chars / 4);
}

/**
 * 预览：建一个 **dry-run 会话**（in-memory session，不调模型）读真实装载结果。
 *
 * 不用"把提示词再拼一遍"的办法：两份拼装一定会分叉，而分叉的正是这个页面要消除的东西。
 */
export async function previewAgent(input: Partial<AgentCard> & { id: string }): Promise<AgentPreview> {
	const id = asString(input.id) || 'preview';
	const prompt = String(input.prompt ?? '').trim();
	const tools = [...new Set(asStringList(input.tools))];
	const skills = [...new Set(asStringList(input.skills))];
	const codemode = asString((input as any).codemode) === 'on' ? 'on' : 'auto';
	const modelKey = asString(input.model) || `${PROVIDER}/${MODEL_ID}`;
	const key = createHash('sha256')
		.update(JSON.stringify({ prompt, tools, skills, codemode, model: modelKey }))
		.digest('hex');
	const cached = previewCache.get(key);
	if (cached) return cached;

	const runtime = await getRuntime();
	const [provider, ...rest] = modelKey.split('/');
	const model = runtime.getModel(provider, rest.join('/'));
	if (!model) throw Object.assign(new Error(`未知模型：${modelKey}`), { status: 400 });

	const blocks = await blocksForPinned(skills);
	const skillsText = blocks.length ? skillInjectionText(blocks) : '';
	const warnings = skills
		.filter((ref) => !blocks.some((block) => block.id === ref.split('@')[0]))
		.map((ref) => `技能 ${ref} 读不到内容（不存在或 hash 不符），不会注入`);

	let system = '';
	let toolsText = '';
	let perTool: { name: string; tokens: number }[] = [];
	let activeTools: string[] = [];
	let contextWindow = Number(model.contextWindow ?? 0);
	let degraded: string | undefined;
	try {
		const loader = createSessionLoader({
			cwd: process.cwd(),
			agentDir: AGENT_DIR,
			skillEntries: [],
			skillPaths: [],
			appendSystemPrompt: prompt ? [prompt] : [],
			codemode,
		});
		await loader.reload();
		const created = await createAgentSession({
			cwd: process.cwd(),
			agentDir: AGENT_DIR,
			modelRuntime: runtime,
			model,
			// 只读 + 写工具都放进去，再由 active 过滤：预览要能显示"选了但不生效"的工具
			tools: [...new Set([...tools, ...TOOLS, ...PINNED_TOOLS])],
			customTools: [],
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(),
		});
		const session = created.session;
		try {
			session.setActiveToolsByName([...new Set([...tools, ...PINNED_TOOLS])]);
			system = String(session.systemPrompt ?? '');
			activeTools = session.getActiveToolNames?.() ?? [];
			contextWindow = Number(session.model?.contextWindow ?? contextWindow);
			const all: any[] = session.getAllTools?.() ?? [];
			const defs = all
				.filter((tool) => activeTools.includes(tool.name) && !PINNED_TOOLS.includes(tool.name))
				.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));
			toolsText = JSON.stringify(defs, null, 2);
			// 逐工具算 token：工具之间的差异全在 description/parameters 上，均分会把账算错。
			perTool = defs.map((def) => ({ name: def.name, tokens: estimate(JSON.stringify(def, null, 2).length) }));
		} finally {
			session.dispose?.();
		}
	} catch (error) {
		// 装载失败不装作成功：明确告诉页面这次是估算值。
		degraded = `dry-run 会话创建失败，下面是按文本长度估算的结果：${error instanceof Error ? error.message : String(error)}`;
		system = prompt;
		toolsText = JSON.stringify(tools.map((name) => ({ name })), null, 2);
		activeTools = tools;
		perTool = tools.map((name) => ({ name, tokens: estimate(JSON.stringify({ name }).length) }));
	}

	const tokens = {
		system: estimate(system.length),
		tools: estimate(toolsText.length),
		skills: estimate(skillsText.length),
	};
	const preview: AgentPreview = {
		id,
		model: modelKey,
		thinking: asString(input.thinking) || 'high',
		contextWindow,
		system,
		toolsText,
		tools: perTool,
		activeTools,
		pinnedTools: PINNED_TOOLS,
		skills: blocks.map((block) => ({
			id: block.id,
			sha256: block.sha256,
			tokens: estimate(block.text.length),
			text: block.text,
		})),
		skillsText,
		chars: { system: system.length, tools: toolsText.length, skills: skillsText.length },
		tokens: { ...tokens, total: tokens.system + tokens.tools + tokens.skills },
		warnings,
		degraded,
	};
	if (previewCache.size > 16) previewCache.clear();
	previewCache.set(key, preview);
	return preview;
}
