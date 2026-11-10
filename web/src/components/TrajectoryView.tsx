import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { formatDuration, formatK } from '@/lib/format';
import { renderMarkdown } from '@/lib/markdown';
import { useStore } from '@/lib/store';
import type { TrajectoryCall, TrajectoryContext, TrajectoryEvent, TrajectoryPayload, TrajectorySnapshot, TrajectoryTool } from '@/lib/types';

type TimelineKind = 'input' | 'tool' | 'think';
type RowKind = 'turn' | 'input' | 'think' | 'output' | 'tool' | 'event';

interface TimelineBar {
	id: string;
	kind: TimelineKind;
	start: number;
	end: number;
	label: string;
	targetId: string;
}

interface TrajectoryRow {
	id: string;
	kind: RowKind;
	time?: number;
	turn: number;
	step?: number;
	badge: string;
	name?: string;
	preview: string;
	text?: string;
	markdown?: boolean;
	durationMs?: number;
	status?: TrajectoryTool['status'];
	stepId?: string;
	call?: TrajectoryCall;
	tool?: TrajectoryTool;
	event?: TrajectoryEvent;
}

function clock(value?: number): string {
	if (!value) return '';
	try {
		return new Date(value).toLocaleTimeString('zh-CN', { hour12: false });
	} catch {
		return '';
	}
}

function firstLine(value?: string): string {
	const line = String(value ?? '').split(/\r?\n/).find((item) => item.trim()) ?? '';
	return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}

function toolHint(args?: string): string {
	if (!args) return '';
	try {
		const value = JSON.parse(args);
		if (value && typeof value === 'object') {
			const code = typeof value.code === 'string' ? firstLine(value.code) : '';
			if (code) return code;
			const picked = value.command ?? value.path ?? value.pattern ?? value.query ?? value.file ?? value.url;
			if (picked != null) return firstLine(String(picked));
		}
	} catch {
		/* 不是 JSON 就显示原文（codemode 送来的是脚本源码） */
	}
	return firstLine(args);
}

function statusLabel(status: TrajectoryTool['status']): string {
	if (status === 'running') return '运行中';
	if (status === 'error') return '失败';
	return '完成';
}

function timelineBars(snapshot: TrajectorySnapshot): TimelineBar[] {
	const bars: TimelineBar[] = [];
	for (const turn of snapshot.turns) {
		const firstStep = turn.steps[0];
		if (turn.user?.timestamp != null) {
			const start = turn.user.timestamp;
			const end = Math.max(
				start + 1,
				firstStep?.startedAt ?? firstStep?.timestamp ?? turn.endedAt ?? start + 1000,
			);
			bars.push({
				id: `input:${turn.id}`,
				kind: 'input',
				start,
				end,
				label: `输入 · 第 ${turn.index} 轮`,
				targetId: `traj-row-input:${turn.id}`,
			});
		}
		for (const step of turn.steps) {
			const stepStart = step.startedAt ?? step.timestamp;
			if (stepStart != null && step.thinking?.trim()) {
				const end = Math.max(stepStart + 1, stepStart + Math.max(step.durationMs ?? 0, 1));
				bars.push({
					id: `think:${step.id}`,
					kind: 'think',
					start: stepStart,
					end,
					label: `思考 · 第 ${turn.index}.${step.index} 步`,
					targetId: `traj-row-think:${step.id}`,
				});
			}
			for (const tool of step.tools) {
				const start = tool.startedAt ?? stepStart;
				if (start == null) continue;
				const end = tool.finishedAt
					?? (tool.durationMs != null ? start + Math.max(tool.durationMs, 1) : (snapshot.busy ? Math.max(snapshot.updatedAt, start + 1) : start + 500));
				bars.push({
					id: `tool:${tool.id}`,
					kind: 'tool',
					start,
					end: Math.max(start + 1, end),
					label: `${tool.name} · ${statusLabel(tool.status)}`,
					targetId: `traj-row-tool:${tool.id}`,
				});
			}
		}
	}
	return bars;
}

