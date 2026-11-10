/**
 * 技能库：内容寻址 store + 索引 + 组合（见 docs/skills-integration.md）。
 *
 * 四条规则：
 *   - 打包看内容寻址：runtime/skillstore/<kind>/<name>/<sha12>/
 *   - 生效看组合列表：selection.refs 是有序引用，顺序就是优先级
 *   - 收权看 override：unreviewed 只翻转 disableModelInvocation，不进 prompt 但仍可手动调用
 *   - 升级看 reload：换组合只改 loader.additionalSkillPaths + session.reload()
 *
 * 这里只负责磁盘和纯函数；拆包 / HTTP / session.reload 分别在 install 与 server/chat.ts 里。
 * store 绝不能落在自动发现目录（~/.pi/agent/skills、<ws>/.pi/skills、.agents/skills），
 * 否则所有会话会立刻全量可见，模板组合失效。
 */

import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { listWorkspaces } from './workspaces.ts';

const run = promisify(execFile);

const RUNTIME_DIR = resolve(process.env.PI_RUNTIME_DIR ?? 'runtime');
export const SKILL_STORE = resolve(process.env.PI_SKILL_STORE ?? join(RUNTIME_DIR, 'skillstore'));
const INDEX_FILE = resolve(process.env.PI_SKILLS_FILE ?? join(RUNTIME_DIR, 'skills.json'));
const HOME = process.env.HOME ?? '/root';
const DEFAULT_DISCOVERY_DIRS = [
	join(HOME, '.pi', 'agent', 'skills'),
	join(HOME, '.agents', 'skills'),
	resolve(process.env.PI_WORKSPACE ?? '/workspace', '.pi', 'skills'),
	resolve(process.env.PI_WORKSPACE ?? '/workspace', '.agents', 'skills'),
];

const MAX_SKILLS_DEFAULT = 30;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const SCRIPT_EXT = new Set(['.sh', '.bash', '.zsh', '.py', '.js', '.mjs', '.cjs', '.ts']);

export type SkillTrust = 'audited' | 'unreviewed' | 'blocked';

export type SkillSource =
	| { kind: 'market'; id: string; url?: string; package?: string; ref?: string; subdir?: string; subdirs?: string[] }
	| { kind: 'local'; path: string }
	| { kind: 'package'; package: string };

export interface SkillSpecFields {
	description?: string;
	license?: string;
	compatibility?: string;
	allowedTools?: string[];
	disableModelInvocation?: boolean;
}

export interface SkillAudit {
	by: string;
	at: number;
	treeHash: string;
	note?: string;
}

export interface SkillEntry {
	name: string;
	source: SkillSource;
	treeHash: string;
	dir: string;
	trust: SkillTrust;
	hasScripts: boolean;
	specFields: SkillSpecFields;
	installedAt: number;
	installedBy: string;
	bytes: number;
	/** 本地来源需要每次 resolve 现算；缺失时保留索引，UI 标灰。 */
	available?: boolean;
	audits?: SkillAudit[];
	warnings?: string[];
}

export interface SkillSelection {
	mode: 'only' | 'add';
	/** 有序引用：`name` 或 `name@sha256:<full-or-prefix>` */
	refs: string[];
	policy: {
		onConflict: 'template-order' | 'error' | 'last-wins';
		maxSkills: number;
		unreviewed: 'manual-only' | 'prompt';
	};
	updatedAt: number;
	updatedBy: string;
}

interface SkillIndex {
	version: number;
	updatedAt: number;
	entries: SkillEntry[];
	selection: SkillSelection;
}

export interface SkillConflict {
	name: string;
	kept: string;
	dropped: string;
	reason: 'duplicate-name' | 'missing' | 'blocked' | 'over-cap';
}

export interface SkillCompositionItem {
	ref: string;
	name: string;
	treeHash: string;
	source: SkillSource;
	trust: SkillTrust;
	dir: string;
	hasScripts: boolean;
	inPrompt: boolean;
	specFields: SkillSpecFields;
}

export interface SkillComposition {
	skills: SkillCompositionItem[];
	conflicts: SkillConflict[];
	warnings: string[];
	tokens: number;
	maxSkills: number;
	mode: SkillSelection['mode'];
}

export interface SkillSnapshot {
	store: string;
	indexFile: string;
	updatedAt: number;
	entries: SkillEntry[];
	selection: SkillSelection;
	composition: SkillComposition;
	diagnostics: string[];
}

export class SkillError extends Error {
	status: number;
	constructor(message: string, status = 400) {
		super(message);
		this.status = status;
	}
}

