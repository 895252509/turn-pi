/**
 * GitHub 技能市场目录：只做浏览 / 详情 / 安装，不参与会话注入。
 *
 * 数据源是几个公开的 Agent Skills 仓库：
 *   - 目录与 star/fork 来自 GitHub API（GITHUB_TOKEN 从凭据 vault 或环境读取，提高限额）
 *   - SKILL.md 正文来自 raw.githubusercontent.com，跟分支走（内容缓存按 tree sha 判新旧）
 *   - 中文翻译用默认大模型（PI_PROVIDER / PI_MODEL）按需生成并落盘缓存
 */

import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { getRuntime } from './chat.ts';
import { resolveSecret } from './credentials.ts';
import { listSkills, type SkillEntry, type SkillTrust } from './skills.ts';

const RUNTIME_DIR = resolve(process.env.PI_RUNTIME_DIR ?? 'runtime');
const CATALOG_FILE = resolve(process.env.PI_SKILL_MARKET_FILE ?? join(RUNTIME_DIR, 'skill-market.json'));
const TRANSLATION_FILE = resolve(process.env.PI_SKILL_TRANSLATIONS ?? join(RUNTIME_DIR, 'skill-translations.json'));
const CONTENT_FILE = resolve(process.env.PI_SKILL_CONTENT_CACHE ?? join(RUNTIME_DIR, 'skill-market-content.json'));
const CACHE_TTL_MS = 15 * 60 * 1000;
const TRANSLATION_CHUNK = 6000;
const TRANSLATION_LIMIT = 120;
const CONTENT_LIMIT = 200;
const run = promisify(execFile);

export interface MarketSourceConfig {
	id: string;
	repo: string;
	branch: string;
	skillsRoot: string;
	label: string;
	license: string;
	category: string;
	/** 官方已标记弃用的仓库（openai/skills），仅做提示，不阻止浏览/安装。 */
	deprecated?: boolean;
	note?: string;
}

export interface MarketSource {
	id: string;
	repo: string;
	url: string;
	label: string;
	license: string;
	category: string;
	ref: string;
	stars: number;
	forks: number;
	openIssues: number;
	description?: string;
	updatedAt?: string;
	skillCount: number;
	installed: number;
	deprecated?: boolean;
	note?: string;
	error?: string;
}

export interface MarketSkill {
	key: string;
	sourceId: string;
	sourceLabel: string;
	repo: string;
	path: string;
	name: string;
	description: string;
	category: string;
	tags: string[];
	license?: string;
	ref: string;
	/** 目录所在 tree 的 sha：内容缓存的失效键（ref 是分支名时不会随上游变动） */
	tree?: string;
	stars: number;
	forks: number;
	/** 来源仓库官方已弃用 */
	deprecated?: boolean;
	/** 本地已安装份数（当前实现是 0/1，保留数字方便以后接下载统计） */
	installs: number;
	installed: boolean;
	trust?: SkillTrust;
}

export interface MarketCatalog {
	updatedAt: number;
	cached: boolean;
	refreshing: boolean;
	sources: MarketSource[];
	skills: MarketSkill[];
	categories: Array<{ id: string; label: string; count: number }>;
	diagnostics: string[];
}

export interface MarketSkillDetail {
	skill: MarketSkill;
	content: string;
	translation?: string;
	translationError?: string;
	translationModel?: string;
	translationCached?: boolean;
}

export class MarketError extends Error {
	status: number;
	constructor(message: string, status = 400) {
		super(message);
		this.status = status;
	}
}

