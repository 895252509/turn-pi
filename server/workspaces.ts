/**
 * Workspace 注册表（v1）。
 *
 * 设计见 docs/workspace-and-worktree.md：
 *   - 会话的 cwd 仍然是唯一事实来源；workspace 只是 cwd 的注册表条目。
 *   - 默认登记 PI_WORKSPACE 和 /work，并在启动/手动刷新时合并一级 git 仓库。
 *   - 注册表是低频写的小 JSON，放 PI_RUNTIME_DIR，不引入数据库。
 */

import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, rename, stat, writeFile, mkdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

/**
 * worktree 依赖共享策略（见 docs/worktree-deps.md）。
 * P0 只实现 link：把主工作区里已存在的依赖目录符号链接进新 worktree。
 */
export interface WorktreeDeps {
	/** link=链接主工作区依赖；none=不处理。不写=link。 */
	mode?: 'link' | 'none';
	/** 要共享的相对路径，默认 ['node_modules']。 */
	include?: string[];
	/** 从 include 里排除的路径。 */
	exclude?: string[];
}

export interface Workspace {
	id: string;
	label: string;
	root: string;
	kind: 'dir' | 'git';
	readonly?: boolean;
	worktreeDeps?: WorktreeDeps;
	source?: 'default' | 'config' | 'discovered';
	/** 运行时状态：root 当前是否存在。不要求调用方持久化。 */
	available?: boolean;
}

interface WorkspaceFile {
	version: number;
	workspaces: Workspace[];
}

const RUNTIME_DIR = resolve(process.env.PI_RUNTIME_DIR ?? 'runtime');
const DEFAULT_ROOT = resolve(process.env.PI_WORKSPACE ?? '/workspace');
const WORKSPACES_FILE = resolve(process.env.PI_WORKSPACES_FILE ?? join(RUNTIME_DIR, 'workspaces.json'));
const DISCOVER = (process.env.PI_WORKSPACE_DISCOVER ?? 'git').trim().toLowerCase();

let workspaces: Workspace[] = [];
let byId = new Map<string, Workspace>();
let byRoot = new Map<string, Workspace>();
let defaultId = 'workspace';

function slugify(input: string): string {
	const slug = input
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return slug || 'workspace';
}

function shortHash(input: string): string {
	return createHash('sha1').update(input).digest('hex').slice(0, 6);
}

function isWithin(path: string, root: string): boolean {
	return path === root || path.startsWith(root + sep);
}

async function directoryExists(root: string): Promise<boolean> {
	try {
		return (await stat(root)).isDirectory();
	} catch {
		return false;
	}
}

async function gitRoot(root: string): Promise<boolean> {
	try {
		return Boolean(await stat(join(root, '.git')));
	} catch {
		return false;
	}
}

