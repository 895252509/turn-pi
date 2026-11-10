import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Bot, Check, Code2, Copy, GitBranch } from 'lucide-react';
import { ImageLightbox } from '@/components/ImageLightbox';
import { ReportedFilesCard } from '@/components/deliverables/ReportedFilesCard';
import { TurnNavigator, type NavTurn } from '@/components/TurnNavigator';
import { WorkspacePicker } from '@/components/WorkspacePicker';
import { copyText } from '@/lib/clipboard';
import { formatDuration, formatK } from '@/lib/format';
import { fileRefRawUrl, formatFileRef } from '@/lib/fileRef';
import { renderMarkdown } from '@/lib/markdown';
import { canOpenFile, useStore } from '@/lib/store';
import type { CodemodeMode, Item, RetryState, ToolRow, TurnHistoryStats, TurnOverviewItem } from '@/lib/types';

const NEAR_BOTTOM = 160;
const BOTTOM_EPSILON = 8;
/** 把 markdown 链接里的 %20 / %23 之类还原；坏转义原样保留。 */
function decodeHref(value: string): string {
	return value
		.split('/')
		.map((segment) => {
			try {
				return decodeURIComponent(segment);
			} catch {
				return segment;
			}
		})
		.join('/');
}
/** 滚到距离顶部这么近时，自动加载上一页历史 */
const LOAD_MORE_PX = 120;
/** 用户主动滚上去后，停止自动跟随；闲置这么久再恢复 */
const AUTO_RESUME_MS = 2 * 60 * 1000;

function scrollToY(box: HTMLDivElement, top: number, instant: boolean) {
	if (!instant) {
		box.scrollTop = top;
		return;
	}
	// 程序化贴底 / 恢复锚点时临时关掉 CSS 的 smooth，避免长距离动画中途停住。
	const previousBehavior = box.style.scrollBehavior;
	box.style.scrollBehavior = 'auto';
	box.scrollTop = top;
	box.style.scrollBehavior = previousBehavior;
}

/** 服务端全量轮次索引 + 已加载状态；生成中尚未进 overview 的新轮先补在末尾。 */
function buildNavTurns(
	items: Item[],
	overview: TurnOverviewItem[],
	historyStart: number,
	favorites: number[] = [],
): NavTurn[] {
	const favoriteSet = new Set(favorites);
	const userTexts = items.filter((item) => item.kind === 'user').map((item) => item.text);
	if (!overview.length) {
		return userTexts.map((text, index) => ({
			index: index + 1,
			text,
			loaded: true,
			favorite: favoriteSet.has(index + 1),
		}));
	}
	const turns: NavTurn[] = overview.map((turn) => ({
		index: turn.index,
		text: turn.text,
		loaded: turn.start >= historyStart,
		favorite: favoriteSet.has(turn.index),
	}));
	const loadedCount = turns.filter((turn) => turn.loaded).length;
	if (userTexts.length > loadedCount) {
		const lastIndex = turns[turns.length - 1]?.index ?? 0;
		for (let i = loadedCount; i < userTexts.length; i += 1) {
			const index = lastIndex + (i - loadedCount) + 1;
			turns.push({
				index,
				text: userTexts[i] ?? '',
				loaded: true,
				favorite: favoriteSet.has(index),
			});
		}
	}
	return turns;
}

/** 历史工具行没有单独的 arg 字段时，从完整参数 JSON 里提取一行预览。 */
function toolArgsPreview(args?: string): string {
	if (!args) return '';
	try {
		const value = JSON.parse(args);
		if (value && typeof value === 'object') {
			// codemode 的参数对象里 code 是整段脚本，只取第一行非空内容
			const code = typeof value.code === 'string' ? value.code.split('\n').find((line: string) => line.trim()) : undefined;
			const picked = code?.trim() || value.command || value.path || value.pattern || value.query || value.file || value.url;
			if (picked != null) return String(picked).replace(/\s+/g, ' ').slice(0, 120);
		}
	} catch {
		/* 不是 JSON 就显示去掉换行后的原文 */
	}
	return args.replace(/\s+/g, ' ').slice(0, 120);
}

/** 子调用一屏最多先显示这么多，其余折叠成一行计数。 */
const NESTED_VISIBLE = 12;

const NestedCallList = memo(function NestedCallList({ calls }: { calls: NonNullable<ToolRow['children']> }) {
	const [open, setOpen] = useState(false);
	const hidden = Math.max(0, calls.length - NESTED_VISIBLE);
	const visible = open || !hidden ? calls : calls.slice(0, NESTED_VISIBLE);
	return (
		<div className="tool-children">
			{visible.map((call, index) => (
				<div key={call.id ?? `${call.name}-${index}`} className={`tool-child ${call.status}`}>
					<span className="name">{call.name}</span>
					{call.args ? <span className="arg" title={call.args}>{call.args}</span> : null}
					{call.durationMs != null ? <span className="ms">{formatDuration(call.durationMs)}</span> : null}
					{call.status === 'error' || call.status === 'cancelled' ? (
						<span className="badge">{call.status === 'cancelled' ? '已取消' : '失败'}</span>
					) : null}
					{call.error ? <span className="err" title={call.error}>{call.error}</span> : null}
				</div>
			))}
			{hidden > 0 ? (
				<button type="button" className="tool-child-more" onClick={() => setOpen((value) => !value)}>
					{open ? '收起' : `还有 ${hidden} 次调用`}
				</button>
			) : null}
		</div>
	);
});

