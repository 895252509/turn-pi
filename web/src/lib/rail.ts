/**
 * 最左模块 rail 的展示状态。
 *
 * 只有一件事要记：rail 是窄条（图标 + 小字）还是宽条（图标 + 文字横排）。
 * 与 `contextColumn.ts` 同风格：纯数据 + localStorage，组件和 store 都依赖它。
 */

import { storage } from './api';

const EXPANDED_KEY = 'turnpi:rail-expanded';

export function loadRailExpanded(): boolean {
	return storage.get(EXPANDED_KEY) === '1';
}

export function saveRailExpanded(expanded: boolean): void {
	storage.set(EXPANDED_KEY, expanded ? '1' : '0');
}

/** 窄条 56px / 宽条 184px，splitter.css 里的 `--rail-w` 必须与之一致 */
export const RAIL_NARROW_WIDTH = 56;
export const RAIL_WIDE_WIDTH = 184;
