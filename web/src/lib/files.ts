/** /api/files/* 只读文件 API 的前端封装。 */

import type { FileList, FileStat, FileText } from './types';

export class FilesError extends Error {
	status: number;
	code: string;

	constructor(message: string, status = 0, code = 'files/error') {
		super(message);
		this.name = 'FilesError';
		this.status = status;
		this.code = code;
	}
}

function query(root: string, path: string, extra?: Record<string, string>): string {
	const params = new URLSearchParams();
	params.set('root', root || 'workspace');
	params.set('path', path);
	for (const [key, value] of Object.entries(extra ?? {})) params.set(key, value);
	return params.toString();
}

async function request<T>(endpoint: string, root: string, path: string): Promise<T> {
	let response: Response;
	try {
		response = await fetch(`/api/files/${endpoint}?${query(root, path)}`);
	} catch (error) {
		throw new FilesError((error as Error).message || '网络请求失败', 0, 'files/network');
	}
	const data = await response.json().catch(() => ({}));
	if (!response.ok) {
		throw new FilesError(
			String(data?.error || data?.message || response.statusText || `HTTP ${response.status}`),
			response.status,
			String(data?.code || 'files/error'),
		);
	}
	return data as T;
}

export function listFiles(root: string, path: string): Promise<FileList> {
	return request<FileList>('list', root, path);
}

export function statFile(root: string, path: string): Promise<FileStat> {
	return request<FileStat>('stat', root, path);
}

export function readFileText(root: string, path: string): Promise<FileText> {
	return request<FileText>('read', root, path);
}

export function getFileRoots(): Promise<{
	roots: {
		id: string;
		label: string;
		path: string;
		readonly: boolean;
		kind?: 'dir' | 'git' | 'worktree';
		available?: boolean;
		workspaceId?: string;
		branch?: string;
	}[];
}> {
	return fetch('/api/files/roots')
		.then(async (response) => {
			const data = await response.json().catch(() => ({}));
			if (!response.ok) {
				throw new FilesError(
					String(data?.error || response.statusText),
					response.status,
					String(data?.code || 'files/error'),
				);
			}
			return data;
		})
		.catch((error) => {
			if (error instanceof FilesError) throw error;
			throw new FilesError((error as Error).message || '网络请求失败', 0, 'files/network');
		});
}

/** raw URL：中文/空格/# 都交给 URLSearchParams 处理。 */
export function rawFileUrl(
	root: string,
	path: string,
	options: { download?: boolean; version?: string } = {},
): string {
	const params = new URLSearchParams();
	params.set('root', root || 'workspace');
	params.set('path', path);
	if (options.download) params.set('download', '1');
	if (options.version) params.set('v', options.version);
	return `/api/files/raw?${params.toString()}`;
}

export function fileApiAvailable(error: unknown): boolean {
	return error instanceof FilesError && error.status !== 404 && error.status !== 0;
}

export function describeFilesError(error: unknown): string {
	if (error instanceof FilesError) {
		if (error.code === 'files/outside-root') return '路径不在工作区内';
		if (error.code === 'files/workspace-unavailable') return '工作区目录不存在，请检查挂载或重新添加';
		if (error.code === 'files/worktree-unavailable') return '隔离工作树目录不存在，可能已被手动删除';
		if (error.code === 'files/not-found') return '文件或目录不存在';
		if (error.code === 'files/not-text') return '不是 UTF-8 文本，无法预览';
		if (error.code === 'files/too-large') return '文件过大，无法预览';
		if (error.status === 404)
			return '文件 API 尚未接入（纯前端阶段），后端提供 /api/files/* 后即可浏览';
		return error.message;
	}
	return (error as Error)?.message || String(error);
}
