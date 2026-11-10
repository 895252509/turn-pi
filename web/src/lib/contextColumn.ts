/**
 * 模块内的「上下文列」（对话模块的第二列 = 历史会话列表）的宽度与折叠状态。
 *
 * 按模块分别记忆：在对话里收起历史，不该顺手把技能模块的分类列也收起来。
 * 只放纯数据/纯函数，React 组件和 store 都依赖它。
 */

import { storage } from './api';
import type { AppView } from './view';

export const CONTEXT_DEFAULT_WIDTH = 248;
export const CONTEXT_MIN_WIDTH = 200;
export const CONTEXT_MAX_WIDTH = 420;

const WIDTH_PREFIX = 'turnpi:context-width:';
const COLLAPSED_PREFIX = 'turnpi:context-collapsed:';

export function contextWidthKey(view: AppView): string {
	return `${WIDTH_PREFIX}${view}`;
}

export function contextCollapsedKey(view: AppView): string {
	return `${COLLAPSED_PREFIX}${view}`;
}

export function clampContextWidth(value: number): number {
	return Math.min(CONTEXT_MAX_WIDTH, Math.max(CONTEXT_MIN_WIDTH, Math.round(value)));
}

export function currentContextWidth(width: number | null): number {
	return width != null ? clampContextWidth(width) : CONTEXT_DEFAULT_WIDTH;
}

export function loadContextWidth(view: AppView): number | null {
	const raw = storage.get(contextWidthKey(view));
	if (!raw) return null;
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? clampContextWidth(value) : null;
}

export function saveContextWidth(view: AppView, width: number | null): void {
	if (width == null) storage.remove(contextWidthKey(view));
	else storage.set(contextWidthKey(view), String(clampContextWidth(width)));
}

export function loadContextCollapsed(view: AppView): boolean {
	return storage.get(contextCollapsedKey(view)) === '1';
}

export function saveContextCollapsed(view: AppView, collapsed: boolean): void {
	storage.set(contextCollapsedKey(view), collapsed ? '1' : '0');
}
