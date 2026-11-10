import { useCallback, useEffect, useMemo, useState } from 'react';
import {
	ArrowDown,
	ArrowUp,
	ChevronDown,
	ChevronRight,
	File,
	GitBranch,
	Loader2,
	RefreshCw,
} from 'lucide-react';
import type {
	GitBranches as GitBranchesData,
	GitChange,
	GitCommitDetail,
	GitCommitFile,
	GitLog,
	GitRepoSummary,
} from '@/lib/types';
import { useStore } from '@/lib/store';
import { loadGitBranches, loadGitCommit, loadGitLog } from '@/lib/git';
import { GitGraph, RefBadge } from './GitGraph';
import { GitBranches } from './GitBranches';

interface DirNode {
	name: string;
	/** 相对仓库根的前缀；根节点为空 */
	path: string;
	dirs: DirNode[];
	files: GitChange[];
}

type Selection = { kind: 'commit'; sha: string } | { kind: 'worktree' };

/** 把扁平改动清单折成目录树（VS Code 源码管理那种），目录是合成的、不入库。 */
function buildTree(changes: GitChange[]): DirNode {
	const root: DirNode = { name: '', path: '', dirs: [], files: [] };
	for (const change of changes) {
		const segments = change.path.replace(/\\/g, '/').split('/').filter(Boolean);
		if (!segments.length) continue;
		let node = root;
		for (const segment of segments.slice(0, -1)) {
			let next = node.dirs.find((item) => item.name === segment);
			if (!next) {
				next = { name: segment, path: node.path ? `${node.path}/${segment}` : segment, dirs: [], files: [] };
				node.dirs.push(next);
			}
			node = next;
		}
		node.files.push(change);
	}
	const sort = (node: DirNode) => {
		node.dirs.sort((a, b) => a.name.localeCompare(b.name));
		node.files.sort((a, b) => a.path.localeCompare(b.path));
		node.dirs.forEach(sort);
	};
	sort(root);
	return root;
}

function countChanges(node: DirNode): number {
	return node.files.length + node.dirs.reduce((sum, dir) => sum + countChanges(dir), 0);
}

/** porcelain 的两字符状态码 → 一个可读字母 + 颜色分类。 */
function changeBadge(code: string): { text: string; tone: string } {
	if (code === '??') return { text: 'U', tone: 'untracked' };
	if (code.includes('D')) return { text: 'D', tone: 'deleted' };
	if (code.includes('R')) return { text: 'R', tone: 'renamed' };
	if (code.includes('A')) return { text: 'A', tone: 'added' };
	if (code.includes('M')) return { text: 'M', tone: 'modified' };
	if (code.includes('U') || code.includes('!')) return { text: '!', tone: 'conflict' };
	return { text: code.trim() || '?', tone: 'other' };
}

function isDeleted(code: string): boolean {
	return code[0] === 'D' || code[1] === 'D';
}

/** `git diff --name-status` 的 A/M/D/T 也用同一套配色。 */
function commitFileTone(status: string): string {
	if (status === 'A') return 'added';
	if (status === 'D') return 'deleted';
	if (status === 'T') return 'renamed';
	return 'modified';
}

function shortTime(iso: string): string {
	const time = new Date(iso).getTime();
	if (!Number.isFinite(time)) return '';
	return new Date(time).toLocaleString('zh-CN', {
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
	});
}

function ChangeRow({
	change,
	depth,
	onOpen,
}: {
	change: GitChange;
	depth: number;
	onOpen: (change: GitChange) => void;
}) {
	const badge = changeBadge(change.code);
	const name = change.path.split('/').pop() ?? change.path;
	return (
		<li>
			<button
				type="button"
				className="git-row git-file-row"
				style={{ paddingLeft: `${depth * 14 + 8}px` }}
				title={`${change.path}${change.staged ? '（已暂存）' : ''}\n点击查看文件内容`}
				onClick={() => onOpen(change)}
			>
				<span className="git-row-icon" aria-hidden="true" />
				<File className="git-row-svg" aria-hidden="true" />
				<span className="git-file-name">{name}</span>
				<span className={`git-code ${badge.tone}`} title={change.code}>
					{badge.text}
				</span>
			</button>
		</li>
	);
}

