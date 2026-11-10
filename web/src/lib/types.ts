/** 服务端返回形状（server/chat.ts, server/index.ts）。 */

export type ToolStatus = 'running' | 'ok' | 'error';

/**
 * 新会话的 codemode 策略。
 * - `auto`：按默认（codemode 可用，模型自己决定用不用）
 * - `on`：强制开启，本轮要求模型必须走脚本
 * - `off`：强制关闭，本次会话不提供 codemode
 */
export type CodemodeMode = 'auto' | 'on' | 'off';

/** codemode 脚本里的嵌套调用（脚本自己的 call log，服务端从 details.calls 转来）。 */
export interface NestedToolCall {
	id?: string;
	name: string;
	args?: string;
	status: 'running' | 'ok' | 'error' | 'cancelled';
	durationMs?: number;
	error?: string;
}

/** 输入框里待发送 / 历史消息里展示的图片。data 是 base64，不带 data: 前缀。 */
export interface ImageAttachment {
	id?: string;
	name?: string;
	mimeType: string;
	data: string;
	size?: number;
}

export interface ToolRow {
	id: string;
	name: string;
	status: ToolStatus;
	arg?: string;
	detail?: string;
	/** 工具原始参数（JSON 文本），展开时查看 */
	args?: string;
	/** 工具结果（可能被服务端截断），展开时查看 */
	result?: string;
	durationMs?: number;
	/** 工具参数里能映射到工作区的文件路径（用于点击打开右栏预览） */
	path?: string;
	/** 1-based 行号（read 的 offset） */
	line?: number;
	/** codemode 的嵌套调用（脚本里 tools.xxx() 的调用日志） */
	children?: NestedToolCall[];
}

export interface HistoryTool {
	id?: string;
	name: string;
	ok?: boolean;
	detail?: string;
	args?: string;
	result?: string;
	durationMs?: number;
	path?: string;
	line?: number;
	children?: NestedToolCall[];
}

export type FileImportance = 'high' | 'normal' | 'low';
export type FileChange = 'created' | 'modified';

/** agent 通过 `report_files` 主动汇报的一个文件。 */
export interface ReportedFile {
	path: string;
	display: string;
	description?: string;
	change?: FileChange;
	importance: FileImportance;
	line?: number;
	/** 全局文件资源地址，见 web/src/lib/fileRef.ts */
	address: string;
}

/** 一轮里 agent 汇报的文件；持久化在会话 sidecar，刷新后仍能还原。 */
export interface TurnFiles {
	turn: number;
	cwd: string;
	files: ReportedFile[];
	updatedAt: number;
}

export type FileKind =
	| 'markdown'
	| 'text'
	| 'image'
	| 'svg'
	| 'pdf'
	| 'binary'
	| 'unknown';

export interface FileRoot {
	id: string;
	label: string;
	path: string;
	kind?: 'dir' | 'git' | 'worktree';
	readonly: boolean;
	available?: boolean;
	workspaceId?: string;
	branch?: string;
}

export interface WorkspaceInfo {
	id: string;
	label: string;
	root: string;
	kind: 'dir' | 'git';
	readonly?: boolean;
	available?: boolean;
	source?: 'default' | 'config' | 'discovered';
}

export interface WorktreeInfo {
	id: string;
	workspaceId: string;
	path: string;
	branch: string;
	baseRef: string;
	baseCommit: string;
	sessionId?: string;
	state: 'creating' | 'ready' | 'missing' | 'removing' | 'removed';
	createdAt: string;
	lastUsedAt: string;
	removedAt?: string;
	available?: boolean;
	workspaceLabel?: string;
	workspaceRoot?: string;
}

export interface JobFieldInfo {
	key: string;
	label: string;
	type: 'number' | 'boolean';
	default: number | boolean;
	min?: number;
	max?: number;
	step?: number;
	unit?: string;
	hint?: string;
}

export interface JobStateInfo {
	enabled: boolean;
	dryRun: boolean;
	intervalMs: number;
	lastRunAt?: string;
	lastFinishedAt?: string;
	lastAutoRunAt?: string;
	lastStatus?: 'ok' | 'error';
	lastSummary?: string;
	lastError?: string;
	nextRunAt?: string;
	totalRuns: number;
}

