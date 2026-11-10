/**
 * 浏览器侧的全局文件资源地址：`pi-resource://file/session/<id>/<path>`。
 *
 * 和服务端 `server/file-ref.ts` 保持同一套编码规则：
 *   - 每个 path segment 单独 encodeURIComponent，`:` 保持字面量；
 *   - `#L24` / `#L24-L30` 只作为行号，不属于文件身份；
 *   - 解析失败返回 null，调用方按普通文本渲染。
 */

export type FileRef =
	| {
			scope: 'session';
			sessionId: string;
			path: string;
			line?: number;
			endLine?: number;
	  }
	| {
			scope: 'absolute';
			path: string;
			line?: number;
			endLine?: number;
	  };

const PREFIX = 'pi-resource://file/';

function encodeSegment(segment: string): string {
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

export function formatFileRef(
	input:
		| { scope: 'session'; sessionId: string; path: string; line?: number; endLine?: number }
		| { scope: 'absolute'; path: string; line?: number; endLine?: number },
): string {
	if (input.scope === 'session') {
		return `${PREFIX}session/${encodeSegment(input.sessionId)}/${encodePath(input.path)}${lineFragment(input.line, input.endLine)}`;
	}
	return `${PREFIX}absolute/${encodePath(input.path).replace(/^\/+/, '')}${lineFragment(input.line, input.endLine)}`;
}

export function parseFileRef(address: string): FileRef | null {
	if (typeof address !== 'string' || !address.startsWith(PREFIX)) return null;
	const hash = address.indexOf('#');
	const base = hash >= 0 ? address.slice(0, hash) : address;
	const fragment = hash >= 0 ? address.slice(hash + 1) : '';
	const parts = base.slice(PREFIX.length).split('/');
	const scope = parts.shift();
	try {
		if (scope === 'session') {
			const id = parts.shift();
			if (!id) return null;
			const sessionId = decodeURIComponent(id);
			const path = parts.map(decodeURIComponent).join('/');
			if (!sessionId || !path) return null;
			return { scope, sessionId, path, ...parseLineFragment(fragment) };
		}
		if (scope === 'absolute') {
			const path = `/${parts.map(decodeURIComponent).join('/')}`;
			if (path === '/') return null;
			return { scope, path, ...parseLineFragment(fragment) };
		}
	} catch {
		/* 坏转义按非法地址处理 */
	}
	return null;
}

/** `<img src>` / 下载链接用：自定义 scheme 不能直接给浏览器。 */
export function fileRefRawUrl(address: string, options: { download?: boolean } = {}): string {
	const params = new URLSearchParams();
	params.set('ref', address);
	if (options.download) params.set('download', '1');
	return `/api/files/raw?${params.toString()}`;
}