/** 只收录几个公开、许可清晰的技能库。 */
export const MARKET_SOURCES: MarketSourceConfig[] = [
	{
		id: 'superpowers',
		repo: 'obra/superpowers',
		branch: 'main',
		skillsRoot: 'skills',
		label: 'Superpowers',
		license: 'MIT',
		category: '工程',
	},
	{
		id: 'ok-skills',
		repo: 'mxyhi/ok-skills',
		branch: 'main',
		skillsRoot: '',
		label: 'OK Skills',
		license: 'Apache-2.0',
		category: '工程',
	},
	{
		id: 'gamedev-skills',
		repo: 'gamedev-skills/awesome-gamedev-agent-skills',
		branch: 'main',
		skillsRoot: 'skills',
		label: 'GameDev Skills',
		license: 'Apache-2.0',
		category: '游戏',
	},
	{
		id: 'anthropic-skills',
		repo: 'anthropics/skills',
		branch: 'main',
		skillsRoot: 'skills',
		label: 'Anthropic Skills',
		license: 'Mixed · Apache-2.0 / source-available',
		category: '综合',
		note: 'docx/pdf/pptx/xlsx 为 source-available，不是开源',
	},
	{
		id: 'openai-skills',
		repo: 'openai/skills',
		branch: 'main',
		skillsRoot: 'skills',
		label: 'OpenAI Skills',
		license: 'Per-skill',
		category: '工程',
		deprecated: true,
		note: '官方 README 已标记 deprecated，正在迁往 openai/plugins',
	},
];

interface RawSkill {
	key: string;
	sourceId: string;
	sourceLabel: string;
	repo: string;
	path: string;
	name: string;
	description: string;
	category: string;
	tags: string[];
	license?: string;
	ref: string;
	/** 目录所在 tree 的 sha：内容缓存的失效键 */
	tree?: string;
	stars: number;
	forks: number;
}

interface RawCatalog {
	version: number;
	updatedAt: number;
	sources: MarketSource[];
	skills: RawSkill[];
}

interface TranslationCache {
	version: number;
	entries: Record<string, { at: number; text: string; model: string }>;
}

let memory: RawCatalog | undefined;
let refreshPromise: Promise<RawCatalog> | undefined;
let translationMemory: TranslationCache | undefined;
let contentMemory: { version: number; entries: Record<string, { at: number; content: string }> } | undefined;