export interface JobInfo {
	id: string;
	name: string;
	description: string;
	enabled: boolean;
	dryRun: boolean;
	intervalMs: number;
	running: boolean;
	fields: JobFieldInfo[];
	config: Record<string, number | boolean>;
	state: JobStateInfo;
}

export interface JobRunRecord {
	id: string;
	jobId: string;
	trigger: 'manual' | 'schedule';
	dryRun: boolean;
	startedAt: string;
	finishedAt: string;
	status: 'ok' | 'error';
	summary: string;
	error?: string;
	detail?: unknown;
}

export interface JobsSnapshot {
	jobs: JobInfo[];
	runs: JobRunRecord[];
}

export interface FileEntry {
	name: string;
	type: 'directory' | 'file' | 'other';
	symlink?: boolean;
	blocked?: boolean;
}

/** Git 面板（server/git.ts）：一个工作区下的多个仓库。 */
export type GitRepoSource = 'root' | 'worktree' | 'manual' | 'scanned';

export interface GitChange {
	code: string;
	path: string;
	staged: boolean;
}

export interface GitRepoSummary {
	key: string;
	name: string;
	/** 相对工作区根的路径；工作区根仓库和工作树为空 */
	rel: string;
	path: string;
	source: GitRepoSource;
	branch: string | null;
	detached: boolean;
	upstream: string | null;
	ahead: number;
	behind: number;
	clean: boolean;
	changes: GitChange[];
	changesTotal: number;
	lastCommit: { sha: string; subject: string; author: string; date: string } | null;
	error?: string;
}

export interface GitPanel {
	root: { id: string; label: string; path: string; workspaceId: string; workspaceLabel: string };
	repos: GitRepoSummary[];
	scannedAt: number;
}

export interface GitCommitRef {
	name: string;
	kind: 'head' | 'branch' | 'remote' | 'tag';
}

/** 一条提交 + 服务端算好的泳道布局（前端只按坐标画线）。 */
export interface GitCommitRow {
	sha: string;
	short: string;
	parents: string[];
	author: string;
	date: string;
	subject: string;
	refs: GitCommitRef[];
	lane: number;
	laneCount: number;
	/** 泳道上方是否连着上一行（分支顶端为 false） */
	top: boolean;
	through: number[];
	incoming: number[];
	outgoing: { from: number; to: number }[];
}

export interface GitBranch {
	/** 短名：本地分支 main，远端分支 origin/main */
	short: string;
	/** 完整 ref：refs/heads/main / refs/remotes/origin/main */
	full: string;
	/** 远端名（远端分支才有）；一个仓库可以有多个远端 */
	remote: string | null;
	current: boolean;
	upstream: string | null;
	ahead: number;
	behind: number;
	sha: string;
	shortSha: string;
	date: string;
	subject: string;
}

export interface GitBranches {
	rel: string;
	path: string;
	locals: GitBranch[];
	remotes: { name: string; branches: GitBranch[] }[];
}

export interface GitCommitFile {
	path: string;
	/** A / M / D / T；重命名在服务端拆成 A+D（--no-renames） */
	status: string;
	additions: number | null;
	deletions: number | null;
}

export interface GitCommitDetail {
	sha: string;
	short: string;
	parents: string[];
	author: string;
	email: string;
	date: string;
	subject: string;
	/** 完整提交信息去掉第一行后的正文 */
	body: string;
	refs: GitCommitRef[];
	files: GitCommitFile[];
	additions: number;
	deletions: number;
	truncated: boolean;
}

export interface GitLog {
	rel: string;
	path: string;
	commits: GitCommitRow[];
	limit: number;
	hasMore: boolean;
}

export interface FileList {
	root: string;
	path: string;
	absolutePath: string;
	entries: FileEntry[];
	truncated: boolean;
}

export interface FileStat {
	root: string;
	path: string;
	absolutePath: string;
	name: string;
	kind: FileKind;
	size: number;
	mtimeMs: number;
	version: string;
}