function DirRows({
	node,
	depth,
	collapsed,
	onToggle,
	onOpen,
}: {
	node: DirNode;
	depth: number;
	collapsed: Set<string>;
	onToggle: (path: string) => void;
	onOpen: (change: GitChange) => void;
}) {
	return (
		<>
			{node.dirs.map((dir) => {
				const closed = collapsed.has(dir.path);
				const Chevron = closed ? ChevronRight : ChevronDown;
				return (
					<li key={`d:${dir.path}`}>
						<button
							type="button"
							className="git-row git-dir-row"
							style={{ paddingLeft: `${depth * 14 + 8}px` }}
							aria-expanded={!closed}
							onClick={() => onToggle(dir.path)}
						>
							<Chevron className="git-row-svg" aria-hidden="true" />
							<span className="git-file-name">{dir.name}</span>
							<span className="git-dir-count">{countChanges(dir)}</span>
						</button>
						{closed ? null : (
							<ul className="git-tree" role="group">
								<DirRows node={dir} depth={depth + 1} collapsed={collapsed} onToggle={onToggle} onOpen={onOpen} />
							</ul>
						)}
					</li>
				);
			})}
			{node.files.map((change) => (
				<ChangeRow key={`f:${change.path}`} change={change} depth={depth} onOpen={onOpen} />
			))}
		</>
	);
}

