/**
 * 只读工作区文件 API（docs/right-panel.md 第 7 节）。
 *
 * 安全边界：所有路径都限制在注册的 workspace root 内，
 * 符号链接先 realpath 再检查 containment，写操作一律拒绝。
 */

import { createReadStream } from 'node:fs';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, extname, join, resolve, sep } from 'node:path';
import { getWorkspace, listWorkspaces } from './workspaces.ts';
import { listWorktrees } from './worktrees.ts';
import { parseFileRef, resolveFileRefTarget } from './file-ref.ts';
import { sessionCwd } from './session-lookup.ts';

function positiveInt(name: string, fallback: number): number {
	const value = Number(process.env[name]);
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

const MAX_TEXT_BYTES = positiveInt('PI_FILE_MAX_TEXT_BYTES', 2 * 1024 * 1024);
const MAX_TEXT_LINES = positiveInt('PI_FILE_MAX_TEXT_LINES', 20_000);
const MAX_ENTRIES = positiveInt('PI_FILE_MAX_ENTRIES', 2000);
const MAX_RAW_BYTES = positiveInt('PI_FILE_MAX_RAW_BYTES', 64 * 1024 * 1024);

type FileKind = 'markdown' | 'text' | 'image' | 'svg' | 'pdf' | 'binary' | 'unknown';
type EntryType = 'directory' | 'file' | 'other';

interface FileEntry {
	name: string;
	type: EntryType;
	symlink?: boolean;
	blocked?: boolean;
}

const MARKDOWN = new Set(['md', 'markdown']);
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif']);
const TEXT = new Set([
	'txt', 'log', 'json', 'jsonl', 'yml', 'yaml', 'toml', 'ini', 'conf', 'env',
	'sh', 'bash', 'zsh', 'py', 'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'vue',
	'svelte', 'sql', 'java', 'kt', 'kts', 'go', 'rs', 'c', 'h', 'cc', 'cpp',
	'hpp', 'cs', 'php', 'rb', 'lua', 'r', 'swift', 'xml', 'html', 'htm', 'css',
	'scss', 'less', 'csv', 'tsv',
]);
const BINARY = new Set([
	'bin', 'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'exe', 'dll',
	'so', 'dylib', 'class', 'jar', 'wasm', 'mp3', 'mp4', 'mov', 'avi', 'mkv',
	'webm', 'wav', 'flac', 'ogg', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
	'ttf', 'otf', 'woff', 'woff2',
]);
const IMAGE_MIME: Record<string, string> = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.bmp': 'image/bmp',
	'.ico': 'image/x-icon',
	'.avif': 'image/avif',
};

class FilesError extends Error {
	status: number;
	code: string;
	headers: Record<string, string>;

	constructor(status: number, code: string, message: string, headers: Record<string, string> = {}) {
		super(message);
		this.name = 'FilesError';
		this.status = status;
		this.code = code;
		this.headers = headers;
	}
}

function badRequest(message = '请求参数不合法') {
	return new FilesError(400, 'files/bad-request', message);
}
function outsideRoot(message = '路径不在工作区内') {
	return new FilesError(403, 'files/outside-root', message);
}
function notFound(message = '文件或目录不存在') {
	return new FilesError(404, 'files/not-found', message);
}
function notFile(message = '目标不是普通文件') {
	return new FilesError(409, 'files/not-file', message);
}
function notText(message = '不是 UTF-8 文本') {
	return new FilesError(415, 'files/not-text', message);
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
	});
	res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, error: unknown) {
	const err =
		error instanceof FilesError
			? error
			: new FilesError(500, 'files/internal', error instanceof Error ? error.message : String(error));
	sendJsonWithHeaders(res, err.status, { error: err.message, code: err.code }, err.headers);
}

function sendJsonWithHeaders(
	res: ServerResponse,
	status: number,
	body: unknown,
	headers: Record<string, string>,
) {
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
		...headers,
	});
	res.end(JSON.stringify(body));
}

interface FileRoot {
	id: string;
	label: string;
	root: string;
	kind: 'dir' | 'git' | 'worktree';
	readonly: boolean;
	available: boolean;
	workspaceId?: string;
	branch?: string;
}

