/** /api/git/* 的前端封装：仓库清单、手动登记、移除。 */

import { api } from './api';
import type { GitBranches, GitCommitDetail, GitLog, GitPanel } from './types';

function query(root: string, worktree: string | undefined, extra: Record<string, string> = {}): string {
	const params = new URLSearchParams();
	params.set('root', root || 'workspace');
	if (worktree) params.set('worktree', worktree);
	for (const [key, value] of Object.entries(extra)) params.set(key, value);
	return params.toString();
}

export function loadGitRepos(
	root: string,
	worktree?: string,
	refresh = false,
): Promise<GitPanel> {
	const suffix = refresh ? `&refresh=1` : '';
	return api<GitPanel>(`/api/git/repos?${query(root, worktree)}${suffix}`);
}

export function addGitRepo(root: string, path: string, worktree?: string): Promise<GitPanel> {
	return api<GitPanel>(`/api/git/repos?${query(root, worktree)}`, { path });
}

export function removeGitRepo(root: string, path: string, worktree?: string): Promise<GitPanel> {
	return api<GitPanel>(`/api/git/repos/remove?${query(root, worktree)}`, { path });
}

export function loadGitLog(
	root: string,
	rel: string,
	worktree?: string,
	limit?: number,
	ref?: string | null,
): Promise<GitLog> {
	const extra: Record<string, string> = { rel };
	if (limit) extra.limit = String(limit);
	if (ref) extra.ref = ref;
	return api<GitLog>(`/api/git/log?${query(root, worktree, extra)}`);
}

export function loadGitBranches(root: string, rel: string, worktree?: string): Promise<GitBranches> {
	return api<GitBranches>(`/api/git/branches?${query(root, worktree, { rel })}`);
}

export function loadGitCommit(
	root: string,
	rel: string,
	sha: string,
	worktree?: string,
): Promise<GitCommitDetail> {
	return api<GitCommitDetail>(`/api/git/commit?${query(root, worktree, { rel, sha })}`);
}

export function describeGitError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error ?? '');
	return message || 'Git 请求失败';
}
