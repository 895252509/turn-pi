import { useMemo } from 'react';
import { Archive, GitBranch, PanelLeftClose, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { GlobalFoot } from '@/components/GlobalFoot';
import { MobileModuleStrip } from '@/components/MobileModuleStrip';
import { SessionList } from '@/components/SessionList';
import { useStore } from '@/lib/store';
import { BrandMark } from '@/components/BrandMark';

/**
 * 对话模块的上下文列（历史会话）。桌面端可折叠成 icon rail 上的一个按钮，移动端就是抽屉。
 *
 * `collapsed` 只是"收起了"：元素仍然挂载，靠 CSS 的 --ctx-f 过渡把列宽收到 0，
 * 所以收起/展开有动画；收起期间用 inert + aria-hidden 把它从焦点/读屏里摘掉。
 */
export function Sidebar({ mobile = false, collapsed = false }: { mobile?: boolean; collapsed?: boolean }) {
	const drawer = useStore((s) => s.drawer);
	const sessions = useStore((s) => s.sessions);
	const newChat = useStore((s) => s.newChat);
	const worktrees = useStore((s) => s.worktrees);
	const removeWorktree = useStore((s) => s.removeWorktree);
	const setContextCollapsed = useStore((s) => s.setContextCollapsed);

	/** worktree 只记住绑定的 sessionId，归档状态要从会话列表里现查 */
	const sessionsById = useMemo(() => new Map(sessions.map((item) => [item.id, item])), [sessions]);

	return (
		<aside
			className={`rail${drawer === 'rail' ? ' open' : ''}${collapsed ? ' collapsed' : ''}`}
			inert={collapsed || undefined}
			aria-hidden={collapsed || undefined}
		>
			{mobile ? <MobileModuleStrip /> : null}
			<div className="rail-head">
				<div className="rail-head-row">
					<div className="brand">
						<BrandMark />
						<div>
							<strong>Turn Pi</strong>
							<small>SDK 内嵌 · 自托管</small>
						</div>
					</div>
					<button
						type="button"
						id="rail-collapse"
						className="icon-btn rail-collapse"
						title="收起会话列表（点左侧对话图标可再展开）"
						aria-label="收起会话列表"
						aria-controls="sessions"
						aria-expanded="true"
						onClick={() => setContextCollapsed(true)}
					>
						<PanelLeftClose aria-hidden="true" />
					</button>
				</div>

				<Button variant="unstyled" className="ghost" id="new-chat" onClick={() => newChat()}>
					＋ 新对话
				</Button>
			</div>

			<div className="rail-body">
				<div className="rail-section grow">
					<span className="label">历史会话</span>
					<SessionList searchable />
				</div>

				{worktrees.length ? (
					<div className="rail-section worktree-section">
						<span className="label">隔离工作树 · {worktrees.length}</span>
						<div className="worktree-list">
							{worktrees.map((worktree) => {
								const bound = worktree.sessionId ? sessionsById.get(worktree.sessionId) : undefined;
								const boundArchived = Boolean(bound?.archived);
								return (
									<div
										key={worktree.id}
										className={`worktree-row${worktree.available === false ? ' missing' : ''}${boundArchived ? ' archived-session' : ''}`}
									>
										<GitBranch aria-hidden="true" />
										<span className="worktree-row-text" title={worktree.path}>
											<strong>{worktree.branch}</strong>
											<small>
												<span className="worktree-row-meta">
													{worktree.workspaceLabel ?? worktree.workspaceId}
													{worktree.available === false ? ' · 目录缺失' : ''}
												</span>
												{boundArchived ? (
													<span
														className="worktree-flag archived"
														title={`绑定会话已归档：${bound?.name || bound?.title || worktree.sessionId}`}
													>
														<Archive aria-hidden="true" />
														会话已归档
													</span>
												) : null}
											</small>
										</span>
										<button
											type="button"
											className="worktree-remove"
											title="删除 worktree（有未提交改动会被拒绝）"
											aria-label={`删除 ${worktree.branch}`}
											onClick={() => {
												if (window.confirm(`删除 worktree ${worktree.branch}？分支会保留。`)) {
													void removeWorktree(worktree.id);
												}
											}}
										>
											<Trash2 aria-hidden="true" />
										</button>
									</div>
								);
							})}
						</div>
					</div>
				) : null}
			</div>

			{mobile ? <GlobalFoot /> : null}
		</aside>
	);
}