/** 临时目录 root 的 id；前端 store 的 fileRoots 里也是这个 id。 */
const TEMP_ROOT_ID = 'tmp';

/**
 * 临时目录 root（只读）。
 *
 * agent 常把截图 / 导出物写进 /tmp，再用 `read /tmp/x.png` 自己看；
 * 聊天工具行和 `pi-resource://file/absolute/tmp/...` 要想在右栏打开，
 * 就必顶让 /tmp 成为一个可读的 root。它不进工作区注册表：
 * 不能靠它建会话，也不能写；仍然走 realpath containment，符号链接逃不出去。
 * `PI_FILE_TMP_ROOT` 可改路径（非 POSIX 环境），前端从 `/api/files/roots` 读真实值。
 */
const TEMP_ROOT: FileRoot = {
	id: TEMP_ROOT_ID,
	label: '临时文件',
	root: process.env.PI_FILE_TMP_ROOT?.trim() || '/tmp',
	kind: 'dir',
	readonly: true,
	available: true,
};

function listRoots(): FileRoot[] {
	const workspaces: FileRoot[] = listWorkspaces().map((workspace) => ({
		id: workspace.id,
		label: workspace.label,
		root: workspace.root,
		kind: workspace.kind,
		readonly: Boolean(workspace.readonly),
		available: workspace.available !== false,
	}));
	const worktrees: FileRoot[] = listWorktrees().map((worktree) => ({
		id: worktree.id,
		label: `${worktree.workspaceLabel ?? worktree.workspaceId} · ${worktree.branch}`,
		root: worktree.path,
		kind: 'worktree',
		readonly: false,
		available: worktree.available === true && worktree.state !== 'missing',
		workspaceId: worktree.workspaceId,
		branch: worktree.branch,
	}));
	return [...workspaces, ...worktrees, TEMP_ROOT];
}

const rootRealCache = new Map<string, Promise<string>>();
function rootReal(workspace: FileRoot): Promise<string> {
	let cached = rootRealCache.get(workspace.id);
	if (!cached) {
		cached = realpath(workspace.root).catch(() => workspace.root);
		rootRealCache.set(workspace.id, cached);
	}
	return cached;
}

function within(path: string, root: string): boolean {
	return path === root || path.startsWith(root + sep);
}

/** 空字符串表示 root；拒绝 NUL 与逃出 root 的 `..`。 */
function normalizeRelative(input: string): string {
	if (input.includes('\0')) throw badRequest('路径包含非法字符');
	const parts: string[] = [];
	for (const part of input.replace(/\\/g, '/').replace(/^\/+/, '').split('/')) {
		if (!part || part === '.') continue;
		if (part === '..') {
			if (!parts.length) throw outsideRoot();
			parts.pop();
			continue;
		}
		parts.push(part);
	}
	return parts.join('/');
}

function parseRootId(id: string): FileRoot {
	if (id === TEMP_ROOT_ID) return TEMP_ROOT;
	const worktree = listWorktrees().find((item) => item.id === id);
	if (worktree) {
		if (worktree.available === false || worktree.state === 'missing') {
			throw new FilesError(
				409,
				'files/worktree-unavailable',
				`worktree 目录不存在：${worktree.branch}（${worktree.path}）`,
			);
		}
		return {
			id: worktree.id,
			label: worktree.branch,
			root: worktree.path,
			kind: 'worktree',
			readonly: false,
			available: true,
			workspaceId: worktree.workspaceId,
			branch: worktree.branch,
		};
	}
	const workspace = getWorkspace(id);
	if (!workspace) throw badRequest(`未知工作区：${id}`);
	if (workspace.available === false)
		throw new FilesError(409, 'files/workspace-unavailable', `工作区目录不存在：${workspace.label}（${workspace.root}）`);
	return {
		id: workspace.id,
		label: workspace.label,
		root: workspace.root,
		kind: workspace.kind,
		readonly: Boolean(workspace.readonly),
		available: true,
	};
}

function parseRoot(url: URL): FileRoot {
	return parseRootId(url.searchParams.get('root') || 'workspace');
}

