/**
 * 全局状态（Zustand）。
 *
 * 旧版 app.js 的命令式 DOM 操作在这里变成可枚举的状态：
 *   - messages 由 `items` 渲染（用户消息 / 助手文本 / 工具组）
 *   - 流式增量、工具状态、统计、会话列表都进同一个 store
 * 行为与旧版对齐：SSE 双键订阅、切会话不销毁后台 Chat、重连后按服务端状态重绘。
 */

import { create } from 'zustand';
import { api, newId, sessionStore, storage } from './api';
import { applyTheme, loadThemeMode, saveThemeMode, type ThemeMode } from './theme';
import { formatDuration } from './format';
import {
	clearDoneTitle,
	currentNotifyPermission,
	deliverTurnDone,
	loadNotifySettings,
	playApprovalSound,
	playDoneSound,
	primeAudio,
	requestNotifyPermission,
	saveNotifySettings,
	type NotifyPermission,
	type NotifySettings,
} from './notify';
import {
	createGuideTab,
	createPanelTab,
	fileTabId,
	guideEntry,
	loadPanelState,
	pathForWorkspace,
	savePanelState,
	sameTabKind,
	type PanelTab,
} from './panel';
import { currentHash, parseViewHash, writeViewHash, type AppView } from './view';
import { parseSessionReferences } from './references/session';
import type { SessionReference } from './input-trigger/types';
import {
	clampContextWidth,
	loadContextCollapsed,
	loadContextWidth,
	saveContextCollapsed,
	saveContextWidth,
} from './contextColumn';
import { shouldAutoHideContext, WIDE_MIN_WIDTH } from './layout';
import {
	addGitRepo as addGitRepoRequest,
	describeGitError,
	loadGitRepos,
	removeGitRepo as removeGitRepoRequest,
} from './git';
import { loadRailExpanded, saveRailExpanded } from './rail';
import { parseFileRef } from './fileRef';
import { getFileRoots } from './files';
import type {
	AgentSummary,
	ChatStats,
	CodemodeMode,
	ContextBreakdown,
	FileImportance,
	HealthResponse,
	HistoryItem,
	ImageAttachment,
	Item,
	LiveState,
	ModelInfo,
	NestedToolCall,
	QueuePlacement,
	QueueSnapshot,
	ReportedFile,
	RetryState,
	SendMode,
	SendResponse,
	SearchSourceGroup,
	SessionSummary,
	GitPanel,
	TurnFiles,
	WorkspaceInfo,
	WorktreeInfo,
	FileRoot,
	ToolCatalogItem,
	ToolRow,
	TurnCounters,
	TurnPart,
	TurnStats,
	TurnOverviewItem,
	Usage,
	CredentialRequest,
	CredentialTimeout,
} from './types';

const SESSION_KEY = 'turnpi-session';
const CLIENT_KEY = 'turnpi-client';
const FILE_CARDS_KEY = 'turnpi-file-cards';

function loadFileCardSettings(): { enabled: boolean; minImportance: FileImportance } {
	try {
		const raw = JSON.parse(storage.get(FILE_CARDS_KEY) ?? '');
		const minImportance: FileImportance =
			raw?.minImportance === 'low' || raw?.minImportance === 'high' ? raw.minImportance : 'normal';
		return { enabled: raw?.enabled !== false, minImportance };
	} catch {
		return { enabled: true, minImportance: 'normal' };
	}
}

function saveFileCardSettings(settings: { enabled: boolean; minImportance: FileImportance }) {
	storage.set(FILE_CARDS_KEY, JSON.stringify(settings));
}
const DOMAIN_KEY = 'turnpi-domain';
const WORKSPACE_KEY = 'turnpi-workspace';
/** 新对话选中的 AgentTemplate；空 = 不绑模板（环境默认工具集） */
const AGENT_KEY = 'turnpi-agent';
const WORKTREE_KEY = 'turnpi-worktree-workspaces';
/** 首次打开 / 刷新只取最近这么多轮；继续上翻时再按同样粒度加载 */
const HISTORY_PAGE_TURNS = 3;