const ToolRowView = memo(function ToolRowView({ tool }: { tool: ToolRow }) {
	const openFile = useStore((s) => s.openFile);
	// 路径不在任何已注册 root 里（比如 /tmp/shot.png）就不画「打开」箭头：
	// 右栏只服务工作区里的文件，箭头点了只会弹「文件不在当前工作区」。
	const openable = useStore((s) => (tool.path ? canOpenFile(s, tool.path) : false));
	const [open, setOpen] = useState(false);
	const args = tool.args?.trim() ?? '';
	const result = tool.result?.trim() ?? '';
	const children = tool.children ?? [];
	// codemode 的 args 是脚本原文，展开时用「脚本」而不是「参数」
	const isScript = tool.name === 'codemode';
	// 收起时始终保留一行预览：实时工具优先用解析过的 arg，历史工具回退到 detail / 原始参数
	const preview = tool.arg || tool.path || tool.detail?.trim() || toolArgsPreview(tool.args);
	const hint = tool.detail?.trim() ?? '';
	const showHint = Boolean(hint && hint !== preview);
	// 服务端还没重启/旧缓存时没有 result，就退回 detail 里的一行结果
	const resultText = result || (showHint ? hint : '');
	const canExpand = Boolean(args || resultText || tool.status === 'running');

	return (
		<div className={`tool ${tool.status}${open ? ' open' : ''}${isScript ? ' script' : ''}`}>
			<div className="tool-head">
				<button
					type="button"
					className="tool-expand"
					aria-expanded={open}
					disabled={!canExpand}
					title={canExpand ? (open ? `收起 ${tool.name} 详情` : `展开 ${tool.name} 参数与结果`) : tool.name}
					onClick={() => setOpen((value) => !value)}
				>
					{/* codemode 单独给个图标：一眼看出这次是脚本批量调工具，不是直连某一个工具 */}
					{isScript ? (
						<span className="tool-icon" aria-hidden="true" title="codemode 脚本调用">
							🧩
						</span>
					) : null}
					<span className="name">{tool.name}</span>
					{preview ? (
						<span className="arg">
							{preview}
							{tool.path && tool.line ? `:${tool.line}` : ''}
						</span>
					) : null}
					{showHint ? <span className="arg tool-detail">{hint}</span> : null}
					{canExpand ? (
						<span className="tool-chevron" aria-hidden="true">
							▸
						</span>
					) : null}
				</button>
				{tool.path && openable ? (
					<button
						type="button"
						className="tool-path tool-open"
						title={`在右栏打开 ${tool.path}${tool.line ? `:${tool.line}` : ''}`}
						aria-label={`在右栏打开 ${tool.path}${tool.line ? `:${tool.line}` : ''}`}
						onClick={() => openFile(tool.path!, { line: tool.line })}
					>
						↗
					</button>
				) : null}
			</div>
			{/* codemode 脚本里的工具调用：边跑边刷，不展开也能看到进度 */}
			{children.length ? <NestedCallList calls={children} /> : null}
			{open ? (
				<div className="tool-body">
					{args ? (
						<div className="tool-section">
							<div className="tool-kicker">{isScript ? '脚本' : '参数'}</div>
							<pre className={isScript ? 'tool-script' : undefined}>{args}</pre>
						</div>
					) : null}
					{resultText ? (
						<div className="tool-section">
							<div className="tool-kicker">结果</div>
							<pre>{resultText}</pre>
						</div>
					) : tool.status === 'running' ? (
						<div className="tool-empty">等待结果…</div>
					) : !args ? (
						<div className="tool-empty">没有更多详情</div>
					) : null}
				</div>
			) : null}
		</div>
	);
});

type TurnItem = Extract<Item, { kind: 'turn' }>;
type ThinkingPart = Extract<TurnItem['parts'][number], { kind: 'thinking' }>;

const ThinkingBlock = memo(function ThinkingBlock({
	part,
	live,
}: {
	part: ThinkingPart;
	live: boolean;
}) {
	const [open, setOpen] = useState(false);
	const wasLive = useRef(live);
	// 思考结束时自动收起，回到默认的“第一行”摘要
	useEffect(() => {
		if (wasLive.current && !live) setOpen(false);
		wasLive.current = live;
	}, [live]);

	// 结束后默认看第一行；思考进行中则滚动显示最新一行，能直观看出还在出字
	const lines = part.text.split(/\r?\n/).map((line) => line.trim());
	const firstLine = lines.find(Boolean) ?? '';
	const lastLine = [...lines].reverse().find(Boolean) ?? '';
	const liveLine = lastLine.length > 120 ? `…${lastLine.slice(-120)}` : lastLine;
	const preview = live ? liveLine : firstLine;

	return (
		<div className={`think${open ? ' open' : ''}${live ? ' live' : ''}`}>
			<button
				type="button"
				className="think-head"
				aria-expanded={open}
				title={open ? '收起思考过程' : '展开思考过程'}
				onClick={() => setOpen((value) => !value)}
			>
				<span className="think-icon" aria-hidden="true">
					🧠
				</span>
				<span className="think-label">{live ? '思考中' : '思考'}</span>
				{open || !preview ? null : <span className="think-preview">{preview}</span>}
				<span className="think-chevron" aria-hidden="true">
					▸
				</span>
			</button>
			{open ? <div className="think-body">{part.text}</div> : null}
		</div>
	);
});

/**
 * 用户气泡下面那一行：发送时间 + 复制。
 * 时间格式和轮次状态条后面的完成时间完全一致（今天 HH:mm，更早 MM-dd HH:mm），
 * 两边复用同一个 formatCompletedAt，别各写一套。
 */
const UserMeta = memo(function UserMeta({ at, text }: { at?: number; text: string }) {
	const [copied, setCopied] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	useEffect(() => () => clearTimeout(timer.current), []);

	const copy = async () => {
		const ok = await copyText(text);
		setCopied(ok);
		clearTimeout(timer.current);
		timer.current = setTimeout(() => setCopied(false), 1400);
	};

	const hasText = text.trim().length > 0;
	return (
		<div className="msg-meta">
			{at ? (
				<span className="msg-time" title={sentAtTitle(at)}>
					{formatCompletedAt(at)}
				</span>
			) : null}
			{hasText ? (
				<button
					type="button"
					className={`msg-copy${copied ? ' copied' : ''}`}
					onClick={() => {
						void copy();
					}}
					aria-label={copied ? '已复制' : '复制这条消息'}
					title={copied ? '已复制' : '复制这条消息'}
				>
					{copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
				</button>
			) : null}
		</div>
	);
});

const Block = memo(function Block({ item }: { item: Item }) {

	const [preview, setPreview] = useState<{ src: string; alt?: string } | null>(null);
	if (item.kind === 'user') {
		return (
			<>
				<div className="msg user">
					<div className="who">你</div>
					<div className="body">
						{item.images?.length ? (
							<div className="user-images">
								{item.images.map((image, index) => {
									const src = `data:${image.mimeType};base64,${image.data}`;
									const alt = image.name ?? `图片 ${index + 1}`;
									return (
										<button
											key={image.id ?? index}
											type="button"
											className="user-image-open"
											aria-label={`放大查看 ${alt}`}
											title="点击放大"
											onClick={() => setPreview({ src, alt })}
										>
											<img src={src} alt={alt} title={image.name} />
										</button>
									);
								})}
							</div>
						) : null}
						{item.text ? <div className="user-text">{item.text}</div> : null}
					</div>
					<UserMeta at={item.at} text={item.text ?? ''} />
				</div>
				{preview ? (
					<ImageLightbox src={preview.src} alt={preview.alt} onClose={() => setPreview(null)} />
				) : null}
			</>
		);
	}
	return <TurnBlock item={item} />;
});

/** 悬停提示：完整的发送时间 */
function sentAtTitle(value: number): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return '';
	const pad = (n: number) => String(n).padStart(2, '0');
	return '发送于 ' + date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
		' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
}

