import { useEffect, useRef, useState } from 'react';
import { Bell, BellOff, Code2, Folder, FolderGit2, GitBranch, Lock, PanelRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Composer } from '@/components/Composer';
import { GitAddView } from '@/components/GitAddView';
import { GitRepoView } from '@/components/GitRepoView';
import { MessageList } from '@/components/MessageList';
import { TrajectoryView } from '@/components/TrajectoryView';
import { useIsMobile } from '@/hooks/use-mobile';
import { useStore } from '@/lib/store';
import { tabRepos } from '@/lib/git-tabs';

type ChatView = 'chat' | 'trajectory' | 'git' | 'git-add';

/** tab 的 DOM id 不能带 `/` `:` 这些字符。 */
function gitTabId(key: string): string {
	return `tab-git-${key.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

export function ChatPane() {
	const busy = useStore((s) => s.busy);
	const modelName = useStore((s) => s.modelName);
	const abort = useStore((s) => s.abort);
	const drawer = useStore((s) => s.drawer);
	const setDrawer = useStore((s) => s.setDrawer);
	const closeDrawers = useStore((s) => s.closeDrawers);
	const panelVisible = useStore((s) => s.panelVisible);
	const togglePanel = useStore((s) => s.togglePanel);
	const notify = useStore((s) => s.notify);
	const notifyPermission = useStore((s) => s.notifyPermission);
	const toggleNotify = useStore((s) => s.toggleNotify);
	const isMobile = useIsMobile();
	const sessionId = useStore((s) => s.sessionId);
	const clientId = useStore((s) => s.clientId);
	const sessionName = useStore((s) => s.sessionName);
	const workspaceId = useStore((s) => s.workspaceId);
	const workspaces = useStore((s) => s.workspaces);
	const workspaceFallback = useStore((s) => s.workspaceFallback);
	const worktreeId = useStore((s) => s.worktreeId);
	const worktrees = useStore((s) => s.worktrees);
	const worktree = worktrees.find((item) => item.id === worktreeId);
	const sessionCodemode = useStore((s) => s.sessionCodemode);
	const workspace = workspaces.find((item) => item.id === workspaceId);
	const WorkspaceIcon = workspace?.kind === 'git' ? FolderGit2 : Folder;
	const renameSession = useStore((s) => s.renameSession);
	const showToast = useStore((s) => s.showToast);

	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState('');
	const [view, setView] = useState<ChatView>('chat');
	/** 当前选中的 Git tab（每个仓库一个） */
	const [gitKey, setGitKey] = useState<string | null>(null);
	const cancelled = useRef(false);
	// 只有 git 工作区才有 Git tab；切到别的工作区时自动退回对话
	const gitAvailable = workspace?.kind === 'git';
	const gitPanel = useStore((s) => s.gitPanel);
	const loadGitPanel = useStore((s) => s.loadGitPanel);
	// 清单可能是上一个工作区的：只认 root.id 与当前 workspace 一致的那份
	const panelRepos =
		gitAvailable && gitPanel && workspace && gitPanel.root.id === workspace.id ? gitPanel.repos : [];
	// 会话跑在隔离工作树里时，只留工作树自己那条分支 tab：主仓库和别的子仓库跟这次会话的改动无关
	// 会话跑在隔离工作树里时只留工作树那条分支 tab（见 lib/git-tabs.ts），「＋」也一起隐藏
	const { repos: gitRepos, worktreeOnly } = tabRepos(panelRepos, worktreeId);
	const activeRepo = gitRepos.find((repo) => repo.key === gitKey);
	const activeView: ChatView =
		view === 'git' && !activeRepo ? 'chat' : view === 'git-add' && !gitAvailable ? 'chat' : view;

	useEffect(() => {
		if (!gitAvailable) return;
		void loadGitPanel();
	}, [gitAvailable, workspaceId, worktreeId, loadGitPanel]);

	// 新建会话会换 clientId：无论当前停在轨迹还是 Git tab，都回到对话起始页。
	useEffect(() => {
		setView('chat');
		setEditing(false);
	}, [clientId]);

	useEffect(() => {
		if (!editing) setDraft(sessionName ?? '');
	}, [sessionName, editing]);

	const notifyLabel = notify.enabled
		? notifyPermission === 'granted'
			? '完成提醒已开启（点击关闭）'
			: '完成提醒已开启；浏览器通知不可用，仍会提示音 + 标题（点击关闭）'
		: '开启完成提醒（后台通知 + 提示音）';

	const startEditing = () => {
		if (!sessionId) {
			showToast('先发一条消息，再给会话命名');
			return;
		}
		cancelled.current = false;
		setDraft(sessionName ?? '');
		setEditing(true);
	};

	const commit = () => {
		if (cancelled.current) {
			cancelled.current = false;
			setEditing(false);
			return;
		}
		setEditing(false);
		const next = draft.trim();
		if (next === (sessionName ?? '')) return;
		renameSession(next).catch(() => {});
	};

	return (
		<main className="chat">
			<header className="chat-head">
				<div className="chat-head-row">
					<button
						id="menu"
						className="icon-btn only-mobile"
						aria-label="打开菜单"
						onClick={() => {
							const open = drawer === 'rail';
							closeDrawers();
							if (!open) setDrawer('rail');
						}}
					>
						<svg viewBox="0 0 24 24" aria-hidden="true">
							<path
								d="M4 7h16M4 12h16M4 17h16"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
							/>
						</svg>
					</button>
					<h1 id="chat-title">
						{editing ? (
							<input
								className="chat-title-input"
								autoFocus
								value={draft}
								maxLength={120}
								placeholder="会话名称"
								onChange={(event) => setDraft(event.target.value)}
								onFocus={(event) => event.currentTarget.select()}
								onBlur={commit}
								onKeyDown={(event) => {
									if (event.key === 'Enter') {
										event.preventDefault();
										event.currentTarget.blur();
									} else if (event.key === 'Escape') {
										event.preventDefault();
										cancelled.current = true;
										event.currentTarget.blur();
									}
								}}
							/>
						) : (
							<button
								type="button"
								className="chat-title-btn"
								title={sessionId ? '点击修改会话名称' : '先发一条消息后可命名'}
								onClick={startEditing}
							>
								{sessionName || '对话'}
							</button>
						)}
					</h1>
					{workspace ? (
						<span
							className="workspace-chip"
							title={`${workspace.label} · ${workspace.root}${workspace.readonly ? ' · 只读' : ''}${workspace.available === false ? ' · 目录不存在' : ''}`}
						>
							<WorkspaceIcon aria-hidden="true" />
							{workspace.label}
							{workspace.readonly ? <Lock aria-hidden="true" /> : null}
						</span>
					) : workspaceFallback ? (
						<span className="workspace-chip" title={workspaceFallback.root || workspaceFallback.label}>
							<Folder aria-hidden="true" />
							{workspaceFallback.label}
						</span>
					) : null}
					{worktree ? (
						<span
							className="workspace-chip worktree-chip"
							title={`${worktree.branch} · ${worktree.path}${worktree.available === false ? ' · 目录不存在' : ''}`}
						>
							<GitBranch aria-hidden="true" />
							{worktree.branch}
						</span>
					) : null}
					{/* 策略在建会话时定，会话内不允许改（改工具集/提示词会掉缓存），这里只回显 */}
					{sessionCodemode !== 'auto' ? (
						<span
							className={`workspace-chip codemode-chip ${sessionCodemode === 'off' ? 'off' : 'on'}`}
							title={
								sessionCodemode === 'off'
									? 'codemode 在本会话被禁用（建会话时定，不能改）'
									: 'codemode 在本会话强制走脚本（建会话时定，不能改）'
							}
						>
							<Code2 aria-hidden="true" />
							{sessionCodemode === 'off' ? 'codemode 禁用' : 'codemode 强制'}
						</span>
					) : null}
					<span id="chat-model" className="model-chip">
						{modelName}
					</span>
					<div className="head-actions">
						<button
							type="button"
							id="notify-toggle"
							className={`notify-btn${notify.enabled ? ' on' : ''}${notify.enabled && notifyPermission !== 'granted' ? ' warn' : ''}`}
							aria-pressed={notify.enabled}
							aria-label={notifyLabel}
							title={notifyLabel}
							onClick={() => {
								toggleNotify().catch(() => {});
							}}
						>
							{notify.enabled ? <Bell aria-hidden="true" /> : <BellOff aria-hidden="true" />}
							{notify.enabled ? <span className="notify-state" aria-hidden="true" /> : null}
						</button>
						<Button
							variant="unstyled"
							className="ghost"
							id="abort"
							hidden={!busy}
							onClick={() => {
								abort().catch(() => {});
							}}
						>
							停止
						</Button>
						<Button
							variant="unstyled"
							className="ghost"
							id="toggle-panel"
							title={isMobile ? (drawer === 'panel' ? '收起右栏' : '打开右栏') : panelVisible ? '收起右栏' : '打开右栏'}
							aria-label={isMobile ? (drawer === 'panel' ? '收起右栏' : '打开右栏') : panelVisible ? '收起右栏' : '打开右栏'}
							aria-expanded={isMobile ? drawer === 'panel' : panelVisible}
							aria-controls="panel"
							onClick={() => {
								if (isMobile) {
									const open = drawer === 'panel';
									closeDrawers();
									if (!open) setDrawer('panel');
								} else {
									togglePanel();
								}
							}}
						>
							<PanelRight aria-hidden="true" />
						</Button>
					</div>
				</div>
				<nav className="chat-tabs" role="tablist" aria-label="对话视图">
					<button
						id="tab-chat"
						type="button"
						role="tab"
						aria-selected={activeView === 'chat'}
						className={`chat-tab${activeView === 'chat' ? ' active' : ''}`}
						onClick={() => setView('chat')}
					>
						对话
					</button>
					<button
						id="tab-trajectory"
						type="button"
						role="tab"
						aria-selected={activeView === 'trajectory'}
						className={`chat-tab${activeView === 'trajectory' ? ' active' : ''}`}
						onClick={() => setView('trajectory')}
					>
						轨迹
					</button>
					{gitAvailable
						? gitRepos.map((repo) => (
								<button
									key={repo.key}
									id={gitTabId(repo.key)}
									type="button"
									role="tab"
									aria-selected={activeView === 'git' && activeRepo?.key === repo.key}
									className={`chat-tab chat-tab-git${activeView === 'git' && activeRepo?.key === repo.key ? ' active' : ''}`}
									title={`${repo.rel || repo.path}（${repo.branch ?? '未知分支'}）`}
									onClick={() => {
										setGitKey(repo.key);
										setView('git');
									}}
								>
									<GitBranch aria-hidden="true" />
									<span className="chat-tab-label">{repo.name}</span>
									{repo.error ? null : repo.clean ? null : <span className="chat-tab-dirty" title={`${repo.changesTotal} 项改动`} />}
								</button>
							))
						: null}
					{gitAvailable && !worktreeOnly ? (
						<button
							id="tab-git-add"
							type="button"
							role="tab"
							aria-selected={activeView === 'git-add'}
							className={`chat-tab chat-tab-add${activeView === 'git-add' ? ' active' : ''}`}
							title="添加/移除手动登记的子仓库"
							onClick={() => setView('git-add')}
						>
							＋
						</button>
					) : null}
				</nav>
			</header>

			<MessageList hidden={activeView !== 'chat'} />
			{activeView === 'trajectory' ? <TrajectoryView /> : null}
			{activeView === 'git' && activeRepo ? <GitRepoView repo={activeRepo} /> : null}
			{activeView === 'git-add' ? (
				<GitAddView
					onAdded={(key) => {
						setGitKey(key);
						setView('git');
					}}
				/>
			) : null}
			<Composer />
		</main>
	);
}
