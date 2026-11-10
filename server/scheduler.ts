/**
 * 进程内定时任务。
 *
 * 设计目标很小：
 *   - 任务定义在代码里，执行状态落盘；
 *   - 单飞、失败隔离、重启后补跑；
 *   - 页面能看「上次跑没跑、结果、异常」，能手动触发和暂停；
 *   - 不引入 cron / 额外进程，也不依赖多实例。
 *
 * 状态文件默认 runtime/jobs/scheduler.json，可用 PI_JOBS_FILE 覆盖。
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export type JobConfigValue = number | boolean;

export interface JobField {
	key: string;
	label: string;
	type: 'number' | 'boolean';
	default: JobConfigValue;
	min?: number;
	max?: number;
	step?: number;
	unit?: string;
	hint?: string;
}

export interface JobRunContext {
	dryRun: boolean;
	config: Record<string, JobConfigValue>;
	signal: AbortSignal;
}

export interface JobRunResult {
	summary: string;
	detail?: unknown;
}

export interface JobDefinition {
	id: string;
	name: string;
	description: string;
	defaultEnabled: boolean;
	defaultDryRun: boolean;
	defaultIntervalMs: number;
	fields: JobField[];
	run: (ctx: JobRunContext) => Promise<JobRunResult>;
}

export interface JobState {
	enabled: boolean;
	dryRun: boolean;
	intervalMs: number;
	config: Record<string, JobConfigValue>;
	lastRunAt?: string;
	lastFinishedAt?: string;
	lastAutoRunAt?: string;
	lastStatus?: 'ok' | 'error';
	lastSummary?: string;
	lastError?: string;
	nextRunAt?: string;
	totalRuns: number;
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

export interface JobView {
	id: string;
	name: string;
	description: string;
	enabled: boolean;
	dryRun: boolean;
	intervalMs: number;
	running: boolean;
	fields: JobField[];
	config: Record<string, JobConfigValue>;
	state: Omit<JobState, 'config'>;
}

export interface JobRunResponse {
	ok: boolean;
	run?: JobRunRecord;
	error?: string;
}

export interface JobsSnapshot {
	jobs: JobView[];
	runs: JobRunRecord[];
}

export interface JobUpdate {
	enabled?: boolean;
	dryRun?: boolean;
	intervalMs?: number;
	config?: Record<string, JobConfigValue>;
}

const RUNTIME_DIR = resolve(process.env.PI_RUNTIME_DIR ?? 'runtime');
const JOBS_FILE = resolve(process.env.PI_JOBS_FILE ?? join(RUNTIME_DIR, 'jobs', 'scheduler.json'));
const RUN_HISTORY_LIMIT = 200;
const MIN_INTERVAL_MS = 60_000;
const MAX_INTERVAL_MS = 30 * 24 * 60 * 60_000;
/** setTimeout 的上限约 24.8 天；超过就分段等待。 */
const MAX_TIMER_MS = 2_147_000_000;

const jobs = new Map<string, JobDefinition>();
const states = new Map<string, JobState>();
const timers = new Map<string, NodeJS.Timeout>();
const active = new Map<string, { controller: AbortController; startedAt: string; trigger: 'manual' | 'schedule' }>();
let runs: JobRunRecord[] = [];
let initPromise: Promise<void> | undefined;
let started = false;
let saveQueue: Promise<void> = Promise.resolve();

function startupDelayMs(): number {
	const value = Number(process.env.PI_JOB_STARTUP_DELAY_MS ?? 60_000);
	return Number.isFinite(value) && value >= 0 ? value : 60_000;
}

function clampNumber(value: unknown, fallback: number, min?: number, max?: number): number {
	const number = Number(value);
	if (!Number.isFinite(number)) return fallback;
	return Math.min(max ?? Number.MAX_SAFE_INTEGER, Math.max(min ?? Number.MIN_SAFE_INTEGER, number));
}

