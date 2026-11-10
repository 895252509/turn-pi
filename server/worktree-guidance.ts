/**
 * worktree 工作流程提示词 —— 以**会话级扩展**的形式注入，不是全局系统提示词。
 *
 * 为什么是扩展而不是 `appendSystemPrompt`：
 *   - 这段规则只对「cwd 落在隔离 worktree 里」的会话成立，普通会话注入进去就是噪音；
 *   - 注入与否按 cwd 判断，不需要把 worktree 状态穿进 loader 的参数里；
 *   - `before_agent_start` 拿得到本轮最终 systemPrompt，可以逐轮追加，并能幂等去重。
 *
 * 本轮范围：只做注入。策略值是 `auto`（worktree 会话就注入）/ `off`，
 * 由调用方在构造时给定，不落盘、不进会话配置（等 AgentSpec 落地后再说）。
 *
 * 为什么需要这段：worktree 创建时服务端已经开好了分支（`git worktree add -b pi/<ws>/<id>`），
 * 但模型仍会习惯性 `git checkout -b` / `git switch -c` / 再嵌套一层 `git worktree add`，
 * 结果是分支越积越多、1 worktree : 1 session 的绑定被绕开、删 worktree 时留下孤儿分支。
 * 提示词把「分支已经存在」讲明白；要更强的约束，得在 bash 工具调用上做拦截
 * （和 `sharedDepsInstallBlock` 同一处）。
 *
 * 措辞用陈述句而不是「请务必」：模型对可验证的事实（路径 / 分支 / 基点）服从度更高，
 * 泛泛的礼貌要求几乎不生效。
 */

import { getWorkspace } from './workspaces.ts';
import { worktreeForCwd, type Worktree } from './worktrees.ts';

/** 注入策略：auto = 在 worktree 里就注入；off = 不注入。 */
export type WorktreeNotesMode = 'auto' | 'off';

/**
 * 幂等标记：注入块的固定首句。
 * 同一轮里可能有多个 before_agent_start 处理器（技能注入、@ 引用注入……），
 * 只要本轮 systemPrompt 里已经带这句就不再追加，避免热重载后叠成两份。
 */
export const WORKTREE_PROMPT_MARKER = 'This session runs in an isolated git worktree';

export interface WorktreePromptInfo {
	id: string;
	/** 本会话的检出目录，等于 session cwd。 */
	path: string;
	/** 服务端创建时已经 checkout 的分支，形如 pi/pi-webchat/ab12cd34。 */
	branch: string;
	/** 创建时的基点（HEAD / 分支名 / commit）。 */
	baseRef: string;
	/** 主工作区根：合并、rebase、安装依赖都在主树里做。 */
	workspaceRoot?: string;
	workspaceLabel?: string;
	/** creating / ready / missing / removing / removed。 */
	state?: string;
}

/** 归一化策略：只有明确写 off 才算关，其余（缺省 / 脏数据）都是 auto。 */
export function normalizeWorktreeNotes(value: unknown): WorktreeNotesMode {
	return value === 'off' ? 'off' : 'auto';
}

/** 只有「cwd 在已登记 worktree 内」且策略不是 off 才注入。 */
export function shouldInjectWorktreeNotes(
	mode: WorktreeNotesMode,
	worktree: Pick<Worktree, 'id'> | undefined | null,
): boolean {
	return mode !== 'off' && Boolean(worktree?.id);
}

/** 把注册表里的 worktree 转成渲染所需的事实（补主工作区路径 / 标签）。 */
export function worktreePromptInfo(worktree: Worktree): WorktreePromptInfo {
	const workspace = getWorkspace(worktree.workspaceId);
	return {
		id: worktree.id,
		path: worktree.path,
		branch: worktree.branch,
		baseRef: worktree.baseRef,
		workspaceRoot: workspace?.root,
		workspaceLabel: workspace?.label,
		state: worktree.state,
	};
}

/** 渲染注入块。纯函数：不读注册表、不看策略，方便检查脚本逐字断言。 */
export function buildWorktreePrompt(info: WorktreePromptInfo): string {
	const main = info.workspaceRoot
		? info.workspaceRoot + (info.workspaceLabel ? ' (' + info.workspaceLabel + ')' : '')
		: 'the main tree';
	const lines = [
		WORKTREE_PROMPT_MARKER + ' (1 worktree : 1 session, managed by the server).',
		'\tcheckout:  ' + info.path,
		'\tbranch:    ' + info.branch + ' (already checked out, based on ' + info.baseRef + ')',
		'\tmain tree: ' + main + ' — other sessions work there; do not edit it from this checkout',
		'',
		'The branch for this session already exists. Creating another one is not part of the job.',
		'',
		'Do not create, move or re-point branches or checkouts:',
		'\t- no `git checkout -b/-B`, `git switch -c/-C`, `git branch <name>`, `git worktree add`;',
		'\t- no switching away from ' + info.branch + ', and no force/move/rename of it;',
		'\t- no `git worktree prune|remove|repair` — the server owns the worktree lifecycle;',
		'\t- no `git push`, `git merge`, or `git rebase` onto the base ref unless the user asks for it.',
		'',
		'How to work here:',
		'\t- edit and test inside the checkout above; it is a normal repo with its own index;',
		'\t- commit on ' + info.branch + ' only when the user asks, in small focused commits;',
		'- unexpected dirty state, conflicts or a foreign branch: stop and report it, do not "fix" it '
			+ 'with checkout/reset;',
		'\t- need scratch space? use /tmp, never a new worktree;',
		'\t- node_modules is symlinked to the main tree, so installs are refused in this checkout;',
		'\t  ask for installs in the main tree instead.',
	];
	if (info.state && info.state !== 'ready') {
		lines.push(
			'',
			'Checkout state is ' + JSON.stringify(info.state) + ': the directory may be missing; '
				+ 'report it instead of recreating it yourself.',
		);
	}
	return lines.join('\n');
}

/**
 * 会话级扩展：在 worktree 会话里把工作流程追加到本轮 systemPrompt 末尾。
 *
 * `cwd` / `mode` 都传函数而不是值：Chat.init 之后 cwd 可能被 session header 改写，
 * 策略也可能在会话被认领 worktree 之后才定下来。
 */
export function createWorktreeGuidanceExtension(options: {
	cwd: () => string;
	mode: () => WorktreeNotesMode;
}): (pi: any) => void {
	return (pi: any) => {
		pi.on('before_agent_start', (event: any) => {
			if (options.mode() === 'off') return;
			const worktree = worktreeForCwd(options.cwd());
			if (!shouldInjectWorktreeNotes(options.mode(), worktree) || !worktree) return;
			const block = buildWorktreePrompt(worktreePromptInfo(worktree));
			const current = typeof event?.systemPrompt === 'string' ? event.systemPrompt : '';
			// 幂等：本轮提示词里已经有这段就不再追加（热重载 / 多个处理器叠加）。
			if (current.includes(WORKTREE_PROMPT_MARKER)) return;
			return { systemPrompt: current ? current + '\n\n' + block : block };
		});
	};
}