interface ResolvedPath {
	workspace: FileRoot;
	rel: string;
	full: string;
	real: string;
}

async function resolvePath(url: URL, options: { allowEmpty?: boolean } = {}): Promise<ResolvedPath> {
	const refParam = url.searchParams.get('ref');
	let workspace: FileRoot;
	let rel: string;
	if (refParam) {
		const parsed = parseFileRef(refParam);
		if (!parsed) throw badRequest('无效的文件引用');
		const target = await resolveFileRefTarget(parsed, listRoots(), sessionCwd);
		if (!target) throw outsideRoot('文件引用不在可访问的工作区内');
		workspace = parseRootId(target.rootId);
		rel = normalizeRelative(target.path);
	} else {
		workspace = parseRoot(url);
		const raw = url.searchParams.get('path');
		if (raw == null && !options.allowEmpty) throw badRequest('缺少 path');
		rel = normalizeRelative(raw ?? '');
	}
	if (!rel && !options.allowEmpty) throw badRequest('空路径');

	const full = resolve(workspace.root, rel);
	const rootPath = await rootReal(workspace);
	if (!within(full, workspace.root)) throw outsideRoot();

	let real: string;
	try {
		real = await realpath(full);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw notFound();
		if ((error as NodeJS.ErrnoException).code === 'EACCES') throw outsideRoot('没有读取权限');
		throw error;
	}
	if (!within(real, rootPath)) throw outsideRoot();
	return { workspace, rel, full, real };
}