/** 轮次完成时间：今天只显示 HH:mm，更早显示 MM-dd HH:mm。 */
function formatCompletedAt(value?: number): string {
	if (!value) return '';
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return '';
	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, '0');
	const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
	const today =
		date.getFullYear() === now.getFullYear() &&
		date.getMonth() === now.getMonth() &&
		date.getDate() === now.getDate();
	return today ? time : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}

function completedAtTitle(value?: number): string {
	if (!value) return '';
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return '';
	const pad = (n: number) => String(n).padStart(2, '0');
	return `完成于 ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 历史轮次用服务端算好的摘要；刚结束的一轮可能还没重绘成历史，用本地 stats / parts 临时补一份 */
function summaryStats(item: TurnItem): TurnHistoryStats | undefined {
	if (item.historyStats) return item.historyStats;
	const stats = item.stats;
	if (stats) {
		return {
			turns: stats.turns,
			steps: stats.steps,
			thinkingCount: item.parts.filter((part) => part.kind === 'thinking').length,
			toolCalls: stats.toolCalls,
			durationMs: stats.durationMs,
			completedAt: stats.completedAt,
			input: stats.input,
			cacheRead: stats.cacheRead,
			output: stats.output,
		};
	}
	// 生成刚结束、服务端历史还没回来（或本轮被中止）时先按已渲染的 parts 折叠，
	// 避免思考/工具行在 settled 后短暂继续展开。
	if (item.streaming || !item.parts.length) return undefined;
	const thinkingCount = item.parts.filter((part) => part.kind === 'thinking').length;
	const toolCalls = item.parts.reduce(
		(count, part) => count + (part.kind === 'tools' ? part.tools.length : 0),
		0,
	);
	return {
		steps: Math.max(1, thinkingCount + (toolCalls > 0 ? 1 : 0)),
		thinkingCount,
		toolCalls,
		durationMs: item.startedAt ? Math.max(0, Date.now() - item.startedAt) : 0,
		input: 0,
		cacheRead: 0,
		output: 0,
	};
}

const HistorySummary = memo(function HistorySummary({
	stats,
	open,
	onToggle,
}: {
	stats: TurnHistoryStats;
	open: boolean;
	onToggle: () => void;
}) {
	return (
		<button
			type="button"
			className={`history-summary${open ? ' open' : ''}`}
			aria-expanded={open}
			title={open ? '收起执行过程' : '展开这一轮的思考与工具调用'}
			onClick={onToggle}
		>
			<span className="history-summary-chevron" aria-hidden="true">
				▸
			</span>
			<span>{stats.steps} 步</span>
			<span>{formatDuration(stats.durationMs)}</span>
			<span className="history-summary-metric" title={`思考 ${stats.thinkingCount} 次`}>
				<span className="history-summary-icon" aria-hidden="true">🧠:</span>
				<span className="history-summary-count">{stats.thinkingCount}</span>
				<span className="history-summary-label">{' 次思考'}</span>
			</span>
			<span className="history-summary-metric" title={`工具 ${stats.toolCalls} 次`}>
				<span className="history-summary-icon" aria-hidden="true">🔧:</span>
				<span className="history-summary-count">{stats.toolCalls}</span>
				<span className="history-summary-label">{' 次工具'}</span>
			</span>
			<span
				className="history-summary-usage"
				title={`输入未命中 ${formatK(stats.input)} / 缓存命中 ${formatK(stats.cacheRead)}`}
			>
				<span>↑{formatK(stats.input)}/{formatK(stats.cacheRead)}</span>
				<span>↓{formatK(stats.output)}</span>
			</span>
			<span className="history-summary-hint">
				<span className="history-summary-hint-full">{open ? '收起' : '展开执行过程'}</span>
				<span className="history-summary-hint-short">{open ? '收起' : '展开'}</span>
			</span>
		</button>
	);
});

/**
 * 自动重试提示：错误原因 + 倒计时；倒计时结束后回到「思考中」。
 * 自己跑一个短计时器，避免为倒计时把整轮消息重渲染。
 */
const RetryNotice = memo(function RetryNotice({ retry }: { retry: RetryState }) {
	const waiting = retry.state === 'waiting';
	const until = waiting ? retry.until : 0;
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!waiting) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 250);
		return () => clearInterval(timer);
	}, [waiting, until]);

	if (retry.state === 'failed') {
		return (
			<span className="retry-notice failed">
				<span className="retry-error" title={retry.errorMessage}>
					⚠ {retry.errorMessage}
				</span>
				<span className="retry-countdown">重试 {retry.attempt} 次仍失败</span>
			</span>
		);
	}

	const remaining = Math.max(0, retry.until - now);
	if (remaining <= 0) return <span className="thinking retrying">重试中 · 思考中 · · ·</span>;
	const seconds = Math.max(1, Math.ceil(remaining / 1000));
	const progress = retry.maxAttempts > 0 ? ` · 第 ${retry.attempt}/${retry.maxAttempts} 次` : '';
	return (
		<span className="retry-notice">
			<span className="retry-error" title={retry.errorMessage}>
				⚠ {retry.errorMessage}
			</span>
			<span className="retry-countdown">
				{seconds} 秒后重试{progress}
			</span>
		</span>
	);
});

const TurnBlock = memo(function TurnBlock({ item }: { item: TurnItem }) {
	const busy = useStore((s) => s.busy);
	const forkTurn = useStore((s) => s.forkTurn);
	const favoriteTurns = useStore((s) => s.favoriteTurns);
	const toggleFavorite = useStore((s) => s.toggleFavorite);
	const sessionId = useStore((s) => s.sessionId);
	const openAddress = useStore((s) => s.openAddress);
	const [expanded, setExpanded] = useState(false);
	const wasStreaming = useRef(item.streaming);
	const summary = summaryStats(item);
	// 所有已完成的轮次默认折叠；只有正在生成的那一轮完整展开
	const collapsible = Boolean(!item.streaming && summary);
	const showDetails = !collapsible || expanded;
	const last = item.parts[item.parts.length - 1];
	let lastTextIndex = -1;
	item.parts.forEach((part, index) => {
		if (part.kind === 'text') lastTextIndex = index;
	});

	// 生成结束自动收起；用户之后手动展开不受影响
	useEffect(() => {
		if (wasStreaming.current && !item.streaming) setExpanded(false);
		wasStreaming.current = item.streaming;
	}, [item.streaming]);

	// 文字正在流式输出：光标贴在文字末尾；工具/思考阶段：光标单独挂在最后一块下面
	const textCursor = item.streaming && !item.thinking && last?.kind === 'text';
	const showTail = item.streaming && !textCursor;
	const favorite = item.stats ? favoriteTurns.includes(item.stats.turns) : false;

	const markdownOptions = useMemo(
		() => ({
			resolveFileRef: (href: string) => {
				const clean = decodeHref(href.trim());
				if (!clean || !sessionId) return null;
				if (/^(?:https?:|mailto:|#)/i.test(clean)) return null;
				if (clean.startsWith('/')) return formatFileRef({ scope: 'absolute', path: clean });
				return formatFileRef({ scope: 'session', sessionId, path: clean });
			},
			resolveImage: (src: string) => {
				if (/^(?:https?:|data:)/i.test(src)) return src;
				if (/^pi-resource:\/\/file\//i.test(src)) return fileRefRawUrl(src);
				if (!sessionId) return null;
				const clean = decodeHref(src);
				const address = clean.startsWith('/')
					? formatFileRef({ scope: 'absolute', path: clean })
					: formatFileRef({ scope: 'session', sessionId, path: clean });
				return fileRefRawUrl(address);
			},
		}),
		[sessionId],
	);

	const onFileRefClick = useCallback(
		(event: React.MouseEvent<HTMLDivElement>) => {
			const anchor = (event.target as Element).closest<HTMLElement>('[data-file-ref]');
			if (!anchor) return;
			event.preventDefault();
			void openAddress(anchor.dataset.fileRef ?? '');
		},
		[openAddress],
	);

	return (
		<div className="msg assistant" onClick={onFileRefClick}>
			<div className="who">pi</div>
			<div className="stream">
				{collapsible && summary ? (
					<HistorySummary
						stats={summary}
						open={expanded}
						onToggle={() => setExpanded((value) => !value)}
					/>
				) : null}
				{item.parts.map((part, index) => {
					if (part.kind === 'text') {
						// 折叠状态下，最后一段文字是最终回答；前面那些执行过程中的旁白淡一点。
						const dimExecutionText = collapsible && !expanded && index !== lastTextIndex;
						return (
							<div
								key={part.id}
								className={`body${textCursor && index === item.parts.length - 1 ? ' cursor' : ''}${dimExecutionText ? ' exec-text' : ''}`}
								dangerouslySetInnerHTML={{ __html: renderMarkdown(part.text, markdownOptions) }}
							/>
						);
					}
					// 思考 / 工具保留在 DOM 里用 grid-rows 做展开收起动画，避免直接卸载导致硬切。
					return (
						<div
							key={part.id}
							className={`turn-part${showDetails ? ' open' : ''}`}
							aria-hidden={!showDetails}
						>
							<div className="turn-part-inner">
								{part.kind === 'thinking' ? (
									<ThinkingBlock
										part={part}
										live={item.streaming && item.activity === 'thinking' && index === item.parts.length - 1}
									/>
								) : (
									<div className="tools">
										{part.tools.map((tool) => (
											<ToolRowView key={tool.id} tool={tool} />
										))}
									</div>
								)}
							</div>
						</div>
					);
				})}
				{item.error ? (
					<div className="body">
						<span style={{ color: 'var(--err)' }}>{item.error}</span>
					</div>
				) : null}
				{item.files ? <ReportedFilesCard files={item.files} /> : null}
				{showTail ? (
					<div className="stream-tail">
						<span className="caret" aria-hidden="true" />
						{item.retry ? (
							<RetryNotice retry={item.retry} />
						) : item.activity ? (
							<span className="thinking">
								{item.activity === 'tool' ? '调用工具 · · ·' : '思考中 · · ·'}
							</span>
						) : null}
					</div>
				) : null}
			</div>
			{item.stats && !item.streaming ? (
				<div className="turn-stats">
					<span>第 {item.stats.turns} 轮</span>
					<button
						type="button"
						className="turn-fork"
						disabled={busy}
						aria-label={busy ? '等这一轮结束再 fork' : `从第 ${item.stats.turns} 轮 fork 一份新会话并进入`}
						title={busy ? '等这一轮结束再 fork' : `从第 ${item.stats.turns} 轮 fork 一份新会话并进入`}
						onClick={() => {
							forkTurn(item.stats!.turns).catch(() => {});
						}}
					>
						<svg viewBox="0 0 24 24" aria-hidden="true">
							<path
								d="M6 3v12a3 3 0 0 0 3 3h3M18 9a9 9 0 0 1-9 9"
								fill="none"
								stroke="currentColor"
								strokeWidth="1.8"
								strokeLinecap="round"
								strokeLinejoin="round"
							/>
							<circle cx="18" cy="6" r="2.6" fill="none" stroke="currentColor" strokeWidth="1.8" />
							<circle cx="6" cy="18" r="2.6" fill="none" stroke="currentColor" strokeWidth="1.8" />
						</svg>
					</button>
					<button
						type="button"
						className={`turn-star${favorite ? ' favorite' : ''}`}
						aria-pressed={favorite}
						aria-label={favorite ? `取消收藏第 ${item.stats.turns} 轮` : `收藏第 ${item.stats.turns} 轮`}
						title={favorite ? `取消收藏第 ${item.stats.turns} 轮` : `收藏第 ${item.stats.turns} 轮`}
						onClick={() => {
							toggleFavorite(item.stats!.turns).catch(() => {});
						}}
					>
						<svg viewBox="0 0 24 24" aria-hidden="true">
							<path
								d="m12 3 2.9 5.9 6.5.9-4.7 4.6 1.1 6.4-5.8-3-5.8 3 1.1-6.4L3.6 9.8l6.5-.9L12 3Z"
								fill={favorite ? 'currentColor' : 'none'}
								stroke="currentColor"
								strokeWidth="1.7"
								strokeLinecap="round"
								strokeLinejoin="round"
							/>
						</svg>
					</button>
					{item.stats.completedAt ? (
						<span className="turn-finished" title={completedAtTitle(item.stats.completedAt)}>
							{formatCompletedAt(item.stats.completedAt)}
						</span>
					) : null}
				</div>
			) : null}
		</div>
	);
});

const SAMPLES = [
	['读一下 /workspace 的结构，说明这个项目在做什么', '读一下这个项目在做什么'],
	['找出这个工作区里所有 TODO 和 FIXME，按文件汇总', '汇总 TODO / FIXME'],
	['看一下 server 目录的代码，画一个简明的数据流说明', '画数据流'],
] as const;

/** 三态滑块：左 = 禁用，中 = 自动，右 = 启用。 */
const CODEMODE_MODES: { value: CodemodeMode; label: string; hint: string }[] = [
	{ value: 'off', label: '禁用', hint: '本次会话不提供 codemode 工具，模型只能直连调工具' },
	{ value: 'auto', label: '自动', hint: 'codemode 可用，模型自己决定走脚本还是直连调工具' },
	{ value: 'on', label: '启用', hint: '要求模型本次必须用 codemode 脚本调工具，不要一个一个直连' },
];

const CODEMODE_HINT: Record<CodemodeMode, string> = {
	off: '本会话不提供 codemode 工具。',
	auto: '',
	on: '本会话要求模型走 codemode 脚本。',
};

const CodemodeSlider = memo(function CodemodeSlider({
	mode,
	disabled,
	onChange,
}: {
	mode: CodemodeMode;
	disabled?: boolean;
	onChange: (mode: CodemodeMode) => void;
}) {
	const step = (delta: number) => {
		const index = CODEMODE_MODES.findIndex((item) => item.value === mode);
		const next = CODEMODE_MODES[Math.min(CODEMODE_MODES.length - 1, Math.max(0, index + delta))];
		if (next && next.value !== mode) onChange(next.value);
	};
	return (
		<div
			className={`mode-slider mode-${mode}`}
			role="radiogroup"
			aria-label="codemode 策略"
			aria-disabled={disabled || undefined}
			onKeyDown={(event) => {
				if (disabled) return;
				if (event.key === 'ArrowLeft') {
					event.preventDefault();
					step(-1);
				} else if (event.key === 'ArrowRight') {
					event.preventDefault();
					step(1);
				}
			}}
		>
			<span className="mode-slider-knob" aria-hidden="true" />
			{CODEMODE_MODES.map((item) => (
				<button
					key={item.value}
					type="button"
					role="radio"
					aria-checked={mode === item.value}
					data-codemode-mode={item.value}
					title={item.hint}
					className={`mode-slider-option${mode === item.value ? ' active' : ''}`}
					disabled={disabled}
					onClick={() => onChange(item.value)}
				>
					{item.label}
				</button>
			))}
		</div>
	);
});

function EmptyState() {
	const pickSample = useStore((s) => s.pickSample);
	const sessionId = useStore((s) => s.sessionId);
	const workspaceId = useStore((s) => s.workspaceId);
	const workspaces = useStore((s) => s.workspaces);
	const worktreeEnabled = useStore((s) => s.worktreeEnabled);
	const setWorktreeEnabled = useStore((s) => s.setWorktreeEnabled);
	const codemodeMode = useStore((s) => s.codemodeMode);
	const setCodemodeMode = useStore((s) => s.setCodemodeMode);
	const agents = useStore((s) => s.agents);
	const agentTemplateId = useStore((s) => s.agentTemplateId);
	const setAgentTemplate = useStore((s) => s.setAgentTemplate);
	const selectableAgents = agents.filter((agent) => agent.kind !== 'base' && agent.status === 'active');
	const selectedAgent = selectableAgents.find((agent) => agent.id === agentTemplateId);
	const workspace = workspaces.find((item) => item.id === workspaceId);
	const canWorktree = Boolean(workspace?.kind === 'git' && !workspace.readonly && workspace.available !== false);
	return (
		<div className="empty">
			<h2>让它干点活</h2>
			<p>
				给它一个任务：读代码、改文件、跑命令。干完把它动过的文件汇报成卡片，点开就在右栏看。
			</p>
			<WorkspacePicker disabled={Boolean(sessionId)} />
			{/* Agent 模板：和 workspace 一样属于“建会话前定下”，定完就不能改 */}
			<div className={`agent-option${agentTemplateId ? ' on' : ''}`}>
				<Bot aria-hidden="true" />
				<label htmlFor="empty-agent">Agent</label>
				<select
					id="empty-agent"
					className="select"
					value={agentTemplateId ?? ''}
					disabled={Boolean(sessionId)}
					onChange={(event) => setAgentTemplate(event.target.value || null)}
				>
					<option value="">默认（环境工具集）</option>
					{selectableAgents.map((agent) => (
						<option key={agent.id} value={agent.id}>
							{`${agent.id} · ${agent.tools.length} 工具 · ${agent.skills.length} 技能`}
						</option>
					))}
				</select>
				{selectedAgent?.description ? <small>{selectedAgent.description}</small> : null}
			</div>
			{canWorktree ? (
				<label className={`worktree-option${worktreeEnabled ? ' on' : ''}`}>
					<input
						type="checkbox"
						checked={worktreeEnabled}
						disabled={Boolean(sessionId)}
						onChange={(event) => setWorktreeEnabled(event.target.checked)}
					/>
					<GitBranch aria-hidden="true" />
					<span>
						<strong>隔离工作树</strong>
						<small>在 /runtime/worktrees 里创建独立检出；改动不会热加载，测试通过后再显式合并。</small>
					</span>
				</label>
			) : null}
			<div className={`codemode-option mode-${codemodeMode}`}>
				<Code2 aria-hidden="true" />
				<span className="codemode-option-text">
					<strong>codemode</strong>
					<small>让模型写一段脚本批量调工具，中间结果不进上下文；只回脚本输出。</small>
				</span>
				<CodemodeSlider
					mode={codemodeMode}
					disabled={Boolean(sessionId)}
					onChange={setCodemodeMode}
				/>
			</div>
			<p className="empty-hint">
				选定工作区后发送第一条消息；之后的工具 cwd 就固定在这里。
				{worktreeEnabled ? ' 当前会在隔离 worktree 中创建会话。' : ''}
				{CODEMODE_HINT[codemodeMode]}
			</p>
			<div className="samples">
				{SAMPLES.map(([text, label]) => (
					<button key={text} data-sample={text} onClick={() => pickSample(text)}>
						{label}
					</button>
				))}
			</div>
		</div>
	);
}

export function MessageList({ hidden = false }: { hidden?: boolean }) {
	const items = useStore((s) => s.items);
	const pinSeq = useStore((s) => s.pinSeq);
	const historyHasMore = useStore((s) => s.historyHasMore);
	const historyLoading = useStore((s) => s.historyLoading);
	const historyLoadingInitial = useStore((s) => s.historyLoadingInitial);
	const historyStart = useStore((s) => s.historyStart);
	const turnOverview = useStore((s) => s.turnOverview);
	const favoriteTurns = useStore((s) => s.favoriteTurns);
	const loadOlderHistory = useStore((s) => s.loadOlderHistory);
	const loadHistoryUntilTurn = useStore((s) => s.loadHistoryUntilTurn);
	const sessionId = useStore((s) => s.sessionId);

	const boxRef = useRef<HTMLDivElement | null>(null);
	const autoStick = useRef(true);
	const lastPin = useRef(pinSeq);
	const lastTop = useRef(0);
	const resumeTimer = useRef<number | null>(null);
	const prependAnchor = useRef<{ top: number; height: number } | null>(null);
	const loadingOlder = useRef(false);
	const jumpSeq = useRef(0);
	const [atBottom, setAtBottom] = useState(true);
	const [activeTurnIndex, setActiveTurnIndex] = useState<number | null>(null);
	const [jumpReq, setJumpReq] = useState<{ index: number; seq: number } | null>(null);
	const navTurns = buildNavTurns(items, turnOverview, historyStart, favoriteTurns);
	const currentTurnIndex =
		activeTurnIndex ?? [...navTurns].reverse().find((turn) => turn.loaded)?.index ?? null;

	const clearResume = useCallback(() => {
		if (resumeTimer.current !== null) {
			window.clearTimeout(resumeTimer.current);
			resumeTimer.current = null;
		}
	}, []);

	const isNearBottom = useCallback(() => {
		const box = boxRef.current;
		if (!box) return true;
		return box.scrollHeight - box.scrollTop - box.clientHeight < NEAR_BOTTOM;
	}, []);

	const pin = useCallback((instant = false) => {
		const box = boxRef.current;
		if (!box) return;
		clearResume();
		// 先按当前（已折叠）布局贴底；instant 会跳过 smooth 动画。
		scrollToY(box, box.scrollHeight, instant);
		lastTop.current = box.scrollTop;
		autoStick.current = true;
		setAtBottom(true);
	}, [clearResume]);

	// 用户自己不滚动时，2 分钟后恢复自动跟随（并立即回到底部）
	const scheduleResume = useCallback(() => {
		clearResume();
		resumeTimer.current = window.setTimeout(() => {
			resumeTimer.current = null;
			pin();
		}, AUTO_RESUME_MS);
	}, [clearResume, pin]);

	// 点击折叠摘要时，以这条摘要为视口锚点：展开/收起动画期间持续补偿 scrollTop，
	// 让用户正在看的这条不跳；同时暂停自动贴底，避免被拉回底部。
	// 展开后如果整轮（含最下面的轮次状态栏）压到输入框，则向上补滚动；
	// 但最多补到这轮顶部贴住标题栏，不能为了露底把顶部推出视口。
	const keepSummaryAnchored = useCallback(
		(event: { target: EventTarget | null }) => {
			const box = boxRef.current;
			const target = (event.target as Element | null)?.closest<HTMLElement>('.history-summary');
			if (!box || !target) return;
			const expanding = target.getAttribute('aria-expanded') === 'false';
			const anchorTop = target.getBoundingClientRect().top;
			const turn = target.closest<HTMLElement>('.msg.assistant');
			const start =
				turn?.previousElementSibling?.classList.contains('msg.user') === true
					? (turn.previousElementSibling as HTMLElement)
					: turn;
			const until = performance.now() + 360;
			autoStick.current = false;
			scheduleResume();
			const tick = () => {
				if (!target.isConnected || performance.now() > until) return;
				const chat = box.parentElement;
				const head = chat?.querySelector<HTMLElement>('.chat-head');
				const composer = chat?.querySelector<HTMLElement>('.composer-wrap');
				const topLimit = (head?.getBoundingClientRect().bottom ?? box.getBoundingClientRect().top) + 8;
				const bottomLimit = (composer?.getBoundingClientRect().top ?? box.getBoundingClientRect().bottom) - 8;
				const turnBottom = turn?.getBoundingClientRect().bottom ?? target.getBoundingClientRect().bottom;
				let delta = 0;
				if (expanding && turnBottom > bottomLimit) {
					// 露底优先：向上滚到状态栏不压输入框，但不能超过顶部余量。
					const room = Math.max(0, (start?.getBoundingClientRect().top ?? topLimit) - topLimit);
					delta = Math.min(turnBottom - bottomLimit, room);
				} else {
					// 底部没有被遮挡时只保持摘要条不动。
					delta = target.getBoundingClientRect().top - anchorTop;
				}
				if (Math.abs(delta) > 0.5) {
					scrollToY(box, box.scrollTop + delta, true);
					lastTop.current = box.scrollTop;
				}
				window.requestAnimationFrame(tick);
			};
			window.requestAnimationFrame(tick);
		},
		[scheduleResume],
	);

	/** 选离视口中线最近的那一轮作为“当前正在主要看的对话”。 */
	const updateActiveTurn = useCallback(() => {
		const box = boxRef.current;
		if (!box) return;
		const loadedTurns = buildNavTurns(items, turnOverview, historyStart).filter((turn) => turn.loaded);
		const users = [...box.querySelectorAll<HTMLElement>('.msg.user')];
		if (!loadedTurns.length || !users.length) {
			setActiveTurnIndex(null);
			return;
		}
		const distance = box.scrollHeight - box.scrollTop - box.clientHeight;
		let ordinal = 0;
		if (distance > NEAR_BOTTOM) {
			const boxRect = box.getBoundingClientRect();
			const head = box.parentElement?.querySelector<HTMLElement>('.chat-head');
			const headHeight = head?.getBoundingClientRect().height ?? 49;
			const focusY = boxRect.top + headHeight + (box.clientHeight - headHeight) * 0.45;
			for (let i = 0; i < users.length; i += 1) {
				if (users[i].getBoundingClientRect().top <= focusY) ordinal = i;
				else break;
			}
		} else {
			ordinal = users.length - 1;
		}
		const next = loadedTurns[Math.min(ordinal, loadedTurns.length - 1)]?.index ?? null;
		setActiveTurnIndex((value) => (value === next ? value : next));
	}, [items, turnOverview, historyStart]);

	const jumpToTurn = useCallback(
		async (turnIndex: number) => {
			const target = navTurns.find((turn) => turn.index === turnIndex);
			if (!target) return;
			if (!target.loaded) {
				const ok = await loadHistoryUntilTurn(turnIndex);
				if (!ok) return;
			}
			jumpSeq.current += 1;
			setJumpReq({ index: turnIndex, seq: jumpSeq.current });
		},
		[loadHistoryUntilTurn, navTurns],
	);

	// 点击导航条：等目标轮进入 DOM 后，无动画滚到该轮用户消息。
	useLayoutEffect(() => {
		if (!jumpReq) return;
		const box = boxRef.current;
		if (!box) return;
		const loadedTurns = buildNavTurns(items, turnOverview, historyStart).filter((turn) => turn.loaded);
		const ordinal = loadedTurns.findIndex((turn) => turn.index === jumpReq.index);
		if (ordinal < 0) return;
		const users = box.querySelectorAll<HTMLElement>('.msg.user');
		const el = users[ordinal];
		if (!el) return;
		const boxRect = box.getBoundingClientRect();
		const elRect = el.getBoundingClientRect();
		const head = box.parentElement?.querySelector<HTMLElement>('.chat-head');
		const headHeight = head?.getBoundingClientRect().height ?? 49;
		const nextTop = box.scrollTop + elRect.top - boxRect.top - headHeight - 12;
		scrollToY(box, Math.max(0, nextTop), true);
		lastTop.current = box.scrollTop;
		const bottom = box.scrollHeight - box.scrollTop - box.clientHeight < NEAR_BOTTOM;
		autoStick.current = bottom;
		if (bottom) clearResume();
		else scheduleResume();
		setAtBottom(bottom);
		setActiveTurnIndex(jumpReq.index);
		setJumpReq(null);
	}, [jumpReq, items, turnOverview, historyStart, isNearBottom, scheduleResume]);

	useLayoutEffect(() => {
		updateActiveTurn();
	}, [updateActiveTurn]);

	useEffect(() => {
		setActiveTurnIndex(null);
		setJumpReq(null);
	}, [sessionId]);

	useEffect(() => {
		return () => clearResume();
	}, [clearResume]);

	// 暂停自动跟随后，页面上的任何操作都重新计时，避免用户正在读/输入时被打断
	useEffect(() => {
		const noteActivity = () => {
			if (!autoStick.current) scheduleResume();
		};
		window.addEventListener('pointerdown', noteActivity, true);
		window.addEventListener('keydown', noteActivity, true);
		window.addEventListener('wheel', noteActivity, { passive: true });
		window.addEventListener('touchstart', noteActivity, { passive: true });
		return () => {
			window.removeEventListener('pointerdown', noteActivity, true);
			window.removeEventListener('keydown', noteActivity, true);
			window.removeEventListener('wheel', noteActivity);
			window.removeEventListener('touchstart', noteActivity);
		};
	}, [scheduleResume]);

	// 实测标题栏 / 输入区高度，写入 CSS 变量；输入框长高时贴底视图跟着上移，避免遮挡
	useLayoutEffect(() => {
		const chat = boxRef.current?.parentElement;
		if (!chat) return;
		const head = chat.querySelector<HTMLElement>('.chat-head');
		const composer = chat.querySelector<HTMLElement>('.composer-wrap');
		if (!head || !composer) return;

		const sync = () => {
			// 用真实高度（含小数），sticky 横道图与标题栏底线才能严丝合缝
			chat.style.setProperty('--head-h', `${head.getBoundingClientRect().height.toFixed(2)}px`);
			chat.style.setProperty('--composer-h', `${composer.getBoundingClientRect().height.toFixed(2)}px`);
			// 输入框换行撑高后，底部内边距变大；仍在跟随就重新贴底
			if (autoStick.current) pin(true);
		};

		sync();
		const Observer = window.ResizeObserver;
		const observer = typeof Observer === 'function' ? new Observer(sync) : null;
		observer?.observe(head);
		observer?.observe(composer);
		window.addEventListener('resize', sync);
		return () => {
			observer?.disconnect();
			window.removeEventListener('resize', sync);
			chat.style.removeProperty('--head-h');
			chat.style.removeProperty('--composer-h');
		};
	}, [pin]);

	useLayoutEffect(() => {
		// 上翻加载：把旧页插到前面后，保持用户当前看到的锚点不跳。
		const anchor = prependAnchor.current;
		if (anchor) {
			prependAnchor.current = null;
			const box = boxRef.current;
			if (box) {
				// 恢复锚点必须在无动画模式下完成：.messages 的 scroll-behavior 是 smooth，
				// 否则插入旧页后会被浏览器平滑动画到目标位置，看起来像页面自己在滚。
				scrollToY(box, anchor.top + Math.max(0, box.scrollHeight - anchor.height), true);
				lastTop.current = box.scrollTop;
				loadingOlder.current = false;
				setAtBottom(isNearBottom());
				return;
			}
		}
		const force = pinSeq !== lastPin.current;
		lastPin.current = pinSeq;
		if (force || autoStick.current) {
			// 初次载入 / 切换会话 / 生成中自动跟随都用无动画贴底。
			pin(true);
			if (force) {
				// 折叠区块、字体和滚动条尺寸可能在同一帧之后才稳定；再校正两次，
				// 防止“加载完停在中间”。用户如果立即上滚，autoStick 会被置 false，这里会跳过。
				window.requestAnimationFrame(() => {
					if (!autoStick.current) return;
					pin(true);
					window.requestAnimationFrame(() => {
						if (autoStick.current) pin(true);
					});
				});
			}
		} else setAtBottom(isNearBottom());
	}, [items, pinSeq, pin, isNearBottom]);

	// 最近几轮太短时没有滚动条，用户无法通过上翻触发加载。
	// 自动补载更早的页，直到内容撑出滚动条或没有更多历史。
	const fillShortViewport = useCallback(() => {
		const box = boxRef.current;
		if (!box || hidden || box.clientHeight <= 0) return false;
		if (!historyHasMore || historyLoading || loadingOlder.current) return false;
		if (box.scrollHeight > box.clientHeight + 8) return false;
		loadingOlder.current = true;
		prependAnchor.current = { top: box.scrollTop, height: box.scrollHeight };
		loadOlderHistory()
			.then((loaded) => {
				if (!loaded) {
					prependAnchor.current = null;
					loadingOlder.current = false;
				}
			})
			.catch(() => {
				prependAnchor.current = null;
				loadingOlder.current = false;
			});
		return true;
	}, [hidden, historyHasMore, historyLoading, loadOlderHistory]);

	// 放在贴底/锚点恢复之后：一页仍不够高时继续补，直到可以滚动。
	useLayoutEffect(() => {
		if (hidden) return;
		fillShortViewport();
	}, [items, historyHasMore, historyLoading, hidden, fillShortViewport]);

	useEffect(() => {
		const onResize = () => fillShortViewport();
		window.addEventListener('resize', onResize);
		return () => window.removeEventListener('resize', onResize);
	}, [fillShortViewport]);

	// 从空视图切到有内容时，旧版会直接把视图滚到底
	useLayoutEffect(() => {
		if (!items.length) setAtBottom(true);
	}, [items.length]);

	// 轨迹 tab 隐藏时浏览器会把 scrollHeight 当成 0；切回来时恢复跟随
	useLayoutEffect(() => {
		if (hidden) return;
		if (autoStick.current) pin(true);
		else setAtBottom(isNearBottom());
	}, [hidden, pin, isNearBottom]);

	return (
		<>
			<div
				id="messages"
				className="messages"
				hidden={hidden}
				ref={boxRef}
				onClickCapture={keepSummaryAnchored}
				onScroll={() => {
					const box = boxRef.current;
					if (!box) return;

					const top = box.scrollTop;
					const previousTop = lastTop.current;
					lastTop.current = top;
					const distance = box.scrollHeight - top - box.clientHeight;
					updateActiveTurn();

					// 上翻到接近顶部：动态加载上一页历史，并记住当前视口位置
					if (
						!hidden &&
						distance > NEAR_BOTTOM &&
						top < LOAD_MORE_PX &&
						historyHasMore &&
						!historyLoading &&
						!loadingOlder.current
					) {
						loadingOlder.current = true;
						prependAnchor.current = { top, height: box.scrollHeight };
						loadOlderHistory()
							.then((loaded) => {
								if (!loaded) {
									prependAnchor.current = null;
									loadingOlder.current = false;
								}
							})
							.catch(() => {
								prependAnchor.current = null;
								loadingOlder.current = false;
							});
					}

					// 已经贴底：恢复跟随
					if (distance <= BOTTOM_EPSILON) {
						clearResume();
						autoStick.current = true;
						setAtBottom(true);
						return;
					}

					if (top < previousTop - 1) {
						// 用户往上滚了：留在他看的位置，2 分钟无操作后再恢复
						autoStick.current = false;
						scheduleResume();
					} else if (!autoStick.current) {
						// 暂停期间还在滚动，视为持续操作，重新计时
						scheduleResume();
					}

					setAtBottom(distance < NEAR_BOTTOM);
				}}
			>
				{historyLoading && !historyLoadingInitial ? (
					<div className="history-loading" role="status">
						<span>正在加载更早的对话…</span>
					</div>
				) : null}
				{historyLoadingInitial ? (
					<div className="history-loading initial" role="status">
						<span>正在加载历史消息…</span>
					</div>
				) : items.length ? (
					<div className="messages-inner">
						{items.map((item) => (
							<Block key={item.id} item={item} />
						))}
					</div>
				) : (
					<EmptyState />
				)}
			</div>

			<TurnNavigator
				turns={navTurns}
				activeIndex={currentTurnIndex}
				hidden={hidden}
				onJump={(index) => {
					jumpToTurn(index).catch(() => {});
				}}
			/>

			<button
				id="to-bottom"
				className="to-bottom"
				type="button"
				title="回到底部"
				aria-label="回到底部"
				hidden={hidden || atBottom}
				onClick={() => {
					pin();
				}}
			>
				<svg viewBox="0 0 24 24" aria-hidden="true">
					<path
						d="M12 5v14M6 13l6 6 6-6"
						fill="none"
						stroke="currentColor"
						strokeWidth="2.2"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			</button>
		</>
	);
}