function sha256(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

function delay(ms: number): Promise<void> {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/**
 * token 懒读：vault（设置 → 凭据，env 层）优先，其次进程环境。
 * 不能在模块顶层求值——那时 initCredentials() 还没跑，存了凭据也读不到。
 */
async function githubToken(): Promise<string> {
	return (await resolveSecret('GITHUB_TOKEN')) || (await resolveSecret('GH_TOKEN')) || '';
}

function githubHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
	return {
		'user-agent': 'turn-pi-skill-market',
		...(token ? { authorization: `Bearer ${token}` } : {}),
		...extra,
	};
}

/** 403 打穿限额后记住重置时间，期间直接失败：不再空打请求，也不拖慢整页刷新。 */
let rateLimit: { until: number; limit?: number; token: boolean } | undefined;

function rateLimitMessage(state: { until: number; limit?: number }): string {
	const when = new Date(state.until).toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
	const quota = state.limit ? `${state.limit} 次/小时` : '60 次/小时';
	return `GitHub API 限额已用尽（${quota}），约 ${when} 恢复；在设置 → 凭据里存 GITHUB_TOKEN 可提到 5000 次/小时。旧目录仍可浏览`;
}

/** GitHub API 无 token 60 次/小时、有 token 5000 次/小时（额度按 token 算）。 */
async function githubJson<T = any>(path: string): Promise<T> {
	const token = await githubToken();
	const state = rateLimit;
	// 窗口内直接失败；但“原来没 token、现在补上了”要立刻放行（额度换了新的计数器）。
	if (state && Date.now() < state.until && !(token && !state.token)) throw new Error(rateLimitMessage(state));
	rateLimit = undefined;
	const response = await fetch(`https://api.github.com${path}`, {
		headers: githubHeaders(token, { accept: 'application/vnd.github+json' }),
		signal: AbortSignal.timeout(20_000),
	});
	if (!response.ok) {
		const remaining = response.headers.get('x-ratelimit-remaining');
		if ((response.status === 403 || response.status === 429) && remaining === '0') {
			const resetAt = Number(response.headers.get('x-ratelimit-reset')) * 1000;
			rateLimit = {
				until: resetAt > Date.now() ? resetAt : Date.now() + 5 * 60_000,
				limit: Number(response.headers.get('x-ratelimit-limit')) || undefined,
				token: Boolean(token),
			};
			throw new Error(rateLimitMessage(rateLimit));
		}
		const text = await response.text().catch(() => '');
		throw new Error(`GitHub ${response.status}${text ? `：${text.slice(0, 160)}` : ''}`);
	}
	return response.json() as Promise<T>;
}

function skillMarkdownUrls(repo: string, ref: string, directory: string): { raw: string; cdn: string; apiPath: string } {
	// 目录 → 具体文件：市场目录保存的是技能目录，不是 SKILL.md 的完整路径。
	const path = `${directory.replace(/\/+$/, '')}/SKILL.md`;
	const encoded = path.split('/').map((part) => encodeURIComponent(part)).join('/');
	return {
		raw: `https://raw.githubusercontent.com/${repo}/${ref}/${encoded}`,
		cdn: `https://cdn.jsdelivr.net/gh/${repo}@${ref}/${encoded}`,
		apiPath: `/repos/${repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`,
	};
}

async function fetchText(url: string, headers: Record<string, string> = {}): Promise<string> {
	const response = await fetch(url, {
		headers: { 'user-agent': 'turn-pi-skill-market', ...headers },
		signal: AbortSignal.timeout(15_000),
	});
	if (!response.ok) throw new Error(`${new URL(url).host} ${response.status}`);
	return response.text();
}

/**
 * raw.githubusercontent.com 的 IP 轮询在部分网络下会连到不可达地址。
 * 同时竞速 raw 与 jsDelivr；详情/翻译再兜底 GitHub Contents API（只用于单文件，避免目录刷新耗尽限额）。
 */
async function curlText(url: string): Promise<string> {
	const { stdout } = await run('curl', [
		'-fsSL',
		'--max-time', '30',
		'--retry', '1',
		'-A', 'turn-pi-skill-market',
		url,
	], { maxBuffer: 8 * 1024 * 1024, timeout: 35_000 });
	return stdout;
}

async function fetchSkillMarkdown(repo: string, ref: string, path: string, allowApiFallback = false): Promise<string> {
	const urls = skillMarkdownUrls(repo, ref, path);
	try {
		return await Promise.any([fetchText(urls.raw), fetchText(urls.cdn)]);
	} catch (error) {
		if (!allowApiFallback) {
			throw error instanceof AggregateError && error.errors.length
				? error.errors[error.errors.length - 1]
				: error;
		}
	}
	// Node 的 fetch 在该网络下偶尔只连 raw 的一个不可达 IP；curl 会自行换 IP。
	// 只给详情/翻译做兜底，目录里 191 个文件不能每个都 spawn curl。
	for (const url of [urls.raw, urls.cdn]) {
		try {
			return await curlText(url);
		} catch {
			/* 试下一个 */
		}
	}
	try {
		const headers = githubHeaders(await githubToken(), { accept: 'application/vnd.github.raw' });
		return await fetchText(`https://api.github.com${urls.apiPath}`, headers);
	} catch (error) {
		throw new Error(`GitHub 原文读取失败：${error instanceof Error ? error.message : String(error)}`);
	}
}

/** 只解析市场卡片需要的 frontmatter，支持 `>-` 折叠描述。 */
function parseSkillFrontmatter(text: string): { name?: string; description?: string; license?: string; disableModelInvocation?: boolean } {
	const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	if (!match) return {};
	const lines = match[1].replace(/\r\n/g, '\n').split('\n');
	const out: { name?: string; description?: string; license?: string; disableModelInvocation?: boolean } = {};
	const unquote = (value: string) => value.trim().replace(/^(['"])(.*)\1$/, '$2');
	for (let i = 0; i < lines.length; i++) {
		const pair = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (!pair) continue;
		const key = pair[1].toLowerCase();
		let value = unquote(pair[2]);
		if (/^[>|][+-]?$/.test(value)) {
			const block: string[] = [];
			while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) {
				block.push(lines[i + 1].trim());
				i += 1;
			}
			value = block.join(' ');
		}
		if (key === 'name') out.name = value;
		else if (key === 'description') out.description = value;
		else if (key === 'license') out.license = value;
		else if (key === 'disable-model-invocation') out.disableModelInvocation = /^(true|yes|1)$/i.test(value);
	}
	return out;
}

function normalizeLicense(value: string | undefined, fallback: string): string {
	const text = String(value ?? '').trim();
	if (!text) return fallback;
	if (/proprietary/i.test(text)) return 'Proprietary · source-available';
	if (/^(apache|mit|bsd|isc|mpl|gpl|lgpl|unlicense)/i.test(text)) return text;
	if (/complete terms|license\.txt/i.test(text)) return fallback;
	return text;
}

const DESIGN = new Set(['codebase-design', 'improve-codebase-architecture', 'domain-modeling', 'prototype', 'product-decision-agent', 'reverse-engineer-anything', 'huashu-design', 'ai-elements', 'better-icons', 'frontend-design', 'imagegen-frontend-web', 'canvas-design', 'algorithmic-art', 'theme-factory', 'web-artifacts-builder', 'slack-gif-creator']);
const RESEARCH = new Set(['find-docs', 'deep-research', 'autoresearch', 'exa-search', 'get-api-docs', 'find-skills', 'teach', 'planning-with-files']);
const QUALITY = new Set(['tdd', 'diagnosing-bugs', 'grilling', 'karpathy-guidelines', 'browser-trace', 'verification-before-completion', 'systematic-debugging', 'test-driven-development', 'requesting-code-review', 'receiving-code-review']);
const DOCUMENT = new Set(['docx', 'pdf', 'pptx', 'xlsx']);
const WRITING = new Set(['academy-guide', 'internal-comms', 'doc-coauthoring', 'brand-guidelines', 'discernment-nudge']);
const DEV = new Set(['claude-api', 'mcp-builder', 'skill-creator', 'webapp-testing']);

function categoryFor(config: MarketSourceConfig, path: string): string {
	const parts = path.split('/').filter(Boolean);
	const top = parts[0] ?? '';
	const leaf = parts[parts.length - 1] ?? '';
	if (config.id === 'superpowers') {
		if (QUALITY.has(leaf)) return '质量 / 调试';
		return config.category;
	}
	if (config.id === 'ok-skills') {
		if (RESEARCH.has(top)) return '研究 / 检索';
		if (DESIGN.has(top)) return '架构 / 设计';
		if (QUALITY.has(top)) return '质量 / 调试';
		return config.category;
	}
	if (config.id === 'gamedev-skills') {
		if (path.includes('/workflows/')) return '游戏工作流';
		if (path.includes('/genres/')) return '游戏设计';
		if (path.includes('/disciplines/')) return '游戏设计';
		if (path.includes('/web-engines/')) return 'Web 引擎';
		if (path.includes('/godot/') || path.includes('/unity/') || path.includes('/unreal/') || path.includes('/ebitengine/')) return '游戏引擎';
		return config.category;
	}
	if (config.id === 'anthropic-skills') {
		if (DOCUMENT.has(leaf)) return '办公 / 文档';
		if (DESIGN.has(leaf)) return '设计 / 创意';
		if (WRITING.has(leaf)) return '写作 / 沟通';
		if (DEV.has(leaf)) return '工程';
		return config.category;
	}
	if (config.id === 'openai-skills') {
		if (/review|test|debug/i.test(leaf)) return '质量 / 调试';
		if (/doc|write|blog/i.test(leaf)) return '写作 / 文档';
		return config.category;
	}
	return config.category;
}

function tagsFor(config: MarketSourceConfig, path: string): string[] {
	const parts = path.split('/').filter(Boolean);
	const tags = new Set<string>();
	tags.add(config.label);
	for (const part of parts) {
		if (part === config.skillsRoot || part === 'SKILL.md') continue;
		tags.add(part.replace(/[-_]+/g, ' '));
	}
	return [...tags].slice(0, 6);
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await fn(items[index], index);
		}
	});
	await Promise.all(workers);
	return results;
}

