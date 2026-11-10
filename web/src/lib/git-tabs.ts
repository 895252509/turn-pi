import type { GitRepoSummary } from './types';

/**
 * 标题栏要显示哪些仓库 tab（纯函数，方便单测）。
 *
 * - 没有绑定隔离工作树：清单原样显示；
 * - 绑定了工作树：只留工作树自己那条分支（主仓库、扫描/登记的子仓库都跟这次会话无关），
 *   如果服务端没给工作树仓库（比如它不是 git 仓库），就不显示任何仓库 tab。
 */
export function tabRepos(
	repos: GitRepoSummary[],
	worktreeId: string | null | undefined,
): { repos: GitRepoSummary[]; worktreeOnly: boolean } {
	if (!worktreeId) return { repos, worktreeOnly: false };
	const worktreeRepos = repos.filter((repo) => repo.source === 'worktree');
	if (!worktreeRepos.length) return { repos: [], worktreeOnly: false };
	return { repos: worktreeRepos, worktreeOnly: true };
}