export interface FileText extends FileStat {
	text: string;
	truncated: boolean;
	eof: boolean;
}

export interface HistoryItem {
	role: string;
	text?: string;
	thinking?: string;
	tools?: HistoryTool[];
	images?: ImageAttachment[];
	/** assistant 以 error 结束时保留错误文本；重试耗尽后仍能看到原因 */
	error?: string;
	/** assistant 单步的 token 用量/耗时；前端据此算本轮平均 TPS */
	usage?: Usage;
	durationMs?: number;
	/** 该轮最后一条 assistant 的完成时间（epoch ms） */
	completedAt?: number;
	/** user 消息：这条消息自己的时间戳（epoch ms），会话文件里有就带上 */
	at?: number;
}

export interface LiveTool {
	id: string;
	name: string;
	status: ToolStatus;
	detail?: string;
	args?: string;
	result?: string;
	durationMs?: number;
	children?: NestedToolCall[];
}

export interface LiveState {
	text: string;
	thinking?: string;
	tools: LiveTool[];
	startedAt: number;
	/** 正在等待下一次自动重试（切回会话时用它恢复倒计时） */
	retry?: RetryState;
}

/** provider 429/5xx 等可重试错误的自动重试状态。 */
export type RetryState =
	| {
			state: 'waiting';
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
			/** 绝对时间（epoch ms）：到这个时刻 SDK 会重新发起调用 */
			until: number;
		}
	| { state: 'failed'; attempt: number; maxAttempts: number; errorMessage: string };

export interface Usage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	total?: number;
}

export interface ToolCatalogItem {
	name: string;
	label?: string;
	active?: boolean;
}

/** Pi SDK 的待发送队列：steering 会在当前 step 后插入，followUp 等本轮结束。 */
export interface QueueSnapshot {
	steering: string[];
	followUp: string[];
}

export type SendMode = 'prompt' | 'steer' | 'followUp';
export type QueuePlacement = 'steering' | 'followUp';

/** 上下文环点击后的估算明细；单位是 token，前端按 k 显示。 */
export interface ContextBreakdown {
	system: number;
	tools: number;
	messages: number;
	other: number;
	subtotal?: number;
	toolCount?: number;
	messageCount?: number;
}


export interface TrajectoryUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

export interface TrajectoryTool {
	id: string;
	name: string;
	args?: string;
	status: 'running' | 'ok' | 'error';
	result?: string;
	isError?: boolean;
	startedAt?: number;
	finishedAt?: number;
	durationMs?: number;
	/** codemode 脚本里的嵌套调用日志 */
	children?: NestedToolCall[];
}

export interface TrajectoryCall {
	responseId?: string;
	startedAt: number;
	firstTokenAt?: number;
	endedAt: number;
	durationMs: number;
	ttftMs?: number;
	generationMs: number;
	tps?: number;
	/** 历史步无 TTFT，generation/tps 用总时长估算 */
	approximate?: boolean;
	usage: TrajectoryUsage;
	model?: string;
}

export interface TrajectoryStep {
	id: string;
	index: number;
	timestamp?: number;
	startedAt?: number;
	finishedAt?: number;
	durationMs?: number;
	text?: string;
	thinking?: string;
	usage?: TrajectoryUsage;
	model?: string;
	responseId?: string;
	call?: TrajectoryCall;
	stopReason?: string;
	tools: TrajectoryTool[];
}

export interface TrajectoryTurn {
	index: number;
	id: string;
	user?: { text: string; timestamp?: number };
	steps: TrajectoryStep[];
	startedAt?: number;
	endedAt?: number;
}

export interface TrajectoryEvent {
	id: string;
	kind: 'model' | 'thinking' | 'compaction' | string;
	turn: number;
	step: number;
	time?: number;
	title: string;
	text?: string;
}

export interface TrajectorySnapshot {
	sessionId: string;
	busy: boolean;
	updatedAt: number;
	live?: LiveState | null;
	turns: TrajectoryTurn[];
	events: TrajectoryEvent[];
	totals: {
		turns: number;
		steps: number;
		toolCalls: number;
		usage: TrajectoryUsage;
		startedAt?: number;
		endedAt?: number;
	};
}