function defaultConfig(job: JobDefinition): Record<string, JobConfigValue> {
	return Object.fromEntries(job.fields.map((field) => [field.key, field.default]));
}

function defaultState(job: JobDefinition): JobState {
	return {
		enabled: job.defaultEnabled,
		dryRun: job.defaultDryRun,
		intervalMs: clampNumber(job.defaultIntervalMs, 6 * 60 * 60_000, MIN_INTERVAL_MS, MAX_INTERVAL_MS),
		config: defaultConfig(job),
		totalRuns: 0,
	};
}

function normalizeConfig(job: JobDefinition, raw: unknown): Record<string, JobConfigValue> {
	const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
	const config = defaultConfig(job);
	for (const field of job.fields) {
		if (!(field.key in source)) continue;
		if (field.type === 'boolean') {
			config[field.key] = Boolean(source[field.key]);
		} else {
			config[field.key] = clampNumber(source[field.key], Number(field.default), field.min, field.max);
		}
	}
	return config;
}

function normalizeState(job: JobDefinition, raw: unknown): JobState {
	const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
	const state = defaultState(job);
	if (typeof source.enabled === 'boolean') state.enabled = source.enabled;
	if (typeof source.dryRun === 'boolean') state.dryRun = source.dryRun;
	state.intervalMs = clampNumber(source.intervalMs, state.intervalMs, MIN_INTERVAL_MS, MAX_INTERVAL_MS);
	state.config = normalizeConfig(job, source.config);
	if (typeof source.lastRunAt === 'string') state.lastRunAt = source.lastRunAt;
	if (typeof source.lastFinishedAt === 'string') state.lastFinishedAt = source.lastFinishedAt;
	if (typeof source.lastAutoRunAt === 'string') state.lastAutoRunAt = source.lastAutoRunAt;
	if (source.lastStatus === 'ok' || source.lastStatus === 'error') state.lastStatus = source.lastStatus;
	if (typeof source.lastSummary === 'string') state.lastSummary = source.lastSummary;
	if (typeof source.lastError === 'string') state.lastError = source.lastError;
	if (typeof source.nextRunAt === 'string') state.nextRunAt = source.nextRunAt;
	state.totalRuns = Math.max(0, Math.floor(clampNumber(source.totalRuns, 0)));
	return state;
}

function ensureState(job: JobDefinition): JobState {
	let state = states.get(job.id);
	if (!state) {
		state = defaultState(job);
		states.set(job.id, state);
	} else {
		// 任务新增字段 / 字段默认值变化时，补齐旧状态。
		state.config = { ...defaultConfig(job), ...state.config };
	}
	return state;
}

async function loadState(): Promise<void> {
	try {
		const raw = JSON.parse(await readFile(JOBS_FILE, 'utf8'));
		const storedJobs = raw && typeof raw === 'object' && raw.jobs && typeof raw.jobs === 'object' ? raw.jobs : {};
		for (const [id, value] of Object.entries(storedJobs)) {
			const job = jobs.get(id);
			if (!job) continue;
			states.set(id, normalizeState(job, value));
		}
		if (Array.isArray(raw?.runs)) {
			runs = raw.runs
				.filter((item: unknown): item is JobRunRecord => Boolean(item && typeof item === 'object' && typeof (item as any).jobId === 'string'))
				.slice(0, RUN_HISTORY_LIMIT);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			process.stderr.write(
				`[jobs] 读取 ${JOBS_FILE} 失败：${error instanceof Error ? error.message : String(error)}\n`,
			);
		}
	}
	for (const job of jobs.values()) ensureState(job);
}

function ensureInit(): Promise<void> {
	if (!initPromise) initPromise = loadState();
	return initPromise;
}

function stateSnapshot(): { version: number; jobs: Record<string, JobState>; runs: JobRunRecord[] } {
	return {
		version: 1,
		jobs: Object.fromEntries([...states.entries()].map(([id, state]) => [id, { ...state, config: { ...state.config } }])),
		runs: runs.slice(0, RUN_HISTORY_LIMIT),
	};
}