function extension(name: string): string {
	return name.split(/[?#]/, 1)[0].slice(name.lastIndexOf('.') + 1).toLowerCase();
}

function kindOf(name: string): FileKind {
	const ext = extension(name);
	if (MARKDOWN.has(ext)) return 'markdown';
	if (ext === 'svg') return 'svg';
	if (IMAGE.has(ext)) return 'image';
	if (ext === 'pdf') return 'pdf';
	if (TEXT.has(ext)) return 'text';
	if (BINARY.has(ext)) return 'binary';
	return 'unknown';
}

function versionOf(info: { size: number; mtimeMs: number }): string {
	return `${info.size}-${Math.floor(info.mtimeMs)}`;
}

async function fileStat(url: URL): Promise<{
	root: string;
	path: string;
	absolutePath: string;
	name: string;
	kind: FileKind;
	size: number;
	mtimeMs: number;
	version: string;
	real: string;
}> {
	const { workspace, rel, full, real } = await resolvePath(url);
	const info = await stat(real);
	if (!info.isFile()) throw notFile();
	const name = basename(rel) || basename(real);
	return {
		root: workspace.id,
		path: rel,
		absolutePath: full,
		name,
		kind: kindOf(name),
		size: info.size,
		mtimeMs: info.mtimeMs,
		version: versionOf(info),
		real,
	};
}

async function list(url: URL) {
	const { workspace, rel, full, real } = await resolvePath(url, { allowEmpty: true });
	let dirents;
	try {
		dirents = await readdir(real, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOTDIR')
			throw new FilesError(409, 'files/not-directory', '目标不是目录');
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw notFound();
		throw error;
	}
	const truncated = dirents.length > MAX_ENTRIES;
	const rootPath = await rootReal(workspace);
	const entries: FileEntry[] = await Promise.all(
		dirents.slice(0, MAX_ENTRIES).map(async (entry) => {
			const child = join(full, entry.name);
			if (!entry.isSymbolicLink()) {
				const type: EntryType = entry.isDirectory()
					? 'directory'
					: entry.isFile()
						? 'file'
						: 'other';
				return { name: entry.name, type };
			}
			try {
				const target = await realpath(child);
				if (!within(target, rootPath)) {
					return { name: entry.name, type: 'other', symlink: true, blocked: true };
				}
				const targetInfo = await stat(target);
				const type: EntryType = targetInfo.isDirectory()
					? 'directory'
					: targetInfo.isFile()
						? 'file'
						: 'other';
				return { name: entry.name, type, symlink: true };
			} catch {
				return { name: entry.name, type: 'other', symlink: true };
			}
		}),
	);
	return {
		root: workspace.id,
		path: rel,
		absolutePath: full,
		entries,
		truncated,
	};
}

function decodeUtf8(buffer: Buffer): string {
	return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
}

function decodeTextBuffer(buffer: Buffer, truncated: boolean): string {
	if (buffer.includes(0)) throw notText('文件包含 NUL 字节');
	if (!truncated) {
		try {
			return decodeUtf8(buffer);
		} catch {
			throw notText();
		}
	}

	// 截断可能切在 UTF-8 多字节字符中间：最多回退 3 字节再试。
	for (let trim = 0; trim <= 3 && trim < buffer.length; trim += 1) {
		try {
			return decodeUtf8(trim ? buffer.subarray(0, buffer.length - trim) : buffer);
		} catch {
			/* 继续回退 */
		}
	}
	throw notText();
}

async function readText(url: URL) {
	const info = await fileStat(url);
	if (info.kind === 'image' || info.kind === 'pdf' || info.kind === 'binary') throw notText();

	const byteTruncated = info.size > MAX_TEXT_BYTES;
	const length = Math.min(info.size, MAX_TEXT_BYTES + 4);
	const handle = await open(info.real, 'r');
	let buffer: Buffer;
	try {
		buffer = Buffer.alloc(length);
		const { bytesRead } = await handle.read(buffer, 0, length, 0);
		buffer = buffer.subarray(0, bytesRead);
	} finally {
		await handle.close();
	}
	if (buffer.length > MAX_TEXT_BYTES) buffer = buffer.subarray(0, MAX_TEXT_BYTES);

	let text = decodeTextBuffer(buffer, byteTruncated);
	let truncated = byteTruncated;

	const lines = text.split('\n');
	if (lines.length > MAX_TEXT_LINES) {
		text = lines.slice(0, MAX_TEXT_LINES).join('\n');
		truncated = true;
	}
	if (byteTruncated) {
		const lastNewline = text.lastIndexOf('\n');
		if (lastNewline >= 0 && lastNewline > text.length * 0.8) text = text.slice(0, lastNewline + 1);
	}

	return {
		root: info.root,
		path: info.path,
		absolutePath: info.absolutePath,
		name: info.name,
		kind: info.kind,
		size: info.size,
		mtimeMs: info.mtimeMs,
		version: info.version,
		text,
		truncated,
		eof: !truncated,
	};
}

interface ByteRange {
	start: number;
	end: number;
}

function parseRange(header: string | undefined, size: number): ByteRange | null {
	if (!header) return null;
	const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!match) throw new FilesError(416, 'files/range-not-satisfiable', 'Range 不合法');
	const startText = match[1];
	const endText = match[2];
	if (!startText && !endText)
		throw new FilesError(416, 'files/range-not-satisfiable', 'Range 不合法');

	let start: number;
	let end: number;
	if (!startText) {
		const suffix = Number(endText);
		if (!Number.isSafeInteger(suffix) || suffix <= 0 || size === 0)
			throw new FilesError(416, 'files/range-not-satisfiable', 'Range 不合法');
		start = Math.max(0, size - suffix);
		end = size - 1;
	} else {
		start = Number(startText);
		end = endText ? Number(endText) : size - 1;
	}
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
		throw new FilesError(416, 'files/range-not-satisfiable', 'Range 不合法', {
			'content-range': `bytes */${size}`,
		});
	}
	return { start, end: Math.min(end, size - 1) };
}

function contentType(name: string, kind: FileKind): string {
	const ext = extname(name).toLowerCase();
	if (kind === 'pdf') return 'application/pdf';
	if (kind === 'svg') return 'image/svg+xml';
	if (kind === 'image') return IMAGE_MIME[ext] ?? 'application/octet-stream';
	if (kind === 'markdown' || kind === 'text') return 'text/plain; charset=utf-8';
	return 'application/octet-stream';
}

function contentDisposition(name: string, attachment: boolean): string {
	const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
	const encoded = encodeURIComponent(name).replace(
		/['()*]/g,
		(char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
	);
	return `${attachment ? 'attachment' : 'inline'}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

async function raw(req: IncomingMessage, res: ServerResponse, url: URL) {
	const info = await fileStat(url);
	if (info.size > MAX_RAW_BYTES)
		throw new FilesError(413, 'files/too-large', '文件过大，无法直接读取');

	const version = `"${info.version}"`;
	if (req.headers['if-none-match'] === version) {
		res.writeHead(304, { etag: version, 'cache-control': 'no-store' });
		res.end();
		return;
	}

	let range: ByteRange | null = null;
	try {
		range = parseRange(req.headers.range, info.size);
	} catch (error) {
		if (error instanceof FilesError && error.code === 'files/range-not-satisfiable' && !error.headers['content-range']) {
			error.headers['content-range'] = `bytes */${info.size}`;
		}
		throw error;
	}

	const download = url.searchParams.get('download') === '1';
	const attachment = download || info.kind === 'binary' || info.kind === 'unknown';
	const headers: Record<string, string | number> = {
		'content-type': contentType(info.name, info.kind),
		'content-disposition': contentDisposition(info.name, attachment),
		'accept-ranges': 'bytes',
		'cache-control': 'no-store',
		etag: version,
		'x-content-type-options': 'nosniff',
	};
	if (info.kind === 'svg') {
		headers['content-security-policy'] =
			"default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'none'";
	}

	const status = range ? 206 : 200;
	const start = range?.start ?? 0;
	const end = range?.end ?? Math.max(0, info.size - 1);
	headers['content-length'] = info.size === 0 ? 0 : end - start + 1;
	if (range) headers['content-range'] = `bytes ${start}-${end}/${info.size}`;

	res.writeHead(status, headers);
	if (req.method === 'HEAD' || info.size === 0) {
		res.end();
		return;
	}
	createReadStream(info.real, { start, end }).on('error', () => {
		try {
			res.destroy();
		} catch {
			/* 已断开 */
		}
	}).pipe(res);
}

export async function handleFiles(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
	try {
		const endpoint = url.pathname.slice('/api/files/'.length);
		if (!endpoint || endpoint.includes('/')) throw badRequest('未知文件接口');
		const method = req.method ?? 'GET';

		if (endpoint === 'roots') {
			if (method !== 'GET') throw new FilesError(405, 'files/method-not-allowed', '只支持 GET');
			const roots = listRoots().map((workspace) => ({
				id: workspace.id,
				label: workspace.label,
				path: workspace.root,
				kind: workspace.kind,
				readonly: workspace.readonly,
				available: workspace.available,
				workspaceId: workspace.workspaceId,
				branch: workspace.branch,
			}));
			return sendJson(res, 200, { roots });
		}

		if (method !== 'GET' && !(endpoint === 'raw' && method === 'HEAD')) {
			throw new FilesError(405, 'files/method-not-allowed', '只支持 GET/HEAD');
		}

		if (endpoint === 'resolve') {
			const ref = url.searchParams.get('ref') ?? '';
			const parsed = parseFileRef(ref);
			if (!parsed) throw badRequest('无效的文件引用');
			const target = await resolveFileRefTarget(parsed, listRoots(), sessionCwd);
			if (!target) throw outsideRoot('文件引用不在可访问的工作区内');
			const synthetic = new URL('http://local/api/files/stat');
			synthetic.searchParams.set('root', target.rootId);
			synthetic.searchParams.set('path', target.path);
			const info = await fileStat(synthetic);
			return sendJson(res, 200, {
				root: info.root,
				path: info.path,
				absolutePath: info.absolutePath,
				display: info.path,
				address: target.ref,
				kind: info.kind,
				name: info.name,
				...(target.line != null ? { line: target.line } : {}),
				...(target.endLine != null ? { endLine: target.endLine } : {}),
			});
		}

		if (endpoint === 'list') return sendJson(res, 200, await list(url));
		if (endpoint === 'stat') {
			const { real: _real, ...info } = await fileStat(url);
			return sendJson(res, 200, info);
		}
		if (endpoint === 'read') return sendJson(res, 200, await readText(url));
		if (endpoint === 'raw') return await raw(req, res, url);
		throw badRequest('未知文件接口');
	} catch (error) {
		sendError(res, error);
	}
}