function readWorktreePrefs(): Set<string> {
	try {
		const raw = storage.get(WORKTREE_KEY);
		const list = raw ? JSON.parse(raw) : [];
		return new Set(Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string') : []);
	} catch {
		return new Set();
	}
}

function writeWorktreePrefs(prefs: Set<string>): void {
	storage.set(WORKTREE_KEY, JSON.stringify([...prefs]));
}

function canUseWorktree(workspace: WorkspaceInfo | undefined): boolean {
	return Boolean(workspace && workspace.kind === 'git' && !workspace.readonly && workspace.available !== false);
}

function worktreePreferred(workspaceId: string, workspaces: WorkspaceInfo[]): boolean {
	return (
		canUseWorktree(workspaces.find((workspace) => workspace.id === workspaceId)) &&
		readWorktreePrefs().has(workspaceId)
	);
}

function initialClientId(): string {
	const existing = sessionStore.get(CLIENT_KEY);
	if (existing) return existing;
	const id = newId();
	sessionStore.set(CLIENT_KEY, id);
	return id;
}

const initialPanel = loadPanelState();
/** 拖拽时每帧写 localStorage 太频繁；persist=false 的中间态不落盘 */
let panelWidthPersist = true;

const initialView = parseViewHash(currentHash());

/** 切模块时把该模块自己的上下文列宽度/折叠状态读回来 */
function contextStateFor(view: AppView): { contextWidth: number | null; contextCollapsed: boolean } {
	return { contextWidth: loadContextWidth(view), contextCollapsed: loadContextCollapsed(view) };
}

const initialLayoutWidth = typeof window === 'undefined' ? 1280 : Math.round(window.innerWidth);

const uid = () => newId();

const isMobileViewport = () =>
	typeof window !== 'undefined' && window.matchMedia('(max-width: 980px)').matches;

/** 工具参数 → 展示用 arg + 可映射到工作区的 path/line */
const toolInfo = (args: unknown): { arg: string; path?: string; line?: number } => {
	if (!args || typeof args !== 'object') return { arg: '' };
	const a = args as Record<string, unknown>;
	// codemode 的参数是一段脚本：预览用第一行非空内容，不要把整段代码铺在一行里
	const script = typeof a.code === 'string' ? a.code.split('\n').find((line) => line.trim())?.trim() ?? '' : '';
	const value = script || a.path || a.file || a.pattern || a.query || a.command || '';
	const rawPath = typeof a.path === 'string' ? a.path : typeof a.file === 'string' ? a.file : '';
	const path = rawPath || undefined;
	const rawLine = Number(a.offset ?? a.line ?? a.startLine);
	const line = Number.isFinite(rawLine) && rawLine > 0 ? Math.floor(rawLine) : undefined;
	return { arg: String(value).slice(0, 80), path, line };
};

/** 工具原始参数：普通工具展开后看完整 JSON，codemode 直接看脚本原文。 */
const toolArgsText = (args: unknown): string => {
	if (args == null) return '';
	if (typeof args === 'string') return args.slice(0, 4000);
	const code = (args as { code?: unknown }).code;
	if (typeof code === 'string') return code.slice(0, 4000);
	try {
		return JSON.stringify(args, null, 2).slice(0, 4000);
	} catch {
		return String(args).slice(0, 4000);
	}
};

type TurnItem = Extract<Item, { kind: 'turn' }>;

const newTurn = (
	streaming = false,
	thinking = false,
	baseline?: TurnCounters,
	startedAt?: number,
): TurnItem => ({
	kind: 'turn',
	id: uid(),
	parts: [],
	streaming,
	thinking,
	activity: thinking ? 'thinking' : undefined,
	baseline,
	startedAt,
});

const countersFrom = (state: {
	steps: number;
	toolCalls: number;
	usage: { input: number; cacheRead: number; output: number };
}): TurnCounters => ({
	steps: state.steps,
	toolCalls: state.toolCalls,
	input: state.usage.input,
	cacheRead: state.usage.cacheRead,
	output: state.usage.output,
});

/** 本轮增量：settled 时的累计值 - 发送时的累计值 */
function roundStats(
	final: TurnCounters,
	baseline: TurnCounters | undefined,
	turns: number,
	startedAt: number | undefined,
	model: string | undefined,
): TurnStats | undefined {
	if (!baseline) return undefined;
	return {
		turns,
		steps: Math.max(0, final.steps - baseline.steps),
		toolCalls: Math.max(0, final.toolCalls - baseline.toolCalls),
		input: Math.max(0, final.input - baseline.input),
		cacheRead: Math.max(0, final.cacheRead - baseline.cacheRead),
		output: Math.max(0, final.output - baseline.output),
		durationMs: Math.max(0, Date.now() - (startedAt ?? Date.now())),
		completedAt: Date.now(),
		model,
	};
}

/** 平均生成速度：输出 tokens / 模型生成耗时（不包括工具等待） */
function averageTps(output: number, durationMs: number): number | undefined {
	if (!(output > 0) || !(durationMs > 0)) return undefined;
	return Math.max(1, Math.round(output / (durationMs / 1000)));
}

/** 底部状态栏回显的历史本轮平均 TPS */
function lastTurnAverage(items: Item[]): number | null {
	for (let i = items.length - 1; i >= 0; i--) {
		const item = items[i];
		if (item.kind === 'turn') return item.avgTps ?? null;
	}
	return null;
}

/** 追加一段正文：紧挨着的两次模型输出合并成一个 body，避免多出空行块 */
function appendText(turn: TurnItem, text: string) {
	const last = turn.parts[turn.parts.length - 1];
	if (last?.kind === 'text') last.text = last.text ? `${last.text}\n\n${text}` : text;
	else turn.parts.push({ kind: 'text', id: uid(), text });
}

/** 追加思考增量：同一段连续思考合并，遇到正文/工具就另起一块 */
function appendThinking(turn: TurnItem, text: string) {
	if (!text) return;
	const last = turn.parts[turn.parts.length - 1];
	if (last?.kind === 'thinking') last.text += text;
	else turn.parts.push({ kind: 'thinking', id: uid(), text });
}

function toolRows(tools: {
	id: string;
	name: string;
	status: 'running' | 'ok' | 'error';
	detail?: string;
	args?: string;
	result?: string;
	durationMs?: number;
	path?: string;
	line?: number;
	children?: NestedToolCall[];
}[]) {
	return tools.map((tool) => ({
		id: tool.id,
		name: tool.name,
		status: tool.status,
		detail: tool.detail,
		args: tool.args,
		result: tool.result,
		durationMs: tool.durationMs,
		path: tool.path,
		line: tool.line,
		children: tool.children,
	}));
}

/**
 * 已持久化历史 → 渲染块。
 * 同一个 user 与下一个 user 之间的所有 assistant message 合并成一“轮”，
 * 这样 PI 标题每轮只出现一次，而不是每个模型 step 一个。
 */
function historyToItems(
	history: HistoryItem[] | undefined,
	firstTurn = 1,
	filesByTurn: Record<string, TurnFiles> = {},
): Item[] {
	const items: Item[] = [];
	let turn: TurnItem | null = null;
	let turnNumber = firstTurn - 1;
	let turnOutput = 0;
	let turnDurationMs = 0;
	let turnSteps = 0;
	let turnThinking = 0;
	let turnTools = 0;
	let turnInput = 0;
	let turnCacheRead = 0;
	let turnCompletedAt = 0;

	const closeTurn = () => {
		if (!turn) return;
		const tps = averageTps(turnOutput, turnDurationMs);
		if (tps != null) turn.avgTps = tps;
		if (turnSteps > 0) {
			turn.historyStats = {
				turns: Math.max(1, turnNumber),
				steps: turnSteps,
				thinkingCount: turnThinking,
				toolCalls: turnTools,
				durationMs: turnDurationMs,
				completedAt: turnCompletedAt || undefined,
				input: turnInput,
				cacheRead: turnCacheRead,
				output: turnOutput,
			};
			// 统计条也从历史还原，刷新后不再只存在最后一轮的内存里。
			turn.stats = {
				turns: Math.max(1, turnNumber),
				steps: turnSteps,
				toolCalls: turnTools,
				input: turnInput,
				cacheRead: turnCacheRead,
				output: turnOutput,
				durationMs: turnDurationMs,
				completedAt: turnCompletedAt || undefined,
			};
		}
		turn = null;
		turnOutput = 0;
		turnDurationMs = 0;
		turnSteps = 0;
		turnThinking = 0;
		turnTools = 0;
		turnInput = 0;
		turnCacheRead = 0;
		turnCompletedAt = 0;
	};

	for (const entry of history ?? []) {
		if (entry.role === 'user') {
			closeTurn();
			turnNumber += 1;
			const images = entry.images?.map((image) => ({ ...image, id: image.id ?? uid() }));
			items.push({
				kind: 'user',
				id: uid(),
				text: entry.text ?? '',
				images: images?.length ? images : undefined,
				at: entry.at,
			});
			continue;
		}
		if (entry.role !== 'assistant') continue;
		if (!turn) {
			turn = newTurn();
			turn.files = filesByTurn[String(Math.max(1, turnNumber))];
			items.push(turn);
		}
		turnSteps += 1;
		turnOutput += Number(entry.usage?.output ?? 0);
		turnInput += Number(entry.usage?.input ?? 0);
		turnCacheRead += Number(entry.usage?.cacheRead ?? 0);
		turnDurationMs += Number(entry.durationMs ?? 0);
		turnCompletedAt = Math.max(turnCompletedAt, Number(entry.completedAt ?? 0));
		if (entry.thinking?.trim()) {
			turnThinking += 1;
			appendThinking(turn, entry.thinking);
		}
		if (entry.text?.trim()) appendText(turn, entry.text);
		if (entry.error) turn.error = entry.error;
		if (entry.tools?.length) {
			turnTools += entry.tools.length;
			turn.parts.push({ kind: 'tools', id: uid(), tools: toolRows(entry.tools.map((tool) => ({ ...tool, id: uid(), status: 'ok' as const }))) });
		}
	}
	closeTurn();
	return items;
}

/** 当前已经渲染了多少轮用户消息；刷新时用它把已上翻的页也一起取回来 */
function loadedTurnCount(items: Item[]): number {
	return items.reduce((count, item) => count + (item.kind === 'user' ? 1 : 0), 0);
}

/** 分页的第一条历史对应全局第几轮；用于持久化统计条上的“第 N 轮”。 */
function firstTurnAt(overview: TurnOverviewItem[] | undefined, start: number): number {
	return overview?.find((turn) => turn.start >= start)?.index ?? 1;
}

/** 一轮里已经渲染出来的正文/思考（按出现顺序拼接） */
function turnText(turn: TurnItem, kind: 'text' | 'thinking'): string {
	const chunks: string[] = [];
	for (const part of turn.parts) {
		if (part.kind === 'text' && kind === 'text') chunks.push(part.text);
		else if (part.kind === 'thinking' && kind === 'thinking') chunks.push(part.text);
	}
	return chunks.join('\n\n');
}

/** 一轮里已经渲染出来的工具行（按出现顺序） */
function turnTools(turn: TurnItem): ToolRow[] {
	const rows: ToolRow[] = [];
	for (const part of turn.parts) {
		if (part.kind === 'tools') rows.push(...part.tools);
	}
	return rows;
}

/**
 * live 是整个当前轮次的累积快照，而 history 已经包含这条轮次里所有落盘的
 * assistant 步骤。刷新/切换会话时两者直接相加，会让思考过程、正文和同一批工具
 * 重复出现（最近全是成串的 bash 就是这么来的）。
 *
 * 这里把 live 中已被历史覆盖的前缀去掉，只留下真正还没落盘的后半段。
 * 比较时忽略空白：历史按 step 用空行拼接，live 的 delta 是连续累积的。
 */
function liveRemainder(live: string | undefined, seen: string): string {
	if (!live) return '';
	const target = seen.replace(/\s+/g, '');
	if (!target) return live;
	let index = 0;
	let matched = 0;
	while (index < live.length && matched < target.length) {
		const ch = live[index];
		if (!/\s/.test(ch)) {
			if (ch !== target[matched]) return live;
			matched += 1;
		}
		index += 1;
	}
	return matched === target.length ? live.slice(index) : live;
}

/** 把服务端的 busy/live 快照并进最后一轮；不新起 PI 标题 */
function mergeLive(items: Item[], live: LiveState, baseline?: TurnCounters) {
	let last = items[items.length - 1];
	// 最后一项还是 turn，说明这一轮已经有 step 落盘；否则 live 属于刚开的新轮。
	const continuing = Boolean(last && last.kind === 'turn');
	if (!last || last.kind !== 'turn') {
		last = newTurn();
		items.push(last);
	}
	const turn = last;
	turn.streaming = true;
	turn.baseline = baseline;
	turn.startedAt = live.startedAt;

	const thinking = liveRemainder(live.thinking, continuing ? turnText(turn, 'thinking') : '');
	if (thinking.trim()) appendThinking(turn, thinking);
	const text = liveRemainder(live.text ?? '', continuing ? turnText(turn, 'text') : '');
	if (text) appendText(turn, text);

	const liveTools = live.tools ?? [];
	let matched = 0;
	if (continuing && liveTools.length) {
		const rows = turnTools(turn);
		while (
			matched < rows.length &&
			matched < liveTools.length &&
			rows[matched].name === liveTools[matched].name
		) {
			matched += 1;
		}
		if (matched) {
			// 已落盘的同一批工具只同步状态（running/ok/error），不再追加第二遍
			let cursor = 0;
			turn.parts = turn.parts.map((part) => {
				if (part.kind !== 'tools') return part;
				return {
					...part,
					tools: part.tools.map((row) => {
						const liveRow = cursor < matched ? liveTools[cursor] : null;
						cursor += 1;
						return liveRow
							? {
									...row,
									status: liveRow.status,
									detail: liveRow.detail ?? row.detail,
									args: row.args ?? liveRow.args,
									result: liveRow.result ?? row.result,
									durationMs: liveRow.durationMs ?? row.durationMs,
									children: liveRow.children ?? row.children,
								}
							: row;
					}),
				};
			});
		}
	}
	const remaining = liveTools.slice(matched);
	if (remaining.length) turn.parts.push({ kind: 'tools', id: uid(), tools: toolRows(remaining) });

	const anyRunning = liveTools.some((tool) => tool.status === 'running');
	turn.activity = anyRunning ? 'tool' : !live.text ? 'thinking' : undefined;
	turn.thinking = Boolean(turn.activity);
	if (live.retry) {
		turn.retry = live.retry;
		turn.activity = 'thinking';
		turn.thinking = true;
	} else {
		turn.retry = undefined;
	}
}

/** 历史 + 正在生成的部分（stats.busy && stats.live 时） */
function conversationItems(stats: ChatStats, baseline?: TurnCounters): Item[] {
	const items = historyToItems(
		stats.history,
		firstTurnAt(stats.turnOverview, stats.historyMeta?.start ?? 0),
		stats.presentedByTurn,
	);
	if (!stats.busy || !stats.live) return items;
	try {
		mergeLive(items, stats.live, baseline);
	} catch (error) {
		// 某条快照合并失败时至少保留历史；无论如何都要让后续 connect() 建起来，
		// 不能因为一次重绘异常把整条 SSE 流卡死。
		console.error('[turn-pi] merge live failed', error);
	}
	return items;
}

function lastTurnIndex(items: Item[]): number {
	for (let i = items.length - 1; i >= 0; i--) {
		if (items[i].kind === 'turn') return i;
	}
	return -1;
}

/** 同一轮多次 report_files：按 path 合并，后到覆盖先到。 */
function mergeReportedFiles(current: ReportedFile[], incoming: ReportedFile[]): ReportedFile[] {
	const merged = new Map(current.map((file) => [file.path, file]));
	for (const file of incoming) merged.set(file.path, file);
	return [...merged.values()];
}

/** 最新一条 live turn 的下标；队列里的用户消息插进来后，下一条助手输出归到一个新 turn。 */
function ensureTurn(items: Item[], thinking: boolean): number {
	const last = items[items.length - 1];
	if (last?.kind === 'turn') return items.length - 1;
	const previousIndex = lastTurnIndex(items);
	const previous = previousIndex >= 0 ? (items[previousIndex] as TurnItem) : null;
	items.push(newTurn(true, thinking, previous?.baseline, previous?.startedAt));
	return items.length - 1;
}

function streamKey(sessionId: string | null, clientId: string): string {
	return sessionId ?? clientId;
}

function parseFrame(data: unknown): any {
	try {
		return JSON.parse(String(data ?? ''));
	} catch {
		return {};
	}
}

// ---------- 瞬时定时器（不放进 store，避免无谓渲染） ----------
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let toastSeq = 0;

/**
 * 一条浮动提示。
 *
 * `placement`：普通提示在底部（贴着 composer，不挡标题）；带撤销的操作放顶部——
 * 它要显眼、要停留 10s，还带按钮，待在底部会和输入框抢手感。
 */
export interface ToastState {
	id: number;
	text: string;
	placement: 'top' | 'bottom';
	/** 停留在屏幕上的毫秒数，也写进 DOM（data-timeout）方便调试/测试 */
	timeout: number;
	actionLabel?: string;
	action?: () => void;
}

export interface ToastOptions {
	placement?: ToastState['placement'];
	/** 默认：带按钮 10s，纯文字 2.6s */
	timeout?: number;
	actionLabel?: string;
	action?: () => void;
}

const TOAST_PLAIN_MS = 2600;
const TOAST_ACTION_MS = 10_000;
let tpsTimer: ReturnType<typeof setTimeout> | undefined;
let tpsChars = 0;
let tpsStart = 0;
/** 上一批工具全部结束，下一次模型输出就是新的一“步” */
let nextStepPending = false;
let pollTimer: ReturnType<typeof setInterval> | undefined;
let sessionSwitchSeq = 0;
/** 已响过铃的审批 requestId / sessionId，避免 SSE 重连或 6s 轮询重复响。 */
const approvalAlertedRequests = new Set<string>();
const approvalAlertedSessions = new Set<string>();

/**
 * 审批卡自己的超时计时器：服务端到点会自动 deny，前端也把卡片收成细条。
 * 不依赖当前是否停在对话页，切到别的模块时计时照常走。
 */
const credentialExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearCredentialExpiry(requestId: string) {
	const timer = credentialExpiryTimers.get(requestId);
	if (!timer) return;
	clearTimeout(timer);
	credentialExpiryTimers.delete(requestId);
}

function clearAllCredentialExpiry() {
	for (const timer of credentialExpiryTimers.values()) clearTimeout(timer);
	credentialExpiryTimers.clear();
}

function scheduleCredentialExpiry(request: CredentialRequest) {
	clearCredentialExpiry(request.requestId);
	const delay = Math.max(0, request.expiresAt - Date.now());
	const timer = setTimeout(() => {
		credentialExpiryTimers.delete(request.requestId);
		useStore.getState().expireCredential(request.requestId);
	}, delay);
	credentialExpiryTimers.set(request.requestId, timer);
}
/** 用户点了停止：这一次 settled 不再提醒（下一轮正常提醒） */
let suppressSettleNotify = false;

/** 底部状态栏的会话级统计，切会话/新对话时立即归零 */
const emptyQueue = (): QueueSnapshot => ({ steering: [], followUp: [] });

/** Git 面板按当前 workspace + 会话绑定的 worktree 取数；key 用于判断清单是否过期。 */
function gitPanelTarget(state: Pick<ChatStore, 'workspaceId' | 'worktreeId' | 'worktrees'>) {
	const root = state.workspaceId || 'workspace';
	const worktree = state.worktrees.find((item) => item.id === state.worktreeId && item.workspaceId === root)?.id;
	return { root, worktree, key: `${root}:${worktree ?? ''}` };
}

const emptyStats = () => ({
	turns: 0,
	steps: 0,
	toolCalls: 0,
	usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
	contextTokens: 0,
	contextWindow: 0,
	contextBreakdown: null as ContextBreakdown | null,
	contextEstimated: false,
	tps: null,
	avgTps: null,
	queue: emptyQueue(),
});

function resetTps() {
	tpsChars = 0;
	tpsStart = 0;
	clearTimeout(tpsTimer);
	tpsTimer = undefined;
}

// ---------- SSE ----------
let es: EventSource | null = null;
let subscribedKey: string | null = null;
let droppedWhileBusy = false;

export interface ChatStore {
	sessionId: string | null;
	sessionName: string | null;
	clientId: string;
	domain: string;
	agentId: string | null;
	workspaces: WorkspaceInfo[];
	/** 新对话默认进入的 workspace；打开历史会话时跟随会话 cwd */
	workspaceId: string;
	/** 历史会话的 cwd 不在注册表且目录不可用时的展示兜底 */
	workspaceFallback: { label: string; root: string } | null;
	worktrees: WorktreeInfo[];
	/** 服务端 `/api/files/roots` 的副本：工具行里的绝对路径（如 `/tmp/shot.png`）靠它落 root */
	fileRoots: FileRoot[];
	/** 当前会话绑定的隔离 worktree；普通会话为 null */
	worktreeId: string | null;
	worktreeBranch: string | null;
	worktreePath: string | null;
	/** 新对话是否在隔离 worktree 中创建；按 workspace 记忆 */
	worktreeEnabled: boolean;
	/** 新对话的 codemode 策略：auto（默认）/ 强制开（要求走脚本）/ 强制关（不给工具） */
	codemodeMode: CodemodeMode;
	/** 当前会话实际生效的策略（来自 stats）；建会话时定下，会话内只读 */
	sessionCodemode: CodemodeMode;
	/** Git 面板：当前工作区的仓库清单；中间区每个仓库展开为一个 tab */
	gitPanel: GitPanel | null;
	/** 清单对应的 `${workspaceId}:${worktreeId ?? ''}`，用来判断是否过期 */
	gitPanelKey: string | null;
	gitPanelStatus: 'idle' | 'loading' | 'ready' | 'error';
	gitPanelError: string | null;
	/** 可选 AgentTemplate（CARD）列表；选中的那个会跟着新会话建会话 */
	agents: AgentSummary[];
	agentTemplateId: string | null;

	busy: boolean;
	connection: 'idle' | 'on' | 'off';
	items: Item[];
	/** 已加载历史在整个会话 history 数组里的起点；上翻时作为 before 游标 */
	historyStart: number;
	historyHasMore: boolean;
	historyLoading: boolean;
	/** 首次切换会话、历史还没回来：对话区显示「正在加载历史消息」 */
	historyLoadingInitial: boolean;
	/** 快照已切过来，但完整的 Chat 还没打开；避免此时发消息重复建会话 */
	sessionOpening: boolean;
	/** 服务端给的轻量轮次索引：导航条 + 点击未加载轮次跳转 */
	turnOverview: TurnOverviewItem[];
	/** 已收藏轮次（1-based） */
	favoriteTurns: number[];
	draft: string;
	pinSeq: number;
	focusSeq: number;
	tps: number | null;
	/** 最后一个已完成轮次的平均 TPS；切会话/新对话时清空 */
	avgTps: number | null;
	/** 生成中的待发送队列（steering / followUp） */
	queue: QueueSnapshot;
	/** agent 正在等待审批的 scoped 凭据请求；栈式展示，支持多条 */
	credentialRequests: CredentialRequest[];
	/** 已超时的凭据审批：保留成卡片细条，提示这里曾经有过审核 */
	credentialTimeouts: CredentialTimeout[];

	models: ModelInfo[];
	sessions: SessionSummary[];
	/** agent 每次 web_search 的来源，右栏「检索」消费 */
	searchSources: SearchSourceGroup[];

	// 当前会话的 pi 状态
	model: string;
	modelName: string;
	thinking: string;
	thinkingLevels: string[];
	tools: string[];
	toolCatalog: ToolCatalogItem[];
	pinnedTools: string[];
	turns: number;
	steps: number;
	toolCalls: number;
	usage: Required<Pick<Usage, 'input' | 'cacheRead' | 'cacheWrite' | 'output'>>;
	contextTokens: number;
	contextWindow: number;
	contextBreakdown: ContextBreakdown | null;
	/** 上下文环当前是否是压缩后的暂估値（下一轮会自动校准） */
	contextEstimated: boolean;

	piVersion: string | null;
	compacting: boolean;

	// UI
	/** 当前模块视图；与 location.hash 同步，刷新/前进后退都落回同一处 */
	view: AppView;
	/** 视口宽度（由 App 的 resize 监听到 store，断点判断只在这里做） */
	layoutWidth: number;
	/** 模块内上下文列的宽度（null = 用默认值）；按模块分别记忆 */
	contextWidth: number | null;
	/** 上下文列是否折叠；按模块分别记忆 */
	contextCollapsed: boolean;
	/** 窄屏（<1180）下用户手动展开过：临时状态，不落盘，跨断点时重置 */
	contextNarrowOpen: boolean;
	/** 最左模块 rail 是否展开成宽条（图标 + 文字横排），落盘 */
	railExpanded: boolean;
	panelVisible: boolean;
	panelWidth: number | null;
	panelTabs: PanelTab[];
	activeTabId: string;
	/** 工具写文件后自增，文件树/当前预览据此刷新 */
	panelRefreshTick: number;
	drawer: 'rail' | 'panel' | null;
	theme: ThemeMode;
	/**
	 * 本轮计时的起点：busy 变 true 时写入，组件用 Date.now() 和它做差，
	 * 这样后台标签页被节流、页面被挂起都不会把计时算歪。
	 * 本轮结束（完成/中断）后只负责停止展示，时间戳留在原地即可，
	 * 下次发送会被覆盖。
	 */
	turnStartedAt: number | null;

	toast: ToastState | null;
	notify: NotifySettings;
	notifyPermission: NotifyPermission;
	/** 轮末文件卡片开关与最低重要度（localStorage） */
	fileCardsEnabled: boolean;
	fileCardsMinImportance: FileImportance;

	booted: boolean;

	// actions
	boot: () => Promise<void>;
	connect: () => void;
	send: (text: string, mode?: SendMode, images?: ImageAttachment[], references?: SessionReference[]) => Promise<boolean>;
	queueAction: (placement: QueuePlacement, index: number, text: string, kind: 'steer' | 'remove') => Promise<void>;
	decideCredential: (requestId: string, decision: 'once' | 'session' | 'deny') => Promise<void>;
	expireCredential: (requestId: string) => void;
	dismissCredentialTimeout: (requestId: string) => void;
	clearQueue: () => Promise<void>;
	abort: () => Promise<void>;
	newChat: () => void;
	newChatInWorkspace: (workspaceId: string) => void;
	openSession: (sessionId: string) => Promise<void>;
	renameSession: (name: string) => Promise<void>;
	archiveSession: (sessionId: string, archived: boolean) => Promise<void>;
	forkCurrent: () => Promise<void>;
	forkTurn: (turnIndex: number) => Promise<void>;
	toggleFavorite: (turnIndex: number) => Promise<void>;
	refreshCurrent: (historyTurns?: number) => Promise<ChatStats | null>;
	refreshConversation: () => Promise<void>;
	loadOlderHistory: () => Promise<boolean>;
	loadHistoryUntilTurn: (turnIndex: number) => Promise<boolean>;
	applyStats: (stats: ChatStats) => void;
	loadModels: () => Promise<void>;
	loadWorkspaces: () => Promise<void>;
	reloadWorkspaces: () => Promise<void>;
	loadWorktrees: () => Promise<void>;
	/** 文件 API 的 root 清单（workspace / worktree / 只读 tmp），绝对路径靠它落 root */
	loadFileRoots: () => Promise<void>;
	loadGitPanel: (options?: { refresh?: boolean }) => Promise<void>;
	addGitRepo: (path: string) => Promise<string | null>;
	removeGitRepo: (path: string) => Promise<boolean>;
	loadAgents: () => Promise<void>;
	setAgentTemplate: (id: string | null) => void;
	setWorktreeEnabled: (enabled: boolean) => void;
	setCodemodeMode: (mode: CodemodeMode) => void;
	removeWorktree: (id: string, force?: boolean) => Promise<boolean>;
	createWorkspace: (path: string, label?: string) => Promise<WorkspaceInfo | null>;
	loadSessions: () => Promise<void>;
	clearSearchSources: () => void;
	refreshEngine: () => Promise<void>;
	setDomain: (domain: string) => void;
	setWorkspace: (workspaceId: string) => void;
	setTheme: (theme: ThemeMode) => void;
	setFileCardsEnabled: (enabled: boolean) => void;
	setFileCardsMinImportance: (importance: FileImportance) => void;
	setModel: (key: string) => Promise<void>;
	setThinking: (level: string) => Promise<void>;
	toggleTool: (name: string) => Promise<void>;
	compact: (instructions?: string) => Promise<void>;
	setDraft: (text: string) => void;
	pickSample: (text: string) => void;
	requestPin: () => void;
	noteChars: (count: number) => void;
	showToast: (text: string, options?: ToastOptions) => void;
	dismissToast: () => void;
	toggleNotify: () => Promise<void>;
	setNotifySound: (sound: boolean) => void;
	previewNotifySound: () => void;
	setApprovalSound: (sound: boolean) => void;
	previewApprovalSound: () => void;
	setPanelVisible: (visible: boolean) => void;
	setView: (view: AppView) => void;
	syncViewFromHash: () => void;
	setLayoutWidth: (width: number) => void;
	setContextWidth: (width: number | null, persist?: boolean) => void;
	setContextCollapsed: (collapsed: boolean) => void;
	toggleRail: () => void;
	toggleContextColumn: () => void;
	setDrawer: (drawer: 'rail' | 'panel' | null) => void;
	closeDrawers: () => void;
	setPanelWidth: (width: number | null, persist?: boolean) => void;
	openPanel: () => void;
	collapsePanel: () => void;
	togglePanel: () => void;
	openGuide: () => void;
	openGuideEntry: (id: string) => void;
	openFile: (path: string, options?: { root?: string; line?: number }) => void;
	/** 按 pi-resource:// 地址打开右栏文件；跨会话时先走 /api/files/resolve */
	openAddress: (address: string) => Promise<void>;
	closePanelTab: (id: string) => void;
	activatePanelTab: (id: string) => void;
	bumpPanelRefresh: () => void;
}

const initialFileCards = loadFileCardSettings();

/** resolveOpenTarget 只看这几个字段，方便在组件里直接算（不把整个 store 传进来）。 */
type FileRootState = Pick<
	ChatStore,
	'worktreeId' | 'workspaceId' | 'worktreePath' | 'worktrees' | 'workspaces' | 'fileRoots'
>;

/** 所有已注册 root 的 (id, 绝对路径)：fileRoots 优先，再用会话里的 workspace / worktree 补齐。 */
function registeredRoots(state: FileRootState): { id: string; path: string }[] {
	const roots: { id: string; path: string }[] = [];
	for (const root of state.fileRoots) {
		if (root.available === false) continue;
		roots.push({ id: root.id, path: String(root.path ?? '').replace(/\/+$/, '') });
	}
	for (const worktree of state.worktrees) {
		if (worktree.available === false) continue;
		roots.push({ id: worktree.id, path: String(worktree.path ?? '').replace(/\/+$/, '') });
	}
	for (const workspace of state.workspaces) {
		if (workspace.available === false) continue;
		roots.push({ id: workspace.id, path: String(workspace.root ?? '').replace(/\/+$/, '') });
	}
	return roots;
}

/**
 * 把工具参数里的路径映射成右栏文件 tab 的目标：注册过的 root + root 内相对路径。
 *
 * 右栏只认注册过的 root（workspace / 隔离 worktree / 已登记仓库 / 只读的 `/tmp`），
 * `worktrees` 之外的绝对路径先按“最具体的 root”匹配；`/etc/passwd` 这种没人认领的
 * 绝对路径永远打不开：工具行如果给它画「打开」箭头，点下去只能弹一个错误 toast。
 * 所以这里把“能不能打开”和“为什么不能”一起算出来，UI 和 openFile 用同一套判断。
 */
export function resolveOpenTarget(
	state: FileRootState,
	path: string,
	root?: string,
): { root: string; relative: string } | { error: string } {
	const raw = String(path ?? '').replace(/\\/g, '/').trim();
	// 绝对路径：落到路径前缀最长的已注册 root（`/tmp/shot.png` → root=tmp）
	if (!root && raw.startsWith('/')) {
		const match = registeredRoots(state)
			.filter((item) => Boolean(item.path) && (raw === item.path || raw.startsWith(item.path + '/')))
			.sort((a, b) => b.path.length - a.path.length)[0];
		const relative = match ? pathForWorkspace(raw, match.path) : null;
		if (match && relative) return { root: match.id, relative };
	}

	const targetRoot = root || state.worktreeId || state.workspaceId || 'workspace';
	if (targetRoot === '__unregistered__') return { error: '当前会话的 cwd 未注册为工作区' };
	const worktree = state.worktrees.find((item) => item.id === targetRoot);
	const workspace = state.workspaces.find((item) => item.id === targetRoot);
	if ((worktree ?? workspace)?.available === false) {
		return { error: `工作区目录不存在：${worktree?.path ?? workspace?.root ?? targetRoot}` };
	}
	const rootPath =
		worktree?.path ??
		workspace?.root ??
		state.fileRoots.find((item) => item.id === targetRoot)?.path ??
		(targetRoot === state.worktreeId ? state.worktreePath : undefined) ??
		(targetRoot === 'workspace' ? '/workspace' : targetRoot);
	const relative = pathForWorkspace(raw, rootPath);
	if (relative == null) return { error: '文件不在当前工作区' };
	if (relative === '') return { error: '文件不在工作区' };
	return { root: targetRoot, relative };
}

/** 这个路径当前会话能不能在右栏打开（工具行的「↗」靠它决定画不画）。 */
export function canOpenFile(state: FileRootState, path: string): boolean {
	return !('error' in resolveOpenTarget(state, path));
}

export const useStore = create<ChatStore>((set, get) => ({
	sessionId: storage.get(SESSION_KEY),
	sessionName: null,
	clientId: initialClientId(),
	domain: storage.get(DOMAIN_KEY) ?? 'general',
	agentId: null,
	workspaces: [],
	workspaceId: storage.get(WORKSPACE_KEY) ?? 'workspace',
	workspaceFallback: null,
	worktrees: [],
	fileRoots: [],
	worktreeId: null,
	worktreeBranch: null,
	worktreePath: null,
	worktreeEnabled: false,
	gitPanel: null,
	gitPanelKey: null,
	gitPanelStatus: 'idle',
	gitPanelError: null,
	codemodeMode: 'auto',
	sessionCodemode: 'auto',
	agents: [],
	agentTemplateId: storage.get(AGENT_KEY) ?? null,

	busy: false,
	connection: 'idle',
	items: [],
	historyStart: 0,
	historyHasMore: false,
	historyLoading: false,
	historyLoadingInitial: false,
	sessionOpening: false,
	turnOverview: [],
	favoriteTurns: [],
	draft: '',
	pinSeq: 0,
	focusSeq: 0,
	tps: null,
	avgTps: null,
	queue: emptyQueue(),
	credentialRequests: [],
	credentialTimeouts: [],

	models: [],
	sessions: [],
	searchSources: [],

	model: '',
	modelName: '',
	thinking: '',
	thinkingLevels: [],
	tools: [],
	toolCatalog: [],
	pinnedTools: [],
	turns: 0,
	steps: 0,
	toolCalls: 0,
	usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
	contextTokens: 0,
	contextWindow: 0,
	contextBreakdown: null,
	contextEstimated: false,

	piVersion: null,
	compacting: false,

	view: initialView,
	...contextStateFor(initialView),
	layoutWidth: initialLayoutWidth,
	contextNarrowOpen: false,
	railExpanded: loadRailExpanded(),
	panelVisible: initialPanel.visible,
	panelWidth: initialPanel.width,
	panelTabs: initialPanel.tabs,
	activeTabId: initialPanel.activeTabId,
	panelRefreshTick: 0,
	drawer: null,
	theme: loadThemeMode(),
	turnStartedAt: null,
	toast: null,
	notify: loadNotifySettings(),
	notifyPermission: currentNotifyPermission(),
	fileCardsEnabled: initialFileCards.enabled,
	fileCardsMinImportance: initialFileCards.minImportance,

	booted: false,

	// ---------- 会话 ----------
	boot: async () => {
		if (get().booted) return;
		set({ booted: true });

		// 侧栏先渲染：即使对话渲染出问题，历史会话列表也不会是空的
		await Promise.all([
			get().loadWorkspaces(),
			get().loadSessions(),
			get().loadWorktrees(),
			get().loadFileRoots(),
			get().loadAgents(),
		]);
		await Promise.all([get().loadModels(), get().refreshEngine()]);

		if (get().sessionId) {
			let stats: ChatStats | null = null;
			try {
				stats = await get().refreshCurrent();
				if (!stats) {
					stats = await api<ChatStats>('/api/session/open', {
						clientId: get().clientId,
						sessionId: get().sessionId,
						domain: get().domain,
					});
				}
			} catch {
				stats = null;
			}
			if (stats) {
				get().applyStats(stats);
				const items = conversationItems(stats, countersFrom(get()));
				set({
					busy: Boolean(stats.busy),
					items,
					avgTps: lastTurnAverage(items),
					historyStart: stats.historyMeta?.start ?? 0,
					historyHasMore: Boolean(stats.historyMeta?.hasMore),
					historyLoading: false,
					historyLoadingInitial: false,
					pinSeq: get().pinSeq + 1,
				});
			} else {
				clearAllCredentialExpiry();
				set({ sessionId: null, items: [], avgTps: null, historyStart: 0, historyHasMore: false, historyLoading: false, historyLoadingInitial: false, sessionOpening: false, turnOverview: [], favoriteTurns: [], credentialRequests: [], credentialTimeouts: [] });
			}
		}

		get().connect();
		pollTimer ??= setInterval(() => {
			get().loadSessions().catch(() => {});
		}, 6000);
	},

	openSession: async (sessionId) => {
		clearDoneTitle();
		// 打开会话一定意味着"回到对话视图"（将来从技能/MCP 模块里点历史会话时靠这行切回）
		get().setView('chat');
		const previous = {
			sessionId: get().sessionId,
			sessionName: get().sessionName,
			agentId: get().agentId,
			turns: get().turns,
			steps: get().steps,
			toolCalls: get().toolCalls,
			usage: { ...get().usage },
			contextTokens: get().contextTokens,
			contextWindow: get().contextWindow,
			contextBreakdown: get().contextBreakdown,
			compacting: get().compacting,
			avgTps: get().avgTps,
			historyStart: get().historyStart,
			historyHasMore: get().historyHasMore,
		};
		const seq = ++sessionSwitchSeq;
		// 立刻断开旧会话的流并清空统计，避免切换过程中还显示上一段会话的数字
		es?.close();
		es = null;
		subscribedKey = null;
		resetTps();
		nextStepPending = false;
		const summary = get().sessions.find((session) => session.id === sessionId);
		clearAllCredentialExpiry();
		set({
			...emptyStats(),
			sessionId,
			sessionName: summary?.name ?? null,
			agentId: null,
			workspaceId: summary?.workspaceId ?? get().workspaceId,
			workspaceFallback: null,
			worktreeId: summary?.worktreeId ?? null,
			worktreeBranch: summary?.worktreeBranch ?? null,
			worktreePath: summary?.worktreePath ?? null,
			sessionCodemode: 'auto',
			busy: Boolean(summary?.busy),
			compacting: false,
			items: [],
			historyStart: 0,
			historyHasMore: false,
			historyLoading: false,
			historyLoadingInitial: true,
			sessionOpening: true,
			turnOverview: [],
			favoriteTurns: [],
			credentialRequests: [],
			credentialTimeouts: [],
			drawer: null,
		});
		storage.set(SESSION_KEY, sessionId);
		get().connect();

		// 第一步：只拿 session 快照（增量索引），先让标题/轮次/token/上下文/工作树切换过来。
		let snapshot: ChatStats | null = null;
		try {
			snapshot = await api<ChatStats>(`/api/session/snapshot?sessionId=${encodeURIComponent(sessionId)}`);
		} catch {
			snapshot = null;
		}
		if (seq !== sessionSwitchSeq) return;
		if (snapshot) {
			get().applyStats(snapshot);
			set({ avgTps: snapshot.lastTps ?? null, busy: Boolean(snapshot.busy ?? summary?.busy) });
		} else {
			// 快照不可用时退回旧路径：一次把 stats + 历史都拿回来。
			try {
				const stats = await api<ChatStats>('/api/session/open', {
					clientId: get().clientId,
					sessionId,
					domain: get().domain,
				});
				if (seq !== sessionSwitchSeq) return;
				get().applyStats(stats);
				const items = conversationItems(stats, countersFrom(get()));
				set({
					items,
					busy: Boolean(stats.busy),
					avgTps: lastTurnAverage(items),
					historyStart: stats.historyMeta?.start ?? 0,
					historyHasMore: Boolean(stats.historyMeta?.hasMore),
					historyLoading: false,
					historyLoadingInitial: false,
					sessionOpening: false,
					pinSeq: get().pinSeq + 1,
				});
			} catch (error) {
				if (seq !== sessionSwitchSeq) return;
				set({ ...previous, historyLoadingInitial: false, sessionOpening: false });
				get().connect();
				get().showToast(`打开失败：${(error as Error).message}`);
			}
			await get().loadSessions();
			return;
		}

		// 第二步：完整 Chat 和历史并行加载。历史一到就渲染，不必等 SessionManager 全量打开。
		const openPromise = api<ChatStats>('/api/session/open', {
			clientId: get().clientId,
			sessionId,
			domain: get().domain,
			history: false,
		})
			.then((stats) => {
				if (seq !== sessionSwitchSeq) return;
				get().applyStats(stats);
				set({ busy: Boolean(stats.busy), sessionOpening: false });
				// 正在生成的会话需要把 live 内容合并回来；已结束的会话不需要再拉一次。
				if (stats.busy) void get().refreshConversation();
			})
			.catch((error) => {
				if (seq !== sessionSwitchSeq) return;
				set({ sessionOpening: false });
				get().showToast(`会话就绪失败：${(error as Error).message}`);
			});
		const historyPromise = api<{
			history?: HistoryItem[];
			historyMeta?: ChatStats['historyMeta'];
			turnOverview?: TurnOverviewItem[];
			presentedByTurn?: ChatStats['presentedByTurn'];
		}>(`/api/session/history?sessionId=${encodeURIComponent(sessionId)}&turns=${HISTORY_PAGE_TURNS}`)
			.then((page) => {
				if (seq !== sessionSwitchSeq) return;
				const items = historyToItems(
					page.history,
					firstTurnAt(page.turnOverview, page.historyMeta?.start ?? 0),
					page.presentedByTurn,
				);
				const avg = lastTurnAverage(items);
				set({
					items,
					avgTps: avg ?? get().avgTps,
					historyStart: page.historyMeta?.start ?? 0,
					historyHasMore: Boolean(page.historyMeta?.hasMore),
					turnOverview: page.turnOverview ?? get().turnOverview,
					historyLoading: false,
					historyLoadingInitial: false,
					pinSeq: get().pinSeq + 1,
				});
			})
			.catch((error) => {
				if (seq !== sessionSwitchSeq) return;
				set({ historyLoading: false, historyLoadingInitial: false });
				get().showToast(`加载历史失败：${(error as Error).message}`);
			});
		await Promise.allSettled([openPromise, historyPromise]);
		if (seq !== sessionSwitchSeq) return;
		await get().loadSessions();
	},

	archiveSession: async (sessionId, archived) => {
		try {
			await api('/api/session/archive', { sessionId, archived });
			// 归档的正是当前在看的会话：直接回到「新对话」页，别让人继续对着已归档的会话说话。
			// newChat() 内部会 loadSessions，所以这里不再重复拉一次。
			const undoArchive = archived
				? {
						placement: 'top' as const,
						timeout: TOAST_ACTION_MS,
						actionLabel: '撤销',
						action: () => void get().archiveSession(sessionId, false),
					}
				: undefined;
			if (archived && get().sessionId === sessionId) {
				get().newChat();
				get().showToast('已归档，可在「历史会话 › 已归档」里恢复', undoArchive);
				return;
			}
			await get().loadSessions();
			get().showToast(
				archived ? '已归档，可在「历史会话 › 已归档」里恢复' : '已恢复会话',
				undoArchive,
			);
		} catch (error) {
			get().showToast(`${archived ? '归档' : '恢复'}失败：${(error as Error).message}`);
		}
	},

	renameSession: async (name) => {
		const sessionId = get().sessionId;
		if (!sessionId) return;
		try {
			const data = await api<{ name: string | null }>('/api/session/rename', { sessionId, name: name.trim() });
			set({ sessionName: data.name ?? null });
			await get().loadSessions();
		} catch (error) {
			get().showToast(`改名失败：${(error as Error).message}`);
		}
	},

	forkCurrent: async () => {
		const sessionId = get().sessionId;
		if (!sessionId) {
			get().showToast('先开始一个会话再 fork');
			return;
		}
		if (get().busy) {
			get().showToast('等这一轮结束再 fork');
			return;
		}
		try {
			const data = await api<{ sessionId: string }>('/api/session/fork', { sessionId });
			get().showToast('已 fork 到新会话');
			await get().openSession(data.sessionId);
		} catch (error) {
			get().showToast(`fork 失败：${(error as Error).message}`);
		}
	},

	forkTurn: async (turnIndex) => {
		const sessionId = get().sessionId;
		if (!sessionId) {
			get().showToast('先开始一个会话再 fork');
			return;
		}
		if (get().busy) {
			get().showToast('等这一轮结束再 fork');
			return;
		}
		try {
			const data = await api<{ sessionId: string }>('/api/session/fork', { sessionId, turn: turnIndex });
			get().showToast(`已从第 ${turnIndex} 轮 fork 到新会话`);
			await get().openSession(data.sessionId);
		} catch (error) {
			get().showToast(`fork 失败：${(error as Error).message}`);
		}
	},

	toggleFavorite: async (turnIndex) => {
		const { sessionId, favoriteTurns } = get();
		if (!sessionId) {
			get().showToast('先打开一个会话再收藏');
			return;
		}
		const favorite = !favoriteTurns.includes(turnIndex);
		const previous = favoriteTurns;
		set({
			favoriteTurns: favorite
				? [...previous, turnIndex].sort((a, b) => a - b)
				: previous.filter((turn) => turn !== turnIndex),
		});
		try {
			const data = await api<{ turns?: number[] }>('/api/session/favorite', {
				sessionId,
				turn: turnIndex,
				favorite,
			});
			if (Array.isArray(data.turns)) set({ favoriteTurns: data.turns });
		} catch (error) {
			set({ favoriteTurns: previous });
			get().showToast(`收藏失败：${(error as Error).message}`);
		}
	},

	refreshCurrent: async (historyTurns) => {
		const { sessionId } = get();
		if (!sessionId) return null;
		const params = new URLSearchParams({ sessionId });
		if (historyTurns && historyTurns > 0) params.set('historyTurns', String(Math.floor(historyTurns)));
		try {
			return await api<ChatStats>(`/api/session?${params.toString()}`);
		} catch {
			return null;
		}
	},

	refreshConversation: async () => {
		// 重连 / settled 后重绘时，保留用户已经向上翻出来的页数
		const turns = Math.max(HISTORY_PAGE_TURNS, loadedTurnCount(get().items));
		const stats = await get().refreshCurrent(turns);
		if (!stats) return;
		get().applyStats(stats);
		const items = conversationItems(stats, countersFrom(get()));
		set({
			items,
			searchSources: [],
			busy: Boolean(stats.busy),
			avgTps: lastTurnAverage(items),
			historyStart: stats.historyMeta?.start ?? 0,
			historyHasMore: Boolean(stats.historyMeta?.hasMore),
			historyLoading: false,
			historyLoadingInitial: false,
			pinSeq: get().pinSeq + 1,
		});
	},

	loadOlderHistory: async () => {
		const { sessionId, historyStart, historyHasMore, historyLoading } = get();
		if (!sessionId || !historyHasMore || historyLoading) return false;
		set({ historyLoading: true });
		try {
			const params = new URLSearchParams({
				sessionId,
				before: String(historyStart),
				turns: String(HISTORY_PAGE_TURNS),
			});
			const page = await api<{
				history?: HistoryItem[];
				historyMeta?: ChatStats['historyMeta'];
				presentedByTurn?: ChatStats['presentedByTurn'];
			}>(`/api/session/history?${params.toString()}`);
			if (get().sessionId !== sessionId) return false;
			const older = historyToItems(
				page.history,
				firstTurnAt(get().turnOverview, page.historyMeta?.start ?? 0),
				page.presentedByTurn,
			);
			set((state) => ({
				items: older.length ? [...older, ...state.items] : state.items,
				historyStart: page.historyMeta?.start ?? 0,
				historyHasMore: Boolean(page.historyMeta?.hasMore),
				historyLoading: false,
			}));
			return older.length > 0;
		} catch (error) {
			if (get().sessionId === sessionId) set({ historyLoading: false });
			get().showToast(`加载更早对话失败：${(error as Error).message}`);
			return false;
		}
	},

	loadHistoryUntilTurn: async (turnIndex) => {
		const snapshot = get();
		const { sessionId, turnOverview, historyStart, historyLoading } = snapshot;
		const target = turnOverview.find((turn) => turn.index === turnIndex);
		if (!sessionId || !target) return false;
		// 已经加载过：不用再请求，直接让调用方滚动
		if (target.start >= historyStart) return true;
		if (historyLoading) return false;

		set({ historyLoading: true });
		let cursor = historyStart;
		let hasMore = snapshot.historyHasMore;
		let olderPages: Item[] = [];
		try {
			// 点击远处的未加载轮次时，一次把从目标轮到当前已加载起点之间的缺口补齐，
			// 保持历史始终连续；超过服务端 200 轮上限时才分多次。
			for (let guard = 0; guard < 20; guard += 1) {
				const earliestLoaded = turnOverview.find((turn) => turn.start >= cursor);
				if (!earliestLoaded) break;
				const need = earliestLoaded.index - target.index;
				if (need <= 0) break;
				const turns = Math.min(200, Math.max(HISTORY_PAGE_TURNS, need));
				const params = new URLSearchParams({
					sessionId,
					before: String(cursor),
					turns: String(turns),
				});
				const page = await api<{
					history?: HistoryItem[];
					historyMeta?: ChatStats['historyMeta'];
					presentedByTurn?: ChatStats['presentedByTurn'];
				}>(`/api/session/history?${params.toString()}`);
				if (get().sessionId !== sessionId) return false;
				const older = historyToItems(
					page.history,
					firstTurnAt(turnOverview, page.historyMeta?.start ?? 0),
					page.presentedByTurn,
				);
				olderPages = [...older, ...olderPages];
				const nextCursor = page.historyMeta?.start ?? 0;
				hasMore = Boolean(page.historyMeta?.hasMore);
				const progressed = nextCursor < cursor;
				cursor = nextCursor;
				if (target.start >= cursor) break;
				if (!hasMore || !progressed) break;
			}
			set((state) => ({
				items: olderPages.length ? [...olderPages, ...state.items] : state.items,
				historyStart: cursor,
				historyHasMore: hasMore,
				historyLoading: false,
			}));
			return target.start >= cursor;
		} catch (error) {
			if (get().sessionId === sessionId) set({ historyLoading: false });
			get().showToast(`加载目标轮次失败：${(error as Error).message}`);
			return false;
		}
	},

	applyStats: (stats) => {
		if (!stats?.model && !stats?.sessionId) return;
		const usage = stats.usage ?? {};
		const busy = get().busy;
		const serverSteps = Number(stats.steps ?? 0);
		const previous = get();
		if (stats.workspaceId && stats.workspaceId !== '__unregistered__' && stats.workspaceId !== previous.workspaceId) {
			storage.set(WORKSPACE_KEY, stats.workspaceId);
		}
		const workspaceFallback =
			stats.workspaceId === '__unregistered__'
				? {
						label: stats.workspaceLabel ?? stats.cwd ?? '未注册工作区',
						root: stats.workspaceRoot ?? stats.cwd ?? '',
					}
				: null;
		if (stats.worktreeId && !previous.worktrees.some((worktree) => worktree.id === stats.worktreeId)) {
			void get().loadWorktrees();
		}
		// 压缩后 SDK 在下一轮 assistant 前可能返回 tokens: null/0；不能把它当成真实的 0 覆盖掉估算值。
		const rawContextTokens = Number(stats.context?.tokens);
		const hasContextTokens = Number.isFinite(rawContextTokens) && rawContextTokens > 0;
		const contextTokens = hasContextTokens ? rawContextTokens : previous.contextTokens;
		set({
			sessionId: stats.sessionId ?? previous.sessionId,
			sessionName: stats.sessionName ?? null,
			agentId: stats.agentId ?? previous.agentId,
			model: stats.model ?? '',
			modelName: stats.modelName ?? '',
			thinking: stats.thinkingLevel ?? '',
			thinkingLevels: stats.thinkingLevels?.length ? stats.thinkingLevels : ['off'],
			tools: stats.tools ?? [],
			// 服务端会话的策略：只读展示（会话内不允许改，否则掉缓存）
			...(stats.codemode ? { sessionCodemode: stats.codemode } : {}),
			toolCatalog: stats.toolCatalog ?? [],
			pinnedTools: stats.pinnedTools ?? [],
			turns: stats.turns ?? 0,
			// 生成中本地会乐观地按“新一步开始”先加 1；服务端完成后取较大值，settle 后再以服务端为准
			steps: busy ? Math.max(previous.steps, serverSteps) : serverSteps,
			toolCalls: stats.toolCalls ?? 0,
			usage: {
				input: Number(usage.input ?? 0),
				cacheRead: Number(usage.cacheRead ?? 0),
				cacheWrite: Number(usage.cacheWrite ?? 0),
				output: Number(usage.output ?? 0),
			},
			contextTokens,
			contextWindow: Number(stats.context?.contextWindow || stats.contextWindow || 0),
			contextBreakdown: stats.context?.breakdown ?? previous.contextBreakdown,
			...(stats.workspaceId ? { workspaceId: stats.workspaceId } : {}),
			workspaceFallback,
			worktreeId: stats.worktreeId ?? null,
			worktreeBranch: stats.worktreeBranch ?? null,
			worktreePath: stats.worktreePath ?? null,
			contextEstimated: hasContextTokens
				? Boolean(stats.context?.estimated)
				: stats.context?.estimated === true || previous.contextEstimated,
			queue: stats.queue ?? previous.queue,
			...(Array.isArray(stats.turnOverview) ? { turnOverview: stats.turnOverview } : {}),
			...(Array.isArray(stats.favorites) ? { favoriteTurns: stats.favorites } : {}),
		});
	},

	send: async (text, requestedMode, images, references) => {
		const state = get();
		if (state.compacting) return false;
		if (state.sessionId && state.sessions.some((session) => session.id === state.sessionId && session.archived)) {
			get().showToast('会话已归档，恢复后才能继续发送');
			return false;
		}
		if (state.sessionOpening) {
			get().showToast('会话还在加载，稍等一下就绪');
			return false;
		}
		const outboundImages = (images ?? []).map((image) => ({
			type: 'image' as const,
			mimeType: image.mimeType,
			data: image.data,
		}));
		// 发送来自用户手势：顺手解锁提示音，并清掉上一轮的未读标记
		primeAudio();
		clearDoneTitle();
		const mode: SendMode = requestedMode ?? (state.busy ? 'steer' : 'prompt');
		const parsedReferences = references ?? parseSessionReferences(text);
		if (mode !== 'prompt' && parsedReferences.length) {
			get().showToast('会话引用只支持普通发送，等本轮结束后再发');
			return false;
		}
		const outboundReferences = mode === 'prompt' ? parsedReferences : [];

		// 生成中：不打断本轮。steer 插到下一个 step，followUp 等本轮结束。
		if (state.busy && mode !== 'prompt') {
			set({ draft: '' });
			try {
				const data = await api<SendResponse & Partial<ChatStats>>('/api/chat', {
					sessionId: state.sessionId,
					clientId: state.clientId,
					text,
					images: outboundImages,
					domain: state.domain,
					workspaceId: state.workspaceId,
					mode,
				});
				if (data.queue) set({ queue: data.queue });
				if (data.model) get().applyStats(data as ChatStats);
				get().showToast(mode === 'steer' ? '已插话，将在当前步骤结束后送入' : '已排队，本轮结束后发送');
				return true;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				set({ draft: text });
				get().showToast(`发送失败：${message}`);
				return false;
			}
		}

		if (state.busy) return false;
		const baseline = countersFrom(state);
		nextStepPending = false;
		set({
			items: [
				...state.items,
				{ kind: 'user', id: uid(), text, images, at: Date.now() },
				// 每轮一个 turn：PI 标题只在最前面出现一次，文本/工具按发生顺序放进 parts
				newTurn(true, true, baseline, Date.now()),
			],
			busy: true,
			// 新的这一轮从第 1 步开始，先乐观 +1，后续每跨过一个工具批次再加
			steps: state.steps + 1,
			draft: '',
			pinSeq: state.pinSeq + 1,
		});

		try {
			const data = await api<SendResponse>('/api/chat', {
				sessionId: state.sessionId,
				clientId: state.clientId,
				text,
				images: outboundImages,
				domain: state.domain,
				workspaceId: state.workspaceId,
				// 选了 Agent 模板就把它带进建会话；续聊不传（工具集跟着会话走）
				agentId: state.sessionId ? undefined : state.agentTemplateId ?? undefined,
				// 新会话还没建 Chat：把用户在首条消息前选的模型一起带过去
				model: state.sessionId ? undefined : state.model || undefined,
				worktree: !state.sessionId && state.worktreeEnabled ? { enabled: true } : undefined,
				// codemode 策略只在建会话时生效；续聊沿用已有会话的工具集
				codemode: !state.sessionId ? state.codemodeMode : undefined,
				references: outboundReferences.length ? outboundReferences : undefined,
				mode: 'prompt',
			});
			if (data.sessionId && data.sessionId !== state.sessionId) {
				set({ sessionId: data.sessionId, agentId: data.agentId });
				storage.set(SESSION_KEY, data.sessionId);
				get().connect();
			} else {
				set({ agentId: data.agentId });
			}
			const stats = await get().refreshCurrent();
			if (stats) get().applyStats(stats);
			get().loadSessions();
			get().loadWorktrees();
			return true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			set((s) => {
				const items = [...s.items];
				const index = lastTurnIndex(items);
				if (index >= 0) {
					const turn = items[index] as TurnItem;
					items[index] = { ...turn, error: `发送失败：${message}`, streaming: false, thinking: false, activity: undefined, retry: undefined };
				}
				return { items, busy: false, steps: baseline.steps, avgTps: lastTurnAverage(items) };
			});
			return false;
		}
	},

	queueAction: async (placement, index, text, kind) => {
		const sessionId = get().sessionId;
		const sid = streamKey(sessionId, get().clientId);
		try {
			const data = await api<{ queue: QueueSnapshot }>('/api/queue/update', {
				sessionId: sessionId ?? sid,
				sid,
				placement,
				index,
				text,
				kind,
			});
			set({ queue: data.queue });
			get().showToast(kind === 'steer' ? '已插话，将在当前步骤结束后送入' : '已从队列移除');
		} catch (error) {
			get().showToast(`队列操作失败：${(error as Error).message}`);
		}
	},

	decideCredential: async (requestId, decision) => {
		const request = get().credentialRequests.find((item) => item.requestId === requestId);
		if (!request) return;
		try {
			await api('/api/credentials/decision', { requestId, decision });
			clearCredentialExpiry(requestId);
			// 极端竞态：接口返回前本地计时器已经把卡片收成超时记录；既然审批成功就抹掉它。
			set((state) => ({
				credentialTimeouts: state.credentialTimeouts.filter((item) => item.requestId !== requestId),
			}));
			get().showToast(
				decision === 'deny'
					? '已拒绝凭据请求'
					: decision === 'session'
						? '已允许本会话使用该凭据（直到会话结束）'
						: '已允许本次凭据使用',
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			// 服务端已经到点删除：不是操作失败，改按「已超时」保留细条。
			if (/超时|不存在/.test(message)) get().expireCredential(requestId);
			else get().showToast(`审批失败：${message}`);
		} finally {
			set((state) => ({
				credentialRequests: state.credentialRequests.filter((item) => item.requestId !== requestId),
			}));
		}
	},

	expireCredential: (requestId) => {
		clearCredentialExpiry(requestId);
		const request = get().credentialRequests.find((item) => item.requestId === requestId);
		if (!request) return;
		set((state) => ({
			credentialRequests: state.credentialRequests.filter((item) => item.requestId !== requestId),
			credentialTimeouts: [
				{ ...request, timedOutAt: Date.now() },
				...state.credentialTimeouts.filter((item) => item.requestId !== requestId),
			].slice(0, 5),
		}));
		get().showToast('凭据审批已超时，已自动拒绝');
	},

	dismissCredentialTimeout: (requestId) => {
		set((state) => ({
			credentialTimeouts: state.credentialTimeouts.filter((item) => item.requestId !== requestId),
		}));
	},

	clearQueue: async () => {
		const sessionId = get().sessionId;
		const sid = streamKey(sessionId, get().clientId);
		try {
			const data = await api<QueueSnapshot & { ok: boolean }>('/api/queue/clear', {
				sessionId: sessionId ?? sid,
				sid,
			});
			const restored = [...data.steering, ...data.followUp].join('\n\n');
			set({
				queue: emptyQueue(),
				draft: [get().draft.trim(), restored].filter(Boolean).join('\n\n'),
				focusSeq: get().focusSeq + 1,
			});
			get().showToast('已收回待发送消息');
		} catch (error) {
			get().showToast(`收回失败：${(error as Error).message}`);
		}
	},

	abort: async () => {
		suppressSettleNotify = true;
		await api('/api/abort', {
			sessionId: get().sessionId,
			sid: streamKey(get().sessionId, get().clientId),
		}).catch(() => {});
		nextStepPending = false;
		set((state) => {
			const items = state.items.map((item) =>
				item.kind === 'turn' ? { ...item, streaming: false, thinking: false, activity: undefined, retry: undefined } : item,
			);
			return { busy: false, items, avgTps: lastTurnAverage(items) };
		});
	},

	newChat: () => {
		sessionSwitchSeq += 1;
		get().setView('chat');
		clearDoneTitle();
		es?.close();
		es = null;
		subscribedKey = null;
		resetTps();
		nextStepPending = false;
		const clientId = newId();
		sessionStore.set(CLIENT_KEY, clientId);
		storage.remove(SESSION_KEY);
		const workspaceId = get().workspaceId;
		clearAllCredentialExpiry();
		set({
			sessionId: null,
			sessionName: null,
			clientId,
			agentId: null,
			items: [],
			workspaceFallback: null,
			worktreeId: null,
			worktreeBranch: null,
			worktreePath: null,
			worktreeEnabled: worktreePreferred(workspaceId, get().workspaces),
			// 新对话回到默认策略：每次都从「自动」开始，不隐式继承上一次的强制选择
			codemodeMode: 'auto',
			sessionCodemode: 'auto',
			historyStart: 0,
			historyHasMore: false,
			historyLoading: false,
			historyLoadingInitial: false,
			sessionOpening: false,
			turnOverview: [],
			favoriteTurns: [],
			credentialRequests: [],
			credentialTimeouts: [],
			draft: '',
			busy: false,
			tools: [],
			toolCatalog: [],
			pinnedTools: [],
			searchSources: [],
			drawer: null,
			focusSeq: get().focusSeq + 1,
			...emptyStats(),
			compacting: false,
		});
		get().connect();
		get().loadSessions();
	},

	newChatInWorkspace: (workspaceId) => {
		const target = get().workspaces.find((workspace) => workspace.id === workspaceId);
		if (!target) return;
		if (target.available === false) {
			get().showToast(`工作区目录不存在：${target.root}`);
			return;
		}
		set({ workspaceId: target.id, workspaceFallback: null });
		storage.set(WORKSPACE_KEY, target.id);
		get().newChat();
	},

	// ---------- 侧栏数据 ----------
	loadModels: async () => {
		const models = await api<ModelInfo[]>('/api/models').catch(() => []);
		set({ models });
	},

	loadWorkspaces: async () => {
		let workspaces: WorkspaceInfo[];
		try {
			const data = await api<{ workspaces: WorkspaceInfo[] }>('/api/workspaces');
			workspaces = Array.isArray(data?.workspaces) ? data.workspaces : [];
		} catch {
			return;
		}
		const current = get().workspaceId;
		const selectable = workspaces.filter((workspace) => workspace.available !== false);
		const exists = selectable.some((workspace) => workspace.id === current);
		const fallback =
			selectable.find((workspace) => workspace.id === 'workspace')?.id ?? selectable[0]?.id ?? 'workspace';
		const next = exists ? current : fallback;
		set({ workspaces, workspaceId: next, worktreeEnabled: worktreePreferred(next, workspaces) });
		if (next !== current) storage.set(WORKSPACE_KEY, next);
	},

	reloadWorkspaces: async () => {
		try {
			// 服务端只接受 POST；不带 payload 时 api() 默认 GET，会落到 404 的 "not found"。
			const data = await api<{ workspaces: WorkspaceInfo[] }>('/api/workspaces/reload', undefined, {
				method: 'POST',
			});
			const workspaces = Array.isArray(data?.workspaces) ? data.workspaces : [];
			const current = get().workspaceId;
			const selectable = workspaces.filter((workspace) => workspace.available !== false);
			const exists = selectable.some((workspace) => workspace.id === current);
			const fallback =
				selectable.find((workspace) => workspace.id === 'workspace')?.id ?? selectable[0]?.id ?? 'workspace';
			const next = exists ? current : fallback;
			set({ workspaces, workspaceId: next, worktreeEnabled: worktreePreferred(next, workspaces) });
			if (next !== current) storage.set(WORKSPACE_KEY, next);
			get().showToast(`已刷新工作区：${workspaces.length} 个`);
		} catch (error) {
			get().showToast(`刷新工作区失败：${(error as Error).message}`);
		}
	},

	createWorkspace: async (path, label) => {
		try {
			const data = await api<{ workspace: WorkspaceInfo }>('/api/workspaces', { path, label });
			const workspace = data.workspace;
			if (!workspace?.id) throw new Error('服务端没有返回工作区');
			const workspaces = [...get().workspaces];
			const index = workspaces.findIndex((item) => item.id === workspace.id);
			if (index >= 0) workspaces[index] = workspace;
			else workspaces.push(workspace);
			set({ workspaces, workspaceId: workspace.id, workspaceFallback: null });
			storage.set(WORKSPACE_KEY, workspace.id);
			get().showToast(`已添加工作区：${workspace.label}`);
			return workspace;
		} catch (error) {
			get().showToast(`添加工作区失败：${(error as Error).message}`);
			return null;
		}
	},

	loadSessions: async () => {
		let sessions: SessionSummary[];
		try {
			sessions = await api<SessionSummary[]>('/api/sessions');
		} catch {
			return;
		}
		// 后台会话没有 SSE：靠轮询发现新出现的审批请求，响一次铃并让左侧会话行闪动。
		const pending = new Set(sessions.filter((session) => session.approvalPending).map((session) => session.id));
		for (const id of pending) {
			if (approvalAlertedSessions.has(id)) continue;
			approvalAlertedSessions.add(id);
			if (get().notify.approvalSound !== false) playApprovalSound();
		}
		for (const id of [...approvalAlertedSessions]) {
			if (!pending.has(id)) approvalAlertedSessions.delete(id);
		}
		set({ sessions });
	},

	loadWorktrees: async () => {
		try {
			const data = await api<{ worktrees: WorktreeInfo[] }>('/api/worktrees');
			set({ worktrees: Array.isArray(data?.worktrees) ? data.worktrees : [] });
		} catch {
			/* 忽略 */
		}
	},

	/** 文件 API 的 root 清单：只有它能告诉前端 `/tmp` 这种 root 的真实路径。 */
	loadFileRoots: async () => {
		try {
			const data = await getFileRoots();
			set({ fileRoots: Array.isArray(data?.roots) ? data.roots : [] });
		} catch {
			/* 文件 API 不可用时退回“只认当前工作区” */
		}
	},

	/** 拉当前工作区的仓库清单；同一 key 已加载过就不重复请求。 */
	loadGitPanel: async (options = {}) => {
		const { root, worktree, key } = gitPanelTarget(get());
		const state = get();
		if (!options.refresh && state.gitPanelKey === key && state.gitPanel) return;
		set({
			gitPanelKey: key,
			gitPanelStatus: state.gitPanel && state.gitPanelKey === key ? 'ready' : 'loading',
			gitPanelError: null,
		});
		try {
			const panel = await loadGitRepos(root, worktree, Boolean(options.refresh));
			if (get().gitPanelKey !== key) return;
			set({ gitPanel: panel, gitPanelStatus: 'ready', gitPanelError: null });
		} catch (error) {
			if (get().gitPanelKey !== key) return;
			set({ gitPanelStatus: 'error', gitPanelError: describeGitError(error) });
		}
	},

	/** 手动登记子目录仓库；成功返回新仓库的 key（供 UI 直接切到它的 tab）。 */
	addGitRepo: async (path) => {
		const { root, worktree, key } = gitPanelTarget(get());
		try {
			const panel = await addGitRepoRequest(root, path, worktree);
			set({ gitPanel: panel, gitPanelKey: key, gitPanelStatus: 'ready', gitPanelError: null });
			const rel = path.replace(/\\/g, '/').replace(/^\/+/, '');
			const added = panel.repos.find(
				(repo) =>
					repo.source === 'manual' &&
					(repo.rel === rel || rel.startsWith(repo.rel + '/') || repo.path === path || path.startsWith(repo.path + '/')),
			);
			get().showToast(`已登记仓库：${added?.rel ?? path}`);
			return added?.key ?? null;
		} catch (error) {
			get().showToast(`添加仓库失败：${describeGitError(error)}`);
			return null;
		}
	},

	removeGitRepo: async (path) => {
		const { root, worktree, key } = gitPanelTarget(get());
		try {
			const panel = await removeGitRepoRequest(root, path, worktree);
			set({ gitPanel: panel, gitPanelKey: key, gitPanelStatus: 'ready', gitPanelError: null });
			get().showToast(`已移除登记：${path}`);
			return true;
		} catch (error) {
			get().showToast(`移除登记失败：${describeGitError(error)}`);
			return false;
		}
	},

	loadAgents: async () => {
		try {
			const data = await api<{ agents: AgentSummary[] }>('/api/agents');
			const agents = Array.isArray(data?.agents) ? data.agents : [];
			const selected = get().agentTemplateId;
			// 模板被删 / 改名后不要留着一个永远建不出会话的选中值
			const missing = selected != null && !agents.some((agent) => agent.id === selected);
			if (missing) storage.remove(AGENT_KEY);
			set({ agents, agentTemplateId: missing ? null : selected });
		} catch {
			/* 忽略 */
		}
	},

	setAgentTemplate: (id) => {
		// 只影响“下一条新对话”，不动当前会话：所以没有会话时也能改（Agent 页的“用这个开新对话”）。
		if (id) storage.set(AGENT_KEY, id);
		else storage.remove(AGENT_KEY);
		set({ agentTemplateId: id });
	},

	setWorktreeEnabled: (enabled) => {
		const state = get();
		if (state.sessionId) {
			state.showToast('隔离工作树在新建对话时选择；已有会话不能切换 cwd');
			return;
		}
		const workspace = state.workspaces.find((item) => item.id === state.workspaceId);
		if (!canUseWorktree(workspace)) {
			state.showToast('只有可写的 git 工作区才能创建隔离工作树');
			return;
		}
		set({ worktreeEnabled: enabled });
		const prefs = readWorktreePrefs();
		if (enabled) prefs.add(state.workspaceId);
		else prefs.delete(state.workspaceId);
		writeWorktreePrefs(prefs);
	},

	setCodemodeMode: (mode) => {
		const state = get();
		if (state.sessionId) {
			state.showToast('codemode 策略在建会话时定；会话内不能改，改工具集会掉提示词缓存');
			return;
		}
		set({ codemodeMode: mode });
	},

	removeWorktree: async (id, force = false) => {
		const state = get();
		if (state.worktreeId === id) {
			state.showToast('当前会话正在使用这个 worktree，先切到别的会话');
			return false;
		}
		try {
			await api('/api/worktrees/remove', { id, force });
			await get().loadWorktrees();
			get().showToast('worktree 已删除；分支仍保留，可手动清理');
			return true;
		} catch (error) {
			get().showToast(`删除 worktree 失败：${(error as Error).message}`);
			return false;
		}
	},

	clearSearchSources: () => set({ searchSources: [] }),

	refreshEngine: async () => {
		const health = await fetch('/api/health')
			.then((r) => r.json() as Promise<HealthResponse>)
			.catch(() => null);
		if (health?.piVersion) set({ piVersion: health.piVersion });
	},

	setWorkspace: (workspaceId) => {
		const target = get().workspaces.find((workspace) => workspace.id === workspaceId);
		if (!target) return;
		if (target.available === false) {
			get().showToast(`工作区目录不存在：${target.root}`);
			return;
		}
		if (get().sessionId) {
			get().showToast('工作区在新建对话时选择；已有会话跟随它自己的 cwd');
			return;
		}
		set({
			workspaceId: target.id,
			workspaceFallback: null,
			worktreeEnabled: worktreePreferred(target.id, get().workspaces),
		});
		storage.set(WORKSPACE_KEY, target.id);
	},

	setTheme: (theme) => {
		saveThemeMode(theme);
		applyTheme(theme);
		set({ theme });
	},

	setFileCardsEnabled: (enabled) => {
		const next = { enabled, minImportance: get().fileCardsMinImportance };
		saveFileCardSettings(next);
		set({ fileCardsEnabled: enabled });
	},

	setFileCardsMinImportance: (minImportance) => {
		const next = { enabled: get().fileCardsEnabled, minImportance };
		saveFileCardSettings(next);
		set({ fileCardsMinImportance: minImportance });
	},

	setDomain: (domain) => {
		const value = domain.trim() || 'general';
		set({ domain: value });
		storage.set(DOMAIN_KEY, value);
	},

	setModel: async (key) => {
		const info = get().models.find((m) => m.key === key);
		const label = info ? `${info.name}${info.reasoning ? ' · reasoning' : ''}` : key;
		// 新会话的第一条消息才会在服务端建 Chat；在那之前先把选择留在本地，
		// 随 /api/chat 的 model 字段一起提交，避免 /api/session/settings 报 404。
		if (!get().sessionId) {
			set({ model: key, modelName: info?.name ?? key });
			get().showToast(`模型：${label}`);
			return;
		}
		let updated: ChatStats | null = null;
		try {
			updated = await api<ChatStats>('/api/session/settings', {
				sessionId: get().sessionId,
				model: key,
			});
		} catch (error) {
			get().showToast(`切换模型失败：${(error as Error).message}`);
			return;
		}
		if (updated?.model) {
			get().applyStats(updated);
			get().showToast(`模型：${label}`);
		}
	},

	setThinking: async (level) => {
		const updated = await api<ChatStats>('/api/session/settings', {
			sessionId: get().sessionId ?? streamKey(get().sessionId, get().clientId),
			thinking: level,
		}).catch(() => null);
		if (updated?.model) get().applyStats(updated);
	},

	toggleTool: async (name) => {
		const next = new Set(get().tools);
		if (next.has(name)) next.delete(name);
		else next.add(name);
		const updated = await api<ChatStats>('/api/session/settings', {
			sessionId: get().sessionId ?? streamKey(get().sessionId, get().clientId),
			tools: [...next],
		}).catch(() => null);
		if (updated?.model) get().applyStats(updated);
	},

	compact: async (instructions) => {
		if (get().compacting) return;
		if (get().busy) {
			get().showToast('生成中不能压缩上下文');
			return;
		}
		const target = get().sessionId ?? streamKey(get().sessionId, get().clientId);
		const current = () => get().sessionId ?? streamKey(get().sessionId, get().clientId);
		set({ compacting: true });
		try {
			const updated = await api<ChatStats>('/api/session/compact', {
				sessionId: target,
				...(instructions?.trim() ? { instructions: instructions.trim() } : {}),
			});
			// 压缩期间切了会话：不要把旧会话的 stats/toast 套到新会话上
			if (current() !== target) return;
			if (updated) get().applyStats(updated);
			get().showToast('上下文已压缩');
		} catch (error) {
			if (current() !== target) return;
			get().showToast(`压缩失败：${(error as Error).message}`);
		} finally {
			if (current() === target) set({ compacting: false });
		}
	},

	// ---------- 输入 / UI ----------
	setDraft: (text) => set({ draft: text }),
	pickSample: (text) => set({ draft: text, focusSeq: get().focusSeq + 1 }),
	requestPin: () => set({ pinSeq: get().pinSeq + 1 }),

	noteChars: (count) => {
		tpsChars += count;
		if (!tpsStart) tpsStart = performance.now();
		clearTimeout(tpsTimer);
		tpsTimer = setTimeout(() => {
			// 只是停止这一小段采样，不清空界面上的 TPS：
			// 工具等待 / 步与步之间可能超过 3 秒，保留最后一个值，避免闪成 —
			tpsChars = 0;
			tpsStart = 0;
		}, 3000);
		const seconds = Math.max((performance.now() - tpsStart) / 1000, 0.5);
		set({ tps: Math.max(1, Math.round(tpsChars / 4 / seconds)) });
	},

	showToast: (text, options = {}) => {
		const timeout = options.timeout ?? (options.actionLabel ? TOAST_ACTION_MS : TOAST_PLAIN_MS);
		const placement = options.placement ?? (options.actionLabel ? 'top' : 'bottom');
		toastSeq += 1;
		set({
			toast: {
				id: toastSeq,
				text,
				placement,
				timeout,
				actionLabel: options.actionLabel,
				action: options.action,
			},
		});
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => set({ toast: null }), timeout);
	},

	dismissToast: () => {
		clearTimeout(toastTimer);
		set({ toast: null });
	},

	toggleNotify: async () => {
		const current = get().notify;
		if (current.enabled) {
			const next = { ...current, enabled: false };
			saveNotifySettings(next);
			set({ notify: next });
			clearDoneTitle();
			get().showToast('已关闭完成提醒');
			return;
		}

		// 授权请求和提示音都必须在用户手势里启动
		primeAudio();
		const permission = await requestNotifyPermission();
		const next = { ...current, enabled: true };
		saveNotifySettings(next);
		set({ notify: next, notifyPermission: permission });
		if (permission === 'denied') {
			get().showToast('完成提醒已开启：浏览器通知被拒绝，改用提示音 + 标题提醒');
		} else if (permission === 'unsupported') {
			get().showToast('完成提醒已开启：浏览器不支持通知，改用提示音 + 标题提醒');
		} else {
			get().showToast('完成提醒已开启：切到后台也会收到通知');
		}
	},

	setNotifySound: (sound) => {
		const next = { ...get().notify, sound };
		saveNotifySettings(next);
		set({ notify: next });
		if (sound) {
			primeAudio();
			playDoneSound();
		}
		get().showToast(sound ? '完成提示音已开启' : '完成提示音已关闭');
	},

	previewNotifySound: () => {
		if (!get().notify.enabled || !get().notify.sound) return;
		primeAudio();
		playDoneSound();
	},

	setApprovalSound: (approvalSound) => {
		const next = { ...get().notify, approvalSound };
		saveNotifySettings(next);
		set({ notify: next });
		if (approvalSound) {
			primeAudio();
			playApprovalSound();
		}
		get().showToast(approvalSound ? '审核提示音已开启' : '审核提示音已关闭');
	},

	previewApprovalSound: () => {
		if (get().notify.approvalSound === false) return;
		primeAudio();
		playApprovalSound();
	},

	setPanelVisible: (visible) => {
		if (visible) get().openPanel();
		else get().collapsePanel();
	},
	setView: (view) => {
		if (get().view === view) return;
		set({ view, ...contextStateFor(view) });
		writeViewHash(view);
	},
	syncViewFromHash: () => {
		const next = parseViewHash(currentHash());
		if (next === get().view) return;
		set({ view: next, ...contextStateFor(next) });
	},
	setContextWidth: (width, persist = true) => {
		const next = width == null ? null : clampContextWidth(width);
		set({ contextWidth: next });
		if (persist) saveContextWidth(get().view, next);
	},
	setContextCollapsed: (collapsed) => {
		set({ contextCollapsed: collapsed });
		saveContextCollapsed(get().view, collapsed);
	},
	setLayoutWidth: (width) => {
		if (!Number.isFinite(width) || width <= 0) return;
		const previous = get().layoutWidth;
		const crossed =
			shouldAutoHideContext(previous) !== shouldAutoHideContext(width) ||
			(previous >= WIDE_MIN_WIDTH) !== (width >= WIDE_MIN_WIDTH);
		// 跨断点时忘掉"窄屏手动展开"，否则窗口缩小后列表会莫名其妙一直开着
		set({ layoutWidth: Math.round(width), ...(crossed ? { contextNarrowOpen: false } : {}) });
	},
	toggleRail: () => {
		const next = !get().railExpanded;
		set({ railExpanded: next });
		saveRailExpanded(next);
	},
	toggleContextColumn: () => {
		const state = get();
		const hiddenByNarrow =
			shouldAutoHideContext(state.layoutWidth) && !state.contextNarrowOpen;
		if (state.contextCollapsed || hiddenByNarrow) {
			set({ contextCollapsed: false, contextNarrowOpen: true });
			saveContextCollapsed(state.view, false);
			return;
		}
		set({ contextCollapsed: true, contextNarrowOpen: false });
		saveContextCollapsed(state.view, true);
	},
	setDrawer: (drawer) => set({ drawer }),
	closeDrawers: () => set({ drawer: null }),
	setPanelWidth: (width, persist = true) => {
		panelWidthPersist = persist;
		set({ panelWidth: width });
	},

	openPanel: () => {
		const existing = get().panelTabs;
		const tabs = existing.length ? existing : [createGuideTab()];
		set({
			panelVisible: true,
			panelTabs: tabs,
			activeTabId: tabs.some((tab) => tab.id === get().activeTabId) ? get().activeTabId : tabs[0].id,
			drawer: isMobileViewport() ? 'panel' : get().drawer,
		});
	},

	collapsePanel: () =>
		set({
			panelVisible: false,
			drawer: get().drawer === 'panel' ? null : get().drawer,
		}),

	togglePanel: () => {
		if (get().panelVisible) get().collapsePanel();
		else get().openPanel();
	},

	openGuide: () => {
		const tabs = [...get().panelTabs];
		const existing = tabs.find((tab) => tab.kind === 'guide');
		if (existing) {
			set({ panelVisible: true, activeTabId: existing.id });
			return;
		}
		const guide = createGuideTab();
		tabs.push(guide);
		set({ panelVisible: true, panelTabs: tabs, activeTabId: guide.id });
	},

	openGuideEntry: (id) => {
		const entry = guideEntry(id);
		if (!entry) return;
		const target = entry.open();
		const tabs = [...get().panelTabs];
		const guideIndex = tabs.findIndex((tab) => tab.kind === 'guide');
		const existingIndex = tabs.findIndex((tab) => sameTabKind(tab, target));

		if (existingIndex >= 0) {
			const existing = tabs[existingIndex];
			if (guideIndex >= 0) tabs.splice(guideIndex, 1);
			set({ panelVisible: true, panelTabs: tabs, activeTabId: existing.id });
			return;
		}

		const tab = createPanelTab(target);
		if (guideIndex >= 0) tabs[guideIndex] = tab;
		else tabs.push(tab);
		set({ panelVisible: true, panelTabs: tabs, activeTabId: tab.id });
	},

	openFile: (path, options = {}) => {
		const target = resolveOpenTarget(get(), path, options.root);
		if ('error' in target) {
			get().showToast(target.error);
			return;
		}
		const { root, relative } = target;
		const id = fileTabId(root, relative);
		const tabs = [...get().panelTabs];
		const index = tabs.findIndex((tab) => tab.id === id);
		const line =
			Number.isFinite(Number(options.line)) && Number(options.line) > 0
				? Math.floor(Number(options.line))
				: undefined;

		if (index >= 0) {
			const current = tabs[index];
			if (current.kind === 'file') {
				tabs[index] = { ...current, line: line ?? current.line, nav: current.nav + 1 };
			}
		} else {
			tabs.push(createPanelTab({ kind: 'file', root, path: relative, line }));
		}

		set({
			panelVisible: true,
			panelTabs: tabs,
			activeTabId: id,
			drawer: isMobileViewport() ? 'panel' : get().drawer,
		});
	},

	openAddress: async (address) => {
		const ref = parseFileRef(address);
		if (!ref) {
			get().showToast('无法识别的文件引用');
			return;
		}
		try {
			const resolved = await api<{ root: string; path: string; line?: number; endLine?: number }>(
				`/api/files/resolve?ref=${encodeURIComponent(address)}`,
			);
			get().openFile(resolved.path, { root: resolved.root, line: resolved.line ?? ref.line });
		} catch (error) {
			get().showToast(`打开文件失败：${(error as Error).message}`);
		}
	},

	closePanelTab: (id) => {
		const tabs = [...get().panelTabs];
		const index = tabs.findIndex((tab) => tab.id === id);
		if (index < 0) return;
		if (id === 'guide' && tabs.length === 1) return;

		const wasActive = get().activeTabId === id;
		tabs.splice(index, 1);
		if (!tabs.length) {
			const guide = createGuideTab();
			set({ panelTabs: [guide], activeTabId: guide.id });
			return;
		}

		let activeTabId = get().activeTabId;
		if (wasActive || !tabs.some((tab) => tab.id === activeTabId)) {
			activeTabId = (tabs[index - 1] ?? tabs[index] ?? tabs[0]).id;
		}
		set({ panelTabs: tabs, activeTabId });
	},

	activatePanelTab: (id) => {
		if (get().panelTabs.some((tab) => tab.id === id)) set({ activeTabId: id });
	},

	bumpPanelRefresh: () => set({ panelRefreshTick: get().panelRefreshTick + 1 }),

	// ---------- SSE ----------
	connect: () => {
		const state = get();
		const key = streamKey(state.sessionId, state.clientId);
		if (es && subscribedKey === key) return;
		es?.close();
		subscribedKey = key;
		es = new EventSource(`/api/events?sessionId=${encodeURIComponent(key)}`);
		const mine = () => subscribedKey === key && streamKey(get().sessionId, get().clientId) === key;

		// 工具批次结束后的第一段输出属于下一条 assistant 消息，也就是新的一“步”
		const beginNextStep = () => {
			if (!nextStepPending) return;
			nextStepPending = false;
			set((s) => ({ steps: s.steps + 1 }));
		};

		const markToolBatchDone = () => {
			const index = lastTurnIndex(get().items);
			if (index < 0) return;
			const turn = get().items[index] as TurnItem;
			if (!turn.streaming) return;
			const running = turn.parts.some(
				(part) => part.kind === 'tools' && part.tools.some((tool) => tool.status === 'running'),
			);
			if (!running) nextStepPending = true;
		};

		es.addEventListener('open', () => {
			set({ connection: 'on' });
			if (!get().piVersion) get().refreshEngine().catch(() => {});
			if (droppedWhileBusy) {
				droppedWhileBusy = false;
				get()
					.refreshConversation()
					.then(() => get().showToast('连接已重连，已按服务端状态同步'));
			}
		});

		es.addEventListener('error', () => {
			set({ connection: 'off' });
			if (get().busy) droppedWhileBusy = true;
		});

		es.addEventListener('retry', (event) => {
			if (!mine()) return;
			const payload = parseFrame((event as MessageEvent).data);
			const attempt = Math.max(1, Number(payload?.attempt) || 1);
			set((s) => {
				const items = [...s.items];
				const index = ensureTurn(items, true);
				const turn = items[index] as TurnItem;
				const maxAttempts = Math.max(
					Number(payload?.maxAttempts) || 0,
					turn.retry?.maxAttempts ?? 0,
				);
				if (payload?.state === 'waiting') {
					const delayMs = Math.max(0, Number(payload.delayMs) || 0);
					const retry: RetryState = {
						state: 'waiting',
						attempt,
						maxAttempts,
						delayMs,
						errorMessage: String(payload.errorMessage || '未知错误'),
						until: Number(payload.until) || Date.now() + delayMs,
					};
					items[index] = { ...turn, retry, streaming: true, thinking: true, activity: 'thinking' };
				} else if (payload?.state === 'failed') {
					const fallback = turn.retry?.state === 'waiting' ? turn.retry.errorMessage : '未知错误';
					const finalError = String(payload.finalError || fallback);
					// 用户主动停止时 SDK 也会发 failed('Retry cancelled')，不该当成调用失败。
					if (/cancel|abort|取消/i.test(finalError)) {
						items[index] = { ...turn, retry: undefined, streaming: true };
					} else {
						const retry: RetryState = {
							state: 'failed',
							attempt,
							maxAttempts,
							errorMessage: finalError,
						};
						items[index] = { ...turn, retry, streaming: true, thinking: true, activity: 'thinking' };
					}
				} else {
					items[index] = { ...turn, retry: undefined };
				}
				return { items };
			});
		});

		es.addEventListener('thinking', (event) => {
			if (!mine()) return;
			const { text } = parseFrame((event as MessageEvent).data);
			if (!text) return;
			beginNextStep();
			get().noteChars(String(text).length);
			set((s) => {
				const items = [...s.items];
				const index = ensureTurn(items, true);
				const turn = items[index] as TurnItem;
				const parts = [...turn.parts];
				const last = parts[parts.length - 1];
				if (last?.kind === 'thinking') parts[parts.length - 1] = { ...last, text: last.text + text };
				else parts.push({ kind: 'thinking', id: uid(), text: String(text) });
				items[index] = { ...turn, parts, retry: undefined, streaming: true, thinking: true, activity: 'thinking' };
				return { items };
			});
		});

		es.addEventListener('delta', (event) => {
			if (!mine()) return;
			const { text } = parseFrame((event as MessageEvent).data);
			if (!text) return;
			beginNextStep();
			get().noteChars(String(text).length);
			set((s) => {
				const items = [...s.items];
				const index = ensureTurn(items, false);
				const turn = items[index] as TurnItem;
				const parts = [...turn.parts];
				const last = parts[parts.length - 1];
				if (last?.kind === 'text') parts[parts.length - 1] = { ...last, text: last.text + text };
				else parts.push({ kind: 'text', id: uid(), text: String(text) });
				items[index] = { ...turn, parts, retry: undefined, streaming: true, thinking: false, activity: undefined };
				return { items };
			});
		});

		es.addEventListener('tool', (event) => {
			if (!mine()) return;
			const payload = parseFrame((event as MessageEvent).data);
			if (!payload.id) return;
			const children = Array.isArray(payload.children) ? (payload.children as NestedToolCall[]) : undefined;
			// codemode 脚本的子调用进度：只刷已有行的 children，不新建行
			if (payload.update) {
				if (!children) return;
				set((s) => {
					const items = [...s.items];
					const index = lastTurnIndex(items);
					if (index < 0) return { items };
					const turn = items[index] as TurnItem;
					const parts = turn.parts.map((part) =>
						part.kind === 'tools'
							? {
									...part,
									tools: part.tools.map((tool): ToolRow =>
										tool.id === payload.id ? { ...tool, children } : tool,
									),
								}
							: part,
					);
					items[index] = { ...turn, parts };
					return { items };
				});
				return;
			}
			if (payload.status === 'running') {
				beginNextStep();
				const info = toolInfo(payload.args);
				const row: ToolRow = {
					id: payload.id,
					name: payload.name,
					status: 'running',
					arg: info.arg,
					args: toolArgsText(payload.args),
					path: info.path,
					line: info.line,
					children,
				};
				set((s) => {
					const items = [...s.items];
					const index = ensureTurn(items, false);
					const turn = items[index] as TurnItem;
					const parts = [...turn.parts];
					const last = parts[parts.length - 1];
					if (last?.kind === 'tools') parts[parts.length - 1] = { ...last, tools: [...last.tools, row] };
					else parts.push({ kind: 'tools', id: uid(), tools: [row] });
					// 工具执行中：光标挂在最后一个工具行下面，提示改为“调用工具”
					items[index] = { ...turn, parts, retry: undefined, streaming: true, thinking: true, activity: 'tool' };
					return { items };
				});
			} else {
				const detail = payload.detail ? String(payload.detail).replace(/\s+/g, ' ').slice(0, 70) : '';
				const result = payload.result ? String(payload.result).slice(0, 4000) : '';
				set((s) => {
					const items = [...s.items];
					const index = lastTurnIndex(items);
					if (index < 0) return { items };
					const turn = items[index] as TurnItem;
					const parts = turn.parts.map((part) =>
						part.kind === 'tools'
							? {
									...part,
									tools: part.tools.map((tool): ToolRow =>
										tool.id === payload.id
											? {
													...tool,
													status: payload.status === 'error' ? 'error' : 'ok',
													detail,
													result: result || tool.result,
													durationMs: payload.durationMs ?? tool.durationMs,
													children: children ?? tool.children,
												}
											: tool,
									),
								}
							: part,
					);
					const anyRunning = parts.some(
						(part) => part.kind === 'tools' && part.tools.some((tool) => tool.status === 'running'),
					);
					// 工具跑完、下一段文字还没来时，模型在思考（等它出 token）
					const activity = turn.streaming ? (anyRunning ? 'tool' : 'thinking') : undefined;
					items[index] = { ...turn, parts, retry: undefined, thinking: Boolean(activity), activity };
					return { items };
				});
				markToolBatchDone();
				if (['write', 'edit', 'bash'].includes(String(payload.name))) get().bumpPanelRefresh();
			}
		});

		es.addEventListener('stats', (event) => {
			if (!mine()) return;
			const payload = parseFrame((event as MessageEvent).data);
			const stats = payload?.stats ?? payload;
			if (!stats?.sessionId && !stats?.model) return;
			get().applyStats(stats as ChatStats);
		});

		es.addEventListener('credential_request', (event) => {
			if (!mine()) return;
			const payload = parseFrame((event as MessageEvent).data);
			if (!payload?.requestId) return;
			const request = payload as CredentialRequest;
			const existed = get().credentialRequests.some((item) => item.requestId === request.requestId);
			if (!existed && !approvalAlertedRequests.has(request.requestId)) {
				approvalAlertedRequests.add(request.requestId);
				approvalAlertedSessions.add(request.sessionId || get().sessionId || '');
				if (get().notify.approvalSound !== false) playApprovalSound();
			}
			set((state) => {
				const exists = state.credentialRequests.some((item) => item.requestId === request.requestId);
				return {
					credentialRequests: exists
						? state.credentialRequests.map((item) =>
								item.requestId === request.requestId ? request : item,
							)
						: [...state.credentialRequests, request],
				};
			});
			if (Number.isFinite(request.expiresAt)) scheduleCredentialExpiry(request);
		});

		// 搜索来源：只累积当前会话的，倒序展示；上限防长会话把内存堆满。
		es.addEventListener('search_sources', (event) => {
			if (!mine()) return;
			const payload = parseFrame((event as MessageEvent).data);
			if (!payload?.query || !Array.isArray(payload.hits)) return;
			set((s) => ({
				searchSources: [
					{
						query: String(payload.query),
						provider: String(payload.provider ?? ''),
						hits: payload.hits,
						cached: Boolean(payload.cached),
						degraded: typeof payload.degraded === 'string' ? payload.degraded : undefined,
						at: Number(payload.at) || Date.now(),
					},
					...s.searchSources,
				].slice(0, 30),
			}));
		});

		es.addEventListener('presented', (event) => {
			if (!mine()) return;
			const payload = parseFrame((event as MessageEvent).data);
			const turn = Number(payload?.turn);
			const files = Array.isArray(payload?.files)
				? (payload.files as ReportedFile[]).filter(
						(file) => file && typeof file.path === 'string' && typeof file.address === 'string',
					)
				: [];
			if (!files.length || !Number.isSafeInteger(turn) || turn <= 0) return;
			set((s) => {
				const items = [...s.items];
				const index = lastTurnIndex(items);
				if (index < 0) return { items };
				const item = items[index] as TurnItem;
				const current = item.files;
				items[index] = {
					...item,
					files: {
						turn,
						cwd: String(payload.cwd ?? current?.cwd ?? ''),
						files: mergeReportedFiles(current?.files ?? [], files),
						updatedAt: Date.now(),
					},
				};
				return { items };
			});
		});

		es.addEventListener('queue', (event) => {
			if (!mine()) return;
			const payload = parseFrame((event as MessageEvent).data);
			set({
				queue: {
					steering: Array.isArray(payload.steering) ? payload.steering.map(String) : [],
					followUp: Array.isArray(payload.followUp) ? payload.followUp.map(String) : [],
				},
			});
		});

		// 运行中的 steering/followUp 真正进入模型：在对话流里补一条用户消息，
		// 下一条助手输出会自动开一个新 turn。
		es.addEventListener('user', (event) => {
			if (!mine()) return;
			const { text } = parseFrame((event as MessageEvent).data);
			if (!text) return;
			nextStepPending = true;
			set((s) => {
				const items = [...s.items];
				const index = lastTurnIndex(items);
				if (index >= 0 && items[index].kind === 'turn') {
					items[index] = { ...(items[index] as TurnItem), streaming: false, thinking: false, activity: undefined, retry: undefined };
				}
				items.push({ kind: 'user', id: uid(), text: String(text), at: Date.now() });
				return { items, busy: true, pinSeq: s.pinSeq + 1 };
			});
		});

		es.addEventListener('settled', async () => {
			if (!mine()) return;
			const aborted = suppressSettleNotify;
			suppressSettleNotify = false;
			nextStepPending = false;
			get().bumpPanelRefresh();
			const before = get();
			const index = lastTurnIndex(before.items);
			const turn = index >= 0 ? (before.items[index] as TurnItem) : null;
			set((s) => ({
				busy: false,
				avgTps: null,
				items: s.items.map((item) =>
					item.kind === 'turn' ? { ...item, streaming: false, thinking: false, retry: undefined } : item,
				),
			}));
			const stats = await get().refreshCurrent(
				Math.max(HISTORY_PAGE_TURNS, loadedTurnCount(before.items)),
			);
			if (stats) get().applyStats(stats);
			const round = roundStats(
				countersFrom(get()),
				turn?.baseline,
				stats?.turns ?? get().turns,
				turn?.startedAt,
				stats?.modelName ?? get().modelName,
			);
			let finished = false;
			if (stats && !stats.busy) {
				// 以持久化历史为准重绘：流式期间可能有丢包/重连
				const items = historyToItems(
					stats.history,
					firstTurnAt(stats.turnOverview, stats.historyMeta?.start ?? 0),
					stats.presentedByTurn,
				);
				const last = lastTurnIndex(items);
				// 只有历史确实以“助手轮”结尾时才挂统计条，避免挂到上一轮
				if (round && last >= 0 && last === items.length - 1) {
					items[last] = { ...(items[last] as TurnItem), stats: round, startedAt: turn?.startedAt };
				}
				const avg = lastTurnAverage(items);
				set({
					items,
					avgTps: avg,
					historyStart: stats.historyMeta?.start ?? 0,
					historyHasMore: Boolean(stats.historyMeta?.hasMore),
					historyLoading: false,
					...(avg != null ? { tps: null } : {}),
				});
				finished = true;
			} else if (round && index >= 0) {
				const tps = averageTps(round.output, round.durationMs);
				set((s) => {
					const items = s.items.map((item, i) =>
						i === index && item.kind === 'turn' ? { ...item, stats: round, avgTps: tps ?? item.avgTps } : item,
					);
					const avg = lastTurnAverage(items);
					return { items, avgTps: avg, ...(avg != null ? { tps: null } : {}) };
				});
				finished = true;
			}

			// 只有真正完成（不是停止、也不是 followUp 已把新一轮顶起来）才提醒。
			if (!aborted && finished && !get().busy) {
				const settings = get().notify;
				const duration = round?.durationMs ?? (turn?.startedAt ? Date.now() - turn.startedAt : 0);
				const turnNumber = round?.turns ?? stats?.turns ?? get().turns;
				const meta = [
					duration > 0 ? formatDuration(duration) : '',
					round?.steps ? `${round.steps} 步` : '',
					round?.toolCalls ? `${round.toolCalls} 次工具` : '',
				].filter(Boolean);
				const label = stats?.sessionName || get().sessionName || 'Turn Pi';
				const delivery = deliverTurnDone(settings, {
					sessionId: stats?.sessionId ?? get().sessionId,
					title: 'pi · 本轮已完成',
					body: `${label}：第 ${turnNumber} 轮已完成${meta.length ? ` · ${meta.join(' · ')}` : ''}`,
				});
				// 前台只弹 toast；后台已走通知 + 声音 + 标题标记，回来后不再补弹
				if (delivery === 'foreground') {
					get().showToast(`本轮已完成${meta.length ? ` · ${meta.join(' · ')}` : ''}`);
				}
			}
			await get().loadSessions();
		});
	},
}));

// 右栏状态变化即持久化；localStorage 不可用时 storage 会静默忽略。
/**
 * 本轮计时的时间窗：busy 只由三个地方翻转——发送（send）、中断（abort）、
 * 完成（服务端 settled）——都在这里统一维护，调用方不用各记一遍。
 *
 * 真正的起点以"当前会话这一轮自己的 startedAt"为准（组件里派生，见 TurnVerse），
 * 这里维护的 turnStartedAt 只是拿不到 startedAt 时的兜底：
 *  - 切会话一律清空，绝不让上一条会话的时间漏到新会话上；
 *  - busy 翻起来且 items 里还没有带 startedAt 的那一帧，用当前时间兜底。
 */
useStore.subscribe((state, previous) => {
	const sessionChanged = state.sessionId !== previous.sessionId;
	const busyChanged = state.busy !== previous.busy;
	if (!sessionChanged && !busyChanged) return;
	if (sessionChanged) useStore.setState({ turnStartedAt: null });
	if (!busyChanged || !state.busy) return;
	const lastTurn = [...state.items].reverse().find((item) => item.kind === 'turn');
	const startedAt =
		lastTurn?.kind === 'turn' && typeof lastTurn.startedAt === 'number'
			? lastTurn.startedAt
			: Date.now();
	useStore.setState({ turnStartedAt: startedAt });
});

useStore.subscribe((state, previous) => {
	if (
		state.panelVisible !== previous.panelVisible ||
		state.panelWidth !== previous.panelWidth ||
		state.panelTabs !== previous.panelTabs ||
		state.activeTabId !== previous.activeTabId
	) {
		const widthChanged = state.panelWidth !== previous.panelWidth;
		savePanelState({
			visible: state.panelVisible,
			width: widthChanged && !panelWidthPersist ? previous.panelWidth : state.panelWidth,
			tabs: state.panelTabs,
			activeTabId: state.activeTabId,
		});
	}
});


/**
 * 上下文列当前是否隐藏。三种来源，任何一种都算隐藏：
 *  1. 用户明确折叠了它；
 *  2. 桌面窄屏（<1180）自动收起；
 *  3. 用户把 rail 展开成宽条、而视口还不够宽（<1440）—— 宽条和上下文列在窄屏二选一。
 * 第 2、3 条都可以被"手动展开过"（contextNarrowOpen）覆盖。
 * 单独导出成 hook，避免 App / ModuleRail 各算一遍口径不一致。
 */
export function useContextHidden(): boolean {
	return useStore(
		(s) =>
			s.contextCollapsed ||
			((shouldAutoHideContext(s.layoutWidth) || (s.railExpanded && s.layoutWidth < WIDE_MIN_WIDTH)) &&
				!s.contextNarrowOpen),
	);
}