export interface TrajectoryPayload {
	sessionId: string;
	stepId: string;
	targetFound: boolean;
	available: boolean;
	reason?: string;
	responseId?: string;
	at?: number;
	model?: string;
	bytes?: number;
	payload?: unknown;
}

export interface TrajectoryContext {
	sessionId: string;
	stepId: string;
	targetFound: boolean;
	time?: number;
	system: string;
	tools: string;
	skills: string;
	messages: string;
	counts: { tools: number; skills: number; messages: number };
	chars: { system: number; tools: number; skills: number; messages: number; total: number };
	tokens: { system: number; tools: number; skills: number; messages: number; total: number };
	compacted: boolean;
	compactionAt?: number;
}

export interface HistoryMeta {
	/** 本次返回的历史在完整 history 数组里的起止下标（start 含，end 不含） */
	start: number;
	end: number;
	total: number;
	hasMore: boolean;
	/** 整个会话一共有多少轮（用户消息数） */
	turnCount: number;
	/** 本次返回的历史里包含多少轮 */
	pageTurns: number;
}

/** 导航条用的轻量轮次索引 */
export interface TurnOverviewItem {
	index: number;
	start: number;
	end: number;
	text: string;
}

export interface ChatStats {
	sessionId: string;
	sessionName?: string | null;
	agentId: string;
	sessionPath?: string;
	cwd?: string;
	workspaceId?: string;
	workspaceLabel?: string;
	workspaceRoot?: string;
	workspaceReadonly?: boolean;
	workspaceAvailable?: boolean;
	worktreeId?: string | null;
	worktreeBranch?: string | null;
	worktreePath?: string | null;
	worktreeState?: string | null;
	worktreeAvailable?: boolean;
	model: string;
	modelName: string;
	contextWindow: number;
	thinkingLevel: string;
	thinkingLevels: string[];
	supportsThinking: boolean;
	tools: string[];
	/** 会话绑定的 AgentTemplate；没绑 = undefined（走环境默认工具集） */
	templateId?: string;
	/** 建会话时定下的 codemode 策略；会话内不可改 */
	codemode?: CodemodeMode;
	toolCatalog: ToolCatalogItem[];
	/** 固定出口工具名：设置页勾选但不可关 */
	pinnedTools?: string[];
	messages: number;
	usage?: Usage;
	cost?: unknown;
	toolCalls: number;
	turns: number;
	steps: number;
	context?: {
		tokens?: number | null;
		contextWindow?: number;
		percent?: number | null;
		maxTokens?: number;
		estimated?: boolean;
		breakdown?: ContextBreakdown;
	};
	busy: boolean;
	/** 切会话快照里的最近一次生成 TPS；完整 stats 到达前先显示 */
	lastTps?: number;
	live?: LiveState | null;
	queue?: QueueSnapshot;
	history?: HistoryItem[];
	historyMeta?: HistoryMeta;
	turnOverview?: TurnOverviewItem[];
	favorites?: number[];
	/** 按绝对轮号索引的 agent 文件汇报 */
	presentedByTurn?: Record<string, TurnFiles>;
}

export interface ModelInfo {
	key: string;
	provider: string;
	id: string;
	name: string;
	contextWindow: number;
	reasoning: boolean;
	/** 模型是否声明支持图片输入 */
	supportsImages?: boolean;
}

/** 设置 → 模型供应商。密钥只保存环境变量名，不保存值。 */
export interface ProviderAuthInfo {
	configured: boolean;
	source?: string;
	label?: string;
}

export interface ProviderCard {
	id: string;
	name: string;
	kind: 'builtin' | 'custom';
	api?: string;
	apis: string[];
	baseUrl?: string;
	apiKeyEnv?: string;
	auth: ProviderAuthInfo;
	modelCount: number;
	modelTotal: number;
	/** 内置供应商恒为启用；自定义供应商可以保留配置但停用。 */
	enabled?: boolean;
	/** 自定义供应商的已保存模型；编辑表单直接回填。 */
	models?: ProviderModelOption[];
}