interface RepoInfo {
	stars: number;
	forks: number;
	openIssues: number;
	description?: string;
	updatedAt?: string;
	ref: string;
}

async function repoInfo(config: MarketSourceConfig): Promise<RepoInfo> {
	// 不再单独查 /commits：分支名可以直接喂给 /git/trees，每个来源从 3 次调用降到 2 次。
	// 代价是 raw URL 跟分支走而不是钉在 commit 上，内容缓存的失效交给 tree sha（见 refreshSource）。
	const repo = await githubJson<any>(`/repos/${config.repo}`);
	return {
		stars: Number(repo.stargazers_count) || 0,
		forks: Number(repo.forks_count) || 0,
		openIssues: Number(repo.open_issues_count) || 0,
		description: typeof repo.description === 'string' ? repo.description : undefined,
		updatedAt: typeof repo.pushed_at === 'string' ? repo.pushed_at : undefined,
		ref: config.branch,
	};
}

async function refreshSource(config: MarketSourceConfig, previous?: { source?: MarketSource; skills: RawSkill[] }): Promise<{ source: MarketSource; skills: RawSkill[]; diagnostics: string[] }> {
	const diagnostics: string[] = [];
	try {
		const info = await repoInfo(config);
		if (!info.ref) throw new Error('来源没有配置分支');
		const tree = await githubJson<any>(`/repos/${config.repo}/git/trees/${encodeURIComponent(info.ref)}?recursive=1`);
		// tree sha 覆盖整棵子树：任何文件变动都会换值，用它当内容缓存的失效键。
		const treeRef = String(tree.sha ?? '');
		const rootPrefix = config.skillsRoot ? `${config.skillsRoot.replace(/^\/+|\/+$/g, '')}/` : '';
		const paths = (tree.tree ?? [])
			.filter((item: any) => item?.type === 'blob' && typeof item.path === 'string' && item.path.endsWith('/SKILL.md'))
			.map((item: any) => String(item.path))
			.filter((path: string) => !rootPrefix || path.startsWith(rootPrefix))
			.map((path: string) => path.slice(0, -'/SKILL.md'.length))
			.filter((path: string) => Boolean(path));
		if (tree.truncated) diagnostics.push(`${config.label} 的 GitHub tree 被截断，技能列表可能不完整`);
		const skills = await mapLimit(paths, 8, async (path) => {
			const key = `${config.id}:${path}`;
			const fallbackName = path.split('/').pop() ?? path;
			try {
				const text = await fetchSkillMarkdown(config.repo, info.ref, path);
				const meta = parseSkillFrontmatter(text);
				return {
					key,
					sourceId: config.id,
					sourceLabel: config.label,
					repo: config.repo,
					path,
					name: meta.name || fallbackName,
					description: meta.description || '',
					category: categoryFor(config, path),
					tags: tagsFor(config, path),
					license: normalizeLicense(meta.license, config.license),
					ref: info.ref,
					tree: treeRef || undefined,
					stars: info.stars,
					forks: info.forks,
				} satisfies RawSkill;
			} catch (error) {
				diagnostics.push(`${config.label}/${path} 读取失败：${error instanceof Error ? error.message : String(error)}`);
				return {
					key,
					sourceId: config.id,
					sourceLabel: config.label,
					repo: config.repo,
					path,
					name: fallbackName,
					description: '',
					category: categoryFor(config, path),
					tags: tagsFor(config, path),
					license: config.license,
					ref: info.ref,
					tree: treeRef || undefined,
					stars: info.stars,
					forks: info.forks,
				} satisfies RawSkill;
			}
		});
		const source: MarketSource = {
			id: config.id,
			repo: config.repo,
			url: `https://github.com/${config.repo}`,
			label: config.label,
			license: config.license,
			category: config.category,
			ref: info.ref,
			stars: info.stars,
			forks: info.forks,
			openIssues: info.openIssues,
			description: info.description,
			updatedAt: info.updatedAt,
			skillCount: skills.length,
			installed: 0,
			deprecated: config.deprecated,
			note: config.note,
		};
		return { source, skills, diagnostics };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		diagnostics.push(`${config.label} 刷新失败：${message}`);
		if (previous?.source) {
			return { source: { ...previous.source, error: message }, skills: previous.skills, diagnostics };
		}
		return {
			source: {
				id: config.id,
				repo: config.repo,
				url: `https://github.com/${config.repo}`,
				label: config.label,
				license: config.license,
				category: config.category,
				ref: '',
				stars: 0,
				forks: 0,
				openIssues: 0,
				skillCount: 0,
				installed: 0,
				deprecated: config.deprecated,
				note: config.note,
				error: message,
			},
			skills: [],
			diagnostics,
		};
	}
}