function buildRows(snapshot: TrajectorySnapshot): TrajectoryRow[] {
	const rows: TrajectoryRow[] = [];
	for (const turn of snapshot.turns) {
		rows.push({
			id: `turn:${turn.index}`,
			kind: 'turn',
			time: turn.startedAt ?? turn.user?.timestamp,
			turn: turn.index,
			badge: '',
			preview: '',
		});
		if (turn.user) {
			rows.push({
				id: `input:${turn.id}`,
				kind: 'input',
				time: turn.user.timestamp,
				turn: turn.index,
				badge: '输入',
				preview: firstLine(turn.user.text),
				text: turn.user.text,
			});
		}
		for (const step of turn.steps) {
			if (step.thinking?.trim()) {
				rows.push({
					id: `think:${step.id}`,
					kind: 'think',
					time: step.startedAt ?? step.timestamp,
					turn: turn.index,
					step: step.index,
					badge: '思考',
					preview: firstLine(step.thinking),
					stepId: step.id,
					call: step.call,
					text: step.thinking,
					durationMs: step.durationMs,
				});
			}
			if (step.text?.trim()) {
				rows.push({
					id: `output:${step.id}`,
					kind: 'output',
					time: step.finishedAt ?? step.timestamp,
					turn: turn.index,
					step: step.index,
					badge: '输出',
					preview: firstLine(step.text),
					call: step.thinking?.trim() ? undefined : step.call,
					stepId: step.thinking?.trim() ? undefined : step.id,
					text: step.text,
					markdown: true,
				});
			}
			for (let toolIndex = 0; toolIndex < step.tools.length; toolIndex += 1) {
				const tool = step.tools[toolIndex];
				rows.push({
					id: `tool:${tool.id}`,
					kind: 'tool',
					time: tool.startedAt ?? step.finishedAt ?? step.timestamp,
					turn: turn.index,
					step: step.index,
					badge: '工具',
					name: tool.name,
					preview: [tool.name, toolHint(tool.args)].filter(Boolean).join(' · '),
					durationMs: tool.durationMs,
					status: tool.status,
					call: !step.thinking?.trim() && !step.text?.trim() && toolIndex === 0 ? step.call : undefined,
					stepId: !step.thinking?.trim() && !step.text?.trim() && toolIndex === 0 ? step.id : undefined,
					tool,
				});
			}
		}
	}
	for (const event of snapshot.events) {
		const badge = event.kind === 'compaction' ? '压缩' : event.kind === 'model' ? '模型' : '级别';
		rows.push({
			id: `event:${event.id}`,
			kind: 'event',
			time: event.time,
			turn: event.turn,
			step: event.step,
			badge,
			preview: firstLine([event.title, event.text].filter(Boolean).join(' · ')),
			text: event.text,
			event,
		});
	}
	rows.sort((left, right) => (left.time ?? 0) - (right.time ?? 0));
	return rows;
}

function Timeline({
	snapshot,
	selected,
	onSelect,
}: {
	snapshot: TrajectorySnapshot;
	selected: string | null;
	onSelect: (bar: TimelineBar) => void;
}) {
	const bars = useMemo(() => timelineBars(snapshot), [snapshot]);
	if (!bars.length) return null;

	const starts = bars.map((bar) => bar.start);
	const ends = bars.map((bar) => bar.end);
	const start = Math.min(...starts, snapshot.totals.startedAt ?? Infinity);
	const end = Math.max(...ends, snapshot.totals.endedAt ?? 0, snapshot.busy ? snapshot.updatedAt : 0);
	const span = Math.max(1, end - start);
	const lanes: { kind: TimelineKind; label: string }[] = [
		{ kind: 'input', label: '输入' },
		{ kind: 'think', label: '思考' },
		{ kind: 'tool', label: '工具调用' },
	];

	return (
		<section className="traj-waterfall" aria-label="执行时间线">
			<div className="traj-waterfall-head">
				<span>执行时间线</span>
				<span>{clock(start)} → {clock(end)} · 点击色块跳转</span>
			</div>
			<div className="traj-waterfall-grid">
				<div className="traj-waterfall-labels" aria-hidden="true">
					{lanes.map((lane) => <span key={lane.kind}>{lane.label}</span>)}
				</div>
				<div className="traj-waterfall-plot">
					{lanes.map((lane) => (
						<div className={`traj-waterfall-lane traj-lane-${lane.kind}`} key={lane.kind}>
							{bars
								.filter((bar) => bar.kind === lane.kind)
								.map((bar) => {
									const left = ((bar.start - start) / span) * 100;
									const width = Math.max(0.12, ((bar.end - bar.start) / span) * 100);
									return (
										<button
											key={bar.id}
											type="button"
											className={`traj-bar traj-lane-${bar.kind}${selected === bar.id ? ' selected' : ''}`}
											style={{ left: `${Math.max(0, left)}%`, width: `${width}%` }}
											title={`${bar.label}\n${clock(bar.start)} → ${clock(bar.end)} · ${formatDuration(bar.end - bar.start)}`}
											aria-label={`${bar.label}，${formatDuration(bar.end - bar.start)}`}
											onClick={() => onSelect(bar)}
										/>
									);
								})}
						</div>
					))}
				</div>
			</div>
		</section>
	);
}

