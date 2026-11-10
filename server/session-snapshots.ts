/**
 * session 文件的增量快照索引。
 *
 * 会话 JSONL 是追加写的：第一次读取后记住 offset，之后只解析新增字节。
 * 快照里放左侧列表和切换会话第一步需要的基本信息（轮次、token、上下文、
 * 模型、名称、自定义策略），避免每次切换都重新扫一遍完整 session 文件。
 */

import { open, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

const SESSION_DIR = process.env.PI_SESSION_DIR ?? '/sessions';
const CACHE_PATH = join(SESSION_DIR, '.session-snapshots.json');
const CACHE_VERSION = 4;

export interface SessionUsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

export interface SessionSnapshot {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	title: string;
	created: number;
	modified: number;
	messageCount: number;
	turns: number;
	steps: number;
	toolCalls: number;
	usage: SessionUsageTotals;
	model?: string;
	modelName?: string;
	thinkingLevel?: string;
	/** 最近一次 assistant 调用后的上下文 token 估算；压缩后等下一次调用前为 null */
	contextTokens: number | null;
	/** 最近一次 assistant 调用的生成速度 */
	lastTps?: number;
	codemode?: 'auto' | 'on' | 'off';
	templateId?: string;
	/** 已解析到的文件偏移；只从下一行开始继续读 */
	offset: number;
	size: number;
	mtimeMs: number;
}

type CacheFile = {
	version: number;
	sessions: SessionSnapshot[];
};

const cache = new Map<string, SessionSnapshot>();
let loaded = false;
let refreshing: Promise<SessionSnapshot[]> | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let saveQueue: Promise<void> = Promise.resolve();

function emptyUsage(): SessionUsageTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

function emptySnapshot(path: string): SessionSnapshot {
	return {
		path,
		id: '',
		cwd: '',
		title: '(空会话)',
		created: 0,
		modified: 0,
		messageCount: 0,
		turns: 0,
		steps: 0,
		toolCalls: 0,
		usage: emptyUsage(),
		contextTokens: null,
		offset: 0,
		size: 0,
		mtimeMs: 0,
	};
}

function timestampMs(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string') {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function textOf(message: any): string {
	const content = message?.content;
	if (typeof content === 'string') return content.trim();
	if (!Array.isArray(content)) return '';
	return content
		.filter((part: any) => part?.type === 'text')
		.map((part: any) => String(part.text ?? ''))
		.join(' ')
		.trim();
}

function usageOf(message: any): SessionUsageTotals | undefined {
	const usage = message?.usage;
	if (!usage) return undefined;
	const input = Number(usage.input ?? 0);
	const output = Number(usage.output ?? 0);
	const cacheRead = Number(usage.cacheRead ?? 0);
	const cacheWrite = Number(usage.cacheWrite ?? 0);
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		total: Number(usage.totalTokens ?? usage.total ?? input + output + cacheRead + cacheWrite),
	};
}

function addUsage(target: SessionUsageTotals, usage: SessionUsageTotals | undefined) {
	if (!usage) return;
	target.input += usage.input;
	target.output += usage.output;
	target.cacheRead += usage.cacheRead;
	target.cacheWrite += usage.cacheWrite;
	target.total += usage.total;
}

function titleOf(snapshot: SessionSnapshot): string {
	return (snapshot.title || '(空会话)').replace(/\s+/g, ' ').slice(0, 60);
}