async function readCatalogFile(): Promise<RawCatalog | undefined> {
	try {
		const raw = JSON.parse(await readFile(CATALOG_FILE, 'utf8'));
		if (!raw || !Array.isArray(raw.sources) || !Array.isArray(raw.skills)) return undefined;
		return {
			version: 1,
			updatedAt: Number(raw.updatedAt) || 0,
			sources: raw.sources,
			skills: raw.skills,
		};
	} catch {
		return undefined;
	}
}

async function writeCatalogFile(catalog: RawCatalog): Promise<void> {
	await mkdir(dirname(CATALOG_FILE), { recursive: true });
	const tmp = `${CATALOG_FILE}.${randomBytes(6).toString('hex')}.tmp`;
	await writeFile(tmp, JSON.stringify({ ...catalog, version: 1 }, null, 2) + '\n', { mode: 0o600 });
	await rename(tmp, CATALOG_FILE);
}

async function refreshCatalog(previous?: RawCatalog): Promise<RawCatalog> {
	const diagnostics: string[] = [];
	const sources: MarketSource[] = [];
	const skills: RawSkill[] = [];
	const results = await mapLimit(MARKET_SOURCES, 3, (config) => {
		const prior = previous
			? { source: previous.sources.find((item) => item.id === config.id), skills: previous.skills.filter((item) => item.sourceId === config.id) }
			: undefined;
		return refreshSource(config, prior);
	});
	for (const result of results) {
		sources.push(result.source);
		skills.push(...result.skills);
		diagnostics.push(...result.diagnostics);
	}
	if (diagnostics.length) {
		for (const message of diagnostics) process.stderr.write(`[skill-market] ${message}\n`);
	}
	const catalog: RawCatalog = { version: 1, updatedAt: Date.now(), sources, skills };
	memory = catalog;
	await writeCatalogFile(catalog).catch(() => {});
	return catalog;
}

