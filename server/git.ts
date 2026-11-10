/**
 * Git 面板：当前工作区的仓库清单 + 只读状态（设计见 docs/git-panel.md）。
 *
 * 三条边界：
 *   1. 只跑只读 git 命令（rev-parse / symbolic-ref / status / log / rev-list），
 *      一律 execFile 直接调用，不拼 shell、不接受任意参数；
 *   2. 所有路径限制在注册的 workspace root 内，先 realpath 再判 containment；
 *   3. 唯一写盘是 PI_RUNTIME_DIR/git-repos.json（手动登记的仓库相对路径），不碰仓库本身。
 */

import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { getWorkspace } from './workspaces.ts';
import { getWorktree, listWorktrees } from './worktrees.ts';

const execFileAsync = promisify(execFile);

const RUNTIME_DIR = resolve(process.env.PI_RUNTIME_DIR ?? 'runtime');
const REPOS_FILE = resolve(process.env.PI_GIT_REPOS_FILE ?? join(RUNTIME_DIR, 'git-repos.json'));

/** 扫描时跳过的重目录：进这些目录只会变慢，不会多出仓库。 */
const SKIP_DIRS = new Set([
	'node_modules', 'dist', 'build', 'out', 'coverage', 'target', 'vendor',
	'.venv', 'venv', '__pycache__', '.next', '.nuxt', '.turbo', '.cache', '.idea', '.vscode',
]);
const MAX_SCAN_DEPTH = 2;
const MAX_SCAN_ENTRIES = 3000;
const MAX_REPOS = 40;
/** 改动清单上限：够看清整棵树，又不至于把几万条 untracked 塞给浏览器。 */
const MAX_CHANGES = 2000;
const REPO_CONCURRENCY = 4;
/** 提交记录默认条数：够看清分支拓扑，又不会让大仓库一次拉太多。 */
const MAX_LOG = 200;
/** 单条提交最多列多少个改动文件：够看清一次提交，又不至于把巨型合并塞给浏览器。 */
const MAX_COMMIT_FILES = 500;
const MAX_LOG_LIMIT = 500;
/** 目录扫描结果缓存：只缓存「哪些子目录是仓库」，仓库状态每次都现读。 */
const SCAN_TTL_MS = 15_000;

type RepoSource = 'root' | 'worktree' | 'manual' | 'scanned';

interface GitChange {
	code: string;
	path: string;
	staged: boolean;
}

interface GitRepoSummary {
	key: string;
	name: string;
	rel: string;
	path: string;
	source: RepoSource;
	branch: string | null;
	detached: boolean;
	upstream: string | null;
	ahead: number;
	behind: number;
	clean: boolean;
	changes: GitChange[];
	changesTotal: number;
	lastCommit: { sha: string; subject: string; author: string; date: string } | null;
	error?: string;
}

interface GitCommitRef {
	name: string;
	kind: 'head' | 'branch' | 'remote' | 'tag';
}

interface GitCommit {
	sha: string;
	short: string;
	parents: string[];
	author: string;
	date: string;
	subject: string;
	refs: GitCommitRef[];
}

/** 一行 = 一条提交 + 画图所需的泳道信息（布局在服务端算，前端只画线）。 */
interface GitCommitRow extends GitCommit {
	lane: number;
	laneCount: number;
	/** 这一行的泳道上面是否连着上一行（分支顶端为 false，不画上方竖线） */
	top: boolean;
	/** 直接穿过的泳道（竖线） */
	through: number[];
	/** 从别的泳道汇入本行 dot 的泳道 */
	incoming: number[];
	/** 本行 dot 到父提交的连线；to === from 表示竖直向下 */
	outgoing: { from: number; to: number }[];
}

interface GitBranch {
	/** 短名：本地分支是 main，远端分支是 origin/main */
	short: string;
	/** 完整 ref：refs/heads/main / refs/remotes/origin/main */
	full: string;
	/** 远端名（远端分支才有），例如 origin；一个仓库可能有多个远端 */
	remote: string | null;
	current: boolean;
	upstream: string | null;
	ahead: number;
	behind: number;
	sha: string;
	shortSha: string;
	date: string;
	subject: string;
}

export interface GitBranches {
	rel: string;
	path: string;
	/** 本地分支（当前分支排最前） */
	locals: GitBranch[];
	/** 远端分支，按远端名分组；remotes 的顺序按名字排序 */
	remotes: { name: string; branches: GitBranch[] }[];
}

interface GitCommitFile {
	path: string;
	/** A / M / D / T（--no-renames：重命名拆成 A+D） */
	status: string;
	additions: number | null;
	deletions: number | null;
}