/** 仓库 tab：默认就是提交记录树；点一条提交，右栏分成「提交信息 / 改动文件」两块。 */
export function GitRepoView({ repo }: { repo: GitRepoSummary }) {
	const openFile = useStore((s) => s.openFile);
	const showToast = useStore((s) => s.showToast);
	const workspaceId = useStore((s) => s.workspaceId);
	const worktreeId = useStore((s) => s.worktreeId);
	const loadGitPanel = useStore((s) => s.loadGitPanel);

	const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
	const [refreshing, setRefreshing] = useState(false);
	const [log, setLog] = useState<GitLog | null>(null);
	const [logLoading, setLogLoading] = useState(true);
	const [logError, setLogError] = useState('');
	const [branches, setBranches] = useState<GitBranchesData | null>(null);
	const [branchesLoading, setBranchesLoading] = useState(true);
	const [branchesError, setBranchesError] = useState('');
	/** 左栏选中的分支（完整 ref）；null 表示不过滤，看 --all */
	const [refFilter, setRefFilter] = useState<string | null>(null);
	const [selection, setSelection] = useState<Selection | null>(null);
	const [detail, setDetail] = useState<GitCommitDetail | null>(null);
	const [detailLoading, setDetailLoading] = useState(false);
	const [detailError, setDetailError] = useState('');

	const tree = useMemo(() => buildTree(repo.changes), [repo.changes]);
	const root = repo.source === 'worktree' && worktreeId ? worktreeId : workspaceId || 'workspace';

	const fetchLog = useCallback(async () => {
		setLogLoading(true);
		setLogError('');
		try {
			setLog(await loadGitLog(root, repo.rel, worktreeId ?? undefined, undefined, refFilter));
		} catch (error) {
			setLogError(error instanceof Error ? error.message : String(error));
		} finally {
			setLogLoading(false);
		}
	}, [root, repo.rel, worktreeId, refFilter]);

	const fetchBranches = useCallback(async () => {
		setBranchesLoading(true);
		setBranchesError('');
		try {
			setBranches(await loadGitBranches(root, repo.rel, worktreeId ?? undefined));
		} catch (error) {
			setBranchesError(error instanceof Error ? error.message : String(error));
		} finally {
			setBranchesLoading(false);
		}
	}, [root, repo.rel, worktreeId]);

	useEffect(() => {
		void fetchLog();
	}, [fetchLog]);

	useEffect(() => {
		void fetchBranches();
	}, [fetchBranches]);

	const openCommit = async (sha: string) => {
		setSelection({ kind: 'commit', sha });
		setDetail(null);
		setDetailError('');
		setDetailLoading(true);
		try {
			setDetail(await loadGitCommit(root, repo.rel, sha, worktreeId ?? undefined));
		} catch (error) {
			setDetailError(error instanceof Error ? error.message : String(error));
		} finally {
			setDetailLoading(false);
		}
	};

	const refresh = async () => {
		if (refreshing) return;
		setRefreshing(true);
		try {
			await Promise.all([
				fetchLog(),
				fetchBranches(),
				loadGitPanel({ refresh: true }),
				selection?.kind === 'commit' ? openCommit(selection.sha) : null,
			]);
		} finally {
			setRefreshing(false);
		}
	};

	const toggle = (path: string) => {
		setCollapsed((previous) => {
			const next = new Set(previous);
			if (next.has(path)) next.delete(path);
			else next.add(path);
			return next;
		});
	};

	/** 仓库里的相对路径 → 工作区里的路径（工作树的仓库本来就在根上）。 */
	const repoPath = (path: string) =>
		repo.source === 'worktree' || !repo.rel ? path : `${repo.rel}/${path}`;

	const openRepoFile = (path: string, code?: string) => {
		if (code && isDeleted(code)) {
			showToast(`${path} 已删除；diff 视图还没做`);
			return;
		}
		openFile(repoPath(path), { root });
	};

	const openCommitFile = (file: GitCommitFile) => {
		if (file.status === 'D') {
			showToast(`${file.path} 在这次提交里被删除；diff 视图还没做`);
			return;
		}
		openRepoFile(file.path);
	};

	return (
		<section className="git-view" aria-label={`${repo.name} 的 Git 状态`}>
			<div className="git-inner">
				<div className="git-repo-head">
					<div className="git-repo-title">
						<strong title={repo.path}>{repo.name}</strong>
						<span className={`git-source git-source-${repo.source}`}>
							{repo.source === 'root'
								? '工作区仓库'
								: repo.source === 'worktree'
									? '当前工作树'
									: repo.source === 'manual'
										? '手动登记'
										: '自动发现'}
						</span>
						<span className="git-branch" title={repo.upstream ? `上游 ${repo.upstream}` : '没有上游分支'}>
							<GitBranch aria-hidden="true" />
							{repo.branch || '（未出生分支）'}
							{repo.detached ? ' detached' : ''}
						</span>
						{repo.ahead > 0 ? (
							<span className="git-ahead" title={`领先上游 ${repo.ahead} 个提交`}>
								<ArrowUp aria-hidden="true" />
								{repo.ahead}
							</span>
						) : null}
						{repo.behind > 0 ? (
							<span className="git-behind" title={`落后上游 ${repo.behind} 个提交`}>
								<ArrowDown aria-hidden="true" />
								{repo.behind}
							</span>
						) : null}
					</div>
					<button
						type="button"
						className="git-btn"
						disabled={refreshing}
						title="重新读取仓库状态与提交记录（并强制重扫子目录）"
						onClick={() => void refresh()}
					>
						{refreshing ? <Loader2 className="spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
						刷新
					</button>
				</div>
				<p className="git-repo-path" title={repo.path}>
					{repo.rel || repo.path}
				</p>
				{repo.error ? <p className="git-error">{repo.error}</p> : null}

				<div className={selection ? 'git-body split' : 'git-body'}>
					<GitBranches
						data={branches}
						loading={branchesLoading}
						error={branchesError}
						active={refFilter}
						onPick={(ref) => setRefFilter(ref)}
						onRetry={() => void fetchBranches()}
					/>
					<div className="git-list">
						{refFilter ? (
							<div className="git-filter-chip">
								<GitBranch aria-hidden="true" />
								<span>只看 {refFilter.replace(/^refs\/(heads|remotes)\//, '')}</span>
								<button type="button" onClick={() => setRefFilter(null)} title="显示所有引用的提交">
									全部
								</button>
							</div>
						) : null}
						{repo.changesTotal > 0 ? (
							<button
								type="button"
								className={`git-commit git-dirty-row${selection?.kind === 'worktree' ? ' selected' : ''}`}
								aria-pressed={selection?.kind === 'worktree'}
								onClick={() => {
									setSelection({ kind: 'worktree' });
									setDetailError('');
								}}
							>
								<span className="git-dirty-dot" aria-hidden="true" />
								<span className="git-commit-body">
									<span className="git-commit-line">
										<span className="git-commit-subject">未提交改动</span>
									</span>
									<span className="git-commit-meta">
										<span>{repo.changesTotal} 项</span>
										<span>{repo.branch || ''}</span>
									</span>
								</span>
							</button>
						) : null}

						{logLoading ? (
							<p className="git-empty">
								<Loader2 className="spin" aria-hidden="true" /> 正在读取提交记录…
							</p>
						) : logError ? (
							<div className="git-log-error">
								<p className="git-error">{logError}</p>
								<button type="button" className="git-btn" onClick={() => void fetchLog()}>
									重试
								</button>
							</div>
						) : log?.commits.length ? (
							<>
								<GitGraph
									commits={log.commits}
									selectedSha={selection?.kind === 'commit' ? selection.sha : null}
									onSelect={(sha) => void openCommit(sha)}
								/>
								{log.hasMore ? (
									<p className="git-hint">
										只显示最近 {log.commits.length} 条提交（--all）；更早的用 `git log` 看。
									</p>
								) : null}
							</>
						) : (
							<p className="git-empty">这个仓库还没有提交。</p>
						)}
					</div>

					{selection ? (
						<aside className="git-detail" aria-label="提交详情">
							{selection.kind === 'worktree' ? (
								<>
									<div className="git-detail-block">
										<div className="git-detail-head">
											<span className="git-detail-title">未提交改动</span>
											<span className="git-detail-badge">{repo.changesTotal} 项</span>
										</div>
										<div className="git-detail-refs">
											<span className="git-ref branch">{repo.branch || '未出生分支'}</span>
											{repo.clean ? <span className="git-ref">工作区干净</span> : null}
										</div>
										<dl className="git-detail-facts">
											<div>
												<dt>路径</dt>
												<dd title={repo.path}>{repo.rel || repo.path}</dd>
											</div>
											{repo.lastCommit ? (
												<div>
													<dt>HEAD</dt>
													<dd title={repo.lastCommit.subject}>
														<code>{repo.lastCommit.sha}</code> {repo.lastCommit.subject}
													</dd>
												</div>
											) : null}
										</dl>
									</div>
									<div className="git-detail-block">
										<div className="git-detail-block-head">
											改动文件 <b>{repo.changesTotal}</b>
										</div>
										{repo.changes.length ? (
											<ul className="git-tree" role="tree" aria-label="改动文件树">
												<DirRows
													node={tree}
													depth={0}
													collapsed={collapsed}
													onToggle={toggle}
													onOpen={(change) => openRepoFile(change.path, change.code)}
												/>
											</ul>
										) : (
											<p className="git-empty">工作区干净，没有可显示的改动。</p>
										)}
										{repo.changesTotal > repo.changes.length ? (
											<p className="git-hint">
												只显示前 {repo.changes.length} 项（共 {repo.changesTotal} 项），其余请用命令行查看。
											</p>
										) : null}
									</div>
								</>
							) : detailLoading ? (
								<p className="git-empty">
									<Loader2 className="spin" aria-hidden="true" /> 正在读取提交详情…
								</p>
							) : detailError ? (
								<div className="git-log-error">
									<p className="git-error">{detailError}</p>
									<button
										type="button"
										className="git-btn"
										onClick={() => void openCommit(selection.sha)}
									>
										重试
									</button>
								</div>
							) : detail ? (
								<>
									<div className="git-detail-block">
										<div className="git-detail-head">
											<span className="git-detail-title">{detail.subject || '(无提交信息)'}</span>
										</div>
										{detail.refs.length ? (
											<div className="git-detail-refs">
												{detail.refs.map((ref) => (
													<RefBadge key={`${ref.kind}:${ref.name}`} name={ref.name} kind={ref.kind} />
												))}
											</div>
										) : null}
										{detail.body ? <pre className="git-detail-body">{detail.body}</pre> : null}
										<dl className="git-detail-facts">
											<div>
												<dt>提交</dt>
												<dd title={detail.sha}>
													<code>{detail.sha}</code>
												</dd>
											</div>
											<div>
												<dt>作者</dt>
												<dd title={detail.email}>
													{detail.author}
													{detail.email ? <span className="git-detail-muted"> &lt;{detail.email}&gt;</span> : null}
												</dd>
											</div>
											<div>
												<dt>时间</dt>
												<dd>{new Date(detail.date).toLocaleString('zh-CN')}</dd>
											</div>
											{detail.parents.length ? (
												<div>
													<dt>父提交</dt>
													<dd>
														{detail.parents.map((parent) => (
															<code key={parent} className="git-parent" title={parent}>
																{parent.slice(0, 7)}
															</code>
														))}
													</dd>
												</div>
											) : (
												<div>
													<dt>父提交</dt>
													<dd>根提交</dd>
												</div>
											)}
										</dl>
									</div>

									<div className="git-detail-block">
										<div className="git-detail-block-head">
											改动文件 <b>{detail.files.length}</b>
											<span className="git-detail-stats">
												<span className="git-add-stat">+{detail.additions}</span>
												<span className="git-del-stat">−{detail.deletions}</span>
											</span>
										</div>
										{detail.files.length ? (
											<ul className="git-commit-files">
												{detail.files.map((file) => (
													<li key={file.path}>
														<button
															type="button"
															className="git-row git-commit-file"
															title={`${file.path}\n点击查看文件内容`}
															onClick={() => openCommitFile(file)}
														>
															<span className={`git-code ${commitFileTone(file.status)}`}>{file.status}</span>
															<span className="git-file-name">{file.path}</span>
															{file.additions !== null || file.deletions !== null ? (
																<span className="git-file-counts">
																	{file.additions === null ? '二进制' : `+${file.additions}`}
																	{file.deletions === null ? '' : ` −${file.deletions}`}
																</span>
															) : null}
														</button>
													</li>
												))}
											</ul>
										) : (
											<p className="git-empty">这次提交没有文件改动（可能是空提交或合并提交）。</p>
										)}
										{detail.truncated ? (
											<p className="git-hint">文件太多，只列前 {detail.files.length} 个。</p>
										) : null}
									</div>
								</>
							) : (
								<p className="git-empty">选一条提交看详情。</p>
							)}
						</aside>
					) : null}
				</div>
			</div>
		</section>
	);
}