export interface ProviderQuotaBalance {
	label: string;
	currency: string;
	remaining: number;
	total?: number;
	used?: number;
	details?: Array<{ label: string; amount: number }>;
}

export interface ProviderQuotaWindow {
	label: string;
	limit?: number;
	remaining?: number;
	reset?: string;
	/** 订阅制额度使用百分比（0..100）。 */
	percent?: number;
	/** 当前窗口已限流。 */
	limited?: boolean;
}

export interface ProviderQuota {
	providerId: string;
	status: 'ok' | 'unsupported' | 'error' | 'unconfigured';
	reachable: boolean;
	checkedAt: number;
	latencyMs?: number;
	balances: ProviderQuotaBalance[];
	windows: ProviderQuotaWindow[];
	plan?: string;
	sources: string[];
	warnings: string[];
	error?: string;
}

export interface ProviderModelOption {
	id: string;
	name: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
}

export interface ProviderConnectionResult {
	ok: true;
	latencyMs: number;
	modelCount: number;
	endpoint: string;
	envVar: string;
	models: ProviderModelOption[];
}

export interface ProviderModelsResult {
	ok: true;
	models: ProviderModelOption[];
	endpoint: string;
	envVar: string;
	latencyMs: number;
}

export type CredentialKind = 'bearer' | 'api-key' | 'basic' | 'query' | 'env';
export type CredentialTier = 'env' | 'scoped';
export type CredentialPolicy = 'ask' | 'auto-read';

export interface CredentialCard {
	id: string;
	name: string;
	label?: string;
	kind: CredentialKind;
	tier: CredentialTier;
	headerName?: string;
	headerPrefix?: string;
	username?: string;
	queryParam?: string;
	envName?: string;
	envPresent?: boolean;
	baseUrl?: string;
	allowedHosts: string[];
	allowedPathPrefix?: string;
	allowedMethods: string[];
	scopes: string[];
	policy: CredentialPolicy;
	createdAt: number;
	updatedAt: number;
	lastUsedAt?: number;
	useCount: number;
	hasSecret: boolean;
	secretEnv?: string;
	secretEnvPresent?: boolean;
}

export interface CredentialList {
	credentials: CredentialCard[];
	leases: number;
	sessionGrants: number;
	envHydrated: string[];
	importableEnv: string[];
	keySource: 'env' | 'file' | 'unknown';
}

export interface CredentialTestResult {
	ok: boolean;
	status: number;
	latencyMs: number;
	endpoint: string;
	message: string;
}

export interface CredentialAuditEntry {
	ts: number;
	actor: string;
	sessionId?: string;
	credential?: string;
	action: string;
	method?: string;
	host?: string;
	path?: string;
	status?: number;
	decision?: string;
	lease?: string;
	scopes?: string;
	error?: string;
}

export interface CredentialRequest {
	requestId: string;
	credential: {
		name: string;
		label: string;
		kind: CredentialKind;
		hosts: string[];
		scopes: string[];
	};
	reason: string;
	scopes: string[];
	sessionId: string;
	expiresAt: number;
}

/** 已经超时、不能再审批的请求；前端保留成卡片细条，提示这里曾经有过审核。 */
export interface CredentialTimeout extends CredentialRequest {
	timedOutAt: number;
}

export interface SessionSummary {
	id: string;
	path: string;
	name?: string;
	title: string;
	created: number;
	modified: number;
	messageCount: number;
	busy?: boolean;
	/** 该会话有凭据使用请求等待用户审批；左侧列表会闪动 */
	approvalPending?: boolean;
	cwd?: string;
	workspaceId?: string | null;
	workspaceLabel?: string;
	workspaceRoot?: string | null;
	worktreeId?: string | null;
	worktreeBranch?: string | null;
	worktreePath?: string | null;
	worktreeState?: string | null;
	archived?: boolean;
}