export interface GitCommitDetail extends GitCommit {
	email: string;
	/** 完整提交信息（第一行是 subject，其余是正文） */
	body: string;
	files: GitCommitFile[];
	additions: number;
	deletions: number;
	truncated: boolean;
}

interface GitPanel {
	root: { id: string; label: string; path: string; workspaceId: string; workspaceLabel: string };
	repos: GitRepoSummary[];
	scannedAt: number;
}

interface ManualRepo {
	root: string;
	rel: string;
}

class GitError extends Error {
	status: number;
	code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = 'GitError';
		this.status = status;
		this.code = code;
	}
}

function badRequest(message: string) {
	return new GitError(400, 'git/bad-request', message);
}
function outsideRoot(message = '路径不在工作区内') {
	return new GitError(403, 'git/outside-root', message);
}
function notFound(message: string) {
	return new GitError(404, 'git/not-found', message);
}

async function git(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync('git', args, {
		cwd,
		timeout: 30_000,
		maxBuffer: 8 * 1024 * 1024,
		env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
	});
	return String(stdout).trim();
}

function within(path: string, root: string): boolean {
	return path === root || path.startsWith(root + sep);
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

/** 便宜的仓库判定：`.git` 是目录（普通仓库）或文件（gitdir 指针 / submodule）都算。 */
async function isGitDir(path: string): Promise<boolean> {
	return pathExists(join(path, '.git'));
}

/** 空字符串表示 root；拒绝 NUL 与逃出 root 的 `..`。 */
function normalizeRel(input: string): string {
	if (input.includes('\0')) throw badRequest('路径包含非法字符');
	const parts: string[] = [];
	for (const part of input.replace(/\\/g, '/').replace(/^\/+/, '').split('/')) {
		if (!part || part === '.') continue;
		if (part === '..') {
			if (!parts.length) throw outsideRoot();
			parts.pop();
			continue;
		}
		parts.push(part);
	}
	return parts.join('/');
}

// ---------------------------------------------------------------- 手动登记

let manualCache: ManualRepo[] | null = null;
let manualWrite: Promise<void> = Promise.resolve();

async function loadManual(): Promise<ManualRepo[]> {
	if (manualCache) return manualCache;
	try {
		const raw = JSON.parse(await readFile(REPOS_FILE, 'utf8'));
		const list = Array.isArray(raw?.repos) ? raw.repos : [];
		manualCache = list
			.filter((item: any) => typeof item?.root === 'string' && typeof item?.rel === 'string' && item.rel)
			.map((item: any) => ({ root: item.root, rel: normalizeRel(item.rel) }))
			.filter((item: ManualRepo) => Boolean(item.rel));
	} catch {
		// 文件不存在 / 手工改坏：当作空表，下次写入时重建。
		manualCache = [];
	}
	return manualCache;
}

async function saveManual(list: ManualRepo[]): Promise<void> {
	manualCache = list;
	manualWrite = manualWrite.then(async () => {
		await mkdir(dirname(REPOS_FILE), { recursive: true });
		const tmp = `${REPOS_FILE}.${process.pid}.tmp`;
		await writeFile(tmp, JSON.stringify({ version: 1, repos: list }, null, 2) + '\n', 'utf8');
		await rename(tmp, REPOS_FILE);
	});
	return manualWrite;
}

// ---------------------------------------------------------------- 根解析

interface PanelRoot {
	id: string;
	label: string;
	path: string;
	workspaceId: string;
	workspaceLabel: string;
}

interface PanelQuery {
	root?: string;
	worktree?: string;
	refresh?: boolean;
}

/** `root` 参数既接受 workspace id，也接受 worktree id（文件 API 的约定一致）。 */
async function resolvePanelRoot(input: PanelQuery): Promise<PanelRoot> {
	const id = String(input.root ?? '').trim() || 'workspace';
	const worktree = listWorktrees().find((item) => item.id === id);
	const workspaceLookup = worktree ? getWorkspace(worktree.workspaceId) : getWorkspace(id);
	if (!workspaceLookup) throw badRequest(`未知工作区：${id}`);
	if (workspaceLookup.available === false) {
		throw new GitError(409, 'git/workspace-unavailable', `工作区目录不存在：${workspaceLookup.label}（${workspaceLookup.root}）`);
	}
	const raw = worktree ? worktree.path : workspaceLookup.root;
	if (worktree && (worktree.available === false || worktree.state === 'missing')) {
		throw new GitError(409, 'git/worktree-unavailable', `worktree 目录不存在：${worktree.branch}（${worktree.path}）`);
	}
	const real = await realpath(raw).catch(() => resolve(raw));
	return {
		id: worktree ? worktree.id : workspaceLookup.id,
		label: worktree ? worktree.branch : workspaceLookup.label,
		path: real,
		workspaceId: workspaceLookup.id,
		workspaceLabel: workspaceLookup.label,
	};
}

// ---------------------------------------------------------------- 扫描

const scanCache = new Map<string, { at: number; paths: string[] }>();

async function scanRepos(root: string, force: boolean): Promise<string[]> {
	const cached = scanCache.get(root);
	if (!force && cached && Date.now() - cached.at < SCAN_TTL_MS) return cached.paths;

	const found: string[] = [];
	let seen = 0;
	const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
	while (queue.length && found.length < MAX_REPOS && seen < MAX_SCAN_ENTRIES) {
		const current = queue.shift()!;
		let entries;
		try {
			entries = await readdir(current.dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			// 只跟真实目录：符号链接可能指向工作区外，直接跳过。
			if (!entry.isDirectory()) continue;
			if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
			seen += 1;
			if (seen > MAX_SCAN_ENTRIES) break;
			const child = join(current.dir, entry.name);
			if (await isGitDir(child)) {
				found.push(child);
				if (found.length >= MAX_REPOS) break;
				continue; // 仓库内部不再下探，避免把 vendored 仓库全翻出来
			}
			if (current.depth + 1 < MAX_SCAN_DEPTH) queue.push({ dir: child, depth: current.depth + 1 });
		}
	}
	scanCache.set(root, { at: Date.now(), paths: found });
	return found;
}

// ---------------------------------------------------------------- 状态

function parseChanges(raw: string): { changes: GitChange[]; total: number } {
	const parts = raw.split('\0');
	const changes: GitChange[] = [];
	let total = 0;
	for (let index = 0; index < parts.length; index += 1) {
		const entry = parts[index];
		if (!entry || entry.length < 4) continue;
		const code = entry.slice(0, 2);
		const path = entry.slice(3);
		if (code[0] === 'R' || code[0] === 'C') index += 1; // -z 格式里重命名后跟一个原路径
		total += 1;
		if (changes.length >= MAX_CHANGES) continue;
		changes.push({ code, path, staged: code[0] !== ' ' && code[0] !== '?' });
	}
	return { changes, total };
}

async function summarize(
	path: string,
	input: { rel: string; source: RepoSource; key: string; label?: string },
): Promise<GitRepoSummary> {
	const base: GitRepoSummary = {
		key: input.key,
		name: input.label || (input.rel ? basename(input.rel) : basename(path)),
		rel: input.rel,
		path,
		source: input.source,
		branch: null,
		detached: false,
		upstream: null,
		ahead: 0,
		behind: 0,
		clean: true,
		changes: [],
		changesTotal: 0,
		lastCommit: null,
	};
	try {
		if (!(await isGitDir(path))) throw new Error('不是 git 仓库（缺少 .git）');

		// 未出生的分支（空仓库）上 rev-parse --abbrev-ref 会失败，symbolic-ref 能拿到分支名。
		const symbolic = await git(path, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '');
		const detached = !symbolic;
		const branch = symbolic || (await git(path, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')) || null;

		const [statusRaw, upstreamRaw, logRaw] = await Promise.all([
			git(path, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).catch(() => ''),
			git(path, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']).catch(() => ''),
			git(path, ['log', '-1', '--format=%h%x1f%s%x1f%an%x1f%cI']).catch(() => ''),
		]);

		const { changes, total } = parseChanges(statusRaw);
		let ahead = 0;
		let behind = 0;
		if (upstreamRaw) {
			const counts = await git(path, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']).catch(() => '');
			const [behindText, aheadText] = counts.split(/\s+/);
			behind = Number(behindText) || 0;
			ahead = Number(aheadText) || 0;
		}
		const [sha, subject, author, date] = logRaw ? logRaw.split('\x1f') : [];
		return {
			...base,
			branch,
			detached,
			upstream: upstreamRaw || null,
			ahead,
			behind,
			clean: total === 0,
			changes,
			changesTotal: total,
			lastCommit: sha ? { sha, subject: subject ?? '', author: author ?? '', date: date ?? '' } : null,
		};
	} catch (error) {
		return { ...base, error: error instanceof Error ? error.message : String(error) };
	}
}

/** 小并发池：几十个仓库同时开 6 条 git 命令会打满进程数。 */
async function mapLimit<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let cursor = 0;
	async function worker() {
		while (cursor < items.length) {
			const index = cursor;
			cursor += 1;
			results[index] = await run(items[index]);
		}
	}
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

interface RepoCandidate {
	path: string;
	rel: string;
	source: RepoSource;
	label?: string;
}

/** 仓库清单：根仓库 + 当前工作树 + 手动登记 + 自动扫描（≤2 层）。 */
export async function gitPanel(input: PanelQuery = {}): Promise<GitPanel> {
	const root = await resolvePanelRoot(input);
	const force = input.refresh === true;
	const candidates: RepoCandidate[] = [];
	const seen = new Set<string>();

	const add = async (path: string, source: RepoSource, label?: string) => {
		const real = await realpath(path).catch(() => resolve(path));
		if (seen.has(real)) return;
		seen.add(real);
		// worktree 的路径在 workspace 外（来自注册表），rel 留空，用 branch 当作名字。
		const rel = source === 'worktree' ? '' : relative(root.path, real);
		candidates.push({ path: real, rel, source, label });
	};

	// 1. 工作区根自己
	if (await isGitDir(root.path)) await add(root.path, 'root');

	// 2. 当前会话的隔离工作树（路径在工作区外，但来自注册表，不是用户输入）
	const worktreeId = String(input.worktree ?? '').trim();
	if (worktreeId) {
		const worktree = getWorktree(worktreeId);
		if (worktree && worktree.workspaceId === root.workspaceId && worktree.state !== 'removed') {
			if (await isDirectory(worktree.path)) await add(worktree.path, 'worktree', worktree.branch);
		}
	}

	// 3. 手动登记：相对工作区根保存，先于自动扫描，保证手动优先
	for (const entry of await loadManual()) {
		if (entry.root !== root.id) continue;
		const abs = resolve(root.path, entry.rel);
		if (!within(abs, root.path)) continue;
		if (await isDirectory(abs)) await add(abs, 'manual');
	}

	// 4. 自动扫描 ≤2 层子目录
	for (const path of await scanRepos(root.path, force)) await add(path, 'scanned');

	const repos = await mapLimit(candidates, REPO_CONCURRENCY, (candidate) =>
		summarize(candidate.path, {
			rel: candidate.rel,
			source: candidate.source,
			label: candidate.label,
			key: `${root.id}:${candidate.source}:${candidate.rel || candidate.path}`,
		}),
	);
	return {
		root: {
			id: root.id,
			label: root.label,
			path: root.path,
			workspaceId: root.workspaceId,
			workspaceLabel: root.workspaceLabel,
		},
		repos,
		scannedAt: Date.now(),
	};
}

// ---------------------------------------------------------------- 写操作

/** 手动登记一个仓库：接受相对工作区根的路径，或工作区内的绝对路径。 */
export async function gitAddRepo(input: PanelQuery & { path?: string }): Promise<GitPanel> {
	const root = await resolvePanelRoot(input);
	const raw = String(input.path ?? '').trim();
	if (!raw) throw badRequest('请填写仓库路径');

	const absolute = raw.startsWith('/');
	const target = absolute ? resolve(raw) : resolve(root.path, normalizeRel(raw));
	if (!within(target, root.path)) throw outsideRoot();
	if (!(await isDirectory(target))) throw notFound(`目录不存在：${raw}`);

	const real = await realpath(target).catch(() => target);
	if (!within(real, root.path)) throw outsideRoot();
	if (!(await isDirectory(real))) throw badRequest(`${raw} 不是目录`);

	// 允许填仓库内的子目录：一律归一到仓库根，避免同一个仓库登记多次。
	const toplevelRaw = await git(real, ['rev-parse', '--show-toplevel']).catch(() => '');
	if (!toplevelRaw) throw badRequest(`${raw} 不是 git 仓库`);
	const toplevel = await realpath(toplevelRaw).catch(() => resolve(toplevelRaw));
	if (!within(toplevel, root.path)) throw outsideRoot('仓库根不在本工作区内');
	const rel = relative(root.path, toplevel);
	if (!rel) throw badRequest('工作区根已经是仓库，无需添加');

	const list = await loadManual();
	if (!list.some((item) => item.root === root.id && item.rel === rel)) {
		await saveManual([...list, { root: root.id, rel }]);
	}
	return gitPanel(input);
}

/** 只删手动登记这一层索引，不动目录。 */
export async function gitRemoveRepo(input: PanelQuery & { path?: string }): Promise<GitPanel> {
	const root = await resolvePanelRoot(input);
	const raw = String(input.path ?? '').trim();
	if (!raw) throw badRequest('请填写仓库路径');
	const target = raw.startsWith('/') ? resolve(raw) : resolve(root.path, normalizeRel(raw));
	const rel = raw.startsWith('/') ? relative(root.path, target) : normalizeRel(raw);

	const list = await loadManual();
	const next = list.filter((item) => !(item.root === root.id && item.rel === rel));
	if (next.length === list.length) throw notFound('这条仓库不是手动登记的，不能移除');
	await saveManual(next);
	return gitPanel(input);
}

// ---------------------------------------------------------------- 提交记录

/** %D（带 --decorate=full）→ 结构化 refs：HEAD 优先，其次分支 / 远端 / tag。 */
function parseRefs(raw: string): GitCommitRef[] {
	const refs: GitCommitRef[] = [];
	const push = (name: string, kind: GitCommitRef['kind']) => {
		const clean = name.trim();
		if (!clean) return;
		if (refs.some((ref) => ref.name === clean && ref.kind === kind)) return;
		refs.push({ name: clean, kind });
	};
	const rank = { head: 0, branch: 1, remote: 2, tag: 3 } as const;
	for (const entry of raw.split(',')) {
		const item = entry.trim();
		if (!item) continue;
		if (item.startsWith('HEAD -> ')) {
			const target = item.slice('HEAD -> '.length);
			push('HEAD', 'head');
			if (target.startsWith('refs/heads/')) push(target.slice('refs/heads/'.length), 'branch');
			else push(target.replace(/^refs\//, ''), 'branch');
			continue;
		}
		if (item === 'HEAD') {
			push('HEAD', 'head');
			continue;
		}
		if (item.startsWith('tag: ')) {
			push(item.slice(5).replace(/^refs\/tags\//, ''), 'tag');
			continue;
		}
		if (item.startsWith('refs/remotes/')) {
			push(item.slice('refs/remotes/'.length), 'remote');
			continue;
		}
		if (item.startsWith('refs/heads/')) {
			push(item.slice('refs/heads/'.length), 'branch');
			continue;
		}
		if (item === 'refs/stash' || item === 'stash') continue; // stash 不算分支
		push(item.replace(/^refs\//, ''), 'branch');
	}
	return refs.sort((a, b) => rank[a.kind] - rank[b.kind] || a.name.localeCompare(b.name));
}

/** git 的 %x1f / %x1e 会变成真实控制字符，所以分隔符用真实字符而不是 '%x1f' 字面量。 */
const LOG_FIELD = '\x1f';
const LOG_RECORD = '\x1e';
const LOG_FORMAT = ['%H', '%h', '%P', '%an', '%aI', '%D', '%s'].join('%x1f') + '%x1e';

async function readLog(path: string, limit: number, ref: string | null = null): Promise<GitCommit[]> {
	const raw = await git(path, [
		'log',
		...(ref ? [ref] : ['--all']),
		// 拓扑序保证「父提交一定排在子提交之后」，泳道算法依赖这一点（同一秒提交也不会乱序）
		'--topo-order',
		'--decorate=full',
		'--date=iso-strict',
		`--max-count=${limit}`,
		`--pretty=format:${LOG_FORMAT}`,
	]).catch(() => '');
	const commits: GitCommit[] = [];
	for (const record of raw.split(LOG_RECORD)) {
		const line = record.replace(/^\n+/, '');
		if (!line) continue;
		const parts = line.split(LOG_FIELD);
		if (parts.length < 7) continue;
		const [sha, short, parents, author, date, decorate, ...rest] = parts;
		commits.push({
			sha,
			short,
			parents: parents ? parents.split(' ').filter(Boolean) : [],
			author,
			date,
			subject: rest.join(LOG_FIELD),
			refs: parseRefs(decorate ?? ''),
		});
	}
	return commits;
}

/**
 * 泳道布局（git log --graph 的简化版）：按 git 给的顺序自上而下走一遍，
 * 记录每条泳道在等哪个父提交，就能得到每行要画的竖线 / 汇入 / 分叉。
 */
export function layoutGraph(commits: GitCommit[]): GitCommitRow[] {
	const lanes: (string | null)[] = [];
	const rows: GitCommitRow[] = [];
	for (const commit of commits) {
		let lane = lanes.findIndex((hash) => hash === commit.sha);
		const fresh = lane === -1;
		if (fresh) {
			lane = lanes.findIndex((hash) => hash == null);
			if (lane === -1) lane = lanes.length;
		}
		const top = !fresh;
		lanes[lane] = commit.sha;

		// 别的泳道也在等这个提交：它们在上一行就已经在等，这里汇进本行 dot
		const incoming: number[] = [];
		for (let index = 0; index < lanes.length; index += 1) {
			if (index !== lane && lanes[index] === commit.sha) {
				incoming.push(index);
				lanes[index] = null;
			}
		}

		const busy = new Set<number>([lane, ...incoming]);
		const through: number[] = [];
		for (let index = 0; index < lanes.length; index += 1) {
			if (lanes[index] != null && !busy.has(index)) through.push(index);
		}

		const outgoing: { from: number; to: number }[] = [];
		commit.parents.forEach((parent, index) => {
			const existing = lanes.findIndex((hash) => hash === parent);
			if (existing !== -1) {
				// 父提交已经在别的泳道上：斜过去汇合（合并提交 / 分支收敛）
				outgoing.push({ from: lane, to: existing });
				if (index === 0) lanes[lane] = null;
				return;
			}
			if (index === 0 && lanes[lane] === commit.sha) {
				lanes[lane] = parent;
				outgoing.push({ from: lane, to: lane });
				return;
			}
			let slot = lanes.findIndex((hash) => hash == null);
			if (slot === -1) slot = lanes.length;
			lanes[slot] = parent;
			outgoing.push({ from: lane, to: slot });
		});
		if (!commit.parents.length) lanes[lane] = null;
		while (lanes.length && lanes[lanes.length - 1] == null) lanes.pop();

		const laneCount = Math.max(
			lane + 1,
			...incoming.map((value) => value + 1),
			...through.map((value) => value + 1),
			...outgoing.map((edge) => edge.to + 1),
		);
		rows.push({ ...commit, lane, laneCount, top, through, incoming, outgoing });
	}
	return rows;
}

/** rel → 仓库绝对路径：realpath 后再判一次 containment，最后确认它真的是 git 仓库。 */
async function resolveRepoRoot(root: PanelRoot, rel: string): Promise<string> {
	const target = resolve(root.path, rel);
	if (!within(target, root.path)) throw outsideRoot();
	const real = await realpath(target).catch(() => target);
	if (!within(real, root.path)) throw outsideRoot();
	if (!(await isDirectory(real))) throw notFound(`仓库不存在：${rel || root.label}`);
	if (!(await isGitDir(real))) throw notFound(`不是 git 仓库：${rel || root.label}`);
	return real;
}

/** 只接受 refs/heads 与 refs/remotes 下真实存在的 ref（挡任意 revision 与 --option 注入）。 */
async function resolveLogRef(path: string, input: string): Promise<string | null> {
	const raw = input.trim();
	if (!raw) return null;
	if (!/^refs\/(heads|remotes)\/[A-Za-z0-9._\/-]{1,240}$/.test(raw)) throw badRequest('分支名不合法');
	const sha = await git(path, ['rev-parse', '--verify', '--quiet', `${raw}^{commit}`]).catch(() => '');
	if (!sha) throw notFound(`分支不存在：${raw}`);
	return raw;
}

const BRANCH_FORMAT = [
	'%(refname)',
	'%(refname:short)',
	'%(objectname)',
	'%(objectname:short)',
	'%(HEAD)',
	'%(upstream:short)',
	'%(upstream:track)',
	'%(committerdate:iso-strict)',
	'%(contents:subject)',
	// for-each-ref 用 %1f 表示十六进制字节，不是 log 的 %x1f
].join('%1f');

function parseTrack(raw: string): { ahead: number; behind: number } {
	const ahead = /ahead (\d+)/.exec(raw)?.[1];
	const behind = /behind (\d+)/.exec(raw)?.[1];
	return { ahead: Number(ahead) || 0, behind: Number(behind) || 0 };
}

/** 本地分支 + 远端分支（远端可能有多个，按远端名分组）。只读 for-each-ref。 */
export async function gitBranches(
	input: PanelQuery & { rel?: string },
): Promise<GitBranches> {
	const root = await resolvePanelRoot(input);
	const rel = normalizeRel(String(input.rel ?? ''));
	const real = await resolveRepoRoot(root, rel);
	const raw = await git(real, [
		'for-each-ref',
		`--format=${BRANCH_FORMAT}`,
		'--sort=-committerdate',
		'refs/heads',
		'refs/remotes',
	]).catch(() => '');

	const locals: GitBranch[] = [];
	const remoteGroups = new Map<string, GitBranch[]>();
	for (const line of raw.split('\n')) {
		if (!line.trim()) continue;
		const [full, short, sha, shortSha, head, upstream, track, date, ...subjectParts] = line.split('\x1f');
		if (!full || !short) continue;
		const subject = subjectParts.join('\x1f');
		if (full.startsWith('refs/remotes/')) {
			// origin/HEAD 这类符号引用不算分支
			if (/(^|\/)HEAD$/.test(full)) continue;
			const name = full.slice('refs/remotes/'.length);
			const remote = name.includes('/') ? name.slice(0, name.indexOf('/')) : name;
			const branch: GitBranch = {
				short,
				full,
				remote,
				current: false,
				upstream: null,
				...parseTrack(track ?? ''),
				sha,
				shortSha,
				date,
				subject,
			};
			const list = remoteGroups.get(remote) ?? [];
			list.push(branch);
			remoteGroups.set(remote, list);
			continue;
		}
		locals.push({
			short,
			full,
			remote: null,
			current: (head ?? '').trim() === '*',
			upstream: upstream || null,
			...parseTrack(track ?? ''),
			sha,
			shortSha,
			date,
			subject,
		});
	}

	// 当前分支排最前，其余按最近提交排（for-each-ref 已经按 committerdate 倒序）
	locals.sort((a, b) => Number(b.current) - Number(a.current));
	const remotes = [...remoteGroups.entries()]
		.sort((a, b) => a[0].localeCompare(b[0]))
		.map(([name, branches]) => ({ name, branches }));
	return { rel: relative(root.path, real), path: real, locals, remotes };
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function parseNumstat(raw: string): Map<string, { additions: number | null; deletions: number | null }> {
	const counts = new Map<string, { additions: number | null; deletions: number | null }>();
	for (const line of raw.split('\n')) {
		if (!line.trim()) continue;
		const [adds, dels, ...rest] = line.split('\t');
		const path = rest.join('\t');
		if (!path) continue;
		counts.set(path, {
			additions: adds === '-' ? null : Number(adds) || 0,
			deletions: dels === '-' ? null : Number(dels) || 0,
		});
	}
	return counts;
}

function parseNameStatus(raw: string): { status: string; path: string }[] {
	const files: { status: string; path: string }[] = [];
	for (const line of raw.split('\n')) {
		if (!line.trim()) continue;
		const [code, ...rest] = line.split('\t');
		const path = rest.join('\t');
		if (!code || !path) continue;
		files.push({ status: code.trim().charAt(0) || 'M', path });
	}
	return files;
}

/** 单条提交的详情：提交信息 + 相对第一个父提交的改动文件清单（合并提交也看第一个父）。 */
export async function gitCommit(
	input: PanelQuery & { rel?: string; sha?: string },
): Promise<GitCommitDetail> {
	const root = await resolvePanelRoot(input);
	const rel = normalizeRel(String(input.rel ?? ''));
	const real = await resolveRepoRoot(root, rel);

	const sha = String(input.sha ?? '').trim();
	// 只收 4~40 位十六进制：避免把任意字符串当 revision 传进 git（也能挡住 --option 注入）
	if (!/^[0-9a-f]{4,40}$/i.test(sha)) throw badRequest('提交号不合法');

	const meta = await git(real, [
		'show',
		'-s',
		'--no-color',
		'--decorate=full',
		`--format=%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%D%x1f%B`,
		sha,
	]).catch(() => '');
	const parts = meta ? meta.split('\x1f') : [];
	if (parts.length < 8) throw notFound(`找不到提交：${sha}`);
	const [fullSha, short, parentText, author, email, date, decorate, ...bodyParts] = parts;
	const message = bodyParts.join('\x1f').replace(/\s+$/, '');
	const [firstLine, ...restLines] = message.split('\n');

	const parents = parentText ? parentText.split(' ').filter(Boolean) : [];
	const base = parents[0] ?? EMPTY_TREE;
	const [nameStatusRaw, numstatRaw] = await Promise.all([
		git(real, ['diff', '--name-status', '--no-renames', '--no-color', base, fullSha]).catch(() => ''),
		git(real, ['diff', '--numstat', '--no-renames', '--no-color', base, fullSha]).catch(() => ''),
	]);
	const counts = parseNumstat(numstatRaw);
	const all = parseNameStatus(nameStatusRaw);
	let additions = 0;
	let deletions = 0;
	for (const item of all) {
		const count = counts.get(item.path);
		if (!count) continue;
		additions += count.additions ?? 0;
		deletions += count.deletions ?? 0;
	}
	const files: GitCommitFile[] = all.slice(0, MAX_COMMIT_FILES).map((item) => ({
		path: item.path,
		status: item.status,
		additions: counts.get(item.path)?.additions ?? null,
		deletions: counts.get(item.path)?.deletions ?? null,
	}));

	return {
		sha: fullSha,
		short,
		parents,
		author,
		email,
		date,
		subject: firstLine ?? '',
		body: restLines.join('\n').trim(),
		refs: parseRefs(decorate ?? ''),
		files,
		additions,
		deletions,
		truncated: all.length > files.length,
	};
}

export interface GitLogResult {
	rel: string;
	path: string;
	commits: GitCommitRow[];
	limit: number;
	hasMore: boolean;
}

/** 单仓库的提交记录：只读 git log，路径同样限制在工作区内。 */
export async function gitLog(
	input: PanelQuery & { rel?: string; limit?: number; ref?: string },
): Promise<GitLogResult> {
	const root = await resolvePanelRoot(input);
	const rel = normalizeRel(String(input.rel ?? ''));
	const real = await resolveRepoRoot(root, rel);
	const ref = await resolveLogRef(real, String(input.ref ?? ''));

	const requested = Number(input.limit ?? MAX_LOG);
	const limit = Math.min(Math.max(Number.isFinite(requested) ? Math.trunc(requested) : MAX_LOG, 1), MAX_LOG_LIMIT);
	const commits = await readLog(real, limit, ref);
	const totalRaw = await git(real, ['rev-list', ...(ref ? [ref] : ['--all']), '--count']).catch(() => '');
	const total = Number(totalRaw) || commits.length;
	return {
		rel: relative(root.path, real),
		path: real,
		commits: layoutGraph(commits),
		limit,
		hasMore: total > commits.length,
	};
}

// ---------------------------------------------------------------- HTTP

function sendJson(res: ServerResponse, status: number, body: unknown) {
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
	});
	res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, error: unknown) {
	const err =
		error instanceof GitError
			? error
			: new GitError(500, 'git/internal', error instanceof Error ? error.message : String(error));
	sendJson(res, err.status, { error: err.message, code: err.code });
}

async function readJson(req: IncomingMessage): Promise<any> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	if (!chunks.length) return {};
	try {
		return JSON.parse(Buffer.concat(chunks).toString('utf8'));
	} catch {
		throw badRequest('请求体不是合法 JSON');
	}
}

/** GET /api/git/repos?root=&worktree=&refresh=1；POST 登记/移除手动仓库。 */
export async function handleGit(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
	const query = {
		root: url.searchParams.get('root') ?? '',
		worktree: url.searchParams.get('worktree') ?? '',
		refresh: url.searchParams.get('refresh') === '1',
	};
	try {
		const endpoint = url.pathname.slice('/api/git/'.length);
		const method = req.method ?? 'GET';
		if (endpoint === 'repos') {
			if (method === 'GET') return sendJson(res, 200, await gitPanel(query));
			if (method === 'POST') {
				const body = await readJson(req);
				return sendJson(res, 200, await gitAddRepo({ ...query, path: String(body?.path ?? '') }));
			}
			throw new GitError(405, 'git/method-not-allowed', '只支持 GET/POST');
		}
		if (endpoint === 'branches') {
			if (method !== 'GET') throw new GitError(405, 'git/method-not-allowed', '只支持 GET');
			return sendJson(res, 200, await gitBranches({ ...query, rel: url.searchParams.get('rel') ?? '' }));
		}
		if (endpoint === 'log') {
			if (method !== 'GET') throw new GitError(405, 'git/method-not-allowed', '只支持 GET');
			return sendJson(
				res,
				200,
				await gitLog({
					...query,
					rel: url.searchParams.get('rel') ?? '',
					ref: url.searchParams.get('ref') ?? '',
					limit: Number(url.searchParams.get('limit') ?? '') || undefined,
				}),
			);
		}
		if (endpoint === 'commit') {
			if (method !== 'GET') throw new GitError(405, 'git/method-not-allowed', '只支持 GET');
			return sendJson(
				res,
				200,
				await gitCommit({
					...query,
					rel: url.searchParams.get('rel') ?? '',
					sha: url.searchParams.get('sha') ?? '',
				}),
			);
		}
		if (endpoint === 'repos/remove') {
			if (method !== 'POST') throw new GitError(405, 'git/method-not-allowed', '只支持 POST');
			const body = await readJson(req);
			return sendJson(res, 200, await gitRemoveRepo({ ...query, path: String(body?.path ?? '') }));
		}
		throw new GitError(404, 'git/not-found', '未知 git 接口');
	} catch (error) {
		sendError(res, error);
	}
}
