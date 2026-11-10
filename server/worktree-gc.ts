/**
 * 延迟 GC：回收已归档、无人使用、工作树干净的 worktree。
 *
 * 这是「定时任务」的第一个内置 job，不负责池化，也不 force 删除：
 *   - 归档是可逆的，所以默认宽限期很长；
 *   - 有 fork / 未归档会话 / 打开中的 chat 一律跳过；
 *   - 脏树只报告，不自动 reset；
 *   - 目录缺失的记录可以只标记 removed，不跑 git。
 */

import { resolve, sep } from 'node:path';
import { listWorktrees, removeWorktree, worktreeStatus } from './worktrees.ts';
import type { JobDefinition, JobRunContext, JobRunResult } from './scheduler.ts';

export interface GcSession {
	id: string;
	cwd?: string;
	archived?: boolean;
	modified?: number;
}

export interface GcLiveChat {
	cwd: string;
	busy: boolean;
	sessionId?: string;
}

export interface WorktreeGcDeps {
	listSessions: () => Promise<GcSession[]>;
	readArchivedSessions: () => Promise<Map<string, { sessionId: string; archivedAt: number }>>;
	liveChats: () => GcLiveChat[];
}

export type GcAction =
	| 'would-remove'
	| 'removed'
	| 'would-retire-missing'
	| 'retired-missing'
	| 'skip';

export interface GcItem {
	id: string;
	branch: string;
	path: string;
	state: string;
	action: GcAction;
	reason?: string;
	sessionIds: string[];
	lastUsedAt?: string;
	archivedAt?: string;
	changes?: string[];
	error?: string;
}

export interface GcDetail {
	sessions: number;
	archivedSessions: number;
	liveChats: number;
	worktrees: number;
	eligible: number;
	removed: number;
	skipped: Record<string, number>;
	items: GcItem[];
	itemsTruncated?: boolean;
}

const REASON_LABELS: Record<string, string> = {
	'in-use': '仍有打开的会话',
	'session-active': '仍有未归档会话',
	'no-session': '没有会话引用（不确定来源）',
	'grace': '未到宽限期',
	'dirty': '有未提交改动',
	'limit': '超过单次上限',
	'missing-disabled': '目录缺失但未开启清理',
	'status-error': '读取状态失败',
	'remove-error': '删除失败',
};

function within(path: string | undefined, root: string): boolean {
	if (!path) return false;
	const resolved = resolve(path);
	return resolved === root || resolved.startsWith(root + sep);
}

function iso(value: number | undefined): string | undefined {
	if (!value || !Number.isFinite(value) || value <= 0) return undefined;
	return new Date(value).toISOString();
}

function parseTime(value: string | undefined): number {
	if (!value) return 0;
	const at = Date.parse(value);
	return Number.isFinite(at) ? at : 0;
}

function bump(map: Record<string, number>, key: string): void {
	map[key] = (map[key] ?? 0) + 1;
}

export function createWorktreeGcJob(deps: WorktreeGcDeps): JobDefinition {
	return {
		id: 'worktree-gc',
		name: 'Worktree 延迟回收',
		description: '回收已归档、无会话占用且干净的隔离工作树；脏树只报告，不强制删除。',
		defaultEnabled: true,
		defaultDryRun: true,
		defaultIntervalMs: 6 * 60 * 60_000,
		fields: [
			{
				key: 'graceDays',
				label: '归档宽限期',
				type: 'number',
				default: 14,
				min: 0,
				max: 365,
				step: 1,
				unit: '天',
				hint: '按「最后使用时间」和「归档时间」中较晚的那个算；0 表示不等。',
			},
			{
				key: 'maxPerRun',
				label: '单次最多删除',
				type: 'number',
				default: 5,
				min: 1,
				max: 100,
				step: 1,
				unit: '个',
				hint: '干跑也按这个上限展示将要删除的数量。',
			},
			{
				key: 'includeMissing',
				label: '清理目录缺失记录',
				type: 'boolean',
				default: true,
				hint: '目录已不存在的记录只标记 removed，不跑 git，也不删分支。',
			},
		],
		run: (ctx) => runWorktreeGc(deps, ctx),
	};
}

