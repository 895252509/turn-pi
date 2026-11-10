/**
 * @ 会话候选来源。
 *
 * 现在只列会话；formatSessionReference / parseSessionReferences / server 协议
 * 已经支持 turn，后续要加「引用第 N 轮」时不需要改 Composer 或菜单。
 */
import type {
	InputTriggerSource,
	TriggerCandidate,
	TriggerContext,
} from '@/lib/input-trigger/types';
import { rankByMatch } from '@/lib/input-trigger/rank';
import {
	formatSessionReference,
	sessionReferenceLabel,
} from '@/lib/references/session';
import type { SessionSummary } from '@/lib/types';

const EMPTY_LIMIT = 16;
const QUERY_LIMIT = 10;

function relativeTime(timestamp: number): string {
	const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
	if (seconds < 60) return '刚刚';
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes} 分钟前`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} 小时前`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days} 天前`;
	return new Date(timestamp).toLocaleDateString('zh-CN');
}

function titleOf(session: SessionSummary): string {
	const title = session.name?.trim() || session.title?.trim() || session.id.slice(0, 8);
	return title.replace(/\s+/gu, ' ').slice(0, 120);
}

/** 会话行 → 菜单候选；turn 预留给未来的轮次选择。 */
export function sessionCandidate(
	session: SessionSummary,
	turn?: number,
): TriggerCandidate {
	const title = titleOf(session);
	const label = sessionReferenceLabel(title, turn);
	return {
		id: `session:${session.id}${turn ? `:${turn}` : ''}`,
		source: 'session',
		title: label,
		description: `${session.messageCount ?? 0} 条消息 · ${relativeTime(session.modified)}`,
		meta: session.workspaceLabel,
		badge: session.busy ? 'busy' : undefined,
		order: -session.modified,
		value: formatSessionReference({ kind: 'session', id: session.id, title, turn }),
	};
}

export function createSessionReferenceSource(): InputTriggerSource {
	return {
		trigger: '@',
		name: 'session',
		order: 10,
		warm(ctx: TriggerContext) {
			// 会话列表在 boot 时已经拉过；这里只做一次兜底刷新，不阻塞菜单。
			void ctx.getState().loadSessions();
		},
		async candidates(ctx, req) {
			let state = ctx.getState();
			if (!state.sessions.length) {
				await state.loadSessions();
				state = ctx.getState();
			}
			const currentWorkspace = state.workspaceId;
			const rows = state.sessions
				.filter((session) => session.id !== state.sessionId)
				.filter((session) => !session.archived);
			const matched = rankByMatch(
				rows,
				req.query,
				(session) => [titleOf(session), session.id, session.workspaceLabel, session.cwd],
				(session) => -session.modified,
			);
			const limit = req.query.trim() ? QUERY_LIMIT : EMPTY_LIMIT;
			const mapped = matched.map((session) => {
				const candidate = sessionCandidate(session);
				const sameWorkspace = session.workspaceId === currentWorkspace;
				return {
					...candidate,
					section: sameWorkspace ? '当前工作区' : '其他工作区',
				};
			});
			// 按工作区分组，但保留 rankByMatch 已经算好的组内顺序。
			mapped.sort((a, b) => Number(a.section !== '当前工作区') - Number(b.section !== '当前工作区'));
			return mapped.slice(0, limit);
		},
		onPick(pick) {
			return { kind: 'insert', text: pick.candidate.value, caretOffset: pick.candidate.value.length };
		},
	};
}
