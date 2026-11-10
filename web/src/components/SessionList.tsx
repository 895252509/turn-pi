import { useMemo, useState } from 'react';
import { Archive, ArchiveRestore, ChevronDown, ChevronRight, GitBranch, Plus, Search, ShieldAlert, X } from 'lucide-react';
import { storage } from '@/lib/api';
import type { SessionSummary } from '@/lib/types';
import { useStore } from '@/lib/store';

const COLLAPSED_KEY = 'turnpi-collapsed-workspaces';

function readCollapsedWorkspaces(): Set<string> {
	try {
		const raw = storage.get(COLLAPSED_KEY);
		const list = raw ? JSON.parse(raw) : [];
		return new Set(Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string') : []);
	} catch {
		return new Set();
	}
}

function sessionTime(modified: number): string {
	return new Date(modified).toLocaleString('zh-CN', {
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
	});
}

function matches(item: SessionSummary, needle: string): boolean {
	if (!needle) return true;
	return [item.name, item.title, item.workspaceLabel, item.worktreeBranch]
		.filter((value): value is string => Boolean(value))
		.some((value) => value.toLowerCase().includes(needle));
}

/**
 * 历史会话列表：左栏常驻，将来弹窗 / 移动端 sheet 复用同一份。
 *
 * 分组、折叠记忆、归档、搜索都在这里，外层只负责摆位置。
 */
export function SessionList({
	id = 'sessions',
	searchable = false,
	onOpened,
	emptyHint,
}: {
	id?: string;
	searchable?: boolean;
	/** 打开会话后回调（关抽屉 / 关弹窗） */
	onOpened?: () => void;
	emptyHint?: string;
}) {
	const sessions = useStore((s) => s.sessions);
	const sessionId = useStore((s) => s.sessionId);
	const credentialRequests = useStore((s) => s.credentialRequests);
	const workspaces = useStore((s) => s.workspaces);
	const workspaceId = useStore((s) => s.workspaceId);
	const openSession = useStore((s) => s.openSession);
	const newChatInWorkspace = useStore((s) => s.newChatInWorkspace);
	const archiveSession = useStore((s) => s.archiveSession);

	const [showArchived, setShowArchived] = useState(false);
	const [pending, setPending] = useState<string | null>(null);
	const [query, setQuery] = useState('');
	const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsedWorkspaces);

	const needle = query.trim().toLowerCase();
	const searching = needle.length > 0;

	const activeSessions = useMemo(
		() => sessions.filter((item) => !item.archived && matches(item, needle)),
		[sessions, needle],
	);
	const archivedSessions = useMemo(
		() => sessions.filter((item) => Boolean(item.archived) && matches(item, needle)),
		[sessions, needle],
	);

	const groups = useMemo(() => {
		const map = new Map<string, { id: string; label: string; sessions: SessionSummary[] }>();
		for (const item of activeSessions) {
			const id = item.workspaceId ?? '__unknown__';
			let group = map.get(id);
			if (!group) {
				const known = workspaces.find((workspace) => workspace.id === id);
				group = {
					id,
					label: item.workspaceLabel ?? known?.label ?? (id === '__unknown__' ? '未注册工作区' : id),
					sessions: [],
				};
				map.set(id, group);
			}
			group.sessions.push(item);
		}
		return [...map.values()];
	}, [activeSessions, workspaces]);

	async function runArchive(sessionIdToToggle: string, archived: boolean) {
		if (pending) return;
		setPending(sessionIdToToggle);
		try {
			await archiveSession(sessionIdToToggle, archived);
		} finally {
			setPending(null);
		}
	}

	function toggleGroup(groupId: string) {
		setCollapsed((previous) => {
			const next = new Set(previous);
			if (next.has(groupId)) next.delete(groupId);
			else next.add(groupId);
			storage.set(COLLAPSED_KEY, JSON.stringify([...next]));
			return next;
		});
	}

	function renderSession(item: SessionSummary, archived: boolean) {
		const approvalPending =
			Boolean(item.approvalPending) || (item.id === sessionId && credentialRequests.length > 0);
		const actionLabel = archived
			? pending === item.id
				? '恢复中…'
				: '恢复会话'
			: item.busy
				? '生成中，结束再归档'
				: pending === item.id
					? '归档中…'
					: '归档会话';
		return (
			<div
				key={item.id}
				className={`session-row${item.id === sessionId ? ' active' : ''}${archived ? ' archived' : ''}${approvalPending ? ' approval-pending' : ''}`}
			>
				<button
					type="button"
					className="session-open"
					onClick={() => {
						openSession(item.id)
							.catch(() => {})
							.finally(() => onOpened?.());
					}}
				>
					<span className="session-title" title={item.title}>
						{approvalPending ? (
							<span className="session-approval" title="等待你审批凭据使用">
								<ShieldAlert aria-hidden="true" />
							</span>
						) : null}
						{item.name || item.title}
					</span>
					{item.worktreeBranch ? (
						<span className="session-worktree" title={item.worktreePath ?? item.worktreeBranch}>
							<GitBranch aria-hidden="true" />
							{item.worktreeBranch}
						</span>
					) : null}
					<span className="session-meta" title={archived ? item.workspaceLabel : undefined}>
						{archived && item.workspaceLabel ? `${item.workspaceLabel} · ` : ''}
						{sessionTime(item.modified)} · {item.messageCount} 条
						{item.busy ? (
							<>
								{' · '}
								<em className="live">生成中</em>
							</>
						) : null}
						{approvalPending ? (
							<>
								{' · '}
								<em className="approval">待审批</em>
							</>
						) : null}
					</span>
				</button>
				<button
					type="button"
					className="session-action"
					title={actionLabel}
					aria-label={actionLabel}
					disabled={pending !== null || (!archived && Boolean(item.busy))}
					onClick={(event) => {
						event.stopPropagation();
						void runArchive(item.id, !archived);
					}}
				>
					{archived ? <ArchiveRestore aria-hidden="true" /> : <Archive aria-hidden="true" />}
				</button>
			</div>
		);
	}

	const archivedExpanded = searching || showArchived;

	return (
		<div id={id} className="sessions">
			{searchable ? (
				<div className="session-search">
					<Search className="session-search-icon" aria-hidden="true" />
					<input
						id={`${id}-search`}
						type="search"
						autoComplete="off"
						value={query}
						placeholder="搜索会话"
						aria-label="搜索历史会话"
						onChange={(event) => setQuery(event.target.value)}
						onKeyDown={(event) => {
							if (event.key !== 'Escape') return;
							// 不要让 Esc 冒泡到全局（全局 Esc 是关抽屉）
							event.stopPropagation();
							setQuery('');
						}}
					/>
					{searching ? (
						<>
							<span className="session-search-count" aria-live="polite">
								{activeSessions.length + archivedSessions.length}
							</span>
							<button
								type="button"
								className="session-search-clear"
								aria-label="清空搜索"
								title="清空搜索"
								onClick={() => setQuery('')}
							>
								<X aria-hidden="true" />
							</button>
						</>
					) : null}
				</div>
			) : null}

			{activeSessions.length === 0 ? (
				<p className={`hint${searching ? ' session-empty' : ''}`}>
					{searching
						? archivedSessions.length > 0
							? '未归档会话里没有匹配，试试下面的已归档'
							: '没有匹配的会话'
						: sessions.length === 0
							? emptyHint ?? '还没有会话'
							: '没有未归档会话'}
				</p>
			) : (
				groups.map((group) => {
					// 搜索时一律展开，否则搜到的东西可能被折叠状态藏起来
					const isCollapsed = !searching && collapsed.has(group.id);
					const known = workspaces.some((workspace) => workspace.id === group.id);
					return (
						<div className={`session-group${isCollapsed ? ' collapsed' : ''}`} key={group.id}>
							<div className={`session-group-label${group.id === workspaceId ? ' current' : ''}`}>
								<button
									type="button"
									className="session-group-toggle"
									aria-expanded={!isCollapsed}
									// 搜索时一律展开，折叠按钮跟着禁用，避免"点了没反应"
									disabled={searching}
									title={
										searching ? '搜索中不折叠' : isCollapsed ? `展开 ${group.label}` : `折叠 ${group.label}`
									}
									onClick={() => toggleGroup(group.id)}
								>
									{isCollapsed ? <ChevronRight aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
									<span className="session-group-name">{group.label}</span>
									<span className="session-group-count">{group.sessions.length}</span>
								</button>
								{known ? (
									<button
										type="button"
										className="session-group-add"
										title={`在 ${group.label} 新建会话`}
										aria-label={`在 ${group.label} 新建会话`}
										onClick={() => newChatInWorkspace(group.id)}
									>
										<Plus aria-hidden="true" />
									</button>
								) : null}
							</div>
							{isCollapsed ? null : group.sessions.map((item) => renderSession(item, false))}
						</div>
					);
				})
			)}

			{archivedSessions.length > 0 ? (
				<div className="archive-block">
					<button
						type="button"
						className="archive-toggle"
						aria-expanded={archivedExpanded}
						aria-controls={`${id}-archived`}
						disabled={searching}
						title={searching ? '搜索中自动展开已归档' : undefined}
						onClick={() => setShowArchived((open) => !open)}
					>
						{archivedExpanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
						<Archive aria-hidden="true" />
						<span>{searching ? '已归档匹配' : '已归档'}</span>
						<span className="archive-count">{archivedSessions.length}</span>
					</button>
					{archivedExpanded ? (
						<div id={`${id}-archived`} className="archive-list">
							{archivedSessions.map((item) => renderSession(item, true))}
						</div>
					) : null}
				</div>
			) : null}
		</div>
	);
}