const stepContextCache = new Map<string, TrajectoryContext>();

function contextSummary(context: TrajectoryContext): string {
	return `系统 ${formatK(context.tokens.system)} · 工具 ${formatK(context.tokens.tools)} · Skill ${formatK(context.tokens.skills)} · 消息 ${formatK(context.tokens.messages)} tok`;
}

function ContextSection({
	title,
	text,
	empty,
	tail = false,
}: {
	title: string;
	text: string;
	empty: string;
	tail?: boolean;
}) {
	const [all, setAll] = useState(false);
	const lines = useMemo(() => (text ? text.split('\n') : []), [text]);
	const preview = useMemo(() => {
		if (!text) return '';
		const picked = tail ? lines.slice(-6) : lines.slice(0, 6);
		return picked.join('\n').slice(0, 5000);
	}, [lines, tail, text]);
	return (
		<section className="traj-context-section">
			<div className="traj-context-section-head">
				<span>{title}</span>
				<span>{text ? `${formatK(text.length)} 字符` : '空'}</span>
			</div>
			<pre className="traj-context-preview">{text ? (all ? text : preview) : empty}</pre>
			{lines.length > 6 ? (
				<button type="button" className="traj-context-more" onClick={() => setAll((value) => !value)}>
					{all ? '收起' : '展开全部'} · {lines.length} 行
				</button>
			) : null}
		</section>
	);
}

/** 任一步骤行展开后按需拉取：系统提示词 / 工具 schema / skill / 截至本步的消息。 */
function StepContext({ sessionId, stepId }: { sessionId: string; stepId: string }) {
	const [data, setData] = useState<TrajectoryContext | null>(null);
	const [error, setError] = useState('');
	const [expanded, setExpanded] = useState(false);

	useEffect(() => {
		const key = `${sessionId}:${stepId}`;
		const cached = stepContextCache.get(key);
		if (cached) {
			setData(cached);
			setError('');
			return;
		}
		let cancelled = false;
		setData(null);
		setError('');
		api<TrajectoryContext>(
			`/api/trajectory/context?sessionId=${encodeURIComponent(sessionId)}&stepId=${encodeURIComponent(stepId)}`,
		)
			.then((next) => {
				stepContextCache.set(key, next);
				if (!cancelled) setData(next);
			})
			.catch((err) => {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			});
		return () => {
			cancelled = true;
		};
	}, [sessionId, stepId]);

	return (
		<div className="traj-context">
			<button type="button" className="traj-context-toggle" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
				<span className="traj-context-title">本步上下文</span>
				<span className="traj-context-meta">{data ? contextSummary(data) : error ? '加载失败' : '加载中…'}</span>
				<span className="traj-chevron">{expanded ? '▾' : '▸'}</span>
			</button>
			{expanded ? (
				<div className="traj-context-body">
					{error ? <div className="traj-context-error">上下文加载失败：{error}</div> : null}
					{!data && !error ? <div className="traj-context-loading">正在读取这一步骤之前的上下文…</div> : null}
					{data ? (
						<>
							{data.compacted ? (
								<div className="traj-context-note">已按最近一次上下文压缩裁剪，压缩摘要保留在消息最前面。</div>
							) : null}
							{data.counts.skills ? (
								<div className="traj-context-note">Skills 取 CARD 钉住的技能；历史注入内容未写入 session。</div>
							) : null}
							<ContextSection title="系统提示词" text={data.system} empty="（无系统提示词）" />
							<ContextSection title={`工具定义 · ${data.counts.tools} 个`} text={data.tools} empty="（本步没有工具定义）" />
							<ContextSection title={`Skills · ${data.counts.skills} 个`} text={data.skills} empty="当前没有生效的 skill" />
							<ContextSection title={`对话消息 · ${data.counts.messages} 条`} text={data.messages} empty="（本步之前没有对话消息）" tail />
						</>
					) : null}
				</div>
			) : null}
		</div>
	);
}

