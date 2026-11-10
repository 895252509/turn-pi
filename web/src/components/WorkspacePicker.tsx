import { useEffect, useRef, useState } from 'react';
import { Check, ChevronsUpDown, Folder, FolderGit2, Lock, Plus, RefreshCw, X } from 'lucide-react';
import { useStore } from '@/lib/store';

/**
 * 新对话空视图里的工作区选择器。
 * 只决定“发送第一条消息时用哪个 cwd”；已有会话跟随自己的 session header。
 */
export function WorkspacePicker({ disabled = false }: { disabled?: boolean }) {
	const workspaces = useStore((s) => s.workspaces);
	const workspaceId = useStore((s) => s.workspaceId);
	const setWorkspace = useStore((s) => s.setWorkspace);
	const reloadWorkspaces = useStore((s) => s.reloadWorkspaces);
	const createWorkspace = useStore((s) => s.createWorkspace);
	const [open, setOpen] = useState(false);
	const [refreshing, setRefreshing] = useState(false);
	const [adding, setAdding] = useState(false);
	const [newPath, setNewPath] = useState('');
	const [addingBusy, setAddingBusy] = useState(false);
	const rootRef = useRef<HTMLDivElement | null>(null);
	const current = workspaces.find((workspace) => workspace.id === workspaceId);
	const selectable = workspaces.filter((workspace) => workspace.available !== false);

	useEffect(() => {
		if (!open) return;
		const onPointerDown = (event: PointerEvent) => {
			if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') setOpen(false);
		};
		document.addEventListener('pointerdown', onPointerDown);
		document.addEventListener('keydown', onKeyDown);
		return () => {
			document.removeEventListener('pointerdown', onPointerDown);
			document.removeEventListener('keydown', onKeyDown);
		};
	}, [open]);

	useEffect(() => {
		if (open) return;
		setAdding(false);
		setNewPath('');
	}, [open]);

	const Icon = current?.kind === 'git' ? FolderGit2 : Folder;

	return (
		<div className="workspace-picker" ref={rootRef}>
			<span className="workspace-picker-label">工作区</span>
			<button
				type="button"
				className="workspace-picker-btn"
				aria-haspopup="listbox"
				aria-expanded={open}
				title={disabled ? '已有会话的工作区由 session cwd 决定' : current?.root ?? '选择工作区'}
				disabled={disabled}
				onClick={() => setOpen((value) => !value)}
			>
				<Icon aria-hidden="true" />
				<span className="workspace-picker-name">{current?.label ?? '工作区'}</span>
				<span className="workspace-picker-path">{current?.root ?? '/workspace'}</span>
				<ChevronsUpDown aria-hidden="true" />
			</button>
			{open ? (
				<div className="workspace-menu" role="listbox" aria-label="选择工作区">
					<div className="workspace-menu-head">
						<span>选择工作区</span>
						<div className="workspace-menu-actions">
							<button
								type="button"
								className="workspace-menu-refresh"
								title="重新发现工作区"
								aria-label="重新发现工作区"
								disabled={refreshing}
								onClick={async () => {
									setRefreshing(true);
									try {
										await reloadWorkspaces();
									} finally {
										setRefreshing(false);
									}
								}}
							>
								<RefreshCw className={refreshing ? 'spin' : undefined} aria-hidden="true" />
							</button>
							<button
								type="button"
								className="workspace-menu-add"
								title="添加任意路径的工作区"
								aria-label="添加任意路径的工作区"
								aria-expanded={adding}
								onClick={() => setAdding((value) => !value)}
							>
								<Plus aria-hidden="true" />
							</button>
						</div>
					</div>
					{adding ? (
						<form
							className="workspace-add-form"
							onSubmit={async (event) => {
								event.preventDefault();
								const path = newPath.trim();
								if (!path || addingBusy) return;
								setAddingBusy(true);
								try {
									const workspace = await createWorkspace(path);
									if (workspace) {
										setNewPath('');
										setAdding(false);
										setOpen(false);
									}
								} finally {
									setAddingBusy(false);
								}
							}}
						>
							<input
								className="workspace-add-input"
								value={newPath}
								onChange={(event) => setNewPath(event.target.value)}
								placeholder="/workspace/my-dir"
								aria-label="工作区绝对路径"
								autoFocus
							/>
							<button type="submit" className="workspace-add-submit" disabled={addingBusy || !newPath.trim()}>
								{addingBusy ? '添加中…' : '添加'}
							</button>
							<button
								type="button"
								className="workspace-add-cancel"
								title="取消"
								aria-label="取消添加工作区"
								onClick={() => {
									setAdding(false);
									setNewPath('');
								}}
							>
								<X aria-hidden="true" />
							</button>
						</form>
					) : null}
					{selectable.length ? (
						selectable.map((workspace) => {
							const selected = workspace.id === workspaceId;
							const ItemIcon = workspace.kind === 'git' ? FolderGit2 : Folder;
							return (
								<button
									key={workspace.id}
									type="button"
									role="option"
									aria-selected={selected}
									className={`workspace-option${selected ? ' selected' : ''}`}
									title={workspace.root}
									onClick={() => {
										setOpen(false);
										setWorkspace(workspace.id);
									}}
								>
									<ItemIcon aria-hidden="true" />
									<span className="workspace-option-text">
										<span className="workspace-option-name">{workspace.label}</span>
										<span className="workspace-option-path">{workspace.root}</span>
									</span>
									{workspace.readonly ? <Lock aria-hidden="true" /> : null}
									{selected ? <Check aria-hidden="true" /> : null}
								</button>
							);
						})
					) : (
						<div className="workspace-menu-empty">读取工作区列表…</div>
					)}
				</div>
			) : null}
		</div>
	);
}
