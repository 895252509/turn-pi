/**
 * 全局文件资源地址（内部 URL）：
 *
 *   pi-resource://file/session/<sessionId>/<path>
 *   pi-resource://file/absolute/<path>
 *
 * 地址只描述“是哪个文件”，行号放在 `#L24` / `#L24-L30` 里；
 * 同一个文件在不同行打开复用同一个右侧 tab，行号只作为导航参数。
 *
 * 这个模块不碰文件系统，只做编码/解码和 path 形状归一化；
 * 解析到 root 的工作由 `resolveFileRefTarget` 完成（root 列表由调用方注入）。
 */

import { relative, resolve, sep } from 'node:path';

export type FileRef =
	| {
			scope: 'session';
			sessionId: string;
			/** 相对会话 cwd 的路径，或 cwd 内的绝对路径 */
			path: string;
			line?: number;
			endLine?: number;
	  }
	| {
			scope: 'absolute';
			/** 绝对路径（POSIX 以 `/` 开头） */
			path: string;
			line?: number;
			endLine?: number;
	  };

const PREFIX = 'pi-resource://file/';

function encodeSegment(segment: string): string {
	// 和 dsh 一致：`:` 保持字面量，Windows 盘符读起来就是 C:
	return encodeURIComponent(segment).replace(/%3A/gi, ':');
}

function encodePath(path: string): string {
	return path
		.replace(/\\/g, '/')
		.replace(/^(?:\.\/)+/, '')
		.split('/')
		.map(encodeSegment)
		.join('/');
}

function parseLineFragment(fragment: string): { line?: number; endLine?: number } {
	if (!fragment) return {};
	const match = /^L(\d+)(?:-L?(\d+))?$/i.exec(fragment);
	if (!match) return {};
	const line = Number(match[1]);
	if (!Number.isSafeInteger(line) || line <= 0) return {};
	const end = match[2] ? Number(match[2]) : undefined;
	return {
		line,
		...(end != null && Number.isSafeInteger(end) && end >= line ? { endLine: end } : {}),
	};
}

function lineFragment(line?: number, endLine?: number): string {
	if (!Number.isSafeInteger(line) || Number(line) <= 0) return '';
	const start = Math.floor(Number(line));
	if (Number.isSafeInteger(endLine) && Number(endLine) > start) return `#L${start}-L${Math.floor(Number(endLine))}`;
	return `#L${start}`;
}

/** 构造地址；`path` 里的反斜杠会统一成 `/`。 */
export function formatFileRef(
	input:
		| { scope: 'session'; sessionId: string; path: string; line?: number; endLine?: number }
		| { scope: 'absolute'; path: string; line?: number; endLine?: number },
): string {
	if (input.scope === 'session') {
		const path = encodePath(input.path);
		return `${PREFIX}session/${encodeSegment(input.sessionId)}/${path}${lineFragment(input.line, input.endLine)}`;
	}
	const path = encodePath(input.path).replace(/^\/+/, '');
	return `${PREFIX}absolute/${path}${lineFragment(input.line, input.endLine)}`;
}

/** 解析地址；非法地址返回 null，调用方按普通文本处理。 */
export function parseFileRef(address: string): FileRef | null {
	if (typeof address !== 'string' || !address.startsWith(PREFIX)) return null;
	const hash = address.indexOf('#');
	const base = hash >= 0 ? address.slice(0, hash) : address;
	const fragment = hash >= 0 ? address.slice(hash + 1) : '';
	const rest = base.slice(PREFIX.length);
	const parts = rest.split('/');
	const scope = parts.shift();
	try {
		if (scope === 'session') {
			const id = parts.shift();
			if (!id) return null;
			const sessionId = decodeURIComponent(id);
			if (!sessionId) return null;
			const path = parts.map(decodeURIComponent).join('/');
			if (!path) return null;
			return { scope, sessionId, path, ...parseLineFragment(fragment) };
		}
		if (scope === 'absolute') {
			const path = `/${parts.map(decodeURIComponent).join('/')}`;
			if (path === '/') return null;
			return { scope, path, ...parseLineFragment(fragment) };
		}
	} catch {
		// decodeURIComponent 遇到坏转义会 throw URIError
	}
	return null;
}

export interface FileRefRoot {
	id: string;
	root: string;
}

export interface ResolvedFileRef {
	rootId: string;
	root: string;
	/** root 内相对路径，始终 `/` 分隔 */
	path: string;
	absolutePath: string;
	ref: string;
	line?: number;
	endLine?: number;
}

function withinPath(path: string, root: string): boolean {
	const clean = root.replace(/[/\\]+$/, '');
	return path === clean || path.startsWith(clean + sep);
}

function toPosix(path: string): string {
	return path.replace(/\\/g, '/');
}

/**
 * 把地址解析到某个已注册 root。
 *
 * - `session`：先取该会话的 cwd，再把相对路径拼成绝对路径；绝对路径原样使用。
 * - `absolute`：直接按绝对路径匹配 root。
 *
 * 只做词法匹配；真正的 realpath/符号链接检查由文件 API 的 `resolvePath` 负责。
 * 找不到 root（例如会话不存在、路径在 root 外）返回 undefined。
 */
export async function resolveFileRefTarget(
	ref: FileRef,
	roots: FileRefRoot[],
	cwdForSession: (sessionId: string) => Promise<string | undefined>,
): Promise<ResolvedFileRef | undefined> {
	let absolute: string;
	let line: number | undefined;
	let endLine: number | undefined;
	let canonicalPath: string;

	if (ref.scope === 'session') {
		const cwd = await cwdForSession(ref.sessionId);
		if (!cwd) return undefined;
		const normalized = ref.path.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
		absolute = normalized.startsWith('/') ? resolve(normalized) : resolve(cwd, normalized);
		// 相对路径不允许用 `..` 逃出会话 cwd；绝对路径也必须在 cwd 内。
		if (!withinPath(absolute, cwd)) return undefined;
		const relCwd = toPosix(relative(cwd, absolute));
		if (!relCwd || relCwd === '..' || relCwd.startsWith('../')) return undefined;
		canonicalPath = relCwd;
		line = ref.line;
		endLine = ref.endLine;
	} else {
		absolute = resolve(ref.path);
		canonicalPath = toPosix(absolute);
		line = ref.line;
		endLine = ref.endLine;
	}

	const match = roots
		.filter((root) => Boolean(root.root) && withinPath(absolute, root.root))
		.sort((a, b) => b.root.length - a.root.length)[0];
	if (!match) return undefined;

	const rel = toPosix(relative(match.root, absolute));
	if (!rel || rel === '..' || rel.startsWith('../')) return undefined;

	return {
		rootId: match.id,
		root: match.root,
		path: rel,
		absolutePath: absolute,
		ref: formatFileRef(
			ref.scope === 'session'
				? { scope: 'session', sessionId: ref.sessionId, path: canonicalPath, line, endLine }
				: { scope: 'absolute', path: canonicalPath, line, endLine },
		),
		...(line != null ? { line } : {}),
		...(endLine != null ? { endLine } : {}),
	};
}
