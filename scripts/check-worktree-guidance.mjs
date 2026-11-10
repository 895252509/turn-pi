/**
 * 回归检查：worktree 工作流程提示（会话级扩展 + 逐会话开关）。
 *
 * 真起一个临时 git 仓库当 workspace，不连服务、不碰真实工作区：
 *   node scripts/check-worktree-guidance.mjs            # 检查已部署的 server/
 *   node scripts/check-worktree-guidance.mjs server  # 只检查某个目录
 *
 * 覆盖：注入块渲染（路径/分支/基点/状态）/ 策略归一化 / 开关判定 /
 *       扩展只对 worktree 会话生效 / 幂等（同一轮不叠两遍）/ off 时不注入。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = resolve(fileURLToPath(new URL('..', import.meta.url)), process.argv[2] ?? 'server');
const root = mkdtempSync(join(tmpdir(), 'pi-wt-notes-'));
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const repo = join(root, 'repo');
mkdirSync(repo, { recursive: true });
writeFileSync(join(repo, 'README.md'), '# repo\n');
git(repo, ['init', '-q', '-b', 'main']);
git(repo, ['config', 'user.email', 'check@example.com']);
git(repo, ['config', 'user.name', 'check']);
git(repo, ['add', '-A']);
git(repo, ['commit', '-q', '-m', 'init']);

process.env.PI_RUNTIME_DIR = join(root, 'runtime');
process.env.PI_WORKSPACES_FILE = join(root, 'workspaces.json');
process.env.PI_WORKTREES_FILE = join(root, 'worktrees.json');
process.env.PI_WORKTREE_ROOT = join(root, 'runtime', 'worktrees');
process.env.PI_WORKSPACE = repo;
process.env.PI_WORKSPACE_DISCOVER = 'none';

writeFileSync(
	process.env.PI_WORKSPACES_FILE,
	JSON.stringify({
		version: 1,
		workspaces: [{ id: 'workspace', label: 'repo', root: repo, kind: 'git', source: 'config' }],
	}),
);

const workspaces = await import(join(serverDir, 'workspaces.ts'));
await workspaces.initWorkspaces();
const worktrees = await import(join(serverDir, 'worktrees.ts'));
await worktrees.initWorktrees();
const guidance = await import(join(serverDir, 'worktree-guidance.ts'));

let failed = 0;
const check = (ok, message) => {
	if (ok) return;
	failed += 1;
	console.error(`FAIL: ${message}`);
};

// 1. 纯函数渲染
const sample = {
	id: 'wt_ab12cd34',
	path: '/runtime/worktrees/workspace/wt_ab12cd34',
	branch: 'pi/workspace/ab12cd34',
	baseRef: 'main',
	workspaceRoot: '/workspace/repo',
	workspaceLabel: 'repo',
	state: 'ready',
};
const block = guidance.buildWorktreePrompt(sample);
check(block.startsWith(guidance.WORKTREE_PROMPT_MARKER), '注入块首句应是幂等标记');
check(block.includes(sample.branch), '注入块应写明本会话分支');
check(block.includes(sample.path), '注入块应写明检出路径');
check(block.includes('based on main'), '注入块应写明基点');
check(block.includes('/workspace/repo'), '注入块应写明主工作区');
check(block.includes('git checkout -b'), '注入块应显式禁止新建分支');
check(block.includes('git worktree add'), '注入块应显式禁止嵌套 worktree');
check(!block.includes('Checkout state'), 'ready 状态不该带异常提示');
const broken = guidance.buildWorktreePrompt({ ...sample, state: 'missing' });
check(broken.includes('Checkout state is "missing"'), '非 ready 状态应提示目录可能缺失');

// 2. 策略归一化：只有明确 off 才算关
check(guidance.normalizeWorktreeNotes('off') === 'off', "off 应保持 off");
check(guidance.normalizeWorktreeNotes('auto') === 'auto', "auto 应保持 auto");
check(guidance.normalizeWorktreeNotes(undefined) === 'auto', '缺省应为 auto');
check(guidance.normalizeWorktreeNotes('on') === 'auto', '未知值应回落 auto');

// 3. 判定：off 或非 worktree 都不注入
check(guidance.shouldInjectWorktreeNotes('auto', { id: 'wt_x' }) === true, 'auto + worktree 应注入');
check(guidance.shouldInjectWorktreeNotes('auto', undefined) === false, '非 worktree 不该注入');
check(guidance.shouldInjectWorktreeNotes('off', { id: 'wt_x' }) === false, '策略 off 不该注入');

// 4. 扩展行为：真 worktree
const wt = await worktrees.createWorktree({ workspaceId: 'workspace' });
const mounted = {};
const pi = { on: (name, handler) => { mounted[name] = handler; } };
guidance.createWorktreeGuidanceExtension({ cwd: () => wt.path, mode: () => 'auto' })(pi);
check(typeof mounted.before_agent_start === 'function', '扩展应注册 before_agent_start');
const out = await mounted.before_agent_start({ type: 'before_agent_start', systemPrompt: 'BASE PROMPT' });
check(Boolean(out?.systemPrompt?.startsWith('BASE PROMPT')), '应保留原 systemPrompt');
check(Boolean(out?.systemPrompt?.includes(wt.branch)), '注入块应带真实分支名');
check(Boolean(out?.systemPrompt?.includes(wt.path)), '注入块应带真实检出路径');
check(!out?.message, '不该额外注入可见 custom message');

// 幂等：本轮已经带标记就不再追加
const again = await mounted.before_agent_start({ type: 'before_agent_start', systemPrompt: out.systemPrompt });
check(again === undefined, '同一轮重复触发不该叠第二份');
const doubled = await mounted.before_agent_start({ type: 'before_agent_start', systemPrompt: 'BASE ' + guidance.WORKTREE_PROMPT_MARKER });
check(doubled === undefined, '带标记的提示词（热重载/其它处理器）不该再追加');

// 空提示词也能注入
const empty = await mounted.before_agent_start({ type: 'before_agent_start', systemPrompt: '' });
check(empty?.systemPrompt?.startsWith(guidance.WORKTREE_PROMPT_MARKER), '空提示词应直接得到注入块');

// 5. 逐会话开关：off 静默
const offMounted = {};
guidance.createWorktreeGuidanceExtension({ cwd: () => wt.path, mode: () => 'off' })({ on: (name, handler) => { offMounted[name] = handler; } });
check((await offMounted.before_agent_start({ systemPrompt: 'BASE' })) === undefined, '策略 off 时扩展应完全静默');

// 6. 非 worktree 工作区：默认 auto 也不注入
const plainMounted = {};
guidance.createWorktreeGuidanceExtension({ cwd: () => repo, mode: () => 'auto' })({ on: (name, handler) => { plainMounted[name] = handler; } });
check((await plainMounted.before_agent_start({ systemPrompt: 'BASE' })) === undefined, '普通会话不该被注入这段提示');

await worktrees.removeWorktree(wt.id, { force: true });
rmSync(root, { recursive: true, force: true });
if (failed) {
	console.error(`worktree-guidance check: ${failed} 项失败`);
	process.exit(1);
}
console.log('worktree-guidance check: ok (26/26)');