export interface AgentSummary {
	id: string;
	description: string;
	kind: 'base' | 'domain' | 'variant' | 'orchestrator';
	domain: string;
	tools: string[];
	skills: string[];
	model: string;
	thinking: string;
	status: string;
	parent: string | null;
	maxActive: number;
	external: boolean;
	prompt: string;
	path: string;
	writable: boolean;
	warnings: string[];
}

/** dry-run 预览：模型这一步实际会收到什么 */
export interface AgentPreview {
	id: string;
	model: string;
	thinking: string;
	contextWindow: number;
	system: string;
	toolsText: string;
	tools: { name: string; tokens: number }[];
	activeTools: string[];
	pinnedTools: string[];
	skills: { id: string; sha256: string; tokens: number; text: string }[];
	skillsText: string;
	chars: { system: number; tools: number; skills: number };
	tokens: { system: number; tools: number; skills: number; total: number };
	warnings: string[];
	degraded?: string;
}

export interface AgentToolInfo {
	name: string;
	label?: string;
	description?: string;
}

export interface AgentSkillRef {
	id: string;
	state: string;
	version: string;
	main: string;
	injected: boolean;
}

export interface AgentMergeChange {
	field: 'tools' | 'skills' | 'prompt' | 'model' | 'thinking' | 'description' | 'domain';
	label: string;
	from: string;
	to: string;
}

export interface SendResponse {
	ok: boolean;
	agentId: string;
	sessionId: string;
	queue?: QueueSnapshot;
}

/** 联网搜索的一条来源；服务端 search_sources 事件原样下发。 */
export interface SearchSource {
	title: string;
	url: string;
	snippet: string;
	publishedAt?: string;
	provider: string;
	score?: number;
}

/** 一次搜索 = 一组来源，按发生时间倒序展示。 */
export interface SearchSourceGroup {
	query: string;
	provider: string;
	hits: SearchSource[];
	cached: boolean;
	degraded?: string;
	at: number;
}

export interface HealthResponse {
	ok: boolean;
	port: number;
	piVersion?: string;
}

/** 对话区的一条块：用户消息 / 助手文本 / 一轮里的工具组。 */
/** 一轮助手输出里的块：文本 / 工具组，按时间顺序交错。 */
export interface TurnCounters {
	steps: number;
	toolCalls: number;
	input: number;
	cacheRead: number;
	output: number;
}

/** 一轮结束时的统计（相对本轮开始时的增量） */
export interface TurnStats extends TurnCounters {
	turns: number;
	durationMs: number;
	completedAt?: number;
	model?: string;
}

/** 历史轮次的执行摘要：折叠时只显示这一行 */
export interface TurnHistoryStats {
	turns?: number;
	steps: number;
	thinkingCount: number;
	toolCalls: number;
	durationMs: number;
	completedAt?: number;
	input: number;
	cacheRead: number;
	output: number;
}

export type TurnPart =
	| { kind: 'text'; id: string; text: string }
	| { kind: 'thinking'; id: string; text: string }
	| { kind: 'tools'; id: string; tools: ToolRow[] };

/** 对话区的一条块：用户消息 / 一整轮助手输出（只有一个 PI 标题）。 */
export type Item =
	| { kind: 'user'; id: string; text: string; images?: ImageAttachment[]; at?: number }
	| {
			kind: 'turn';
			id: string;
			parts: TurnPart[];
			streaming: boolean;
			/** 模型在等结果/思考（没有在跑工具，也没在吐字） */
			thinking?: boolean;
			/** 当前在等什么：模型出 token（thinking）还是工具执行（tool） */
			activity?: 'thinking' | 'tool';
			/** 自动重试：倒计时期间显示错误，倒计时结束后回到「思考中」 */
			retry?: RetryState;
			error?: string;
			/** 本轮开始时的累计计数器，用于算 settled 时的增量 */
			baseline?: TurnCounters;
			startedAt?: number;
			/** 本轮平均输出速度（tok/s），来自历史里的 usage.output / durationMs */
			avgTps?: number;
			stats?: TurnStats;
			historyStats?: TurnHistoryStats;
			/** 本轮 agent 主动汇报的文件（report_files） */
			files?: TurnFiles;
		};