const stepPayloadCache = new Map<string, TrajectoryPayload>();

function formatBytes(value?: number): string {
	const n = Number(value ?? 0);
	if (!Number.isFinite(n) || n <= 0) return '—';
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function jsonKind(value: JsonValue): string {
	if (value === null) return 'null';
	if (Array.isArray(value)) return 'array';
	return typeof value;
}

function JsonNode({
	name,
	value,
	depth = 0,
	isIndex = false,
	defaultOpen = false,
}: {
	name?: string;
	value: JsonValue;
	depth?: number;
	isIndex?: boolean;
	defaultOpen?: boolean;
}) {
	const [open, setOpen] = useState(defaultOpen);
	const composite = value !== null && typeof value === 'object';
	const label = name == null ? null : isIndex ? `[${name}]` : JSON.stringify(name);
	const indent = { paddingLeft: `${Math.min(depth, 10) * 12}px` };

	if (!composite || (Array.isArray(value) && value.length === 0)) {
		return (
			<div className="traj-json-line" style={indent}>
				{label ? <span className="traj-json-key">{label}</span> : null}
				{label ? <span className="traj-json-colon">: </span> : null}
				<span className={`traj-json-value traj-json-${jsonKind(value)}`}>
					{Array.isArray(value) ? '[]' : JSON.stringify(value)}
				</span>
			</div>
		);
	}

	const entries = Array.isArray(value)
		? value.map((item, index) => [String(index), item] as const)
		: Object.entries(value) as [string, JsonValue][];
	const summary = Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`;
	return (
		<div className="traj-json-node">
			<button type="button" className="traj-json-toggle" style={indent} aria-expanded={open} onClick={() => setOpen((current) => !current)}>
				<span className="traj-json-caret">{open ? '▾' : '▸'}</span>
				{label ? <span className="traj-json-key">{label}</span> : null}
				{label ? <span className="traj-json-colon">: </span> : null}
				<span className="traj-json-bracket">{summary}</span>
			</button>
			{open ? (
				<div className="traj-json-children">
					{entries.map(([key, item]) => (
						<JsonNode key={key} name={key} value={item} depth={depth + 1} isIndex={Array.isArray(value)} />
					))}
				</div>
			) : null}
		</div>
	);
}

/** 原始 provider payload：最近 20 步才有，展开时才读取。 */
function RawPayload({ sessionId, stepId }: { sessionId: string; stepId: string }) {
	const [expanded, setExpanded] = useState(false);
	const [data, setData] = useState<TrajectoryPayload | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState('');

	useEffect(() => {
		if (!expanded || data) return;
		const key = `${sessionId}:${stepId}`;
		const cached = stepPayloadCache.get(key);
		if (cached) {
			setData(cached);
			return;
		}
		let cancelled = false;
		setLoading(true);
		setError('');
		api<TrajectoryPayload>(
			`/api/trajectory/payload?sessionId=${encodeURIComponent(sessionId)}&stepId=${encodeURIComponent(stepId)}`,
		)
			.then((next) => {
				stepPayloadCache.set(key, next);
				if (!cancelled) setData(next);
			})
			.catch((err) => {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [expanded, data, sessionId, stepId]);

	const meta = data?.available
		? `最近 20 步 · ${data.at ? clock(data.at) : ''} · ${formatBytes(data.bytes)}`
		: data
			? '未记录'
			: '展开时读取';

	return (
		<div className="traj-raw">
			<button type="button" className="traj-raw-toggle" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
				<span className="traj-raw-title">API 原始 payload</span>
				<span className="traj-raw-meta">{meta}</span>
				<span className="traj-chevron">{expanded ? '▾' : '▸'}</span>
			</button>
			{expanded ? (
				<div className="traj-raw-body">
					{loading ? <div className="traj-raw-note">正在读取原始 payload…</div> : null}
					{error ? <div className="traj-raw-error">读取失败：{error}</div> : null}
					{data && !data.available ? <div className="traj-raw-note">{data.reason ?? '该步没有记录原始 payload。'}</div> : null}
					{data?.available ? (
						<>
							<div className="traj-raw-sub">
								<span>{data.model ?? 'provider request'}</span>
								<span>{data.responseId ?? ''}</span>
							</div>
							<div className="traj-json">
								<JsonNode value={data.payload as JsonValue} defaultOpen />
							</div>
						</>
					) : null}
				</div>
			) : null}
		</div>
	);
}

function formatDateTime(value?: number): string {
	if (!value) return '—';
	const date = new Date(value);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}

function formatSeconds(value?: number): string {
	if (value == null || !Number.isFinite(value)) return '—';
	return `${(value / 1000).toFixed(2)} 秒`;
}

function formatCount(value?: number): string {
	const n = Number(value ?? 0);
	return Number.isFinite(n) ? n.toLocaleString('zh-CN') : '0';
}

function formatTps(value?: number): string {
	if (value == null || !Number.isFinite(value)) return '—';
	return `${Number(value).toFixed(1)} tok/s`;
}

function CallStats({ call }: { call: TrajectoryCall }) {
	const usage = call.usage;
	return (
		<section className="traj-call" aria-label="本次调用统计">
			<div className="traj-call-head">
				<span>本次调用</span>
				<span>{call.model ?? ''}</span>
			</div>
			<dl className="traj-call-grid">
				<dt>开始时间</dt>
				<dd>{formatDateTime(call.startedAt)}</dd>
				<dt>总时长</dt>
				<dd>{formatSeconds(call.durationMs)}</dd>
				<dt>首 token 延迟</dt>
				<dd>{formatSeconds(call.ttftMs)}</dd>
				<dt>生成</dt>
				<dd>{formatSeconds(call.generationMs)}</dd>
				<dt>输入</dt>
				<dd>命中 {formatCount(usage?.cacheRead)} · 未命中 {formatCount(usage?.input)}</dd>
				{usage?.cacheWrite ? (
					<>
						<dt>缓存写入</dt>
						<dd>{formatCount(usage.cacheWrite)}</dd>
					</>
				) : null}
				<dt>输出</dt>
				<dd>{formatCount(usage?.output)} tok</dd>
				<dt>输出 TPS</dt>
				<dd>{formatTps(call.tps)}</dd>
			</dl>
			{call.approximate ? (
				<div className="traj-call-note">历史调用：首 token 延迟未采集，生成与 TPS 按总时长估算。</div>
			) : null}
		</section>
	);
}

function Row({
	row,
	open,
	idle,
	sessionId,
	onToggle,
}: {
	row: TrajectoryRow;
	open: boolean;
	idle: boolean;
	sessionId: string;
	onToggle: () => void;
}) {
	const stale = row.status === 'running' && idle;
	if (row.kind === 'turn') {
		return (
			<div className="traj-turn-divider" id={`traj-row-${row.id}`}>
				<span>第 {row.turn} 轮</span>
				<span>{clock(row.time)}</span>
			</div>
		);
	}
	const meta = [
		row.kind === 'input' ? `#${row.turn}` : row.step ? `${row.turn}.${row.step}` : '',
		clock(row.time),
	].filter(Boolean);
	const title = row.kind === 'tool' ? row.name : row.kind === 'event' ? row.event?.title : row.badge;
	return (
		<article id={`traj-row-${row.id}`} className={`traj-row traj-kind-${row.kind}${row.status ? ` traj-status-${row.status}` : ''}${open ? ' open' : ''}`}>
			<button type="button" className="traj-row-head" aria-expanded={open} onClick={onToggle}>
				<span className={`traj-row-badge traj-kind-${row.kind}`}>{row.badge}</span>
				<span className="traj-row-preview">{row.preview}</span>
				<span className="traj-row-meta">{meta.join(' · ')}</span>
				<span className="traj-chevron">{open ? '▾' : '▸'}</span>
			</button>
			{open ? (
				<div className="traj-row-body">
					<div className="traj-card-head">
						<b>{title || row.badge}</b>
						<span>
							{row.kind === 'tool' ? (stale ? '无结果' : statusLabel(row.status ?? 'ok')) : row.kind === 'event' ? row.event?.kind : `第 ${row.turn} 轮${row.step ? ` · ${row.step} 步` : ''}`}
						</span>
					</div>
					{row.call ? <CallStats call={row.call} /> : null}
					{row.stepId ? (
						<>
							<StepContext sessionId={sessionId} stepId={row.stepId} />
							<RawPayload sessionId={sessionId} stepId={row.stepId} />
						</>
					) : null}
					{row.kind === 'think' ? (
						<pre>{row.text || '—'}</pre>
					) : row.kind === 'tool' && row.tool ? (
						<>
							{row.tool.children?.length ? (
								<div className="traj-card-section">
									<div className="traj-kicker">脚本调用 · {row.tool.children.length} 次</div>
									<div className="tool-children">
										{row.tool.children.map((call, index) => (
											<div key={call.id ?? `${call.name}-${index}`} className={`tool-child ${call.status}`}>
												<span className="name">{call.name}</span>
												{call.args ? <span className="arg" title={call.args}>{call.args}</span> : null}
												{call.durationMs != null ? <span className="ms">{formatDuration(call.durationMs)}</span> : null}
											</div>
										))}
									</div>
								</div>
							) : null}
							<div className="traj-card-section">
								<div className="traj-kicker">{row.tool.name === 'codemode' ? '脚本' : '参数'}</div>
								<pre>{row.tool.args || '—'}</pre>
							</div>
							<div className="traj-card-section">
								<div className="traj-kicker">结果</div>
								<pre>{row.tool.result || (row.status === 'running' ? '等待结果…' : '—')}</pre>
							</div>
						</>
					) : row.markdown && row.text ? (
						<div className="msg assistant traj-text">
							<div className="body" dangerouslySetInnerHTML={{ __html: renderMarkdown(row.text) }} />
						</div>
					) : (
						<pre>{row.text || '—'}</pre>
					)}
				</div>
			) : null}
		</article>
	);
}

