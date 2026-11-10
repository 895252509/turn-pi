/**
 * Worktree 注册表（v1）。
 *
 * 设计约定：
 *   - worktree 只在容器内使用，根目录默认 $PI_RUNTIME_DIR/worktrees；
 *   - 不追求宿主机 git/IDE 能识别（元数据里记录的是容器内绝对路径）；
 *   - 作为 session cwd 的一种来源，不引入第二套会话模型；
 *   - 1 worktree : 1 session；删除必须显式，脏树默认拒绝；
 *   - 永不自动 merge、永不自动 prune。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, lstat, readFile, readlink, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { getWorkspace, type Workspace } from './workspaces.ts';

export type WorktreeState = 'creating' | 'ready' | 'missing' | 'removing' | 'removed';

/** 一个"共享依赖"链接：worktree 里的相对路径 → 主工作区里的真实路径。见 docs/worktree-deps.md。 */
export interface WorktreeLink {
	/** worktree 内的相对路径，如 node_modules。 */
	path: string;
	/** 链接目标（主工作区内的绝对路径）。 */
	target: string;
	createdAt: string;
}

export interface Worktree {
	id: string;
	workspaceId: string;
	path: string;
	branch: string;
	baseRef: string;
	baseCommit: string;
	sessionId?: string;
	state: WorktreeState;
	createdAt: string;
	lastUsedAt: string;
	removedAt?: string;
	/** worktree 里指向主工作区的依赖链接；删除时只 unlink 这些路径。 */
	links?: WorktreeLink[];
	/** 运行时字段，不要求调用方持久化。 */
	available?: boolean;
	workspaceLabel?: string;
	workspaceRoot?: string;
}

interface WorktreeFile {
	version: number;
	worktrees: Worktree[];
}

const execFileAsync = promisify(execFile);
const RUNTIME_DIR = resolve(process.env.PI_RUNTIME_DIR ?? 'runtime');
const WORKTREE_ROOT = resolve(process.env.PI_WORKTREE_ROOT ?? join(RUNTIME_DIR, 'worktrees'));
const WORKTREES_FILE = resolve(process.env.PI_WORKTREES_FILE ?? join(RUNTIME_DIR, 'worktrees.json'));

let worktrees: Worktree[] = [];
let initialized = false;
let serial: Promise<unknown> = Promise.resolve();

function withLock<T>(fn: () => Promise<T>): Promise<T> {
	const run = serial.then(fn, fn);
	serial = run.catch(() => undefined);
	return run;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

function isWithin(path: string, root: string): boolean {
	return path === root || path.startsWith(root + sep);
}

async function realOrResolve(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch {
		return resolve(path);
	}
}

async function git(cwd: string, args: string[]): Promise<string> {
	try {
		const { stdout } = await execFileAsync('git', args, {
			cwd,
			timeout: 120_000,
			maxBuffer: 10 * 1024 * 1024,
			env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
		});
		return String(stdout).trim();
	} catch (error: any) {
		const stderr = String(error?.stderr ?? '').trim();
		const stdout = String(error?.stdout ?? '').trim();
		const detail = stderr || stdout || error?.message || String(error);
		throw new Error(`git ${args.join(' ')} 失败：${detail}`);
	}
}

function normalizeWorktree(raw: any): Worktree | null {
	if (!raw || typeof raw !== 'object') return null;
	const id = String(raw.id ?? '').trim();
	const workspaceId = String(raw.workspaceId ?? '').trim();
	const path = typeof raw.path === 'string' ? resolve(raw.path) : '';
	const branch = String(raw.branch ?? '').trim();
	const baseRef = String(raw.baseRef ?? 'HEAD').trim() || 'HEAD';
	const baseCommit = String(raw.baseCommit ?? '').trim();
	if (!id || !workspaceId || !path || !branch || !baseCommit) return null;
	const state: WorktreeState =
		raw.state === 'creating' || raw.state === 'missing' || raw.state === 'removing' || raw.state === 'removed'
			? raw.state
			: 'ready';
	return {
		id,
		workspaceId,
		path,
		branch,
		baseRef,
		baseCommit,
		sessionId: typeof raw.sessionId === 'string' && raw.sessionId ? raw.sessionId : undefined,
		state,
		createdAt: String(raw.createdAt ?? new Date().toISOString()),
		lastUsedAt: String(raw.lastUsedAt ?? raw.createdAt ?? new Date().toISOString()),
		removedAt: typeof raw.removedAt === 'string' ? raw.removedAt : undefined,
		links: normalizeLinks(raw.links),
	};
}

function normalizeLinks(raw: any): WorktreeLink[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const links = raw
		.filter(
			(item: any) =>
				item &&
				typeof item.path === 'string' &&
				typeof item.target === 'string' &&
				item.path &&
				!item.path.startsWith('/') &&
				!item.path.split('/').includes('..'),
		)
		.map((item: any) => ({
			path: item.path,
			target: item.target,
			createdAt: String(item.createdAt ?? new Date().toISOString()),
		}));
	return links.length ? links : undefined;
}

async function save(): Promise<void> {
	const payload: WorktreeFile = { version: 1, worktrees };
	await mkdir(dirname(WORKTREES_FILE), { recursive: true });
	const tmp = `${WORKTREES_FILE}.${process.pid}.tmp`;
	await writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
	await rename(tmp, WORKTREES_FILE);
}

async function load(): Promise<void> {
	try {
		const raw = await readFile(WORKTREES_FILE, 'utf8');
		const parsed = JSON.parse(raw);
		const list = Array.isArray(parsed?.worktrees) ? parsed.worktrees : [];
		worktrees = list.map(normalizeWorktree).filter((item: Worktree | null): item is Worktree => Boolean(item));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			process.stderr.write(
				`[worktrees] 读取 ${WORKTREES_FILE} 失败：${error instanceof Error ? error.message : String(error)}\n`,
			);
		}
		worktrees = [];
	}
}