/** 只接受 P0 支持的形状；非法值当未设置，避免出现"看似生效实则没实现"的配置。 */
function normalizeWorktreeDeps(raw: any): WorktreeDeps | undefined {
	if (!raw || typeof raw !== 'object') return undefined;
	const mode = raw.mode === 'none' ? 'none' : raw.mode === 'link' ? 'link' : undefined;
	const paths = (value: any): string[] | undefined => {
		if (!Array.isArray(value)) return undefined;
		const list = value
			.filter((item): item is string => typeof item === 'string')
			.map((item) => item.trim().replace(/^\.\//, '').replace(/\/+$/, ''))
			.filter(
				(item) =>
					Boolean(item) &&
					item !== '.' &&
					!item.startsWith('/') &&
					!item.split('/').includes('..') &&
					!item.includes('\0'),
			);
		return list.length ? [...new Set(list)] : undefined;
	};
	const include = paths(raw.include);
	const exclude = paths(raw.exclude);
	if (!mode && !include && !exclude) return undefined;
	return { mode, include, exclude };
}

function normalizeWorkspace(raw: any, source: Workspace['source']): Workspace | null {
	if (!raw || typeof raw !== 'object') return null;
	const root = typeof raw.root === 'string' ? resolve(raw.root) : '';
	if (!root) return null;
	const id = slugify(String(raw.id ?? basename(root)));
	return {
		id,
		label: String(raw.label ?? basename(root) ?? id).trim() || id,
		root,
		kind: raw.kind === 'git' ? 'git' : 'dir',
		readonly: Boolean(raw.readonly),
		worktreeDeps: normalizeWorktreeDeps(raw.worktreeDeps),
		source,
	};
}

/** 默认 workspace + /work（如果存在且不是同一个真实目录）+ 一级 git 仓库。 */
async function discoverWorkspaces(): Promise<Workspace[]> {
	const found: Workspace[] = [];
	const seenReal = new Set<string>();

	const add = async (workspace: Workspace) => {
		let real = workspace.root;
		try {
			real = await realpath(workspace.root);
		} catch {
			/* 用原路径继续 */
		}
		if (seenReal.has(real)) return;
		if (!(await directoryExists(workspace.root))) return;
		seenReal.add(real);
		found.push(workspace);
	};

	await add({
		id: 'workspace',
		label: DEFAULT_ROOT === '/workspace' ? '工作区' : basename(DEFAULT_ROOT),
		root: DEFAULT_ROOT,
		kind: (await gitRoot(DEFAULT_ROOT)) ? 'git' : 'dir',
		source: 'default',
	});

	const aliasRoot = resolve('/work');
	if (aliasRoot !== DEFAULT_ROOT) {
		await add({
			id: 'pi-agent',
			label: 'Pi Agent',
			root: aliasRoot,
			kind: (await gitRoot(aliasRoot)) ? 'git' : 'dir',
			source: 'default',
		});
	}

	if (DISCOVER === 'none') return found;

	let entries: { name: string; isDirectory(): boolean }[] = [];
	try {
		entries = await readdir(DEFAULT_ROOT, { withFileTypes: true });
	} catch {
		return found;
	}
	const children = entries
		.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
		.map((entry) => entry.name)
		.sort((a, b) => a.localeCompare(b));

	for (const name of children) {
		const root = join(DEFAULT_ROOT, name);
		if (DISCOVER === 'git' && !(await gitRoot(root))) continue;
		const base = slugify(name);
		const id = found.some((workspace) => workspace.id === base) ? `${base}-${shortHash(root)}` : base;
		await add({
			id,
			label: name,
			root,
			kind: (await gitRoot(root)) ? 'git' : 'dir',
			source: 'discovered',
		});
	}
	return found;
}

function rebuildIndex() {
	byId = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
	byRoot = new Map(workspaces.map((workspace) => [workspace.root, workspace]));
	const fallback = workspaces.find((workspace) => workspace.id === 'workspace') ?? workspaces[0];
	defaultId = fallback?.id ?? 'workspace';
}

async function save() {
	const payload: WorkspaceFile = { version: 1, workspaces };
	await mkdir(dirname(WORKSPACES_FILE), { recursive: true });
	const tmp = `${WORKSPACES_FILE}.${process.pid}.tmp`;
	await writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
	await rename(tmp, WORKSPACES_FILE);
}

let initialized = false;
let refreshing: Promise<Workspace[]> | null = null;

async function readWorkspaceFile(): Promise<{ list: Workspace[]; loadError: boolean }> {
	try {
		const raw = await readFile(WORKSPACES_FILE, 'utf8');
		const parsed = JSON.parse(raw);
		const list = Array.isArray(parsed?.workspaces) ? parsed.workspaces : [];
		return {
			list: list
				.map((item: any) => normalizeWorkspace(item, item?.source ?? 'config'))
				.filter((item: Workspace | null): item is Workspace => Boolean(item)),
			loadError: false,
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { list: [], loadError: false };
		process.stderr.write(
			`[workspaces] 读取 ${WORKSPACES_FILE} 失败，保留当前注册表并继续自动发现：${error instanceof Error ? error.message : String(error)}\n`,
		);
		return { list: [...workspaces], loadError: true };
	}
}

async function realRootOf(workspace: Workspace): Promise<string> {
	try {
		return await realpath(workspace.root);
	} catch {
		return resolve(workspace.root);
	}
}

/** 自动发现的目录被删除后从注册表移除；手工/默认 workspace 不自动删。 */
async function pruneMissingDiscovered(): Promise<boolean> {
	const kept: Workspace[] = [];
	let changed = false;
	for (const workspace of workspaces) {
		if (workspace.source === 'discovered' && !(await directoryExists(workspace.root))) {
			changed = true;
			continue;
		}
		kept.push(workspace);
	}
	workspaces = kept;
	return changed;
}

/** 合并自动发现结果：新仓库加入，已存在（按 realpath）的跳过。 */
async function mergeDiscoveredWorkspaces(discovered: Workspace[]): Promise<boolean> {
	let changed = false;
	const byReal = new Map<string, Workspace>();
	for (const workspace of workspaces) byReal.set(await realRootOf(workspace), workspace);

	for (const candidate of discovered) {
		const real = await realRootOf(candidate);
		if (byReal.has(real)) continue;
		let id = candidate.id;
		let counter = 1;
		while (workspaces.some((workspace) => workspace.id === id)) {
			id = `${candidate.id}-${shortHash(`${real}:${counter}`)}`;
			counter += 1;
		}
		const workspace = { ...candidate, id };
		workspaces.push(workspace);
		byReal.set(real, workspace);
		changed = true;
	}
	return changed;
}

/** 老部署只有 PI_WORKSPACE；注册表被手工删空时也要保证默认根可用。 */
async function ensureDefaultWorkspace(): Promise<boolean> {
	if (workspaces.some((workspace) => workspace.id === 'workspace')) return false;
	const real = await realpath(DEFAULT_ROOT).catch(() => resolve(DEFAULT_ROOT));
	const existing = workspaces.find((workspace) => resolve(workspace.root) === real);
	if (existing) {
		existing.id = 'workspace';
		existing.source = 'default';
		return true;
	}
	workspaces.unshift({
		id: 'workspace',
		label: DEFAULT_ROOT === '/workspace' ? '工作区' : basename(DEFAULT_ROOT),
		root: DEFAULT_ROOT,
		kind: (await gitRoot(DEFAULT_ROOT)) ? 'git' : 'dir',
		source: 'default',
	});
	return true;
}

/** 重新读注册表 + 重新发现 + 合并；返回最新列表。 */
async function refreshWorkspaces(): Promise<Workspace[]> {
	if (refreshing) return refreshing;
	refreshing = (async () => {
		const loaded = await readWorkspaceFile();
		workspaces = loaded.list;
		let changed = false;

		if (await pruneMissingDiscovered()) changed = true;
		if (DISCOVER !== 'none') {
			if (await mergeDiscoveredWorkspaces(await discoverWorkspaces())) changed = true;
		}
		if (await ensureDefaultWorkspace()) changed = true;
		for (const workspace of workspaces) workspace.available = await directoryExists(workspace.root);

		rebuildIndex();

		if (changed) {
			if (loaded.loadError) {
				// 文件存在但解析失败：保留原文件，避免一次语法错误把用户手工配置覆盖掉。
				process.stderr.write(`[workspaces] 保留原文件不覆盖：${WORKSPACES_FILE}\n`);
			} else {
				try {
					await save();
					process.stdout.write(`[workspaces] 已更新 ${WORKSPACES_FILE}（${workspaces.length} 个）\n`);
				} catch (error) {
					process.stderr.write(
						`[workspaces] 写入失败：${error instanceof Error ? error.message : String(error)}\n`,
					);
				}
			}
		}

		process.stdout.write(
			`[workspaces] ${workspaces.length} 个：${workspaces
				.slice(0, 8)
				.map((workspace) => `${workspace.id}=${workspace.root}`)
				.join(', ')}${workspaces.length > 8 ? ' …' : ''}\n`,
		);
		return workspaces;
	})().finally(() => {
		refreshing = null;
	});
	return refreshing;
}

/** 启动时调用一次；失败不阻塞服务，至少保留默认 workspace。 */
export async function initWorkspaces(): Promise<Workspace[]> {
	if (initialized) return workspaces;
	initialized = true;
	return refreshWorkspaces();
}

/** 手工新增仓库/修改配置后，不重启进程也能重新发现并合并。 */
export async function reloadWorkspaces(): Promise<Workspace[]> {
	initialized = true;
	return refreshWorkspaces();
}

/** 把任意已存在的目录登记为 workspace；不要求是 git 仓库。 */
export async function addWorkspace(input: {
	path: string;
	label?: string;
	readonly?: boolean;
	worktreeDeps?: WorktreeDeps;
}): Promise<Workspace> {
	await initWorkspaces();
	const raw = String(input.path ?? '').trim();
	if (!raw) throw new Error('路径不能为空');
	if (!isAbsolute(raw)) throw new Error('请填写容器内绝对路径');
	const root = resolve(raw);
	if (root === '/') throw new Error('不能把根目录添加为工作区');

	let real: string;
	try {
		real = await realpath(root);
	} catch {
		throw new Error(`目录不存在：${root}`);
	}
	if (real === '/') throw new Error('不能把根目录添加为工作区');
	if (!(await directoryExists(real))) throw new Error(`目标不是目录：${root}`);

	for (const workspace of workspaces) {
		if (resolve(workspace.root) === root || (await realRootOf(workspace)) === real) {
			throw new Error(`目录已登记为工作区：${workspace.label}（${workspace.root}）`);
		}
	}

	const label = String(input.label ?? '').trim().slice(0, 80) || basename(root) || basename(real) || root;
	const baseId = slugify(label);
	let id = baseId;
	let counter = 1;
	while (workspaces.some((workspace) => workspace.id === id)) {
		id = `${baseId}-${shortHash(`${root}:${counter}`)}`;
		counter += 1;
	}

	const workspace: Workspace = {
		id,
		label,
		root,
		kind: (await gitRoot(root)) ? 'git' : 'dir',
		readonly: Boolean(input.readonly),
		worktreeDeps: normalizeWorktreeDeps(input.worktreeDeps),
		source: 'config',
		available: true,
	};
	workspaces.push(workspace);
	rebuildIndex();
	try {
		await save();
	} catch (error) {
		workspaces.pop();
		rebuildIndex();
		throw error;
	}
	return workspace;
}

/** 打开历史会话时，如果 cwd 还不在注册表里，自动登记为 workspace。 */
export async function ensureWorkspaceForCwd(cwd: string | null | undefined): Promise<Workspace | undefined> {
	await initWorkspaces();
	const root = resolve(String(cwd ?? ''));
	if (!root || root === '/') return undefined;
	const existing = workspaceForCwd(root);
	if (existing) return existing;
	if (!(await directoryExists(root))) return undefined;
	const real = await realpath(root).catch(() => root);
	if (real === '/') return undefined;
	for (const workspace of workspaces) {
		if ((await realRootOf(workspace)) === real) return workspace;
	}

	const label = basename(root) || root;
	const baseId = slugify(label);
	let id = baseId;
	let counter = 1;
	while (workspaces.some((workspace) => workspace.id === id)) {
		id = `${baseId}-${shortHash(`${root}:${counter}`)}`;
		counter += 1;
	}
	const workspace: Workspace = {
		id,
		label,
		root,
		kind: (await gitRoot(root)) ? 'git' : 'dir',
		source: 'config',
		available: true,
	};
	workspaces.push(workspace);
	rebuildIndex();
	try {
		await save();
	} catch (error) {
		workspaces.pop();
		rebuildIndex();
		throw error;
	}
	return workspace;
}

export function listWorkspaces(): Workspace[] {
	return workspaces;
}

export function workspaceFile(): string {
	return WORKSPACES_FILE;
}

/** 接受 id；`workspace` 始终是默认 workspace 的别名。 */
export function getWorkspace(id: string | null | undefined): Workspace | undefined {
	const key = String(id ?? '').trim();
	if (!key || key === 'workspace') return byId.get(defaultId) ?? byId.get('workspace');
	return byId.get(key);
}

export function defaultWorkspace(): Workspace {
	return byId.get(defaultId) ?? byId.get('workspace') ?? {
		id: 'workspace',
		label: '工作区',
		root: DEFAULT_ROOT,
		kind: 'dir',
		source: 'default',
	};
}

/** 先精确匹配，再按最长前缀匹配；用于历史 session 的 cwd 反查。 */
export function workspaceForCwd(cwd: string | null | undefined): Workspace | undefined {
	const path = resolve(String(cwd ?? ''));
	const exact = byRoot.get(path);
	if (exact) return exact;
	return workspaces
		.filter((workspace) => isWithin(path, workspace.root))
		.sort((a, b) => b.root.length - a.root.length)[0];
}

export function workspaceIdForCwd(cwd: string | null | undefined): string | undefined {
	return workspaceForCwd(cwd)?.id;
}

/** 只读工作区必须屏蔽的写盘工具；bash 也能写，必须一起关。 */
export const WRITE_TOOLS: readonly string[] = ['bash', 'edit', 'write'];

/** readonly workspace 不能给 agent 任何可写盘的工具，否则只读承诺是空的。 */
export function filterWorkspaceTools(names: string[], readonly?: boolean): string[] {
	if (!readonly) return names;
	const blocked = new Set(WRITE_TOOLS);
	return names.filter((name) => !blocked.has(name));
}

/** 只用于日志/排障，不暴露给浏览器。 */
export function workspaceDebugInfo() {
	return { file: WORKSPACES_FILE, defaultRoot: DEFAULT_ROOT, defaultId, count: workspaces.length };
}