async function runWorktreeGc(deps: WorktreeGcDeps, ctx: JobRunContext): Promise<JobRunResult> {
	const graceDays = Math.max(0, Number(ctx.config.graceDays ?? 14));
	const maxPerRun = Math.max(1, Math.floor(Number(ctx.config.maxPerRun ?? 5)));
	const includeMissing = ctx.config.includeMissing !== false;
	const graceMs = graceDays * 24 * 60 * 60_000;

	const [sessions, archived] = await Promise.all([deps.listSessions(), deps.readArchivedSessions()]);
	const liveChats = deps.liveChats();
	const worktrees = listWorktrees();
	const items: GcItem[] = [];
	const skipped: Record<string, number> = {};
	let eligible = 0;
	let removed = 0;
	let acted = 0;

	for (const worktree of worktrees) {
		if (ctx.signal.aborted) {
			bump(skipped, 'aborted');
			break;
		}

		const root = resolve(worktree.path);
		const refs = sessions.filter((session) => within(session.cwd, root));
		const live = liveChats.filter((chat) => within(chat.cwd, root));
		const base: GcItem = {
			id: worktree.id,
			branch: worktree.branch,
			path: worktree.path,
			state: worktree.state,
			action: 'skip',
			sessionIds: refs.map((session) => session.id),
			lastUsedAt: worktree.lastUsedAt,
		};

		if (live.length) {
			base.reason = `in-use（${live.filter((chat) => chat.busy).length ? '生成中' : '打开中'}）`;
			bump(skipped, 'in-use');
			items.push(base);
			continue;
		}

		const unarchived = refs.filter((session) => !(session.archived || archived.has(session.id)));
		if (unarchived.length) {
			base.reason = `session-active（${unarchived.length} 个未归档会话）`;
			bump(skipped, 'session-active');
			items.push(base);
			continue;
		}

		if (!refs.length && worktree.state !== 'missing') {
			base.reason = REASON_LABELS['no-session'];
			bump(skipped, 'no-session');
			items.push(base);
			continue;
		}

		const archivedAt = refs.reduce((latest, session) => Math.max(latest, archived.get(session.id)?.archivedAt ?? 0), 0);
		base.archivedAt = iso(archivedAt);
		const lastUsed = parseTime(worktree.lastUsedAt);
		const graceBase = Math.max(lastUsed, archivedAt);
		if (!graceBase || Date.now() - graceBase < graceMs) {
			base.reason = `grace（还需 ${Math.max(0, Math.ceil((graceMs - (Date.now() - graceBase)) / 86_400_000))} 天）`;
			bump(skipped, 'grace');
			items.push(base);
			continue;
		}

		if (worktree.state === 'missing') {
			if (!includeMissing) {
				base.reason = REASON_LABELS['missing-disabled'];
				bump(skipped, 'missing-disabled');
				items.push(base);
				continue;
			}
			if (acted >= maxPerRun) {
				base.reason = REASON_LABELS.limit;
				bump(skipped, 'limit');
				items.push(base);
				continue;
			}
			eligible += 1;
			acted += 1;
			if (ctx.dryRun) {
				base.action = 'would-retire-missing';
				items.push(base);
				continue;
			}
			try {
				await removeWorktree(worktree.id, { allowMissing: true });
				base.action = 'retired-missing';
				removed += 1;
			} catch (error) {
				base.action = 'skip';
				base.reason = `remove-error：${error instanceof Error ? error.message : String(error)}`;
				base.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
				bump(skipped, 'remove-error');
			}
			items.push(base);
			continue;
		}

		let changes: string[] = [];
		try {
			const status = await worktreeStatus(worktree.id);
			changes = status.changes;
		} catch (error) {
			base.reason = `status-error：${error instanceof Error ? error.message : String(error)}`;
			base.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
			bump(skipped, 'status-error');
			items.push(base);
			continue;
		}

		if (changes.length) {
			base.reason = `dirty（${changes.length} 项改动）`;
			base.changes = changes.slice(0, 20);
			bump(skipped, 'dirty');
			items.push(base);
			continue;
		}

		if (acted >= maxPerRun) {
			base.reason = REASON_LABELS.limit;
			bump(skipped, 'limit');
			items.push(base);
			continue;
		}

		eligible += 1;
		acted += 1;
		if (ctx.dryRun) {
			base.action = 'would-remove';
			items.push(base);
			continue;
		}
		try {
			await removeWorktree(worktree.id, { force: false });
			base.action = 'removed';
			removed += 1;
		} catch (error) {
			base.action = 'skip';
			base.reason = `remove-error：${error instanceof Error ? error.message : String(error)}`;
			base.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
			bump(skipped, 'remove-error');
		}
		items.push(base);
	}

	const detail: GcDetail = {
		sessions: sessions.length,
		archivedSessions: archived.size,
		liveChats: liveChats.length,
		worktrees: worktrees.length,
		eligible,
		removed,
		skipped,
		items: items.slice(0, 200),
		itemsTruncated: items.length > 200,
	};
	const mode = ctx.dryRun ? '干跑' : '执行';
	const skipText = Object.entries(skipped)
		.map(([key, count]) => `${REASON_LABELS[key] ?? key} ${count}`)
		.join('，');
	return {
		summary: `${mode}：扫描 ${worktrees.length} 个，候选 ${eligible} 个，${ctx.dryRun ? '将删除' : '已删除'} ${ctx.dryRun ? eligible : removed} 个${skipText ? `；跳过 ${skipText}` : ''}`,
		detail,
	};
}
