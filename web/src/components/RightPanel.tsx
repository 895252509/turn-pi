import { useEffect, useRef, useState } from 'react';
import { Compass, FileText, Folder, Globe, PanelRightClose, Plus } from 'lucide-react';
import { GuideView } from '@/components/GuideView';
import { FilesView } from '@/components/files/FilesView';
import { PreviewView } from '@/components/previews/PreviewView';
import { SearchSourcesView } from '@/components/SearchSourcesView';
import { basename, type PanelTab } from '@/lib/panel';
import { useStore } from '@/lib/store';

function tabTitle(tab: PanelTab): string {
	if (tab.kind === 'guide') return '功能';
	if (tab.kind === 'files') return '文件';
	if (tab.kind === 'search') return '检索';
	return basename(tab.path);
}

function tabTooltip(tab: PanelTab): string {
	if (tab.kind === 'guide') return '功能';
	if (tab.kind === 'files') return '文件';
	if (tab.kind === 'search') return '联网搜索来源';
	return `${tab.root}:${tab.path}`;
}

function TabIcon({ tab }: { tab: PanelTab }) {
	if (tab.kind === 'guide') return <Compass aria-hidden="true" />;
	if (tab.kind === 'files') return <Folder aria-hidden="true" />;
	if (tab.kind === 'search') return <Globe aria-hidden="true" />;
	return <FileText aria-hidden="true" />;
}

/** 右栏壳：头部 tab 条 + 常驻操作 + 所有 tab body（保持挂载）。 */
export function RightPanel({ isMobile = false, open = false }: { isMobile?: boolean; open?: boolean }) {
	const panelVisible = useStore((s) => s.panelVisible);
	const tabs = useStore((s) => s.panelTabs);
	const activeTabId = useStore((s) => s.activeTabId);
	const activatePanelTab = useStore((s) => s.activatePanelTab);
	const closePanelTab = useStore((s) => s.closePanelTab);
	const openGuide = useStore((s) => s.openGuide);
	const openGuideEntry = useStore((s) => s.openGuideEntry);
	const collapsePanel = useStore((s) => s.collapsePanel);
	const workspaceId = useStore((s) => s.workspaceId || 'workspace');
	const worktreeId = useStore((s) => s.worktreeId);
	const worktrees = useStore((s) => s.worktrees);
	const workspaces = useStore((s) => s.workspaces);
	const workspaceFallback = useStore((s) => s.workspaceFallback);

	const [mounted, setMounted] = useState(false);
	const [entered, setEntered] = useState(false);
	const tabRefs = useRef<Record<string, HTMLDivElement | null>>({});

	useEffect(() => {
		if (open) setMounted(true);
	}, [open]);

	useEffect(() => {
		if (!open) {
			setEntered(false);
			return;
		}
		const frame = requestAnimationFrame(() => setEntered(true));
		return () => cancelAnimationFrame(frame);
	}, [open]);

	const active = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
	const shown = isMobile ? open : panelVisible;

	useEffect(() => {
		const node = tabRefs.current[activeTabId];
		node?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
	}, [activeTabId]);

	if (!active) return null;
	if (isMobile && !mounted) return null;

	const hidden = isMobile && !open;
	const workspaceInfo = workspaces.find((workspace) => workspace.id === workspaceId);
	const worktreeInfo = worktrees.find((worktree) => worktree.id === worktreeId);
	const fileRootId = worktreeInfo?.id ?? workspaceId;
	const workspaceUnavailable =
		workspaceId === '__unregistered__' ||
		workspaceInfo?.available === false ||
		(worktreeInfo ? worktreeInfo.available === false || worktreeInfo.state === 'missing' : false);
	const unavailableRoot = worktreeInfo?.path ?? workspaceFallback?.root ?? workspaceInfo?.root ?? '';

	return (
		<aside
			id="panel"
			className={`panel${entered ? ' open' : ''}`}
			inert={hidden}
			aria-hidden={hidden || undefined}
		>
			<header className="panel-head">
				<div className="panel-tabs" role="tablist" aria-label="右栏">
					{tabs.map((tab) => {
						const selected = tab.id === active.id;
						const closeable = !(tab.kind === 'guide' && tabs.length === 1);
						return (
							<div
								key={tab.id}
								ref={(node) => {
									tabRefs.current[tab.id] = node;
								}}
								role="tab"
								tabIndex={selected ? 0 : -1}
								aria-selected={selected}
								aria-label={tabTitle(tab)}
								title={tabTooltip(tab)}
								className={`panel-tab${selected ? ' active' : ''}${tab.kind === 'guide' ? ' panel-tab-guide' : ''}`}
								onClick={() => activatePanelTab(tab.id)}
								onKeyDown={(event) => {
									if (event.key === 'Enter' || event.key === ' ') {
										event.preventDefault();
										activatePanelTab(tab.id);
									}
								}}
							>
								<TabIcon tab={tab} />
								{tab.kind === 'guide' ? null : <span className="panel-tab-name">{tabTitle(tab)}</span>}
								{closeable ? (
									<button
										type="button"
										className="panel-tab-close"
										aria-label={`关闭 ${tabTitle(tab)}`}
										title={`关闭 ${tabTitle(tab)}`}
										onClick={(event) => {
											event.stopPropagation();
											closePanelTab(tab.id);
										}}
									>
										×
									</button>
								) : null}
							</div>
						);
					})}
				</div>
				<div className="panel-actions">
					<button
						type="button"
						className="panel-action"
						title="功能"
						aria-label="功能"
						onClick={openGuide}
					>
						<Plus aria-hidden="true" />
					</button>
					<button
						type="button"
						className="panel-action"
						title="收起右栏"
						aria-label="收起右栏"
						onClick={collapsePanel}
					>
						<PanelRightClose aria-hidden="true" />
					</button>
				</div>
			</header>

			<div className="panel-body">
				{tabs.map((tab) => {
					const isActive = tab.id === active.id;
					return (
						<section
							key={tab.id}
							className={`panel-page kind-${tab.kind}${isActive ? ' active' : ''}`}
							style={{ display: isActive ? 'flex' : 'none' }}
							aria-hidden={!isActive || undefined}
						>
							{tab.kind === 'guide' ? (
								<GuideView onOpen={openGuideEntry} />
							) : tab.kind === 'files' ? (
								workspaceUnavailable ? (
									<div className="files-offline">
										<strong>工作区不可用</strong>
										<span>{unavailableRoot || '该会话的 cwd 未注册为工作区，或目录已不存在。'}</span>
										<span>先在新建对话里添加该目录，或恢复挂载后再试。</span>
									</div>
								) : (
									<FilesView key={fileRootId} root={fileRootId} active={isActive} visible={shown} />
								)
							) : tab.kind === 'search' ? (
								<SearchSourcesView />
							) : (
								<PreviewView tab={tab} active={isActive} visible={shown} />
							)}
						</section>
					);
				})}
			</div>
		</aside>
	);
}