async function rawCatalog(): Promise<RawCatalog> {
	if (memory) return memory;
	memory = await readCatalogFile();
	if (memory) return memory;
	if (refreshPromise) return refreshPromise;
	refreshPromise = refreshCatalog().finally(() => {
		refreshPromise = undefined;
	});
	return refreshPromise;
}

function installedIndex(entries: SkillEntry[]) {
	const byKey = new Map<string, { count: number; trust?: SkillTrust }>();
	for (const entry of entries) {
		if (entry.source.kind !== 'market') continue;
		const url = entry.source.url ?? entry.source.id;
		const key = `${url}|${entry.name}`;
		const prior = byKey.get(key);
		byKey.set(key, { count: (prior?.count ?? 0) + 1, trust: entry.trust });
	}
	return byKey;
}

/** 目录读取：无缓存时同步拉取；有缓存时过期就后台刷新、先返回旧数据。 */
export async function getMarketCatalog(options: { refresh?: boolean } = {}): Promise<MarketCatalog> {
	const index = await listSkills();
	const lookup = installedIndex(index.entries);
	const before = memory;
	const raw = await rawCatalog();
	const stale = Date.now() - raw.updatedAt > CACHE_TTL_MS;
	if (options.refresh || stale) {
		if (!refreshPromise) {
			refreshPromise = refreshCatalog(raw).finally(() => {
				refreshPromise = undefined;
			});
		}
		if (options.refresh || !before) {
			await refreshPromise;
		}
	}
	const current = memory ?? raw;
	const sources = current.sources.map((source) => {
		const repoUrl = `https://github.com/${source.repo}.git`;
		const count = current.skills
			.filter((skill) => skill.sourceId === source.id)
			.reduce((sum, skill) => sum + (lookup.get(`${repoUrl}|${skill.name}`)?.count ?? 0), 0);
		return { ...source, installed: count };
	});
	const deprecatedBySource = new Map(current.sources.map((source) => [source.id, Boolean(source.deprecated)]));
	const skills: MarketSkill[] = current.skills.map((skill) => {
		const repoUrl = `https://github.com/${skill.repo}.git`;
		const hit = lookup.get(`${repoUrl}|${skill.name}`);
		return {
			...skill,
			deprecated: deprecatedBySource.get(skill.sourceId),
			installs: hit?.count ?? 0,
			installed: Boolean(hit?.count),
			trust: hit?.trust,
		};
	});
	const counts = new Map<string, number>();
	for (const skill of skills) counts.set(skill.category, (counts.get(skill.category) ?? 0) + 1);
	const categories = [...counts.entries()].map(([label, count]) => ({ id: label, label, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
	return {
		updatedAt: current.updatedAt,
		cached: Boolean(before),
		refreshing: Boolean(refreshPromise) && !options.refresh,
		sources,
		skills,
		categories,
		diagnostics: current.sources.filter((source) => source.error).map((source) => `${source.label}：${source.error}`),
	};
}

async function contentCache(): Promise<{ version: number; entries: Record<string, { at: number; content: string }> }> {
	if (contentMemory) return contentMemory;
	try {
		const raw = JSON.parse(await readFile(CONTENT_FILE, 'utf8'));
		contentMemory = raw && typeof raw.entries === 'object'
			? { version: 1, entries: raw.entries }
			: { version: 1, entries: {} };
	} catch {
		contentMemory = { version: 1, entries: {} };
	}
	return contentMemory;
}

async function writeContentCache(cache: { version: number; entries: Record<string, { at: number; content: string }> }): Promise<void> {
	const entries = Object.entries(cache.entries)
		.sort((a, b) => b[1].at - a[1].at)
		.slice(0, CONTENT_LIMIT);
	contentMemory = { version: 1, entries: Object.fromEntries(entries) };
	await mkdir(dirname(CONTENT_FILE), { recursive: true });
	const tmp = `${CONTENT_FILE}.${randomBytes(6).toString('hex')}.tmp`;
	await writeFile(tmp, JSON.stringify(contentMemory, null, 2) + '\n', { mode: 0o600 });
	await rename(tmp, CONTENT_FILE).catch(() => {});
}

export async function getMarketSkill(sourceId: string, path: string): Promise<{ skill: MarketSkill; content: string }> {
	const catalog = await getMarketCatalog();
	const skill = catalog.skills.find((item) => item.sourceId === sourceId && item.path === path);
	if (!skill) throw new MarketError('技能不存在，先刷新市场目录', 404);
	const cache = await contentCache();
	const key = `${sourceId}:${path}:${skill.tree ?? skill.ref}`;
	const hit = cache.entries[key];
	if (hit?.content) return { skill, content: hit.content };
	const content = await fetchSkillMarkdown(skill.repo, skill.ref, skill.path, true);
	cache.entries[key] = { at: Date.now(), content };
	await writeContentCache(cache).catch(() => {});
	return { skill, content };
}

function readTranslationCacheFile(): Promise<TranslationCache | undefined> {
	return readFile(TRANSLATION_FILE, 'utf8')
		.then((text) => {
			const raw = JSON.parse(text);
			return raw && typeof raw === 'object'
				? { version: 1, entries: raw.entries && typeof raw.entries === 'object' ? raw.entries : {} }
				: undefined;
		})
		.catch(() => undefined);
}

async function translationCache(): Promise<TranslationCache> {
	if (translationMemory) return translationMemory;
	translationMemory = (await readTranslationCacheFile()) ?? { version: 1, entries: {} };
	return translationMemory;
}

async function writeTranslationCache(cache: TranslationCache): Promise<void> {
	const entries = Object.entries(cache.entries)
		.sort((a, b) => b[1].at - a[1].at)
		.slice(0, TRANSLATION_LIMIT);
	translationMemory = { version: 1, entries: Object.fromEntries(entries) };
	await mkdir(dirname(TRANSLATION_FILE), { recursive: true });
	const tmp = `${TRANSLATION_FILE}.${randomBytes(6).toString('hex')}.tmp`;
	await writeFile(tmp, JSON.stringify(translationMemory, null, 2) + '\n', { mode: 0o600 });
	await rename(tmp, TRANSLATION_FILE);
}

function chunkMarkdown(text: string, max = TRANSLATION_CHUNK): string[] {
	const paragraphs = text.replace(/\r\n/g, '\n').split(/\n{2,}/);
	const chunks: string[] = [];
	let current = '';
	const push = () => {
		if (current.trim()) chunks.push(current.trim());
		current = '';
	};
	for (const paragraph of paragraphs) {
		if (paragraph.length > max) {
			push();
			for (let i = 0; i < paragraph.length; i += max) chunks.push(paragraph.slice(i, i + max));
			continue;
		}
		if (current.length + paragraph.length + 2 > max) push();
		current += (current ? '\n\n' : '') + paragraph;
	}
	push();
	return chunks.length ? chunks : [text];
}

async function translationModel(): Promise<{ runtime: any; model: any; label: string }> {
	const runtime = await getRuntime();
	const provider = process.env.PI_PROVIDER ?? 'opencode-go';
	const id = process.env.PI_MODEL ?? 'deepseek-v4.1-flash';
	let model = runtime.getModel(provider, id);
	if (!model) {
		const available = await runtime.getAvailable();
		model = available[0];
	}
	if (!model) throw new MarketError('没有可用模型，先在设置里配置供应商', 503);
	return { runtime, model, label: `${model.provider}/${model.id}` };
}

function assistantText(message: any): string {
	if (message?.stopReason === 'error') throw new Error(message.errorMessage || '模型翻译失败');
	return (Array.isArray(message?.content) ? message.content : [])
		.filter((block: any) => block?.type === 'text')
		.map((block: any) => String(block.text ?? ''))
		.join('')
		.trim();
}

async function translateBody(body: string, label: string): Promise<{ text: string; model: string }> {
	const { runtime, model, label: modelLabel } = await translationModel();
	const chunks = chunkMarkdown(body);
	const translated: string[] = [];
	for (const chunk of chunks) {
		const prompt = [
			'把下面的 Agent Skill 文档翻译成简体中文。',
			'要求：保留 Markdown 结构；代码块、命令、路径、URL、frontmatter 字段名、技能名不要翻译；',
			'只输出译文，不要解释，不要加“以下是翻译”之类的前缀。',
			'',
			`文件：${label}`,
			'---',
			chunk,
		].join('\n');
		let text = '';
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				const message = await runtime.completeSimple(
					model,
					{ messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }] },
					{ signal: AbortSignal.timeout(120_000), sessionId: `pi-skill-market-${randomBytes(8).toString('hex')}` },
				);
				text = assistantText(message);
				if (text) break;
			} catch (error) {
				if (attempt === 2) throw error;
				await delay(1200 * (attempt + 1));
			}
		}
		if (!text) throw new Error('模型返回了空翻译');
		translated.push(text);
	}
	return { text: translated.join('\n\n'), model: modelLabel };
}