export async function initWorktrees(): Promise<Worktree[]> {
	if (initialized) return worktrees;
	initialized = true;
	await load();
	let changed = false;
	for (const worktree of worktrees) {
		if (worktree.state === 'removed') continue;
		const available = await pathExists(worktree.path);
		if (!available && worktree.state !== 'missing') {
			worktree.state = 'missing';
			changed = true;
		} else if (available && worktree.state === 'creating') {
			worktree.state = 'ready';
			changed = true;
		}
	}
	if (changed) await save().catch(() => undefined);
	process.stdout.write(`[worktrees] ${worktrees.filter((item) => item.state !== 'removed').length} 个，根目录 ${WORKTREE_ROOT}\n`);
	return worktrees;
}

function snapshot(worktree: Worktree): Worktree {
	const workspace = getWorkspace(worktree.workspaceId);
	const available = worktree.state !== 'removed' && existsSync(worktree.path);
	const state: WorktreeState =
		worktree.state === 'removed'
			? 'removed'
			: available
				? worktree.state === 'missing'
					? 'ready'
					: worktree.state
				: 'missing';
	return {
		...worktree,
		available,
		state,
		workspaceLabel: workspace?.label ?? worktree.workspaceId,
		workspaceRoot: workspace?.root,
	};
}

export function listWorktrees(): Worktree[] {
	return worktrees
		.map(snapshot)
		.filter((worktree) => worktree.state !== 'removed')
		.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export function getWorktree(id: string | null | undefined): Worktree | undefined {
	const key = String(id ?? '').trim();
	return worktrees.find((worktree) => worktree.id === key);
}

export function worktreeForCwd(cwd: string | null | undefined): Worktree | undefined {
	const path = resolve(String(cwd ?? ''));
	return worktrees
		.filter((worktree) => worktree.state !== 'removed' && isWithin(path, worktree.path))
		.sort((a, b) => b.path.length - a.path.length)[0];
}

export function worktreeForSession(sessionId: string | null | undefined): Worktree | undefined {
	const key = String(sessionId ?? '').trim();
	if (!key) return undefined;
	return worktrees.find((worktree) => worktree.sessionId === key && worktree.state !== 'removed');
}

export function worktreeRoot(): string {
	return WORKTREE_ROOT;
}

export function worktreesFile(): string {
	return WORKTREES_FILE;
}

async function repoRoot(workspace: Workspace): Promise<void> {
	const top = await git(workspace.root, ['rev-parse', '--show-toplevel']);
	const [rootReal, topReal] = await Promise.all([realOrResolve(workspace.root), realOrResolve(top)]);
	if (rootReal !== topReal) {
		throw new Error(`工作区不是 git 仓库根目录：${workspace.root}（仓库根是 ${topReal}）`);
	}
}

function validateBaseRef(input: string): string {
	const ref = String(input ?? '').trim() || 'HEAD';
	if (ref.startsWith('-') || ref.includes('\0') || /\s/.test(ref)) {
		throw new Error('baseRef 不合法');
	}
	return ref;
}

async function refExists(workspace: Workspace, branch: string): Promise<boolean> {
	try {
		await git(workspace.root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
		return true;
	} catch {
		return false;
	}
}

async function cleanupFailedCreate(
	workspace: Workspace,
	path: string,
	branch: string,
	links?: WorktreeLink[],
): Promise<void> {
	await unlinkWorktreeDeps({ path, links }).catch(() => undefined);
	await git(workspace.root, ['worktree', 'remove', '--force', path]).catch(() => undefined);
	await rm(path, { recursive: true, force: true }).catch(() => undefined);
	if (await refExists(workspace, branch)) {
		await git(workspace.root, ['branch', '-D', branch]).catch(() => undefined);
	}
}

// —— worktree 依赖共享（docs/worktree-deps.md）————————————————————

const DEFAULT_DEP_PATHS = ['node_modules'];
const DEP_LINK_MARKER = '# turn-pi: worktree shared deps (local only)';
/** 逃生阀：命令里带它就放行安装（给人用，不给 agent 默认用）。 */
export const SHARED_DEPS_BYPASS = 'PI_ALLOW_SHARED_DEPS=1';

async function lstatOrNull(path: string) {
	try {
		return await lstat(path);
	} catch {
		return null;
	}
}

/** 当前工作区想在 worktree 里共享哪些路径。 */
function depPathsFor(workspace: Workspace): string[] {
	const config = workspace.worktreeDeps;
	if (config?.mode === 'none') return [];
	const include = config?.include?.length ? config.include : DEFAULT_DEP_PATHS;
	const exclude = new Set(config?.exclude ?? []);
	return [...new Set(include)].filter((path) => !exclude.has(path));
}

/**
 * 符号链接不被 `.gitignore` 的 `node_modules/` 匹配（带斜杠只匹配目录），
 * 所以往 repo 本地的 info/exclude 补一条 `/node_modules`。不入库、不改用户 .gitignore。
 */
async function ensureLocalIgnore(workspace: Workspace, name: string): Promise<void> {
	const common = await git(workspace.root, ['rev-parse', '--git-common-dir']);
	const file = join(resolve(workspace.root, common), 'info', 'exclude');
	const pattern = `/${name}`;
	const current = await readFile(file, 'utf8').catch(() => '');
	const lines = current.split('\n').map((line) => line.trim());
	if (lines.includes(pattern)) return;
	const tail = current.trimEnd();
	const head = tail ? `${tail}\n` : '';
	const marker = lines.includes(DEP_LINK_MARKER) ? '' : `${DEP_LINK_MARKER}\n`;
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, `${head}${marker}${pattern}\n`, 'utf8');
}

/** 链一个路径；不满足前置条件就返回 null（不报错，不阻断创建）。 */
async function linkDep(worktree: Worktree, workspace: Workspace, name: string): Promise<WorktreeLink | null> {
	const target = join(workspace.root, name);
	const link = join(worktree.path, name);
	if (!isWithin(link, worktree.path)) return null;
	const targetStat = await lstatOrNull(target);
	if (!targetStat) return null;
	const dirStat = await stat(target).catch(() => null);
	if (!dirStat?.isDirectory()) return null;
	if (await lstatOrNull(link)) return null; // 分支自带同名路径，尊重它
	await ensureLocalIgnore(workspace, name);
	await symlink(target, link, 'dir');
	return { path: name, target, createdAt: new Date().toISOString() };
}

async function linkWorktreeDeps(worktree: Worktree, workspace: Workspace): Promise<WorktreeLink[]> {
	const created: WorktreeLink[] = [];
	for (const name of depPathsFor(workspace)) {
		const link = await linkDep(worktree, workspace, name).catch((error) => {
			process.stderr.write(
				`[worktrees] 链接依赖失败 ${name}：${error instanceof Error ? error.message : String(error)}\n`,
			);
			return null;
		});
		if (link) created.push(link);
	}
	return created;
}

/** 只 unlink "指向 worktree 外部"的符号链接；真目录和内部链接一律不动。 */
async function unlinkWorktreeDeps(worktree: Pick<Worktree, 'path' | 'links'>): Promise<string[]> {
	const removed: string[] = [];
	for (const link of worktree.links ?? []) {
		const path = join(worktree.path, link.path);
		const info = await lstatOrNull(path);
		if (!info?.isSymbolicLink()) continue;
		const target = await readlink(path).catch(() => '');
		if (!target) continue;
		if (isWithin(resolve(worktree.path, target), worktree.path)) continue;
		await rm(path, { force: true });
		removed.push(link.path);
	}
	return removed;
}

/** `git status --porcelain` 里去掉依赖链接那几行，避免 worktree 被当成脏树。 */
function withoutLinkNoise(status: string, links?: WorktreeLink[]): string {
	if (!status || !links?.length) return status;
	const linked = new Set(links.map((link) => link.path));
	return status
		.split('\n')
		.filter((line) => {
			if (!line.trim()) return false;
			const path = line.slice(3).trim().replace(/^"|"$/g, '');
			return !linked.has(path);
		})
		.join('\n');
}

const PACKAGE_INSTALL = /\b(npm|pnpm|yarn|bun)\s+(?:i|install|add|ci|update|up|upgrade|dedupe|prune|rebuild|link|unlink)\b/;
const PYTHON_INSTALL = /\b(pip3?|uv|poetry|pipenv)\s+(?:install|add|sync|lock)\b/;
const OTHER_INSTALL = /\b(composer|bundle)\s+(?:install|add|update)\b/;

/**
 * 共享依赖是可写的：在 worktree 里跑安装会把主工作区写脏（且 package.json 改动留在 worktree）。
 * 返回非空字符串表示应当拦截该 bash 命令。这不是安全边界，只防手滑。
 */
export async function sharedDepsInstallBlock(cwd: string, command: string): Promise<string | null> {
	if (!command || command.includes(SHARED_DEPS_BYPASS)) return null;
	if (!PACKAGE_INSTALL.test(command) && !PYTHON_INSTALL.test(command) && !OTHER_INSTALL.test(command)) return null;
	const shared: string[] = [];
	for (const name of ['node_modules', '.venv']) {
		const info = await lstatOrNull(join(cwd, name));
		if (info?.isSymbolicLink()) shared.push(name);
	}
	if (!shared.length) return null;
	return (
		`当前会话在 worktree 里共享主工作区的依赖（${shared.join('、')} 是符号链接），` +
		`在这里安装会直接写到主工作区的依赖目录，而 package.json 的改动却留在本 worktree。` +
		`请回主工作区安装；确实要在这里装，先删掉链接，或在命令前加 ${SHARED_DEPS_BYPASS}。`
	);
}

export async function createWorktree(input: {
	workspaceId: string;
	baseRef?: string;
	/** 仅用于恢复/测试；正常新会话在 Chat.init 后绑定。 */
	sessionId?: string;
}): Promise<Worktree> {
	await initWorktrees();
	return withLock(async () => {
		const workspace = getWorkspace(input.workspaceId);
		if (!workspace) throw new Error(`未知工作区：${input.workspaceId}`);
		if (workspace.available === false) throw new Error(`工作区不可用：${workspace.label}（${workspace.root}）`);
		if (workspace.readonly) throw new Error(`只读工作区不能创建 worktree：${workspace.label}`);
		if (workspace.kind !== 'git') throw new Error(`不是 git 工作区：${workspace.label}`);
		await repoRoot(workspace);

		const baseRef = validateBaseRef(input.baseRef ?? 'HEAD');
		const baseCommit = await git(workspace.root, ['rev-parse', '--verify', `${baseRef}^{commit}`]);
		const id = `wt_${randomBytes(4).toString('hex')}`;
		const path = resolve(WORKTREE_ROOT, workspace.id, id);
		if (!isWithin(path, WORKTREE_ROOT)) throw new Error('worktree 路径越界');
		if (isWithin(path, workspace.root)) throw new Error('PI_WORKTREE_ROOT 不能位于工作区内');
		const branch = `pi/${workspace.id}/${id.slice(3)}`;
		await git(workspace.root, ['check-ref-format', '--branch', branch]);
		if (await refExists(workspace, branch)) throw new Error(`分支已存在：${branch}`);
		if (existsSync(path)) throw new Error(`worktree 路径已存在：${path}`);

		await mkdir(dirname(path), { recursive: true });
		const now = new Date().toISOString();
		const record: Worktree = {
			id,
			workspaceId: workspace.id,
			path,
			branch,
			baseRef,
			baseCommit,
			sessionId: input.sessionId,
			state: 'creating',
			createdAt: now,
			lastUsedAt: now,
		};
		try {
			await git(workspace.root, ['worktree', 'add', '-b', branch, path, baseRef]);
			record.state = 'ready';
			// 依赖共享失败不阻断创建：会话照样能开，缺依赖比"建不出来"好恢复。
			const links = await linkWorktreeDeps(record, workspace);
			if (links.length) record.links = links;
			worktrees.push(record);
			await save();
			process.stdout.write(`[worktrees] 创建 ${id} ${branch} -> ${path}\n`);
			return snapshot(record);
		} catch (error) {
			await cleanupFailedCreate(workspace, path, branch, record.links);
			throw error;
		}
	});
}

/**
 * 自愈：`git clean -xdf`、手工删除、`npm ci` 都可能让链接消失。
 * 补缺失的、认领已存在但没记录的、清掉配置已不要的记录。
 */
export async function ensureWorktreeLinks(id: string): Promise<WorktreeLink[]> {
	await initWorktrees();
	return withLock(async () => {
		const worktree = getWorktree(id);
		if (!worktree || worktree.state === 'removed') return [];
		const workspace = getWorkspace(worktree.workspaceId);
		if (!workspace) return [];
		const wanted = depPathsFor(workspace);
		if (!wanted.length) return [];
		if (!(await pathExists(worktree.path))) return [];

		const kept: WorktreeLink[] = [];
		for (const link of worktree.links ?? []) {
			if (!wanted.includes(link.path)) continue;
			const info = await lstatOrNull(join(worktree.path, link.path));
			if (info?.isSymbolicLink()) kept.push(link);
		}
		const known = new Set(kept.map((link) => link.path));
		const adopted: WorktreeLink[] = [];
		for (const name of wanted.filter((path) => !known.has(path))) {
			const link = join(worktree.path, name);
			const info = await lstatOrNull(link);
			const target = join(workspace.root, name);
			if (info?.isSymbolicLink()) {
				// 已经是链接（可能是手工建的）：目标对得上就认领，对不上不碰。
				const pointed = await readlink(link).catch(() => '');
				if (pointed && resolve(worktree.path, pointed) === target) {
					adopted.push({ path: name, target, createdAt: new Date().toISOString() });
					known.add(name);
				}
			}
		}

		const added: WorktreeLink[] = [];
		for (const name of wanted.filter((path) => !known.has(path))) {
			const link = await linkDep(worktree, workspace, name).catch((error) => {
				process.stderr.write(
					`[worktrees] 补齐依赖链接失败 ${name}：${error instanceof Error ? error.message : String(error)}\n`,
				);
				return null;
			});
			if (link) added.push(link);
		}

		const links = [...kept, ...adopted, ...added];
		if (JSON.stringify(links) === JSON.stringify(worktree.links ?? [])) return added;
		worktree.links = links.length ? links : undefined;
		await save();
		if (links.length) {
			process.stdout.write(`[worktrees] 依赖链接 ${id}：${links.map((link) => link.path).join(',')}\n`);
		}
		return added;
	});
}

export async function bindWorktreeSession(id: string, sessionId: string): Promise<Worktree> {
	await initWorktrees();
	return withLock(async () => {
		const worktree = getWorktree(id);
		if (!worktree) throw new Error(`未知 worktree：${id}`);
		if (worktree.state === 'removed') throw new Error(`worktree 已删除：${id}`);
		if (worktree.sessionId && worktree.sessionId !== sessionId) {
			throw new Error(`worktree 已绑定会话 ${worktree.sessionId}，请新建 worktree`);
		}
		worktree.sessionId = sessionId;
		worktree.lastUsedAt = new Date().toISOString();
		await save();
		return snapshot(worktree);
	});
}

export async function touchWorktree(id: string): Promise<void> {
	return withLock(async () => {
		const worktree = getWorktree(id);
		if (!worktree || worktree.state === 'removed') return;
		worktree.lastUsedAt = new Date().toISOString();
		await save().catch(() => undefined);
	});
}

export async function removeWorktree(
	id: string,
	options: { force?: boolean; allowMissing?: boolean } = {},
): Promise<Worktree> {
	await initWorktrees();
	return withLock(async () => {
		const worktree = getWorktree(id);
		if (!worktree) throw new Error(`未知 worktree：${id}`);
		if (worktree.state === 'removed') return snapshot(worktree);
		const available = await pathExists(worktree.path);
		// 目录已丢失：不跑 git、不碰分支，只把审计记录标成 removed。
		// 以前这里要求 options.allowMissing，而且必须先能查到 workspace，于是
		// 项目目录改名（pi-webchat → turn-pi）后，旧记录的 workspaceId 指向已经不存在的
		// workspace，removeWorktree 直接报错，孤儿记录永远清不掉（/api/health 的
		// worktrees 计数一直虚高）。目录都不在了，就没有可回收的东西，直接标记即可。
		if (!available) {
			worktree.state = 'removed';
			worktree.removedAt = new Date().toISOString();
			await save();
			process.stdout.write(`[worktrees] 回收缺失目录 ${id} ${worktree.branch}\n`);
			return snapshot(worktree);
		}
		const workspace = getWorkspace(worktree.workspaceId);
		if (!workspace) throw new Error(`worktree 所属工作区不存在：${worktree.workspaceId}`);
		if (!options.force) {
			const status = withoutLinkNoise(await git(worktree.path, ['status', '--porcelain']), worktree.links);
			if (status) {
				throw new Error('worktree 有未提交改动；先提交，或显式 force 删除');
			}
		}
		// 先摘掉指向外部的依赖链接，再删 worktree；否则 git 会看到未跟踪的链接。
		await unlinkWorktreeDeps(worktree).catch(() => undefined);
		await git(workspace.root, [
			'worktree',
			'remove',
			...(options.force ? ['--force'] : []),
			worktree.path,
		]);
		worktree.state = 'removed';
		worktree.removedAt = new Date().toISOString();
		await save();
		process.stdout.write(`[worktrees] 删除 ${id} ${worktree.branch}\n`);
		return snapshot(worktree);
	});
}

export interface WorktreeStatus {
	worktree: Worktree;
	clean: boolean;
	dirty: boolean;
	changes: string[];
	ahead: number;
	behind: number;
	commits: string[];
	diffStat: string;
	stagedStat: string;
}

export async function worktreeStatus(id: string): Promise<WorktreeStatus> {
	const worktree = getWorktree(id);
	if (!worktree) throw new Error(`未知 worktree：${id}`);
	if (worktree.state === 'removed') throw new Error(`worktree 已删除：${id}`);
	if (!(await pathExists(worktree.path))) throw new Error(`worktree 目录不存在：${worktree.path}`);
	const workspace = getWorkspace(worktree.workspaceId);
	const mainHead = workspace ? await git(workspace.root, ['rev-parse', 'HEAD']).catch(() => '') : '';

	const [status, diffStat, stagedStat, aheadText, behindText, commitsText] = await Promise.all([
		git(worktree.path, ['status', '--porcelain']),
		git(worktree.path, ['diff', '--stat']),
		git(worktree.path, ['diff', '--cached', '--stat']),
		git(worktree.path, ['rev-list', '--count', `${worktree.baseCommit}..HEAD`]),
		mainHead ? git(worktree.path, ['rev-list', '--count', `HEAD..${mainHead}`]) : Promise.resolve('0'),
		git(worktree.path, ['log', '--oneline', '--decorate=no', `${worktree.baseCommit}..HEAD`]),
	]);
	const ahead = Number(aheadText) || 0;
	const behind = Number(behindText) || 0;
	const changes = withoutLinkNoise(status, worktree.links) ? withoutLinkNoise(status, worktree.links).split('\n').filter(Boolean) : [];
	return {
		worktree: snapshot(worktree),
		clean: changes.length === 0,
		dirty: changes.length > 0,
		changes,
		ahead,
		behind,
		commits: commitsText ? commitsText.split('\n').filter(Boolean) : [],
		diffStat,
		stagedStat,
	};
}

/** 只用于启动日志/排障。 */
export function worktreeDebugInfo() {
	return { root: WORKTREE_ROOT, file: WORKTREES_FILE, count: worktrees.length };
}