export function TrajectoryView() {
	const sessionId = useStore((s) => s.sessionId);
	const clientId = useStore((s) => s.clientId);
	const busy = useStore((s) => s.busy);
	const [snapshot, setSnapshot] = useState<TrajectorySnapshot | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState('');
	const [reloadTick, setReloadTick] = useState(0);
	const [open, setOpen] = useState<Set<string>>(() => new Set());
	const [selectedBar, setSelectedBar] = useState<string | null>(null);
	const boxRef = useRef<HTMLDivElement | null>(null);
	const stick = useRef(true);
	const initialized = useRef(false);
	const lastSession = useRef<string | null>(null);

	useEffect(() => {
		if (lastSession.current !== sessionId) {
			lastSession.current = sessionId;
			setSnapshot(null);
			setOpen(new Set());
			setSelectedBar(null);
			initialized.current = false;
			stick.current = true;
		}
		if (!sessionId) {
			setSnapshot(null);
			setLoading(false);
			return;
		}
		let cancelled = false;
		let timer: number | undefined;
		const load = async (initial: boolean) => {
			if (initial) setLoading(true);
			try {
				const data = await api<TrajectorySnapshot>(
					`/api/trajectory?sessionId=${encodeURIComponent(sessionId)}&sid=${encodeURIComponent(clientId)}`,
				);
				if (!cancelled) {
					setSnapshot(data);
					setError('');
				}
			} catch (err) {
				if (!cancelled && initial) setError(err instanceof Error ? err.message : String(err));
			} finally {
				if (!cancelled && initial) setLoading(false);
			}
		};
		load(true);
		if (busy) timer = window.setInterval(() => load(false), 4000);
		return () => {
			cancelled = true;
			if (timer !== undefined) window.clearInterval(timer);
		};
	}, [sessionId, clientId, busy, reloadTick]);

	useLayoutEffect(() => {
		const box = boxRef.current;
		if (!box) return;
		if (!initialized.current || stick.current) {
			box.scrollTop = box.scrollHeight;
			initialized.current = true;
		}
	}, [snapshot]);

	const rows = useMemo(() => (snapshot ? buildRows(snapshot) : []), [snapshot]);
	const toggle = (key: string) => {
		setOpen((previous) => {
			const next = new Set(previous);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	};
	const selectBar = (bar: TimelineBar) => {
		setSelectedBar(bar.id);
		setOpen((previous) => {
			const next = new Set(previous);
			next.add(bar.id);
			return next;
		});
		const target = document.getElementById(bar.targetId);
		if (target && typeof target.scrollIntoView === 'function') {
			target.scrollIntoView({ behavior: 'smooth', block: 'center' });
		}
	};
	const refresh = () => setReloadTick((value) => value + 1);

	if (!sessionId) {
		return (
			<div className="trajectory">
				<div className="trajectory-inner">
					<div className="traj-empty">先发一条消息，轨迹会从这里开始。</div>
				</div>
			</div>
		);
	}

	const totals = snapshot?.totals;
	const live = snapshot?.live;
	const runningTools = live?.tools.filter((tool) => tool.status === 'running') ?? [];

	return (
		<div
			className="trajectory"
			ref={boxRef}
			onScroll={() => {
				const box = boxRef.current;
				if (!box) return;
				stick.current = box.scrollHeight - box.scrollTop - box.clientHeight < 100;
			}}
		>
			<div className="trajectory-inner">
				{snapshot ? <Timeline snapshot={snapshot} selected={selectedBar} onSelect={selectBar} /> : null}

				<div className="traj-toolbar">
					<div className="traj-summary">
						{snapshot ? (
							<>
								<span><b>{totals?.turns ?? 0}</b> 轮</span>
								<span><b>{totals?.steps ?? 0}</b> 步</span>
								<span><b>{totals?.toolCalls ?? 0}</b> 工具</span>
								<span><b>{formatK(totals?.usage.total ?? 0)}</b> 累计 tokens</span>
							</>
						) : (
							<span>加载轨迹…</span>
						)}
					</div>
					<div className="traj-actions">
						{snapshot?.busy ? <span className="traj-live-chip"><i /> 生成中</span> : null}
						<button type="button" className="traj-refresh" disabled={loading} onClick={refresh}>
							{loading ? '刷新中…' : '刷新'}
						</button>
					</div>
				</div>

				{error ? <div className="traj-error">轨迹加载失败：{error}</div> : null}

				<div className="traj-rows">
					{rows.map((row) => (
						<Row key={row.id} row={row} open={open.has(row.id)} idle={!snapshot?.busy} sessionId={sessionId} onToggle={() => toggle(row.id)} />
					))}
				</div>

				{snapshot?.busy ? (
					<section className="traj-live">
						<div className="traj-live-head">
							<span className="traj-pulse" />
							正在执行
							<span className="traj-live-note">
								{runningTools.length ? runningTools.map((tool) => tool.name).join('、') : '等待模型下一步…'}
							</span>
						</div>
					</section>
				) : null}

				{snapshot && !snapshot.turns.length && !snapshot.busy ? <div className="traj-empty">还没有可展示的执行步骤。</div> : null}
			</div>
		</div>
	);
}