function saveState(): Promise<void> {
	const snapshot = stateSnapshot();
	saveQueue = saveQueue
		.catch(() => undefined)
		.then(async () => {
			await mkdir(dirname(JOBS_FILE), { recursive: true });
			const tmp = `${JOBS_FILE}.${process.pid}.tmp`;
			await writeFile(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
			await rename(tmp, JOBS_FILE);
		});
	return saveQueue;
}

function view(job: JobDefinition): JobView {
	const state = ensureState(job);
	const { config, ...rest } = state;
	return {
		id: job.id,
		name: job.name,
		description: job.description,
		enabled: state.enabled,
		dryRun: state.dryRun,
		intervalMs: state.intervalMs,
		running: active.has(job.id),
		fields: job.fields.map((field) => ({ ...field })),
		config: { ...config },
		state: { ...rest },
	};
}

function clearTimer(jobId: string): void {
	const timer = timers.get(jobId);
	if (timer) clearTimeout(timer);
	timers.delete(jobId);
}

function nextRunFor(job: JobDefinition, state: JobState): number {
	const now = Date.now();
	const stored = state.nextRunAt ? Date.parse(state.nextRunAt) : NaN;
	if (Number.isFinite(stored) && stored > now) return stored;
	const lastAuto = state.lastAutoRunAt ? Date.parse(state.lastAutoRunAt) : NaN;
	if (Number.isFinite(lastAuto)) {
		const due = lastAuto + state.intervalMs;
		if (due > now) return due;
		// 已经过期：最多 1 秒后补跑，避免每次重启都等待一个完整间隔。
		return now + 1_000;
	}
	return now + startupDelayMs();
}

function armJob(job: JobDefinition): void {
	clearTimer(job.id);
	const state = ensureState(job);
	if (!state.enabled) {
		state.nextRunAt = undefined;
		return;
	}
	const now = Date.now();
	const nextAt = nextRunFor(job, state);
	state.nextRunAt = new Date(nextAt).toISOString();
	const delay = Math.min(Math.max(0, nextAt - now), MAX_TIMER_MS);
	const timer = setTimeout(() => {
		timers.delete(job.id);
		if (Date.now() < nextAt - 50) {
			armJob(job);
			return;
		}
		if (!started) return;
		if (!ensureState(job).enabled) return;
		if (active.has(job.id)) {
			// 手动任务还在跑：推迟一分钟再看，避免和手动执行并发。
			ensureState(job).nextRunAt = new Date(Date.now() + 60_000).toISOString();
			armJob(job);
			return;
		}
		void runJob(job.id, { trigger: 'schedule' });
	}, delay);
	timer.unref?.();
	timers.set(job.id, timer);
}

function formatError(error: unknown): string {
	if (error instanceof Error) {
		const stack = String(error.stack ?? '').trim();
		return (stack || error.message).slice(0, 4_000);
	}
	return String(error).slice(0, 4_000);
}

function runId(): string {
	return `run_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

export function registerJob(job: JobDefinition): void {
	if (jobs.has(job.id)) throw new Error(`定时任务已注册：${job.id}`);
	jobs.set(job.id, job);
	ensureState(job);
}

export async function startScheduler(): Promise<void> {
	await ensureInit();
	if (started) return;
	started = true;
	for (const job of jobs.values()) {
		ensureState(job);
		armJob(job);
	}
	await saveState().catch(() => undefined);
	process.stdout.write(`[jobs] scheduler started: ${[...jobs.keys()].join(', ') || '(none)'}\n`);
}

export function stopScheduler(): void {
	started = false;
	for (const timer of timers.values()) clearTimeout(timer);
	timers.clear();
	for (const run of active.values()) run.controller.abort();
	process.stdout.write('[jobs] scheduler stopped\n');
}

export async function getJobsSnapshot(): Promise<JobsSnapshot> {
	await ensureInit();
	return {
		jobs: [...jobs.values()].map(view),
		runs: runs.slice(0, RUN_HISTORY_LIMIT).map((run) => ({ ...run })),
	};
}

export async function updateJob(id: string, patch: JobUpdate): Promise<JobView> {
	await ensureInit();
	const job = jobs.get(id);
	if (!job) throw new Error(`未知定时任务：${id}`);
	const state = ensureState(job);
	if (typeof patch.enabled === 'boolean') state.enabled = patch.enabled;
	if (typeof patch.dryRun === 'boolean') state.dryRun = patch.dryRun;
	if (patch.intervalMs != null) {
		state.intervalMs = Math.floor(clampNumber(patch.intervalMs, state.intervalMs, MIN_INTERVAL_MS, MAX_INTERVAL_MS));
		state.nextRunAt = undefined;
	}
	if (patch.config) {
		for (const field of job.fields) {
			if (!(field.key in patch.config)) continue;
			const value = patch.config[field.key];
			if (field.type === 'boolean') {
				state.config[field.key] = Boolean(value);
			} else {
				state.config[field.key] = clampNumber(value, Number(state.config[field.key] ?? field.default), field.min, field.max);
			}
		}
	}
	if (started) armJob(job);
	await saveState();
	return view(job);
}

export async function runJob(
	id: string,
	options: { dryRun?: boolean; trigger?: 'manual' | 'schedule' } = {},
): Promise<JobRunResponse> {
	await ensureInit();
	const job = jobs.get(id);
	if (!job) throw new Error(`未知定时任务：${id}`);
	if (active.has(id)) return { ok: false, error: '任务正在执行，等这一轮结束' };

	const state = ensureState(job);
	const trigger = options.trigger ?? 'manual';
	const dryRun = options.dryRun ?? state.dryRun;
	const controller = new AbortController();
	const startedAt = new Date().toISOString();
	active.set(id, { controller, startedAt, trigger });
	process.stdout.write(`[jobs] ${id} start (${trigger}${dryRun ? ', dry-run' : ''})\n`);

	let result: JobRunResult | undefined;
	let errorText: string | undefined;
	try {
		result = await job.run({ dryRun, config: { ...state.config }, signal: controller.signal });
	} catch (error) {
		errorText = formatError(error);
	}

	const finishedAt = new Date().toISOString();
	const record: JobRunRecord = {
		id: runId(),
		jobId: id,
		trigger,
		dryRun,
		startedAt,
		finishedAt,
		status: errorText ? 'error' : 'ok',
		summary: result?.summary ?? (errorText ? '执行失败' : '完成'),
		error: errorText,
		detail: result?.detail,
	};

	state.lastRunAt = finishedAt;
	state.lastFinishedAt = finishedAt;
	state.lastStatus = record.status;
	state.lastSummary = record.summary;
	state.lastError = record.error;
	state.totalRuns += 1;
	if (trigger === 'schedule') state.lastAutoRunAt = finishedAt;

	runs.unshift(record);
	runs = runs.slice(0, RUN_HISTORY_LIMIT);
	active.delete(id);

	if (started && trigger === 'schedule') armJob(job);
	await saveState().catch((error) => {
		process.stderr.write(`[jobs] 保存状态失败：${error instanceof Error ? error.message : String(error)}\n`);
	});

	process.stdout.write(
		`[jobs] ${id} ${record.status} ${record.summary}${record.error ? ` (${record.error.split('\n')[0]})` : ''}\n`,
	);
	return record.status === 'ok' ? { ok: true, run: record } : { ok: false, error: record.error ?? '执行失败', run: record };
}

/** 排障用，不对外暴露。 */
export function schedulerDebugInfo() {
	return { file: JOBS_FILE, started, jobs: [...jobs.keys()], active: [...active.keys()] };
}