function sha256(value: string | Buffer): string {
	return createHash('sha256').update(value).digest('hex');
}

function isWithin(path: string, root: string): boolean {
	return path === root || path.startsWith(root + sep);
}

function safeName(value: string): string {
	const name = value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return name || 'skill';
}

function safeSegment(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'source';
}

/** 启动自检：store 一旦落进自动发现目录，模板组合立刻破功。 */
function assertStoreLocation(): void {
	const store = resolve(SKILL_STORE);
	for (const dir of DEFAULT_DISCOVERY_DIRS) {
		const root = resolve(dir);
		if (isWithin(store, root) || isWithin(root, store)) {
			throw new Error(`skill store 不能放在自动发现目录内：${store} ↔ ${root}`);
		}
	}
}

assertStoreLocation();

function defaultSelection(): SkillSelection {
	return {
		mode: 'only',
		refs: [],
		policy: { onConflict: 'template-order', maxSkills: MAX_SKILLS_DEFAULT, unreviewed: 'manual-only' },
		updatedAt: 0,
		updatedBy: 'owner',
	};
}

function normalizeSelection(raw: any): SkillSelection {
	const base = defaultSelection();
	if (!raw || typeof raw !== 'object') return base;
	const refs = Array.isArray(raw.refs)
		? raw.refs.filter((ref: unknown): ref is string => typeof ref === 'string' && Boolean(ref.trim())).map((ref: string) => ref.trim())
		: [];
	const mode = raw.mode === 'add' ? 'add' : 'only';
	const policy = raw.policy && typeof raw.policy === 'object' ? raw.policy : {};
	const onConflict = ['template-order', 'error', 'last-wins'].includes(policy.onConflict)
		? policy.onConflict
		: base.policy.onConflict;
	const unreviewed = policy.unreviewed === 'prompt' ? 'prompt' : 'manual-only';
	const maxSkills = Math.max(1, Math.min(200, Number(policy.maxSkills) || base.policy.maxSkills));
	return {
		mode,
		refs: [...new Set(refs)],
		policy: { onConflict, maxSkills, unreviewed },
		updatedAt: Number(raw.updatedAt) || 0,
		updatedBy: typeof raw.updatedBy === 'string' ? raw.updatedBy : 'owner',
	};
}

function normalizeEntry(raw: any): SkillEntry | null {
	if (!raw || typeof raw !== 'object') return null;
	const name = String(raw.name ?? '').trim();
	const dir = typeof raw.dir === 'string' ? resolve(raw.dir) : '';
	const treeHash = String(raw.treeHash ?? '').trim();
	const kind = raw.source?.kind;
	if (!name || !dir || !treeHash) return null;
	if (!['market', 'local', 'package'].includes(kind)) return null;
	return {
		name,
		source: raw.source,
		treeHash,
		dir,
		trust: raw.trust === 'audited' || raw.trust === 'blocked' ? raw.trust : 'unreviewed',
		hasScripts: Boolean(raw.hasScripts),
		specFields: raw.specFields && typeof raw.specFields === 'object' ? raw.specFields : {},
		installedAt: Number(raw.installedAt) || Date.now(),
		installedBy: typeof raw.installedBy === 'string' ? raw.installedBy : 'owner',
		bytes: Number(raw.bytes) || 0,
		available: raw.available !== false,
		audits: Array.isArray(raw.audits) ? raw.audits.filter((item: any) => item && typeof item === 'object') : undefined,
		warnings: Array.isArray(raw.warnings) ? raw.warnings.filter((item: unknown): item is string => typeof item === 'string') : undefined,
	};
}

/** 串行化索引读改写，避免并发安装互相覆盖。 */
let indexQueue: Promise<unknown> = Promise.resolve();
function withIndexLock<T>(fn: () => Promise<T>): Promise<T> {
	const next = indexQueue.then(fn, fn);
	indexQueue = next.catch(() => undefined);
	return next;
}

async function readIndex(): Promise<SkillIndex> {
	try {
		const raw = JSON.parse(await readFile(INDEX_FILE, 'utf8'));
		return {
			version: 1,
			updatedAt: Number(raw.updatedAt) || 0,
			entries: Array.isArray(raw.entries) ? raw.entries.map(normalizeEntry).filter(Boolean) as SkillEntry[] : [],
			selection: normalizeSelection(raw.selection),
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return { version: 1, updatedAt: 0, entries: [], selection: defaultSelection() };
		}
		throw error;
	}
}