function applyEntry(snapshot: SessionSnapshot, entry: any) {
	if (!entry || typeof entry !== 'object') return;
	const entryTime = timestampMs(entry.timestamp);
	if (entryTime != null && entryTime > snapshot.modified) snapshot.modified = entryTime;

	if (entry.type === 'session' && !snapshot.id) {
		snapshot.id = typeof entry.id === 'string' ? entry.id : '';
		snapshot.cwd = typeof entry.cwd === 'string' ? entry.cwd : '';
		snapshot.created = timestampMs(entry.timestamp) ?? 0;
		if (entry.parentSession && typeof entry.parentSession === 'string') {
			// 只用于树关系，不参与基本展示；保留字段在需要时可从这里扩展。
		}
		return;
	}

	if (entry.type === 'session_info') {
		snapshot.name = typeof entry.name === 'string' ? entry.name.trim() || undefined : undefined;
		return;
	}
	if (entry.type === 'thinking_level_change') {
		if (typeof entry.thinkingLevel === 'string') snapshot.thinkingLevel = entry.thinkingLevel;
		return;
	}
	if (entry.type === 'model_change') {
		snapshot.model = [entry.provider, entry.modelId].filter(Boolean).join('/') || snapshot.model;
		snapshot.modelName = String(entry.modelId ?? snapshot.modelName ?? snapshot.model ?? '');
		return;
	}

	if (entry.type === 'custom') {
		if (entry.customType === 'codemode-mode') {
			const mode = entry.data?.mode;
			if (mode === 'auto' || mode === 'on' || mode === 'off') snapshot.codemode = mode;
		} else if (entry.customType === 'agent-template') {
			if (typeof entry.data?.id === 'string' && entry.data.id.trim()) snapshot.templateId = entry.data.id.trim();
		}
		return;
	}

	if (entry.type === 'compaction') {
		// 压缩后旧的 contextTokens 不再可信，等下一次 assistant 调用校准。
		snapshot.contextTokens = null;
		addUsage(snapshot.usage, usageOf(entry));
		return;
	}
	if (entry.type === 'branch_summary') {
		addUsage(snapshot.usage, usageOf(entry));
		return;
	}
	if (entry.type === 'usage') {
		addUsage(snapshot.usage, usageOf(entry));
		return;
	}
	if (entry.type !== 'message') return;

	snapshot.messageCount += 1;
	const message = entry.message;
	const messageTime = timestampMs(message?.timestamp) ?? entryTime;
	if (messageTime != null && messageTime > snapshot.modified) snapshot.modified = messageTime;
	if (message?.role === 'user') {
		snapshot.turns += 1;
		if (snapshot.title === '(空会话)') {
			const text = textOf(message);
			if (text) snapshot.title = text;
		}
		return;
	}
	if (message?.role === 'toolResult') {
		addUsage(snapshot.usage, usageOf(message));
		return;
	}
	if (message?.role !== 'assistant') return;

	snapshot.steps += 1;
	const content = Array.isArray(message.content) ? message.content : [];
	snapshot.toolCalls += content.filter((block: any) => block?.type === 'toolCall').length;
	const usage = usageOf(message);
	addUsage(snapshot.usage, usage);
	if (usage && usage.total > 0) snapshot.contextTokens = usage.total;
	if (message.provider || message.model) {
		snapshot.model = [message.provider, message.model].filter(Boolean).join('/');
		snapshot.modelName = String(message.model ?? snapshot.model);
	}
	const durationMs = Number(message.durationMs);
	if (usage && usage.output > 0 && Number.isFinite(durationMs) && durationMs > 0) {
		snapshot.lastTps = Number((usage.output / (durationMs / 1000)).toFixed(1));
	}
}

/** 只解析完整行；末尾没有换行的半行留到下次。 */
async function readAppended(snapshot: SessionSnapshot) {
	const start = Math.min(snapshot.offset, snapshot.size);
	const length = snapshot.size - start;
	if (length <= 0) return;
	const handle = await open(snapshot.path, 'r');
	try {
		const buffer = Buffer.alloc(length);
		await handle.read(buffer, 0, length, start);
		const lastNewline = buffer.lastIndexOf(0x0a);
		if (lastNewline < 0) return;
		const text = buffer.subarray(0, lastNewline + 1).toString('utf8');
		for (const line of text.split('\n')) {
			if (!line.trim()) continue;
			try {
				applyEntry(snapshot, JSON.parse(line));
			} catch {
				/* 坏行跳过，和 SessionManager 的行为一致 */
			}
		}
		snapshot.offset = start + lastNewline + 1;
	} finally {
		await handle.close();
	}
}

