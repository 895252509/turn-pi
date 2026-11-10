/** 扩展名 → 预览类型。服务端 stat.kind 是权威，这里用于图标和未知类型兜底。 */

import type { FileKind } from './types';

const MARKDOWN = new Set(['md', 'markdown']);
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif']);
const TEXT = new Set([
	'txt',
	'log',
	'json',
	'jsonl',
	'yml',
	'yaml',
	'toml',
	'ini',
	'conf',
	'env',
	'sh',
	'bash',
	'zsh',
	'py',
	'js',
	'jsx',
	'ts',
	'tsx',
	'mjs',
	'cjs',
	'vue',
	'svelte',
	'sql',
	'java',
	'kt',
	'kts',
	'go',
	'rs',
	'c',
	'h',
	'cc',
	'cpp',
	'hpp',
	'cs',
	'php',
	'rb',
	'lua',
	'r',
	'swift',
	'xml',
	'html',
	'htm',
	'css',
	'scss',
	'less',
	'csv',
	'tsv',
]);

export function extensionOf(name: string): string {
	const clean = name.split(/[?#]/, 1)[0];
	const index = clean.lastIndexOf('.');
	if (index === 0) return clean.slice(1).toLowerCase();
	return index > 0 ? clean.slice(index + 1).toLowerCase() : '';
}

export function kindFromName(name: string): FileKind {
	const ext = extensionOf(name);
	if (MARKDOWN.has(ext)) return 'markdown';
	if (ext === 'svg') return 'svg';
	if (IMAGE.has(ext)) return 'image';
	if (ext === 'pdf') return 'pdf';
	if (TEXT.has(ext)) return 'text';
	return 'unknown';
}

export function isTextLike(kind: FileKind): boolean {
	return kind === 'markdown' || kind === 'text' || kind === 'svg' || kind === 'unknown';
}

export function formatBytes(size: number): string {
	if (!Number.isFinite(size) || size < 0) return '—';
	if (size < 1024) return `${size} B`;
	if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
	if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
	return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
