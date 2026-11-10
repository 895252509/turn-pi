import { useState } from 'react';
import { Check, ChevronDown, ChevronRight, GitBranch as GitBranchIcon, Loader2, RotateCcw } from 'lucide-react';
import type { GitBranch, GitBranches as GitBranchesData } from '@/lib/types';

interface Props {
	data: GitBranchesData | null;
	loading: boolean;
	error: string;
	/** 当前过滤用的完整 ref（null = 全部提交） */
	active: string | null;
	onPick: (ref: string | null) => void;
	onRetry: () => void;
}

/** 行尾的 ahead/behind 小标记：↑ 领先、↓ 落后。 */
function Track({ branch }: { branch: GitBranch }) {
	if (!branch.ahead && !branch.behind) return null;
	return (
		<span className="git-branch-track" title={`领先 ${branch.ahead} / 落后 ${branch.behind}`}>
			{branch.ahead ? `↑${branch.ahead}` : ''}
			{branch.behind ? `↓${branch.behind}` : ''}
		</span>
	);
}

function BranchRow({
	branch,
	active,
	onPick,
}: {
	branch: GitBranch;
	active: boolean;
	onPick: () => void;
}) {
	// 远端分支去掉 "origin/" 前缀，远端名已经在分组标题上
	const name = branch.remote ? branch.short.slice(branch.remote.length + 1) : branch.short;
	return (
		<button
			type="button"
			className={`git-branch-row${active ? ' active' : ''}${branch.current ? ' current' : ''}`}
			aria-pressed={active}
			title={`${branch.short}\n${branch.shortSha} ${branch.subject}`}
			onClick={onPick}
		>
			<GitBranchIcon className="git-branch-icon" aria-hidden="true" />
			<span className="git-branch-name">{name}</span>
			{branch.current ? <Check className="git-branch-current" aria-label="当前分支" /> : null}
			<Track branch={branch} />
		</button>
	);
}

/** Git tab 左侧的分支列表：本地分支 + 每个远端一组（远端可能不止一个）。 */
export function GitBranches({ data, loading, error, active, onPick, onRetry }: Props) {
	// 远端分支默认折叠：云端仓库动辄几十条，展开会淹没本地分支
	const [closed, setClosed] = useState<Set<string>>(() => new Set(['remote']));
	const toggle = (key: string) =>
		setClosed((previous) => {
			const next = new Set(previous);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});

	if (loading && !data) {
		return (
			<aside className="git-branches" aria-label="分支">
				<p className="git-empty">
					<Loader2 className="spin" aria-hidden="true" /> 正在读取分支…
				</p>
			</aside>
		);
	}
	if (error && !data) {
		return (
			<aside className="git-branches" aria-label="分支">
				<p className="git-error">{error}</p>
				<button type="button" className="git-btn" onClick={onRetry}>
					重试
				</button>
			</aside>
		);
	}

	const locals = data?.locals ?? [];
	const remotes = data?.remotes ?? [];
	const remoteTotal = remotes.reduce((sum, group) => sum + group.branches.length, 0);

	return (
		<aside className="git-branches" aria-label="分支">
			<button
				type="button"
				className={`git-branch-all${active === null ? ' active' : ''}`}
				aria-pressed={active === null}
				title="不带分支过滤，显示所有引用的提交"
				onClick={() => onPick(null)}
			>
				<RotateCcw className="git-branch-icon" aria-hidden="true" />
				<span className="git-branch-name">全部提交</span>
				{active !== null ? <span className="git-branch-track">过滤中</span> : null}
			</button>

			<div className="git-branch-group">
				<button
					type="button"
					className="git-branch-group-head"
					aria-expanded={!closed.has('local')}
					onClick={() => toggle('local')}
				>
					{closed.has('local') ? <ChevronRight aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
					本地分支
					<b>{locals.length}</b>
				</button>
				{closed.has('local') ? null : locals.length ? (
					locals.map((branch) => (
						<BranchRow
							key={branch.full}
							branch={branch}
							active={active === branch.full}
							onPick={() => onPick(active === branch.full ? null : branch.full)}
						/>
					))
				) : (
					<p className="git-branch-empty">没有本地分支</p>
				)}
			</div>

			{remotes.length ? (
				<div className="git-branch-group">
					<button
						type="button"
						className="git-branch-group-head"
						aria-expanded={!closed.has('remote')}
						onClick={() => toggle('remote')}
					>
						{closed.has('remote') ? <ChevronRight aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
						远端分支
						<b>{remoteTotal}</b>
					</button>
					{closed.has('remote')
						? null
						: remotes.map((group) => {
								const key = `remote:${group.name}`;
								return (
									<div className="git-branch-remote" key={key}>
										<button
											type="button"
											className="git-branch-group-head sub"
											aria-expanded={!closed.has(key)}
											onClick={() => toggle(key)}
										>
											{closed.has(key) ? <ChevronRight aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
											{group.name}
											<b>{group.branches.length}</b>
										</button>
										{closed.has(key)
											? null
											: group.branches.map((branch) => (
													<BranchRow
														key={branch.full}
														branch={branch}
														active={active === branch.full}
														onPick={() => onPick(active === branch.full ? null : branch.full)}
													/>
												))}
									</div>
								);
							})}
				</div>
			) : null}
		</aside>
	);
}
