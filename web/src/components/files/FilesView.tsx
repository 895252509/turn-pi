import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronsDownUp, Copy, Eye, EyeOff, RefreshCw } from 'lucide-react';
import { FileTree, type DirState } from '@/components/files/FileTree';
import { useStore } from '@/lib/store';
import { describeFilesError, listFiles } from '@/lib/files';

const POLL_MS = 3000;

export function FilesView({
	root,
	active,
	visible,
}: {
	root: string;
	active: boolean;
	visible: boolean;
}) {
	const openFile = useStore((s) => s.openFile);
	const showToast = useStore((s) => s.showToast);
	const refreshTick = useStore((s) => s.panelRefreshTick);
	const workspaces = useStore((s) => s.workspaces);
	const worktrees = useStore((s) => s.worktrees);
	const fileRoots = useStore((s) => s.fileRoots);
	const worktree = worktrees.find((item) => item.id === root);
	const workspace = workspaces.find((item) => item.id === root);
	// 只读 tmp 这类 root 不在工作区/隔离工作树表里，名字和路径从文件 API 的 root 清单拿
	const fileRoot = fileRoots.find((item) => item.id === root);
	const rootPath =
		worktree?.path ?? workspace?.root ?? fileRoot?.path ?? (root === 'workspace' ? '/workspace' : root);
	const rootLabel =
		worktree?.branch ?? workspace?.label ?? fileRoot?.label ?? (root === 'workspace' ? '/workspace' : root);
	const [dirs, setDirs] = useState<Record<string, DirState>>({
		'': { status: 'idle', entries: [], expanded: true },
	});
	const [showIgnored, setShowIgnored] = useState(false);
	const seq = useRef<Record<string, number>>({});
	const dirsRef = useRef(dirs);
	dirsRef.current = dirs;
	const lastTick = useRef(refreshTick);

	const loadDir = useCallback(
		async (path: string, options: { force?: boolean } = {}) => {
			const nextSeq = (seq.current[path] ?? 0) + 1;
			seq.current[path] = nextSeq;
			setDirs((prev) => {
				const current = prev[path] ?? { status: 'idle' as const, entries: [] };
				// 空目录加载成功后 entries 仍为空：用 ready 区分「已加载」和「从没加载」。
				const cached = current.entries.length > 0 || current.status === 'ready';
				return {
					...prev,
					[path]: {
						...current,
						status: cached ? current.status : 'loading',
						refreshing: cached,
						error: undefined,
						// 没有缓存子项时先不展开：加载成功后由下面的 setDirs 展开，
						// 加载期间只让目录行图标转圈（重试时也先收起旧错误）。
						expanded: cached ? current.expanded : path === '',
						pending: !cached,
					},
				};
			});

			try {
				const result = await listFiles(root, path);
				if (seq.current[path] !== nextSeq) return;
				setDirs((prev) => ({
					...prev,
					[path]: {
						...(prev[path] ?? {}),
						status: 'ready',
						entries: result.entries,
						truncated: result.truncated,
						error: undefined,
						refreshing: false,
						expanded: Boolean(prev[path]?.expanded || prev[path]?.pending || path === ''),
						pending: false,
					},
				}));
			} catch (error) {
				if (seq.current[path] !== nextSeq) return;
				setDirs((prev) => ({
					...prev,
					[path]: {
						...(prev[path] ?? { entries: [] }),
						status: 'error',
						error: describeFilesError(error),
						refreshing: false,
						// 失败时展开，让「重试」入口可见；重试时会重新收起并转圈。
						expanded: true,
						pending: false,
					},
				}));
			}
		},
		[root],
	);

	const refreshAll = useCallback(() => {
		for (const [path, dir] of Object.entries(dirsRef.current)) {
			if (path === '' || dir.expanded) loadDir(path, { force: true });
		}
	}, [loadDir]);

	// 首次挂载只加载根；目录懒加载
	useEffect(() => {
		loadDir('');
	}, [loadDir]);

	// 聊天里的 write/edit/bash 或 settled 后刷新
	useEffect(() => {
		if (refreshTick === lastTick.current) return;
		lastTick.current = refreshTick;
		if (active && visible) refreshAll();
	}, [refreshTick, active, visible, refreshAll]);

	// 激活文件 tab 时顺手刷新已展开目录，并启动低频轮询
	useEffect(() => {
		if (!active || !visible) return;
		refreshAll();
		const timer = window.setInterval(() => {
			if (document.visibilityState === 'visible') refreshAll();
		}, POLL_MS);
		const onFocus = () => refreshAll();
		window.addEventListener('focus', onFocus);
		return () => {
			window.clearInterval(timer);
			window.removeEventListener('focus', onFocus);
		};
	}, [active, visible, refreshAll]);

	const toggleDir = (path: string) => {
		const current = dirsRef.current[path];
		const willExpand = !current?.expanded;
		if (!willExpand) {
			setDirs((prev) => ({
				...prev,
				[path]: { ...(prev[path] ?? { status: 'idle', entries: [] }), expanded: false, pending: false },
			}));
			return;
		}
		// 首次打开：先请求，等返回再展开；重复点击不再发请求。
		const cached = Boolean(current?.entries.length) || current?.status === 'ready';
		if (!cached && current?.status === 'loading') return;
		if (cached) {
			setDirs((prev) => ({
				...prev,
				[path]: { ...(prev[path] ?? { status: 'idle', entries: [] }), expanded: true, pending: false },
			}));
		}
		loadDir(path);
	};

	const collapseAll = () => {
		setDirs((prev) => {
			const next: Record<string, DirState> = {};
			for (const [path, dir] of Object.entries(prev)) next[path] = { ...dir, expanded: path === '', pending: false };
			return next;
		});
	};

	const copyRoot = async () => {
		try {
			await navigator.clipboard?.writeText(rootPath);
			showToast('已复制根路径');
		} catch {
			showToast(rootPath);
		}
	};

	const rootState = dirs[''];
	const rootError = rootState?.status === 'error' && !rootState.entries.length;

	return (
		<div className="files">
			<div className="files-head">
				<span className="files-root" title={rootPath}>
					{rootLabel}
					<small>{rootPath}</small>
				</span>
				<div className="files-actions">
					<button
						type="button"
						className={`files-btn${showIgnored ? ' active' : ''}`}
						title={showIgnored ? '隐藏 node_modules/.git 等目录' : '显示被忽略的目录'}
						aria-pressed={showIgnored}
						onClick={() => setShowIgnored((value) => !value)}
					>
						{showIgnored ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
						<span>显示忽略项</span>
					</button>
					<button
						type="button"
						className={`files-btn icon${rootState?.refreshing || rootState?.status === 'loading' ? ' spinning' : ''}`}
						title="刷新"
						aria-label="刷新文件树"
						onClick={refreshAll}
					>
						<RefreshCw aria-hidden="true" />
					</button>
					<button
						type="button"
						className="files-btn icon"
						title="全部折叠"
						aria-label="全部折叠"
						onClick={collapseAll}
					>
						<ChevronsDownUp aria-hidden="true" />
					</button>
					<button
						type="button"
						className="files-btn icon only-desktop"
						title="复制根路径"
						aria-label="复制根路径"
						onClick={copyRoot}
					>
						<Copy aria-hidden="true" />
					</button>
				</div>
			</div>

			{rootError ? (
				<div className="files-offline">
					<strong>文件树暂不可用</strong>
					<span>{rootState.error}</span>
					<button type="button" className="files-retry" onClick={() => loadDir('', { force: true })}>
						重试
					</button>
				</div>
			) : null}

			<div className="files-body panel-scroll">
				<FileTree
					root={root}
					dirs={dirs}
					showIgnored={showIgnored}
					onToggle={toggleDir}
					onOpen={(fileRoot, path) => openFile(path, { root: fileRoot })}
					onRetry={(path) => loadDir(path, { force: true })}
				/>
			</div>
		</div>
	);
}
