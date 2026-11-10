/**
 * 回归检查：Git 面板（server/git.ts）的仓库发现、扫描边界、手动登记与只读状态。
 *
 *   node scripts/check-git-panel.mjs
 *
 * 全部在临时目录里造 git 仓库，不碰真实工作区。
 * 背景见 docs/git-panel.md。
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
const serverDir = join(repoDir, 'server');

const root = await mkdtemp(join(tmpdir(), 'pi-git-panel-'));
const ws = join(root, 'ws');
process.env.PI_RUNTIME_DIR = join(root, 'runtime');
process.env.PI_WORKSPACES_FILE = join(root, 'workspaces.json');
process.env.PI_GIT_REPOS_FILE = join(root, 'git-repos.json');
process.env.PI_WORKSPACE = ws;
process.env.PI_WORKSPACE_DISCOVER = 'none';
process.env.PI_WORKTREE_ROOT = join(root, 'worktrees');

const git = (cwd, args) =>
	execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function initRepo(dir) {
	await mkdir(dir, { recursive: true });
	git(dir, ['init', '-q', '-b', 'main']);
	await writeFile(join(dir, 'a.txt'), 'a\n');
	git(dir, ['add', '.']);
	git(dir, ['-c', 'user.email=t@example.com', '-c', 'user.name=tester', 'commit', '-qm', 'init']);
}

let failed = 0;
let total = 0;
const check = (ok, message, extra) => {
	total += 1;
	if (ok) return;
	failed += 1;
	console.error(`FAIL: ${message}${extra === undefined ? '' : ` → ${JSON.stringify(extra)}`}`);
};
const names = (panel) => panel.repos.map((repo) => `${repo.source}:${repo.rel || '<root>'}`).sort();

// ---------- 造样本 ----------
await initRepo(ws); // 工作区根就是仓库
await initRepo(join(ws, 'sub/repoA')); // 第 2 层
await initRepo(join(ws, 'top/repoB')); // 第 2 层
await initRepo(join(ws, 'a/b/repoC')); // 第 3 层：自动扫描不该发现
await initRepo(join(ws, 'node_modules/vendored')); // 跳过目录：不该发现
await mkdir(join(ws, 'plain'), { recursive: true });
await writeFile(join(ws, 'plain/readme.txt'), 'not a repo\n');

const workspaces = await import(join(serverDir, 'workspaces.ts'));
await workspaces.initWorkspaces();
const gitPanel = await import(join(serverDir, 'git.ts'));

// ---------- 1. 发现 + 扫描边界 ----------
let panel = await gitPanel.gitPanel({ root: 'workspace' });
check(panel.root.path === ws, 'root 指向工作区', panel.root);
check(
	JSON.stringify(names(panel)) === JSON.stringify(['root:<root>', 'scanned:sub/repoA', 'scanned:top/repoB']),
	'只发现根仓库和两层内的子仓库（跳过 node_modules、第 3 层、非仓库目录）',
	names(panel),
);
const rootRepo = panel.repos.find((repo) => repo.source === 'root');
check(rootRepo?.branch === 'main', '根仓库分支是 main', rootRepo?.branch);
check(rootRepo?.lastCommit?.subject === 'init', '根仓库显示最后一条提交', rootRepo?.lastCommit);
check(rootRepo?.error === undefined, '根仓库状态读取没有报错', rootRepo?.error);
const cleanRepo = panel.repos.find((repo) => repo.rel === 'sub/repoA');
check(cleanRepo?.clean === true, '未改动的子仓库是干净的', cleanRepo?.changesTotal);

// ---------- 2. 状态是现读的（不跟扫描缓存走） ----------
await writeFile(join(ws, 'sub/repoA/dirty.txt'), 'x\n');
panel = await gitPanel.gitPanel({ root: 'workspace', refresh: false });
const dirtyRepo = panel.repos.find((repo) => repo.rel === 'sub/repoA');
check(dirtyRepo?.clean === false && dirtyRepo?.changesTotal === 1, '未跟踪文件让仓库变脏', dirtyRepo?.changes);
check(dirtyRepo?.changes[0]?.code === '??', 'porcelain 状态码是 ??', dirtyRepo?.changes?.[0]);

// ---------- 3. 手动登记：去重、归一子目录、超出扫描深度也认 ----------
panel = await gitPanel.gitAddRepo({ root: 'workspace', path: 'sub/repoA' });
check(panel.repos.length === 3, '手动登记已在扫描列表里的仓库不重复', names(panel));
check(
	panel.repos.some((repo) => repo.rel === 'sub/repoA' && repo.source === 'manual'),
	'手动登记优先于自动扫描',
	names(panel),
);

await mkdir(join(ws, 'sub/repoA/src'), { recursive: true });
panel = await gitPanel.gitAddRepo({ root: 'workspace', path: 'sub/repoA/src' });
check(!panel.repos.some((repo) => repo.rel === 'sub/repoA/src'), '填仓库内子目录会归一到仓库根', names(panel));

panel = await gitPanel.gitAddRepo({ root: 'workspace', path: 'a/b/repoC' });
check(
	panel.repos.some((repo) => repo.rel === 'a/b/repoC' && repo.source === 'manual'),
	'手动可以登记扫描深度之外的仓库',
	names(panel),
);

panel = await gitPanel.gitAddRepo({ root: 'workspace', path: join(ws, 'top/repoB') });
check(panel.repos.some((repo) => repo.rel === 'top/repoB' && repo.source === 'manual'), '绝对路径也能登记');

// ---------- 4. 越界与非法输入 ----------
const expectError = async (label, run, status) => {
	try {
		await run();
		check(false, `${label} 应该失败`);
	} catch (error) {
		check(error?.status === status, `${label} 返回 ${status}`, { status: error?.status, message: error?.message });
	}
};
await expectError('…/../ 越界', () => gitPanel.gitAddRepo({ root: 'workspace', path: '../outside' }), 403);
await expectError('绝对路径越界', () => gitPanel.gitAddRepo({ root: 'workspace', path: '/etc' }), 403);
await expectError('非仓库目录', () => gitPanel.gitAddRepo({ root: 'workspace', path: 'plain' }), 400);
await expectError('工作区根无需登记', () => gitPanel.gitAddRepo({ root: 'workspace', path: '' }), 400);
await expectError('不存在的目录', () => gitPanel.gitAddRepo({ root: 'workspace', path: 'nope' }), 404);

// ---------- 5. 移除手动登记：仓库回到自动扫描 ----------
panel = await gitPanel.gitRemoveRepo({ root: 'workspace', path: 'sub/repoA' });
check(
	panel.repos.some((repo) => repo.rel === 'sub/repoA' && repo.source === 'scanned'),
	'移除手动登记后仓库回落为自动发现',
	names(panel),
);
await expectError('移除未登记的仓库', () => gitPanel.gitRemoveRepo({ root: 'workspace', path: 'sub/repoA' }), 404);

const saved = JSON.parse(await readFile(process.env.PI_GIT_REPOS_FILE, 'utf8'));
check(saved.repos.length === 2, '手动登记落盘（repoA 移除后剩 repoC / repoB）', saved.repos);
check(saved.repos.every((item) => item.root === 'workspace'), '登记按 workspace id 归属', saved.repos);

// ---------- 6. 当前工作树作为独立仓库卡片 ----------
const worktrees = await import(join(serverDir, 'worktrees.ts'));
await worktrees.initWorktrees();
const worktree = await worktrees.createWorktree({ workspaceId: 'workspace', baseRef: 'main' });
panel = await gitPanel.gitPanel({ root: 'workspace', worktree: worktree.id });
const worktreeCard = panel.repos.find((repo) => repo.source === 'worktree');
check(Boolean(worktreeCard), '隔离工作树作为独立卡片出现', names(panel));
check(worktreeCard?.branch === worktree.branch, '工作树卡片用它的分支名', worktreeCard?.branch);
check(worktreeCard?.rel === '', '工作树卡片 rel 为空（路径在工作区外）', worktreeCard?.rel);
check(panel.repos[0]?.source === 'root', '根仓库排在最前', names(panel));

// ---------- 7. 提交记录：泳道布局、ref、limit、路径边界 ----------
const graphRepo = join(ws, 'graph');
await mkdir(graphRepo, { recursive: true });
git(graphRepo, ['init', '-q', '-b', 'main']);
await writeFile(join(graphRepo, 'a.txt'), 'a\n');
git(graphRepo, ['add', '.']);
git(graphRepo, ['-c', 'user.email=t@example.com', '-c', 'user.name=tester', 'commit', '-qm', 'init']);
git(graphRepo, ['tag', 'v0']);
git(graphRepo, ['checkout', '-q', '-b', 'feat']);
await writeFile(join(graphRepo, 'b.txt'), 'b\n');
git(graphRepo, ['add', '.']);
git(graphRepo, ['-c', 'user.email=t@example.com', '-c', 'user.name=tester', 'commit', '-qm', 'feat: b']);
git(graphRepo, ['checkout', '-q', 'main']);
await writeFile(join(graphRepo, 'c.txt'), 'c\n');
git(graphRepo, ['add', '.']);
git(graphRepo, ['-c', 'user.email=t@example.com', '-c', 'user.name=tester', 'commit', '-qm', 'main: c']);
git(graphRepo, ['-c', 'user.email=t@example.com', '-c', 'user.name=tester', 'merge', '-q', '--no-ff', 'feat', '-m', "Merge branch 'feat'"]);

const log = await gitPanel.gitLog({ root: 'workspace', rel: 'graph' });
check(log.commits.length === 4, '读出全部 4 条提交', log.commits.length);
check(log.rel === 'graph' && log.path === graphRepo, 'repo 标识就是 rel / 绝对路径', log);
check(log.limit === 200 && log.hasMore === false, '默认 200 条且没有截断', { limit: log.limit, hasMore: log.hasMore });

const mergeRow = log.commits.find((row) => row.subject.startsWith('Merge branch'));
check(Boolean(mergeRow), '找到合并提交', log.commits.map((row) => row.subject));
check(mergeRow?.parents.length === 2, '合并提交有两个父', mergeRow?.parents);
check(mergeRow?.refs.some((ref) => ref.kind === 'head'), '合并行带 HEAD 徽标', mergeRow?.refs);
check(mergeRow?.refs.some((ref) => ref.kind === 'branch' && ref.name === 'main'), '合并行带 main 分支', mergeRow?.refs);
check(mergeRow?.outgoing.length === 2, '合并行画出两条父边', mergeRow?.outgoing);
check(
	log.commits.filter((row) => row.parents.length === 0).length === 1 &&
		log.commits.at(-1).parents.length === 0,
	'根提交只有一个且排在最后（--topo-order）',
	log.commits.map((row) => row.parents.length),
);
check(
	log.commits.some((row) => row.refs.some((ref) => ref.kind === 'branch' && ref.name === 'feat')),
	'feat 分支挂在它自己的提交上',
);
check(
	log.commits.some((row) => row.refs.some((ref) => ref.kind === 'tag' && ref.name === 'v0')),
	'tag 也解析成 ref',
);
check(log.commits.some((row) => row.lane === 1), '分支占用第二条泳道', log.commits.map((row) => row.lane));
check(
	log.commits.some((row) => row.outgoing.some((edge) => edge.to !== edge.from)),
	'分叉/收敛处有一条斜线',
);
check(log.commits[0].top === false, '第一条（分支顶端）头上没有线', log.commits[0]);
check(
	log.commits.every((row) => row.laneCount >= 1 && row.laneCount <= 2),
	'这段历史两条泳道就够',
	log.commits.map((row) => row.laneCount),
);

const limited = await gitPanel.gitLog({ root: 'workspace', rel: 'graph', limit: 2 });
check(limited.commits.length === 2 && limited.limit === 2, 'limit 生效', { got: limited.commits.length, limit: limited.limit });
check(limited.hasMore === true, '截断时 hasMore 为 true');

await expectError('提交记录越界', () => gitPanel.gitLog({ root: 'workspace', rel: '../outside' }), 403);
await expectError('提交记录不存在的目录', () => gitPanel.gitLog({ root: 'workspace', rel: 'nope' }), 404);
await expectError('提交记录非仓库目录', () => gitPanel.gitLog({ root: 'workspace', rel: 'plain' }), 404);

// ---------- 8. 提交详情：提交信息 + 相对第一个父提交的改动文件 ----------
const mergeDetail = await gitPanel.gitCommit({ root: 'workspace', rel: 'graph', sha: mergeRow.sha });
check(mergeDetail.sha === mergeRow.sha, '详情返回完整 sha', mergeDetail.sha);
check(mergeDetail.subject === mergeRow.subject, '详情标题和列表一致', mergeDetail.subject);
check(mergeDetail.parents.length === 2, '合并提交详情带两个父', mergeDetail.parents);
check(mergeDetail.files.length === 1, '合并提交相对第一个父只多出 b.txt', mergeDetail.files);
check(mergeDetail.files[0]?.path === 'b.txt' && mergeDetail.files[0]?.status === 'A', '文件状态是 A', mergeDetail.files[0]);
check(mergeDetail.files[0]?.additions === 1 && mergeDetail.files[0]?.deletions === 0, '文件行数统计对齐', mergeDetail.files[0]);
check(mergeDetail.additions === 1 && mergeDetail.deletions === 0, '汇总增删行数', {
	additions: mergeDetail.additions,
	deletions: mergeDetail.deletions,
});

const rootDetail = await gitPanel.gitCommit({ root: 'workspace', rel: 'graph', sha: log.commits.at(-1).sha });
check(rootDetail.parents.length === 0, '根提交没有父', rootDetail.parents);
check(rootDetail.files.length === 1 && rootDetail.files[0]?.path === 'a.txt', '根提交按空树算新增文件', rootDetail.files);

git(graphRepo, ['-c', 'user.email=t@example.com', '-c', 'user.name=tester', 'commit', '-q', '--allow-empty', '-m', 'chore: 空提交', '-m', '正文第一行\n正文第二行']);
const emptySha = git(graphRepo, ['rev-parse', 'HEAD']);
const emptyDetail = await gitPanel.gitCommit({ root: 'workspace', rel: 'graph', sha: emptySha.slice(0, 8) });
check(emptyDetail.sha === emptySha, '短 sha 也能查到完整提交', emptyDetail.sha);
check(emptyDetail.subject === 'chore: 空提交', '正文不混进标题', emptyDetail.subject);
check(emptyDetail.body.includes('正文第二行'), '多行正文保留', emptyDetail.body);
check(emptyDetail.files.length === 0, '空提交没有改动文件', emptyDetail.files);

await expectError('提交号不像 sha', () => gitPanel.gitCommit({ root: 'workspace', rel: 'graph', sha: '--upload-pack=x' }), 400);
await expectError('提交号不存在', () => gitPanel.gitCommit({ root: 'workspace', rel: 'graph', sha: 'deadbeefdeadbeef' }), 404);
await expectError('提交详情越界', () => gitPanel.gitCommit({ root: 'workspace', rel: '../outside', sha: emptySha }), 403);
await expectError('提交详情非仓库', () => gitPanel.gitCommit({ root: 'workspace', rel: 'plain', sha: emptySha }), 404);

// ---------- 9. 分支列表：本地 + 每个远端一组，ref 过滤 ----------
const branches = await gitPanel.gitBranches({ root: 'workspace', rel: 'graph' });
check(branches.locals.length === 2, '本地分支两条（main / feat）', branches.locals.map((b) => b.short));
check(branches.locals[0].current === true, '当前分支排最前', branches.locals.map((b) => b.current));
check(branches.locals[0].full === 'refs/heads/main', '当前分支是 main', branches.locals[0].full);
check(
	branches.locals.some((b) => b.full === 'refs/heads/feat'),
	'feat 本地分支也在列表里',
	branches.locals.map((b) => b.full),
);
check(branches.remotes.length === 0, '没有远端时远端分组为空', branches.remotes);

// 造两个远端引用（refs/remotes 只是 ref，不需要真连远端）
git(graphRepo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
git(graphRepo, ['update-ref', 'refs/remotes/origin/release/1.0', 'HEAD']);
git(graphRepo, ['update-ref', 'refs/remotes/upstream/main', 'HEAD']);
const withRemotes = await gitPanel.gitBranches({ root: 'workspace', rel: 'graph' });
check(withRemotes.remotes.length === 2, '两个远端各一组', withRemotes.remotes.map((g) => g.name));
check(
	withRemotes.remotes.map((g) => g.name).join(',') === 'origin,upstream',
	'远端按名字排序',
	withRemotes.remotes.map((g) => g.name),
);
const originGroup = withRemotes.remotes.find((g) => g.name === 'origin');
check(originGroup?.branches.length === 2, 'origin 有两条远端分支', originGroup?.branches.map((b) => b.short));
check(
	originGroup?.branches.every((b) => b.remote === 'origin' && !b.current),
	'远端分支带 remote 字段、不算当前分支',
);
check(
	withRemotes.remotes[0].branches[0].full.startsWith('refs/remotes/origin/'),
	'远端分支带完整 ref',
);

// 按分支过滤提交：只走那条 ref
const onlyFeat = await gitPanel.gitLog({ root: 'workspace', rel: 'graph', ref: 'refs/heads/feat' });
check(onlyFeat.commits.length === 2, '只看 feat 只有两条提交（feat + init）', onlyFeat.commits.map((c) => c.subject));
check(onlyFeat.commits[0].refs.some((r) => r.name === 'feat'), '过滤后第一条是 feat 的提交');

await expectError('过滤不存在的分支', () => gitPanel.gitLog({ root: 'workspace', rel: 'graph', ref: 'refs/heads/nope' }), 404);
await expectError('过滤任意 revision', () => gitPanel.gitLog({ root: 'workspace', rel: 'graph', ref: 'HEAD~1' }), 400);
await expectError('过滤注入参数', () => gitPanel.gitLog({ root: 'workspace', rel: 'graph', ref: '--upload-pack=x' }), 400);
await expectError('分支列表越界', () => gitPanel.gitBranches({ root: 'workspace', rel: '../outside' }), 403);

// ---------- 10. 仓库 tab 的过滤规则（纯函数） ----------
const { tabRepos } = await import(join(repoDir, 'web/src/lib/git-tabs.ts'));
const fakeRepos = [
	{ key: 'root', source: 'root', rel: '', name: 'ws' },
	{ key: 'manual', source: 'manual', rel: 'libs/x', name: 'x' },
	{ key: 'wt', source: 'worktree', rel: '', name: 'pi/ws/abc' },
];
check(tabRepos(fakeRepos, null).repos.length === 3, '没绑工作树时列出全部仓库');
check(tabRepos(fakeRepos, null).worktreeOnly === false, '没绑工作树时不是工作树模式');
const bound = tabRepos(fakeRepos, 'wt_1');
check(bound.repos.length === 1 && bound.repos[0].key === 'wt', '绑工作树后只剩工作树那条', bound.repos.map((r) => r.key));
check(bound.worktreeOnly === true, '绑工作树后进入工作树模式');
check(tabRepos([fakeRepos[0]], 'wt_1').repos.length === 0, '清单里没有工作树仓库时不显示任何 tab');

await rm(root, { recursive: true, force: true });
if (failed) {
	console.error(`git-panel check: ${failed} 项失败`);
	process.exit(1);
}
console.log(`git-panel check: ok (${total}/${total})`);
