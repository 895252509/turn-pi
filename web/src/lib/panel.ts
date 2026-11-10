/**
 * 右栏（Right Panel）的 tab 模型、Guide 注册表与 localStorage 持久化。
 *
 * 这里只放纯数据/纯函数，React 组件和 Zustand store 都依赖它，避免循环引用。
 * 设计见 docs/right-panel.md。
 */

import { storage } from './api';
import { PANEL_NARROW_DEFAULT, WIDE_MIN_WIDTH, clampPanelWidthFor, panelMaxWidthFor } from './layout';

export const PANEL_STORAGE_KEY = 'turnpi-panel-v1';
export const PANEL_WIDTH_KEY = 'turnpi-panel-width';

export const PANEL_DEFAULT_WIDTH = 460;
export const PANEL_MIN_WIDTH = 320;
/** 硬上限：实际能拖到的宽度还要受"聊天区至少留 PANEL_MIN_CHAT_WIDTH"约束 */
export const PANEL_MAX_WIDTH = 1600;

export type FileKind =
	| 'markdown'
	| 'text'
	| 'image'
	| 'svg'
	| 'pdf'
	| 'binary'
	| 'unknown';

export interface PanelTabSpec {
	kind: 'files' | 'file' | 'guide' | 'search';
	path?: string;
	root?: string;
	line?: number;
}

export type PanelTab =
	| { id: 'guide'; kind: 'guide' }
	| { id: 'files'; kind: 'files' }
	| { id: 'search'; kind: 'search' }
	| {
			id: `file:${string}`;
			kind: 'file';
			root: string;
			path: string;
			line?: number;
			nav: number;
	  };

export interface GuideEntry {
	id: string;
	title: string;
	description?: string;
	icon: 'files' | 'search';
	order: number;
	badge?: number;
	multiple?: boolean;
	open: () => PanelTabSpec;
}

export const GUIDE_ENTRIES: GuideEntry[] = [
	{
		id: 'files',
		title: '文件',
		description: '浏览工作区文件',
		icon: 'files',
		order: 10,
		open: () => ({ kind: 'files' }),
	},
	{
		id: 'search',
		title: '检索',
		description: '本轮联网搜索的来源',
		icon: 'search',
		order: 15,
		open: () => ({ kind: 'search' }),
	},
];

export function guideEntry(id: string): GuideEntry | undefined {
	return GUIDE_ENTRIES.find((entry) => entry.id === id);
}

export function createGuideTab(): PanelTab {
	return { id: 'guide', kind: 'guide' };
}

export function fileTabId(root: string, path: string): `file:${string}` {
	return `file:${root}:${path}`;
}

/** tab 实例化；文件 tab 需要 root + path */
export function createPanelTab(spec: PanelTabSpec): PanelTab {
	if (spec.kind === 'guide') return createGuideTab();
	if (spec.kind === 'files') return { id: 'files', kind: 'files' };
	if (spec.kind === 'search') return { id: 'search', kind: 'search' };
	const root = spec.root || 'workspace';
	const path = normalizeWorkspacePath(spec.path ?? '') ?? '';
	return {
		id: fileTabId(root, path),
		kind: 'file',
		root,
		path,
		line: positiveLine(spec.line),
		nav: 1,
	};
}

/** files 是单例；文件按 root + path 去重 */
export function sameTabKind(tab: PanelTab, spec: PanelTabSpec): boolean {
	if (tab.kind !== spec.kind) return false;
	if (tab.kind !== 'file') return true;
	const root = spec.root || 'workspace';
	const path = normalizeWorkspacePath(spec.path ?? '');
	return tab.root === root && tab.path === path;
}

