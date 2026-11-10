/**
 * 回归检查：worktree 依赖共享（docs/worktree-deps.md，P0）。
 *
 * 真起一个临时 git 仓库当 workspace，不连服务、不碰真实工作区：
 *   node scripts/check-worktree-deps.mjs
 *
 * 覆盖：创建即链接 / info-exclude 生效 / git clean 后自愈 / 安装拦截 /
 *       删除只摘链接不动主工作区 / mode:none 不链接。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = mkdtempSync(join(tmpdir(), 'pi-wt-deps-'));
const serverDir = join(resolve(fileURLToPath(new URL('..', import.meta.url))), 'server');
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** 造一个最小 git 仓库 + 被 ignore 的 node_modules。 */
const makeRepo = (name, { link = true } = {}) => {
	const repo = join(root, name);
	mkdirSync(join(repo, 'node_modules', 'dep'), { recursive: true });
	writeFileSync(join(repo, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
	writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
	writeFileSync(join(repo, 'README.md'), `# ${name}\n`);
	git(repo, ['init', '-q', '-b', 'main']);
	git(repo, ['config', 'user.email', 'check@example.com']);
	git(repo, ['config', 'user.name', 'check']);
	git(repo, ['add', '-A']);
	git(repo, ['commit', '-q', '-m', 'init']);
	return { repo, link };
};

const a = makeRepo('repo-a');
const b = makeRepo('repo-b');

process.env.PI_RUNTIME_DIR = join(root, 'runtime');
process.env.PI_WORKSPACES_FILE = join(root, 'workspaces.json');
process.env.PI_WORKSPACE = a.repo;
process.env.PI_WORKSPACE_DISCOVER = 'none';

writeFileSync(
	process.env.PI_WORKSPACES_FILE,
	JSON.stringify({
		version: 1,
		workspaces: [
			{ id: 'workspace', label: 'a', root: a.repo, kind: 'git', source: 'config' },
			// mode:none 不应链接
			{ id: 'repo-b', label: 'b', root: b.repo, kind: 'git', source: 'config', worktreeDeps: { mode: 'none' } },
		],
	}),
);

const workspaces = await import(join(serverDir, 'workspaces.ts'));
await workspaces.initWorkspaces();
const worktrees = await import(join(serverDir, 'worktrees.ts'));
await worktrees.initWorktrees();

let failed = 0;
const check = (ok, message) => {
	if (ok) return;
	failed += 1;
	console.error(`FAIL: ${message}`);
};

const isLink = (path) => {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
};

// 1. 创建即链接
const wt = await worktrees.createWorktree({ workspaceId: 'workspace' });
const link = join(wt.path, 'node_modules');
check(isLink(link), 'worktree 里 node_modules 应是符号链接');
check(resolve(wt.path, 'node_modules') && readFileSync(join(link, 'dep', 'index.js'), 'utf8').includes('module.exports'), '链接应能读到主工作区依赖');
check((wt.links ?? []).some((item) => item.path === 'node_modules'), 'links 应记录 node_modules');

// 2. info/exclude 生效 → worktree 不脏
check(git(wt.path, ['status', '--porcelain']) === '', 'worktree 不该因为链接变脏');
check(readFileSync(join(a.repo, '.git', 'info', 'exclude'), 'utf8').includes('/node_modules'), 'info/exclude 应写入 /node_modules');

// 3. git clean 删掉链接后自愈
rmSync(link, { force: true });
check(!existsSync(link), '前置：链接已删');
const added = await worktrees.ensureWorktreeLinks(wt.id);
check(added.length === 1 && isLink(link), 'ensureWorktreeLinks 应补回链接');

// 4. 安装拦截
check(Boolean(await worktrees.sharedDepsInstallBlock(wt.path, 'npm install lodash')), 'npm install 应被拦截');
check(Boolean(await worktrees.sharedDepsInstallBlock(wt.path, 'pnpm add -D vitest')), 'pnpm add 应被拦截');
check((await worktrees.sharedDepsInstallBlock(wt.path, 'npm run build')) === null, 'npm run build 不该被拦截');
check((await worktrees.sharedDepsInstallBlock(wt.path, 'PI_ALLOW_SHARED_DEPS=1 npm install lodash')) === null, '带逃生阀应放行');
check((await worktrees.sharedDepsInstallBlock(a.repo, 'npm install lodash')) === null, '主工作区（非链接）不该被拦截');

// 5. 删除只摘链接，不动主工作区
await worktrees.removeWorktree(wt.id, { force: true });
check(!existsSync(wt.path), 'worktree 目录应已删除');
check(existsSync(join(a.repo, 'node_modules', 'dep', 'index.js')), '主工作区 node_modules 应完好');

// 6. mode:none 不链接
const wtB = await worktrees.createWorktree({ workspaceId: 'repo-b' });
check(!existsSync(join(wtB.path, 'node_modules')), 'mode:none 不该创建链接');
await worktrees.removeWorktree(wtB.id, { force: true });

rmSync(root, { recursive: true, force: true });
if (failed) {
	console.error(`worktree-deps check: ${failed} 项失败`);
	process.exit(1);
}
console.log('worktree-deps check: ok (15/15)');
