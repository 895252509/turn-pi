/**
 * agent 主动汇报的文件卡片：校验、sidecar 持久化、历史回放。
 *
 * 设计见 docs/turn-file-cards.md：
 *   - 只接受“会话 cwd 内的普通文件”，不复制内容、不做 diff；
 *   - 每个文件带 importance（high / normal / low），前端按它排序和筛选；
 *   - sidecar 按会话一个文件：`<sessions>/.presented/<sessionId>.json`。
 */

import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { formatFileRef } from './file-ref.ts';

const SESSION_DIR = process.env.PI_SESSION_DIR ?? '/sessions';
const REPORT_DIR = join(SESSION_DIR, '.presented');
const MAX_FILES = 8;
const MAX_TURNS = 50;
/** 单个文件最多保留 50 轮，超过时按轮次从旧到新裁掉。 */
const MAX_DESCRIPTION = 200;

export type FileImportance = 'high' | 'normal' | 'low';
export type FileChange = 'created' | 'modified';

export interface ReportedFile {
	path: string;
	display: string;
	description?: string;
	change?: FileChange;
	importance: FileImportance;
	line?: number;
	address: string;
}

export interface TurnFiles {
	turn: number;
	cwd: string;
	files: ReportedFile[];
	updatedAt: number;
}

export interface ReportPayload {
	turn: number;
	callId: string;
	cwd?: string;
	files: ReportedFile[];
	rejected: { path: string; reason: string }[];
}

function safeSessionFileId(sessionId: string): string {
	return String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_');
}

function reportFilePath(sessionId: string): string {
	return join(REPORT_DIR, `${safeSessionFileId(sessionId)}.json`);
}

function within(path: string, root: string): boolean {
	const clean = root.replace(/[/\\]+$/, '');
	return path === clean || path.startsWith(clean + sep);
}

function toPosix(path: string): string {
	return path.replace(/\\/g, '/');
}

function cleanDescription(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined;
	const text = value.replace(/\s+/g, ' ').trim();
	return text ? text.slice(0, MAX_DESCRIPTION) : undefined;
}

function cleanImportance(value: unknown): FileImportance {
	return value === 'high' || value === 'low' ? value : 'normal';
}

function cleanChange(value: unknown): FileChange | undefined {
	return value === 'created' || value === 'modified' ? value : undefined;
}

function cleanLine(value: unknown): number | undefined {
	const line = Number(value);
	return Number.isSafeInteger(line) && line > 0 ? line : undefined;
}

/**
 * 校验并归一化一次汇报。
 *
 * 部分成功：合法文件进入 files，非法条目进入 rejected；只有 `files` 非空时
 * 调用方才需要写 sidecar / 发事件。
 */
export async function normalizeReported(
	target: { cwd: string; sessionId: string },
	raw: unknown,
): Promise<{ files: ReportedFile[]; rejected: { path: string; reason: string }[] }> {
	const rejected: { path: string; reason: string }[] = [];
	if (!Array.isArray(raw)) {
		return { files: [], rejected: [{ path: '', reason: 'files 必须是数组' }] };
	}

	const cwd = resolve(target.cwd);
	let cwdReal = cwd;
	try {
		cwdReal = await realpath(cwd);
	} catch {
		/* cwd 不存在时按词法路径继续，后续 lstat 会逐条报错 */
	}

	const byPath = new Map<string, ReportedFile>();
	const entries = raw.slice(0, MAX_FILES + 1);
	for (let index = 0; index < entries.length; index += 1) {
		if (index >= MAX_FILES) {
			rejected.push({ path: '', reason: `一次最多汇报 ${MAX_FILES} 个文件` });
			break;
		}
		const item = entries[index];
		if (!item || typeof item !== 'object') {
			rejected.push({ path: '', reason: '条目必须是对象' });
			continue;
		}
		const rawPath = typeof (item as any).path === 'string' ? String((item as any).path).trim() : '';
		if (!rawPath) {
			rejected.push({ path: '', reason: '缺少 path' });
			continue;
		}
		if (rawPath.includes('\0')) {
			rejected.push({ path: rawPath, reason: '路径包含非法字符' });
			continue;
		}

		const absolute = resolve(cwd, rawPath);
		if (!within(absolute, cwd)) {
			rejected.push({ path: rawPath, reason: '文件不在会话工作目录内' });
			continue;
		}

		let info;
		try {
			info = await lstat(absolute);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			rejected.push({
				path: rawPath,
				reason: code === 'ENOENT' ? '文件不存在' : '无法读取文件信息',
			});
			continue;
		}
		if (info.isSymbolicLink()) {
			rejected.push({ path: rawPath, reason: '不接受符号链接' });
			continue;
		}
		if (!info.isFile()) {
			rejected.push({ path: rawPath, reason: '不是普通文件' });
			continue;
		}

		let real: string;
		try {
			real = await realpath(absolute);
		} catch {
			rejected.push({ path: rawPath, reason: '无法解析真实路径' });
			continue;
		}
		if (!within(real, cwdReal)) {
			rejected.push({ path: rawPath, reason: '文件不在会话工作目录内' });
			continue;
		}

		const rel = toPosix(relative(cwd, absolute));
		if (!rel || rel.startsWith('../')) {
			rejected.push({ path: rawPath, reason: '文件不在会话工作目录内' });
			continue;
		}

		const line = cleanLine((item as any).line);
		const description = cleanDescription((item as any).description);
		const change = cleanChange((item as any).change);
		const file: ReportedFile = {
			path: rel,
			display: rel,
			importance: cleanImportance((item as any).importance),
			address: formatFileRef({
				scope: 'session',
				sessionId: target.sessionId,
				path: rel,
				...(line != null ? { line } : {}),
			}),
			...(description ? { description } : {}),
			...(change ? { change } : {}),
			...(line != null ? { line } : {}),
		};
		// 同一路径后到覆盖先到：agent 可能在同一次调用里重复列同一个文件。
		byPath.set(rel, file);
	}

	return { files: [...byPath.values()], rejected };
}