function positiveLine(line: number | undefined): number | undefined {
	const value = Number(line);
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

/** POSIX 规范化；空字符串表示工作区根。`..` 逃出根时返回 null。 */
export function normalizeWorkspacePath(input: string): string | null {
	let path = String(input ?? '').replace(/\\/g, '/').trim();
	if (!path) return '';
	// 工具可能传绝对路径；只接受工作区内的绝对路径
	path = path.replace(/^\/+/, '');
	if (path === 'workspace') return '';
	if (path.startsWith('workspace/')) path = path.slice('workspace/'.length);
	const parts: string[] = [];
	for (const part of path.split('/')) {
		if (!part || part === '.') continue;
		if (part === '..') {
			if (!parts.length) return null;
			parts.pop();
			continue;
		}
		parts.push(part);
	}
	return parts.join('/');
}

/**
 * 把工具参数里的路径映射到指定 workspace 根下的相对路径。
 * 绝对路径必须落在 root 内；相对路径按 cwd=root 解释。
 * 返回 null 表示不属于这个 workspace。
 */
export function pathForWorkspace(input: string, rootPath: string): string | null {
	let path = String(input ?? '').replace(/\\/g, '/').trim();
	if (!path) return '';
	const root = String(rootPath ?? '').replace(/\/+$/, '') || '/';

	if (!path.startsWith('/')) {
		if (path === 'workspace') return '';
		if (path.startsWith('workspace/') && root === '/workspace') path = path.slice('workspace/'.length);
		return normalizeWorkspacePath(path);
	}

	if (path === root) return '';
	if (root !== '/' && path.startsWith(root + '/')) return normalizeWorkspacePath(path.slice(root.length + 1));
	// 兼容旧前端：绝对路径 /workspace/foo 视为默认 workspace 的相对路径。
	if (root === '/workspace' && path.startsWith('/workspace/')) {
		return normalizeWorkspacePath(path.slice('/workspace/'.length));
	}
	return null;
}

export function basename(path: string): string {
	const clean = path.replace(/\/+$/, '');
	const index = clean.lastIndexOf('/');
	return index >= 0 ? clean.slice(index + 1) : clean;
}

export function dirname(path: string): string {
	const clean = path.replace(/\/+$/, '');
	const index = clean.lastIndexOf('/');
	return index > 0 ? clean.slice(0, index) : '';
}

/** 在 markdown/文本里把相对路径解析到工作区；越界返回 null。 */
export function resolveRelativePath(baseDir: string, href: string): string | null {
	const raw = String(href ?? '').trim();
	if (!raw) return null;
	if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(raw)) return null;
	const withoutSuffix = raw.split(/[?#]/, 1)[0];
	let decoded = withoutSuffix;
	try {
		decoded = decodeURIComponent(withoutSuffix);
	} catch {
		/* 保留原样，交给 normalize 判断 */
	}
	const joined = decoded.startsWith('/')
		? decoded.replace(/^\/+/, '')
		: `${baseDir ? `${baseDir}/` : ''}${decoded}`;
	return normalizeWorkspacePath(joined);
}

export interface PanelState {
	visible: boolean;
	width: number | null;
	tabs: PanelTab[];
	activeTabId: string;
}

function isMobileViewport(): boolean {
	return typeof window !== 'undefined' && window.matchMedia('(max-width: 980px)').matches;
}

function validTab(raw: any): PanelTab | null {
	if (!raw || typeof raw !== 'object') return null;
	if (raw.kind === 'guide') return createGuideTab();
	if (raw.kind === 'files') return { id: 'files', kind: 'files' };
	if (raw.kind === 'search') return { id: 'search', kind: 'search' };
	if (raw.kind === 'file') {
		const root = typeof raw.root === 'string' && raw.root ? raw.root : 'workspace';
		const path = normalizeWorkspacePath(typeof raw.path === 'string' ? raw.path : '');
		if (path == null) return null;
		return {
			id: fileTabId(root, path),
			kind: 'file',
			root,
			path,
			line: positiveLine(raw.line),
			nav: Number.isFinite(Number(raw.nav)) ? Math.max(1, Math.floor(Number(raw.nav))) : 1,
		};
	}
	return null;
}

/** 读取持久化状态；坏数据/未知 kind 全部丢弃。 */
export function loadPanelState(): PanelState {
	const fallbackTabs = [createGuideTab()];
	let parsed: any = null;
	const raw = storage.get(PANEL_STORAGE_KEY);
	if (raw) {
		try {
			parsed = JSON.parse(raw);
		} catch {
			parsed = null;
		}
	}

	const tabs: PanelTab[] = [];
	const seen = new Set<string>();
	for (const item of Array.isArray(parsed?.tabs) ? parsed.tabs : []) {
		const tab = validTab(item);
		if (!tab || seen.has(tab.id)) continue;
		seen.add(tab.id);
		tabs.push(tab);
	}
	if (!tabs.length) tabs.push(...fallbackTabs);

	const active = typeof parsed?.activeTabId === 'string' ? parsed.activeTabId : '';
	const activeTabId = tabs.some((tab) => tab.id === active) ? active : tabs[0].id;

	const legacyWidth = storage.get(PANEL_WIDTH_KEY);
	const hasWidth = parsed && Object.prototype.hasOwnProperty.call(parsed, 'width');
	const widthValue = Number(hasWidth ? parsed.width : legacyWidth);
	const width =
		hasWidth && parsed?.width == null
			? null
			: Number.isFinite(widthValue) && widthValue > 0
				? Math.round(widthValue)
				: null;

	// 移动端强制从关闭态开始；桌面端恢复上次 visible
	return {
		visible: isMobileViewport() ? false : parsed?.visible !== false,
		width,
		tabs,
		activeTabId,
	};
}

export function savePanelState(state: PanelState) {
	storage.set(
		PANEL_STORAGE_KEY,
		JSON.stringify({
			visible: state.visible,
			width: state.width,
			tabs: state.tabs,
			activeTabId: state.activeTabId,
		}),
	);
	if (state.width != null) storage.set(PANEL_WIDTH_KEY, String(state.width));
	else storage.remove(PANEL_WIDTH_KEY);
}

/** 当前视口下右栏最宽能到多少（reservedLeft = 模块 rail + 上下文列占掉的宽度） */
export function panelMaxWidth(reservedLeft = 0): number {
	const viewport = typeof window === 'undefined' ? WIDE_MIN_WIDTH : window.innerWidth;
	return panelMaxWidthFor(viewport, reservedLeft, PANEL_MIN_WIDTH, PANEL_MAX_WIDTH);
}

export function clampPanelWidth(value: number, reservedLeft = 0): number {
	const viewport = typeof window === 'undefined' ? WIDE_MIN_WIDTH : window.innerWidth;
	return clampPanelWidthFor(viewport, value, PANEL_MIN_WIDTH, PANEL_MAX_WIDTH, reservedLeft);
}

/** 没拖过时的默认宽度：<1440 是 400（与 splitter.css 的 --panel-w 一致），宽屏 460 */
export function currentPanelWidth(width: number | null): number {
	if (width != null) return width;
	const viewport = typeof window === 'undefined' ? WIDE_MIN_WIDTH : window.innerWidth;
	return viewport >= WIDE_MIN_WIDTH ? PANEL_DEFAULT_WIDTH : PANEL_NARROW_DEFAULT;
}
