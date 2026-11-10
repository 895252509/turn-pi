import { GitBranch, Tag } from 'lucide-react';
import type { GitCommitRef, GitCommitRow } from '@/lib/types';

/** 一行提交的高度：必须和 chat.css 里 `.git-commit` 的高度一致，否则泳道会错开。 */
const ROW_H = 28;
const LANE_W = 14;

function laneColor(lane: number): string {
	return `var(--git-lane-${lane % 8})`;
}

function curve(x1: number, y1: number, x2: number, y2: number): string {
	const dy = y2 - y1;
	return `M${x1} ${y1}C${x1} ${y1 + dy * 0.55},${x2} ${y2 - dy * 0.55},${x2} ${y2}`;
}

function relativeTime(iso: string): string {
	const time = new Date(iso).getTime();
	if (!Number.isFinite(time)) return '';
	const diff = Date.now() - time;
	if (diff < 60_000) return '刚刚';
	const minutes = Math.round(diff / 60_000);
	if (minutes < 60) return `${minutes} 分钟前`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours} 小时前`;
	const days = Math.round(hours / 24);
	if (days < 30) return `${days} 天前`;
	return new Date(time).toLocaleDateString('zh-CN');
}

/** 一行的分支图：公用的竖线、汇入曲线、分叉曲线和 dot，坐标都由服务端算好。 */
function LaneGraph({ commit }: { commit: GitCommitRow }) {
	const width = Math.max(1, commit.laneCount) * LANE_W;
	const x = (lane: number) => lane * LANE_W + LANE_W / 2;
	const mid = ROW_H / 2;
	const dot = x(commit.lane);
	return (
		<svg
			className="git-graph-svg"
			width={width}
			height={ROW_H}
			viewBox={`0 0 ${width} ${ROW_H}`}
			aria-hidden="true"
			focusable="false"
		>
			{commit.through.map((lane) => (
				<path key={`t${lane}`} d={`M${x(lane)} 0V${ROW_H}`} stroke={laneColor(lane)} />
			))}
			{commit.top ? <path d={`M${dot} 0V${mid}`} stroke={laneColor(commit.lane)} /> : null}
			{commit.incoming.map((lane) => (
				<path key={`i${lane}`} d={curve(x(lane), 0, dot, mid)} stroke={laneColor(lane)} />
			))}
			{commit.outgoing.map((edge, index) => (
				<path
					key={`o${index}`}
					d={edge.to === edge.from ? `M${dot} ${mid}V${ROW_H}` : curve(dot, mid, x(edge.to), ROW_H)}
					stroke={laneColor(edge.to)}
				/>
			))}
			<circle cx={dot} cy={mid} r={3} fill={laneColor(commit.lane)} />
		</svg>
	);
}

/** ref 徽标：HEAD / 分支 / 远端 / tag 四种着色。 */
export function RefBadge({ name, kind }: { name: string; kind: GitCommitRef['kind'] }) {
	const Icon = kind === 'tag' ? Tag : kind === 'head' ? null : GitBranch;
	const label =
		kind === 'tag' ? 'tag' : kind === 'remote' ? '远端分支' : kind === 'head' ? 'HEAD' : '分支';
	return (
		<span className={`git-ref ${kind}`} title={`${label} ${name}`}>
			{Icon ? <Icon aria-hidden="true" /> : null}
			<span className="git-ref-name">{name}</span>
		</span>
	);
}

/** 提交记录树：左边是分支泳道图，右边是 ref 徽标 + 摘要 + 作者/时间；整行可点，选中后右栏出详情。 */
export function GitGraph({
	commits,
	selectedSha,
	onSelect,
}: {
	commits: GitCommitRow[];
	selectedSha?: string | null;
	onSelect: (sha: string) => void;
}) {
	return (
		<ol className="git-graph" aria-label="提交记录">
			{commits.map((commit) => {
				const selected = selectedSha === commit.sha;
				return (
					<li key={commit.sha}>
						<button
							type="button"
							className={`git-commit${selected ? ' selected' : ''}`}
							aria-pressed={selected}
							title={`${commit.sha}\n${commit.subject}`}
							onClick={() => onSelect(commit.sha)}
						>
							<LaneGraph commit={commit} />
							<span className="git-commit-body">
								<span className="git-commit-line">
									{commit.refs.map((ref) => (
										<RefBadge key={`${ref.kind}:${ref.name}`} name={ref.name} kind={ref.kind} />
									))}
									<span className="git-commit-subject">{commit.subject || '(无提交信息)'}</span>
								</span>
								<span className="git-commit-meta">
									<code>{commit.short}</code>
									<span className="git-commit-author">{commit.author}</span>
									<span>{relativeTime(commit.date)}</span>
								</span>
							</span>
						</button>
					</li>
				);
			})}
		</ol>
	);
}