function splitFrontmatter(text: string): { frontmatter: string; body: string } {
	const match = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
	if (!match) return { frontmatter: '', body: text };
	return { frontmatter: match[0], body: text.slice(match[0].length) };
}

/** 中文对照：按 SKILL.md 内容 hash 缓存，重复打开不再重复消耗 token。 */
export async function translateMarketSkill(sourceId: string, path: string): Promise<{ translation: string; cached: boolean; model: string }> {
	const cache = await translationCache();
	const prefix = `${sourceId}:${path}:`;
	// 先看缓存：网络抖动时，已经翻译过的内容不该因为拉不到原文而失败。
	const prior = Object.entries(cache.entries)
		.filter(([key]) => key.startsWith(prefix))
		.sort((a, b) => b[1].at - a[1].at)[0];
	if (prior?.[1]?.text) return { translation: prior[1].text, cached: true, model: prior[1].model };
	const { skill, content } = await getMarketSkill(sourceId, path);
	const split = splitFrontmatter(content);
	const hash = sha256(content).slice(0, 16);
	const key = `${prefix}${hash}`;
	const hit = cache.entries[key];
	if (hit?.text) return { translation: hit.text, cached: true, model: hit.model };
	const result = await translateBody(split.body || content, `${skill.sourceLabel}/${skill.name}`);
	cache.entries[key] = { at: Date.now(), text: result.text, model: result.model };
	await writeTranslationCache(cache).catch(() => {});
	return { translation: result.text, cached: false, model: result.model };
}