async function writeIndex(index: SkillIndex): Promise<void> {
	await mkdir(dirname(INDEX_FILE), { recursive: true });
	const payload = JSON.stringify({ ...index, version: 1 }, null, 2) + '\n';
	const tmp = `${INDEX_FILE}.${randomBytes(6).toString('hex')}.tmp`;
	await writeFile(tmp, payload, { mode: 0o600 });
	await rename(tmp, INDEX_FILE);
}

function isSkillDir(path: string): boolean {
	return basename(path).toLowerCase() === 'skill.md';
}

/** 目录内的文件清单（相对路径 + 内容 sha256），排除 .git/node_modules。 */
async function walkFiles(root: string, relative = ''): Promise<Array<{ rel: string; size: number; hash: string }>> {
	const dir = join(root, relative);
	const entries = await readdir(dir, { withFileTypes: true });
	const files: Array<{ rel: string; size: number; hash: string }> = [];
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (entry.name === '.git' || entry.name === 'node_modules') continue;
		const rel = relative ? join(relative, entry.name) : entry.name;
		const full = join(root, rel);
		if (entry.isDirectory()) {
			files.push(...await walkFiles(root, rel));
			continue;
		}
		if (!entry.isFile()) continue;
		const content = await readFile(full);
		files.push({ rel: rel.split(sep).join('/'), size: content.length, hash: sha256(content) });
	}
	return files;
}

/** treeHash 覆盖整个目录，而不只是 SKILL.md：脚本被换也要能被审计发现。 */
async function hashTree(root: string): Promise<{ treeHash: string; bytes: number; files: Array<{ rel: string; size: number; hash: string }> }> {
	const files = await walkFiles(root);
	const bytes = files.reduce((sum, file) => sum + file.size, 0);
	const treeHash = sha256(files.map((file) => `${file.rel}\0${file.hash}\n`).join(''));
	return { treeHash, bytes, files };
}

interface Frontmatter {
	name?: string;
	fields: SkillSpecFields;
	body: string;
	raw: string;
}