async function readSnapshot(path: string): Promise<SessionSnapshot | undefined> {
	let info;
	try {
		info = await stat(path);
	} catch {
		return undefined;
	}
	const previous = cache.get(path);
	const snapshot =
		previous && previous.size <= info.size && previous.mtimeMs <= info.mtimeMs
			? { ...previous, usage: { ...previous.usage } }
			: emptySnapshot(path);
	if (!snapshot.id) {
		snapshot.title = '(空会话)';
		snapshot.created = Number(info.birthtimeMs) || Number(info.mtimeMs) || 0;
	}
	snapshot.size = info.size;
	snapshot.mtimeMs = info.mtimeMs;
	await readAppended(snapshot);
	if (!snapshot.id) snapshot.id = basename(path).replace(/\.jsonl$/, '');
	if (!snapshot.created) snapshot.created = Number(info.birthtimeMs) || Number(info.mtimeMs) || 0;
	if (!snapshot.modified) snapshot.modified = snapshot.created || info.mtimeMs;
	snapshot.title = titleOf(snapshot);
	cache.set(path, snapshot);
	return snapshot;
}

async function loadCache() {
	if (loaded) return;
	loaded = true;
	try {
		const raw = await readFile(CACHE_PATH, 'utf8');
		const data = JSON.parse(raw) as CacheFile;
		if (data?.version !== CACHE_VERSION || !Array.isArray(data.sessions)) return;
		for (const snapshot of data.sessions) {
			if (!snapshot?.path || typeof snapshot.path !== 'string') continue;
			cache.set(snapshot.path, {
				...emptySnapshot(snapshot.path),
				...snapshot,
				usage: { ...emptyUsage(), ...snapshot.usage },
			});
		}
	} catch {
		/* 首次运行或缓存损坏：重新扫描 */
	}
}

function scheduleSave() {
	if (saveTimer) return;
	saveTimer = setTimeout(() => {
		saveTimer = undefined;
		const data: CacheFile = { version: CACHE_VERSION, sessions: [...cache.values()] };
		saveQueue = saveQueue
			.then(async () => {
				const tmp = `${CACHE_PATH}.${process.pid}.tmp`;
				await writeFile(tmp, JSON.stringify(data), 'utf8');
				await rename(tmp, CACHE_PATH);
			})
			.catch(() => {
				/* 缓存写失败不影响读取 */
			});
	}, 600);
	saveTimer.unref?.();
}

async function scanFiles(): Promise<string[]> {
	try {
		const entries = await readdir(SESSION_DIR, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
			.map((entry) => join(SESSION_DIR, entry.name));
	} catch {
		return [];
	}
}

async function doRefresh(): Promise<SessionSnapshot[]> {
	await loadCache();
	const paths = await scanFiles();
	const seen = new Set(paths);
	for (const path of [...cache.keys()]) {
		if (!seen.has(path)) cache.delete(path);
	}
	// 首次建立缓存时文件较多；并发 8 个已经足够压满本地 I/O。
	const results: SessionSnapshot[] = [];
	let cursor = 0;
	const workers = Array.from({ length: Math.min(8, paths.length) }, async () => {
		for (;;) {
			const index = cursor++;
			if (index >= paths.length) return;
			try {
				const snapshot = await readSnapshot(paths[index]);
				if (snapshot) results.push(snapshot);
			} catch {
				/* 单个文件读失败不阻断其它会话 */
			}
		}
	});
	await Promise.all(workers);
	scheduleSave();
	return results.sort((a, b) => b.modified - a.modified);
}

export async function refreshSessionSnapshots(): Promise<SessionSnapshot[]> {
	if (refreshing) return refreshing;
	refreshing = doRefresh().finally(() => {
		refreshing = undefined;
	});
	return refreshing;
}

export async function listSessionSnapshots(): Promise<SessionSnapshot[]> {
	return refreshSessionSnapshots();
}

export async function getSessionSnapshot(idOrPath: string): Promise<SessionSnapshot | undefined> {
	const snapshots = await refreshSessionSnapshots();
	return snapshots.find((snapshot) => snapshot.id === idOrPath || snapshot.path === idOrPath);
}