/** 工具结果里给模型看的文本。 */
export function renderReportText(payload: ReportPayload): string {
	const lines: string[] = [];
	if (payload.files.length) {
		lines.push(`Reported ${payload.files.length} file${payload.files.length === 1 ? '' : 's'}:`);
		for (const file of payload.files) {
			const meta = [file.change, file.importance].filter(Boolean).join(', ');
			lines.push(`- ${file.path}${meta ? ` (${meta})` : ''}${file.line ? ` #L${file.line}` : ''}`);
		}
	} else {
		lines.push('No files reported.');
	}
	if (payload.rejected.length) {
		lines.push('Rejected:');
		for (const item of payload.rejected) lines.push(`- ${item.path || '(empty)'}: ${item.reason}`);
	}
	return lines.join('\n');
}

function isReportedFile(value: unknown): value is ReportedFile {
	if (!value || typeof value !== 'object') return false;
	const file = value as any;
	return (
		typeof file.path === 'string' &&
		typeof file.display === 'string' &&
		typeof file.address === 'string' &&
		(file.importance === 'high' || file.importance === 'normal' || file.importance === 'low')
	);
}

function isTurnFiles(value: unknown): value is TurnFiles {
	if (!value || typeof value !== 'object') return false;
	const turn = value as any;
	return (
		Number.isSafeInteger(turn.turn) &&
		turn.turn > 0 &&
		typeof turn.cwd === 'string' &&
		Array.isArray(turn.files) &&
		turn.files.every(isReportedFile)
	);
}

/** 读一个会话的全部已汇报轮次；坏文件当空处理，不让历史接口失败。 */
export async function readReportedByTurn(sessionId: string): Promise<Record<string, TurnFiles>> {
	try {
		const raw = JSON.parse(await readFile(reportFilePath(sessionId), 'utf8'));
		if (!raw?.turns || typeof raw.turns !== 'object') return {};
		const out: Record<string, TurnFiles> = {};
		for (const [key, value] of Object.entries(raw.turns)) {
			if (isTurnFiles(value)) out[key] = value;
		}
		return out;
	} catch {
		return {};
	}
}

const writeQueues = new Map<string, Promise<void>>();

async function writeReported(sessionId: string, turns: Record<string, TurnFiles>): Promise<void> {
	await mkdir(REPORT_DIR, { recursive: true });
	const file = reportFilePath(sessionId);
	const tmp = `${file}.tmp`;
	await writeFile(tmp, `${JSON.stringify({ sessionId, turns }, null, 2)}\n`, 'utf8');
	await rename(tmp, file);
}

function trimTurns(turns: Record<string, TurnFiles>): Record<string, TurnFiles> {
	const keys = Object.keys(turns)
		.map((key) => Number(key))
		.filter((key) => Number.isSafeInteger(key) && key > 0)
		.sort((a, b) => a - b);
	const keep = new Set(keys.slice(-MAX_TURNS).map(String));
	const out: Record<string, TurnFiles> = {};
	for (const [key, value] of Object.entries(turns)) {
		if (keep.has(key)) out[key] = value;
	}
	return out;
}

/**
 * 把一次汇报合并进会话 sidecar。同一轮同一路径后到覆盖先到；
 * 写操作按会话串行，避免两次工具调用同时读到旧文件。
 */
export async function appendReportedFiles(
	sessionId: string,
	cwd: string,
	payload: ReportPayload,
): Promise<void> {
	const key = safeSessionFileId(sessionId);
	const run = (writeQueues.get(key) ?? Promise.resolve())
		.catch(() => undefined)
		.then(async () => {
			const turns = await readReportedByTurn(sessionId);
			const current = turns[String(payload.turn)] ?? {
				turn: payload.turn,
				cwd,
				files: [],
				updatedAt: Date.now(),
			};
			const merged = new Map(current.files.map((file) => [file.path, file]));
			for (const file of payload.files) merged.set(file.path, file);
			turns[String(payload.turn)] = {
				turn: payload.turn,
				cwd,
				files: [...merged.values()],
				updatedAt: Date.now(),
			};
			await writeReported(sessionId, trimTurns(turns));
		});
	writeQueues.set(key, run);
	await run;
}