/** 只解析 skill 规范用到的字段；不做完整 YAML，避免为了几个键引入依赖。 */
function parseFrontmatter(text: string): Frontmatter {
	const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	if (!match) return { fields: {}, body: text, raw: '' };
	const raw = match[1];
	const fields: SkillSpecFields = {};
	let name: string | undefined;
	const lines = raw.split(/\r?\n/);
	let current: string | undefined;
	const list: string[] = [];
	const flush = () => {
		if (current === 'allowed-tools' || current === 'allowed_tools') fields.allowedTools = [...list];
		current = undefined;
		list.length = 0;
	};
	const unquote = (value: string) => value.trim().replace(/^(['"])(.*)\1$/, '$2');
	for (const line of lines) {
		const item = line.match(/^\s*-\s+(.+)$/);
		if (item && current) {
			list.push(unquote(item[1]));
			continue;
		}
		const pair = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (!pair) continue;
		flush();
		const key = pair[1].toLowerCase();
		const value = unquote(pair[2]);
		if (key === 'name') name = value;
		else if (key === 'description') fields.description = value;
		else if (key === 'license') fields.license = value;
		else if (key === 'compatibility') fields.compatibility = value;
		else if (key === 'allowed-tools' || key === 'allowed_tools') {
			current = key;
			if (value) list.push(value);
		} else if (key === 'disable-model-invocation' || key === 'disable_model_invocation') {
			fields.disableModelInvocation = /^(true|yes|1)$/i.test(value);
		}
	}
	flush();
	return { name, fields, body: text.slice(match[0].length), raw };
}

async function readSkillMeta(dir: string): Promise<{
	name: string;
	specFields: SkillSpecFields;
	hasScripts: boolean;
	warnings: string[];
	treeHash: string;
	bytes: number;
}> {
	const skillFile = join(dir, 'SKILL.md');
	let text: string;
	try {
		text = await readFile(skillFile, 'utf8');
	} catch {
		throw new SkillError(`目录里没有 SKILL.md：${dir}`, 400);
	}
	const parsed = parseFrontmatter(text);
	const frontmatterName = parsed.name;
	const dirName = basename(dir);
	const name = frontmatterName || dirName;
	const warnings: string[] = [];
	if (!parsed.fields.description) warnings.push('frontmatter 缺少 description，模型不知道何时使用它');
	if (frontmatterName && frontmatterName !== dirName) warnings.push(`目录名 ${dirName} 与 frontmatter.name ${frontmatterName} 不一致`);
	const { treeHash, bytes, files } = await hashTree(dir);
	const hasScripts = files.some((file) => {
		const parts = file.rel.split('/');
		return parts.includes('scripts') || SCRIPT_EXT.has(extname(file.rel).toLowerCase());
	});
	return { name, specFields: parsed.fields, hasScripts, warnings, treeHash, bytes };
}

/** 在解包/克隆目录里找 skill 根：一个有 SKILL.md 的目录不再向下递归。 */
async function findSkillDirs(root: string, depth = 0, maxDepth = 3): Promise<string[]> {
	if (depth > maxDepth) return [];
	try {
		const entries = await readdir(root, { withFileTypes: true });
		if (entries.some((entry) => entry.isFile() && isSkillDir(entry.name))) return [root];
		const found: string[] = [];
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name === '.git' || entry.name === 'node_modules') continue;
			found.push(...await findSkillDirs(join(root, entry.name), depth + 1, maxDepth));
		}
		return found;
	} catch {
		return [];
	}
}

async function copyIntoStore(sourceDir: string, sourceKind: SkillSource['kind'], name: string): Promise<{ dir: string; treeHash: string; bytes: number }> {
	const { treeHash } = await hashTree(sourceDir);
	const dir = join(SKILL_STORE, sourceKind, safeName(name), treeHash.slice(0, 12));
	if (await stat(dir).then((info) => info.isDirectory()).catch(() => false)) {
		return { dir, treeHash, bytes: (await hashTree(dir)).bytes };
	}
	await mkdir(dirname(dir), { recursive: true });
	const tmp = join(dirname(dir), `.tmp-${randomBytes(6).toString('hex')}`);
	await cp(sourceDir, tmp, { recursive: true, dereference: false, filter: (from) => !/[\\/](\.git|node_modules)([\\/]|$)/.test(from) });
	try {
		await rename(tmp, dir);
	} catch (error) {
		await rm(tmp, { recursive: true, force: true }).catch(() => {});
		if (!(await stat(dir).then((info) => info.isDirectory()).catch(() => false))) throw error;
	}
	return { dir, treeHash, bytes: (await hashTree(dir)).bytes };
}

function sourceLabel(source: SkillSource): string {
	if (source.kind === 'market') return `市场 · ${source.package ?? source.url ?? source.id}`;
	if (source.kind === 'local') return `本地 · ${source.path}`;
	return `插件包 · ${source.package}`;
}

async function entryFromDir(options: {
	dir: string;
	source: SkillSource;
	previous?: SkillEntry;
	nameHint?: string;
}): Promise<SkillEntry> {
	const meta = await readSkillMeta(options.dir);
	const changed = options.previous ? options.previous.treeHash !== meta.treeHash : true;
	const trust: SkillTrust = changed ? 'unreviewed' : options.previous?.trust ?? 'unreviewed';
	return {
		name: meta.name || options.nameHint || basename(options.dir),
		source: options.source,
		treeHash: meta.treeHash,
		dir: resolve(options.dir),
		trust,
		hasScripts: meta.hasScripts,
		specFields: meta.specFields,
		installedAt: options.previous?.installedAt ?? Date.now(),
		installedBy: options.previous?.installedBy ?? 'owner',
		bytes: meta.bytes,
		available: true,
		audits: options.previous?.audits,
		warnings: meta.warnings.length ? meta.warnings : undefined,
	};
}

function mergeEntry(entries: SkillEntry[], entry: SkillEntry): SkillEntry[] {
	const index = entries.findIndex(
		(item) => item.name === entry.name && item.treeHash === entry.treeHash && item.source.kind === entry.source.kind,
	);
	if (index < 0) return [...entries, entry];
	const next = [...entries];
	next[index] = { ...entry, trust: entry.treeHash === entries[index].treeHash ? entries[index].trust : entry.trust, audits: entries[index].audits };
	return next;
}

/** 本地来源每次现算：开发期目录会变，索引里的 hash 只是上一次的快照。 */
async function refreshMutableEntries(entries: SkillEntry[], diagnostics: string[]): Promise<SkillEntry[]> {
	const next: SkillEntry[] = [];
	for (const entry of entries) {
		if (entry.source.kind !== 'local') {
			next.push(entry);
			continue;
		}
		try {
			const refreshed = await entryFromDir({ dir: entry.dir, source: entry.source, previous: entry });
			next.push({
				...refreshed,
				// 本地来源默认不参与审计；内容变了必须回到 unreviewed。
				trust: refreshed.treeHash === entry.treeHash ? entry.trust : 'unreviewed',
				audits: refreshed.treeHash === entry.treeHash ? entry.audits : undefined,
			});
		} catch (error) {
			diagnostics.push(`本地技能 ${entry.name} 不可用：${error instanceof Error ? error.message : String(error)}`);
			next.push({ ...entry, available: false });
		}
	}
	return next;
}

function parseRef(ref: string): { name: string; hash?: string } {
	const trimmed = ref.trim();
	const at = trimmed.lastIndexOf('@');
	if (at <= 0) return { name: trimmed };
	const hashPart = trimmed.slice(at + 1).replace(/^sha256:/, '');
	if (!/^[a-f0-9]{8,64}$/i.test(hashPart)) return { name: trimmed };
	return { name: trimmed.slice(0, at), hash: hashPart.toLowerCase() };
}

function resolveRef(entries: SkillEntry[], ref: string): SkillEntry | undefined {
	const { name, hash } = parseRef(ref);
	const candidates = entries.filter((entry) => entry.name === name);
	if (!hash) {
		return candidates.sort(
			(a, b) => (Number(b.available !== false) - Number(a.available !== false)) || b.installedAt - a.installedAt,
		)[0];
	}
	return candidates.find((entry) => entry.treeHash.startsWith(hash));
}

function estimateTokens(item: SkillCompositionItem): number {
	// name + description 常驻 system prompt；留一点结构/路径开销。
	const text = `${item.name} ${item.specFields.description ?? ''} ${item.dir}`;
	return Math.ceil(text.length / 4);
}

export function composeSkills(entries: SkillEntry[], selection: SkillSelection): SkillComposition {
	const conflicts: SkillConflict[] = [];
	const warnings: string[] = [];
	const kept = new Map<string, SkillCompositionItem>();
	const ordered: SkillCompositionItem[] = [];
	const refs = selection.policy.onConflict === 'last-wins' ? [...selection.refs].reverse() : selection.refs;
	for (const ref of refs) {
		const entry = resolveRef(entries, ref);
		if (!entry) {
			conflicts.push({ name: parseRef(ref).name, kept: '', dropped: ref, reason: 'missing' });
			continue;
		}
		if (entry.available === false) {
			conflicts.push({ name: entry.name, kept: '', dropped: ref, reason: 'missing' });
			continue;
		}
		if (entry.trust === 'blocked') {
			conflicts.push({ name: entry.name, kept: '', dropped: ref, reason: 'blocked' });
			continue;
		}
		const existing = kept.get(entry.name);
		if (existing) {
			conflicts.push({ name: entry.name, kept: existing.ref, dropped: ref, reason: 'duplicate-name' });
			if (selection.policy.onConflict === 'error') warnings.push(`同名技能冲突：${entry.name}`);
			continue;
		}
		const item: SkillCompositionItem = {
			ref,
			name: entry.name,
			treeHash: entry.treeHash,
			source: entry.source,
			trust: entry.trust,
			dir: entry.dir,
			hasScripts: entry.hasScripts,
			inPrompt:
				(entry.trust === 'audited' || (entry.trust === 'unreviewed' && selection.policy.unreviewed === 'prompt')) &&
				!entry.specFields.disableModelInvocation,
			specFields: entry.specFields,
		};
		kept.set(entry.name, item);
		ordered.push(item);
	}
	if (ordered.length > selection.policy.maxSkills) {
		for (const item of ordered.splice(selection.policy.maxSkills)) {
			conflicts.push({ name: item.name, kept: '', dropped: item.ref, reason: 'over-cap' });
		}
		warnings.push(`组合超过上限 ${selection.policy.maxSkills}，超出部分未生效`);
	}
	return {
		skills: ordered,
		conflicts,
		warnings,
		tokens: ordered.filter((item) => item.inPrompt).reduce((sum, item) => sum + estimateTokens(item), 0),
		maxSkills: selection.policy.maxSkills,
		mode: selection.mode,
	};
}

async function snapshotFrom(entries: SkillEntry[], selection: SkillSelection, diagnostics: string[]): Promise<SkillSnapshot> {
	return {
		store: SKILL_STORE,
		indexFile: INDEX_FILE,
		updatedAt: Date.now(),
		entries: [...entries].sort((a, b) => a.name.localeCompare(b.name) || b.installedAt - a.installedAt),
		selection,
		composition: composeSkills(entries, selection),
		diagnostics,
	};
}

export async function listSkills(): Promise<SkillSnapshot> {
	const index = await readIndex();
	const diagnostics: string[] = [];
	const entries = await refreshMutableEntries(index.entries, diagnostics);
	if (JSON.stringify(entries) !== JSON.stringify(index.entries)) {
		await withIndexLock(async () => {
			const latest = await readIndex();
			await writeIndex({ ...latest, entries, updatedAt: Date.now() });
		});
	}
	return snapshotFrom(entries, index.selection, diagnostics);
}

/** 供 Chat 初始化/apply 使用：只返回 loader 需要的路径与信任映射。 */
export async function loadSkillComposition(): Promise<{
	paths: string[];
	entries: SkillCompositionItem[];
	selection: SkillSelection;
	diagnostics: string[];
}> {
	const snapshot = await listSkills();
	const paths = snapshot.composition.skills.map((skill) => skill.dir);
	return {
		paths,
		entries: snapshot.composition.skills,
		selection: snapshot.selection,
		diagnostics: snapshot.diagnostics,
	};
}

export function trustForSkillPath(entries: SkillCompositionItem[], filePath: string): SkillTrust | undefined {
	const resolved = resolve(filePath);
	const match = entries
		.filter((entry) => isWithin(resolved, resolve(entry.dir)))
		.sort((a, b) => b.dir.length - a.dir.length)[0];
	return match?.trust;
}

function validateLocalPath(path: string): string {
	if (!isAbsolute(path.trim())) throw new SkillError('本地来源必须是绝对路径');
	const resolved = resolve(path.trim());
	const roots = [RUNTIME_DIR, ...listWorkspaces().map((workspace) => workspace.root)].map((root) => resolve(root));
	if (!roots.some((root) => isWithin(resolved, root))) {
		throw new SkillError('本地来源必须位于已注册 workspace（或 runtime）内', 403);
	}
	return resolved;
}

/** 解包 npm 包前先检查条目路径，拒绝绝对路径和 `..`。 */
function assertTarEntries(list: string): void {
	for (const line of list.split('\n')) {
		const entry = line.trim();
		if (!entry) continue;
		if (entry.startsWith('/') || entry.split('/').includes('..')) {
			throw new SkillError(`拒绝不安全的压缩包条目：${entry}`, 400);
		}
	}
}

async function installFromNpm(packageName: string, temp: string): Promise<string[]> {
	await mkdir(temp, { recursive: true });
	const { stdout } = await run('npm', ['pack', '--silent', '--pack-destination', temp, packageName], {
		timeout: 120_000,
		maxBuffer: 8 * 1024 * 1024,
	});
	const tarball = stdout.trim().split('\n').filter(Boolean).pop();
	if (!tarball) throw new SkillError('npm pack 没有返回 tarball 名', 502);
	const archive = isAbsolute(tarball) ? tarball : join(temp, tarball);
	const { stdout: list } = await run('tar', ['-tzf', archive], { maxBuffer: 32 * 1024 * 1024 });
	assertTarEntries(list);
	const unpack = join(temp, 'unpack');
	await mkdir(unpack, { recursive: true });
	await run('tar', ['-xzf', archive, '-C', unpack, '--no-same-owner']);
	return findSkillDirs(unpack, 0, 4);
}

async function installFromGit(url: string, ref: string | undefined, temp: string, sparsePaths: string[] = []): Promise<string[]> {
	const dest = join(temp, 'repo');
	const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
	const git = (args: string[]) => run('git', args, { timeout: 180_000, maxBuffer: 8 * 1024 * 1024, env });
	const commitRef = Boolean(ref && /^[0-9a-f]{7,40}$/i.test(ref));
	if (sparsePaths.length || commitRef) {
		// 先 init + sparse，再按 commit/分支拉一层：默认市场只需几个子目录，不下载整仓。
		await mkdir(dest, { recursive: true });
		await git(['init', '-q', dest]);
		await git(['-C', dest, 'remote', 'add', 'origin', url]);
		if (sparsePaths.length) {
			await git(['-C', dest, 'sparse-checkout', 'init', '--cone']);
			await git(['-C', dest, 'sparse-checkout', 'set', ...sparsePaths]);
		}
		await git(['-C', dest, 'fetch', '--depth', '1', 'origin', ref || 'HEAD']);
		await git(['-C', dest, 'checkout', '--detach', 'FETCH_HEAD']);
		return findSkillDirs(dest);
	}
	await git(['clone', '--depth', '1', ...(ref ? ['--branch', ref] : []), '--', url, dest]);
	return findSkillDirs(dest);
}

async function installFromRawUrl(url: string, temp: string): Promise<string[]> {
	const response = await fetch(url, { redirect: 'follow' });
	if (!response.ok) throw new SkillError(`下载失败：HTTP ${response.status}`, 502);
	const bytes = Buffer.from(await response.arrayBuffer());
	if (bytes.length > MAX_SOURCE_BYTES) throw new SkillError('SKILL.md 超过 2MB 上限', 413);
	const text = bytes.toString('utf8');
	const parsed = parseFrontmatter(text);
	const nameMatch = parsed.raw.match(/^name:\s*(.+)$/m);
	const name = nameMatch ? nameMatch[1].trim().replace(/^(['"])(.*)\1$/, '$2') : basename(new URL(url).pathname, '.md') || 'skill';
	const dir = join(temp, safeName(name));
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, 'SKILL.md'), text);
	return [dir];
}

export async function installSkill(input: any): Promise<{ installed: SkillEntry[]; snapshot: SkillSnapshot }> {
	const source = input?.source;
	if (!source || typeof source !== 'object') throw new SkillError('source required');
	const kind = source.kind;
	if (!['local', 'market'].includes(kind)) throw new SkillError(`不支持直接安装的来源：${String(kind)}`);
	const temp = join(tmpdir(), `pi-skill-${randomBytes(6).toString('hex')}`);
	try {
		let sourceDirs: string[] = [];
		let skillSource: SkillSource;
		if (kind === 'local') {
			const path = validateLocalPath(String(source.path ?? ''));
			sourceDirs = await findSkillDirs(path, 0, 4);
			if (!sourceDirs.length) throw new SkillError(`目录里找不到 SKILL.md：${path}`);
			skillSource = { kind: 'local', path };
		} else {
			const url = typeof source.url === 'string' ? source.url.trim() : '';
			const pkg = typeof source.package === 'string' ? source.package.trim() : '';
			const ref = typeof source.ref === 'string' ? source.ref.trim() : undefined;
			const subdir = typeof source.subdir === 'string' ? source.subdir.trim().replace(/^\.?\//, '').replace(/\/+$/, '') : '';
			const subdirs = Array.isArray(source.subdirs)
				? source.subdirs
					.filter((item: unknown): item is string => typeof item === 'string' && Boolean(item.trim()))
					.map((item: string) => item.trim().replace(/^\.?\//, '').replace(/\/+$/, ''))
				: [];
			if (subdir.split('/').includes('..') || subdirs.some((item) => item.split('/').includes('..'))) {
				throw new SkillError('subdir 不能包含 ..');
			}
			if (!url && !pkg) throw new SkillError('market 来源需要 url 或 package');
			if (pkg) {
				sourceDirs = await installFromNpm(pkg, temp);
				skillSource = { kind: 'market', id: pkg, package: pkg, ref, subdir: subdir || undefined };
			} else if (/^https?:\/\/.+\.md(?:[?#].*)?$/i.test(url)) {
				sourceDirs = await installFromRawUrl(url, temp);
				skillSource = { kind: 'market', id: url, url, ref, subdir: subdir || undefined };
			} else {
				if (!/^(https?:\/\/|git@|ssh:\/\/)/i.test(url)) throw new SkillError('market url 需要 http(s) / git@ / ssh://');
				sourceDirs = await installFromGit(url, ref, temp, subdirs);
				skillSource = { kind: 'market', id: url, url, ref, subdir: subdir || undefined, ...(subdirs.length ? { subdirs } : {}) };
			}
			const wanted = subdirs.length ? subdirs : subdir ? [subdir] : [];
			if (wanted.length) {
				// git clone 在 temp/repo，npm 解包在 temp/unpack（包根通常还有一层 package/），都要兼容。
				const roots = wanted.flatMap((item) => [
					item,
					join('repo', item),
					join('unpack', item),
					join('unpack', 'package', item),
				]).map((relative) => resolve(temp, relative));
				sourceDirs = sourceDirs.filter((dir) => roots.some((root) => isWithin(resolve(dir), root)));
			}
			if (!sourceDirs.length) throw new SkillError('来源里找不到 SKILL.md');
		}
		const installed: SkillEntry[] = [];
		await withIndexLock(async () => {
			const index = await readIndex();
			let entries = index.entries;
			for (const sourceDir of sourceDirs) {
				const meta = await readSkillMeta(sourceDir);
				let dir = sourceDir;
				let sourceForEntry = skillSource;
				if (skillSource.kind === 'market') {
					const copied = await copyIntoStore(sourceDir, 'market', meta.name);
					dir = copied.dir;
					sourceForEntry = { ...skillSource, id: skillSource.id };
				}
				const previous = entries.find(
					(item) => item.name === meta.name && item.treeHash === meta.treeHash && item.source.kind === sourceForEntry.kind,
				);
				const entry = await entryFromDir({ dir, source: sourceForEntry, previous });
				entries = mergeEntry(entries, entry);
				installed.push(entry);
			}
			await writeIndex({ ...index, entries, updatedAt: Date.now() });
		});
		return { installed, snapshot: await listSkills() };
	} finally {
		await rm(temp, { recursive: true, force: true }).catch(() => {});
	}
}

export async function auditSkill(input: any): Promise<SkillSnapshot> {
	const name = String(input?.name ?? '').trim();
	const treeHash = String(input?.treeHash ?? '').trim();
	const trust = String(input?.trust ?? '').trim() as SkillTrust;
	if (!name || !treeHash) throw new SkillError('name 和 treeHash required');
	if (!['audited', 'unreviewed', 'blocked'].includes(trust)) throw new SkillError('trust 非法');
	await withIndexLock(async () => {
		const index = await readIndex();
		const entry = index.entries.find((item) => item.name === name && item.treeHash === treeHash);
		if (!entry) throw new SkillError('技能不存在或 hash 已变，请刷新后再审计', 404);
		const at = Date.now();
		const audits = [...(entry.audits ?? []), { by: 'owner', at, treeHash, note: String(input?.note ?? '') || undefined }];
		const entries = index.entries.map((item) =>
			item === entry ? { ...item, trust, audits: audits.slice(-20) } : item,
		);
		await writeIndex({ ...index, entries, updatedAt: at });
	});
	return listSkills();
}

export async function removeSkill(input: any): Promise<SkillSnapshot> {
	const name = String(input?.name ?? '').trim();
	const treeHash = String(input?.treeHash ?? '').trim();
	if (!name) throw new SkillError('name required');
	await withIndexLock(async () => {
		const index = await readIndex();
		const matches = index.entries.filter((item) => item.name === name && (!treeHash || item.treeHash === treeHash));
		if (!matches.length) throw new SkillError('技能不存在', 404);
		const referenced = index.selection.refs.some((ref) => {
			const parsed = parseRef(ref);
			return parsed.name === name && (!parsed.hash || matches.some((entry) => entry.treeHash.startsWith(parsed.hash)));
		});
		if (referenced) throw new SkillError('技能还在组合里，先停用再删除', 409);
		const entries = index.entries.filter((item) => !matches.includes(item));
		for (const entry of matches) {
			if (entry.source.kind !== 'market') continue;
			if (!isWithin(resolve(entry.dir), SKILL_STORE)) continue;
			await rm(entry.dir, { recursive: true, force: true }).catch(() => {});
		}
		await writeIndex({ ...index, entries, updatedAt: Date.now() });
	});
	return listSkills();
}

export async function selectSkills(input: any): Promise<SkillSnapshot> {
	const rawRefs = Array.isArray(input?.refs)
		? input.refs.filter((ref: unknown): ref is string => typeof ref === 'string' && Boolean(ref.trim())).map((ref: string) => ref.trim())
		: [];
	const mode = input?.mode === 'add' ? 'add' : 'only';
	await withIndexLock(async () => {
		const index = await readIndex();
		const selection = normalizeSelection({
			...index.selection,
			mode,
			refs: rawRefs,
			policy: {
				...index.selection.policy,
				...(input?.policy && typeof input.policy === 'object' ? input.policy : {}),
			},
			updatedAt: Date.now(),
			updatedBy: 'owner',
		});
		if (selection.refs.length > selection.policy.maxSkills) {
			throw new SkillError(`组合最多 ${selection.policy.maxSkills} 个技能（当前 ${selection.refs.length}）`, 400);
		}
		const composition = composeSkills(index.entries, selection);
		if (selection.policy.onConflict === 'error' && composition.conflicts.some((item) => item.reason === 'duplicate-name')) {
			throw new SkillError('组合里存在同名技能，当前策略是 error', 409);
		}
		await writeIndex({ ...index, selection, updatedAt: Date.now() });
	});
	return listSkills();
}

export async function refreshSkills(input: any = {}): Promise<SkillSnapshot> {
	const name = String(input?.name ?? '').trim();
	if (!name) return listSkills();
	await withIndexLock(async () => {
		const index = await readIndex();
		const entries: SkillEntry[] = [];
		for (const entry of index.entries) {
			if (entry.name !== name || entry.source.kind === 'market') {
				entries.push(entry);
				continue;
			}
			try {
				entries.push(await entryFromDir({ dir: entry.dir, source: entry.source, previous: entry }));
			} catch {
				entries.push({ ...entry, available: false });
			}
		}
		await writeIndex({ ...index, entries, updatedAt: Date.now() });
	});
	return listSkills();
}

/** 供 API 展示来源；UI 只根据 kind 渲染徽标。 */
export { sourceLabel };
