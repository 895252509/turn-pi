/**
 * 断点与列宽策略（纯函数，方便和 store / Splitter 共用）。
 *
 * 桌面端的列宽来源是 splitter.css 的 `--panel-w` / `--ctx-w`；这里只提供"没有用户拖拽时"
 * 的默认值和夹取规则，两边必须保持一致：
 *
 *   ≥1440          上下文列 248，右栏默认 460（四列舒展）
 *   981–1439       上下文列 220，右栏默认 400（右栏按 34% 视口夹取）
 *   <1180 且桌面   上下文列默认收起（聊天区优先），点 rail 的对话图标可手动展开
 *   ≤980           单栏 + 抽屉（列宽由 app.css 管）
 */

export const WIDE_MIN_WIDTH = 1440;
export const CONTEXT_AUTOHIDE_WIDTH = 1180;

export const CONTEXT_WIDE_WIDTH = 248;
export const CONTEXT_NARROW_WIDTH = 220;

export const PANEL_WIDE_DEFAULT = 460;
export const PANEL_NARROW_DEFAULT = 400;

/** 模块 rail 的两种宽度（与 splitter.css 的 --rail-w 保持一致） */
export const RAIL_NARROW_WIDTH = 56;
export const RAIL_WIDE_WIDTH = 184;

/**
 * 右栏拖到最宽时，聊天区至少还要留这么多。
 * 比按固定比例封顶更贴近使用：平板/窄桌面也能把文件区拖大看文档，聊天区不会归零。
 */
export const PANEL_MIN_CHAT_WIDTH = 340;

/** <1440 用窄一点的上下文列；splitter.css 里 <1440 的 `--ctx-w` 必须与此一致 */
export function contextWidthForViewport(viewportWidth: number): number {
	return viewportWidth >= WIDE_MIN_WIDTH ? CONTEXT_WIDE_WIDTH : CONTEXT_NARROW_WIDTH;
}

/** 桌面窄屏：上下文列默认收起，免得聊天区被挤到 400px 出头 */
export function shouldAutoHideContext(viewportWidth: number): boolean {
	return viewportWidth < CONTEXT_AUTOHIDE_WIDTH;
}

/**
 * 右栏能拖到的最宽值：一直放到"聊天区还剩 PANEL_MIN_CHAT_WIDTH"为止，
 * 再被硬上限兜住（超宽屏也不会离谱）。
 *
 * `reservedLeft` = 模块 rail + 上下文列已经占掉的宽度。调用方知道当前布局就传，
 * 拿不到就只按视口算（会比实际能拖的宽一点，但不会把聊天区压成 0）。
 */
export function panelMaxWidthFor(
	viewportWidth: number,
	reservedLeft = 0,
	hardMin = 320,
	hardMax = 1600,
): number {
	const ceiling = viewportWidth - Math.max(0, reservedLeft) - PANEL_MIN_CHAT_WIDTH;
	return Math.max(hardMin, Math.min(hardMax, Math.round(ceiling)));
}

/**
 * 右栏宽度夹取。用户拖过的宽度、以及窗口/左列变化后的旧宽度都会经这里再校验一次，
 * 所以缩窗口、展开宽条 rail、展开上下文列都不会出现"聊天区被右栏吃掉"。
 */
export function clampPanelWidthFor(
	viewportWidth: number,
	value: number,
	hardMin = 320,
	hardMax = 1600,
	reservedLeft = 0,
): number {
	const max = panelMaxWidthFor(viewportWidth, reservedLeft, hardMin, hardMax);
	return Math.min(max, Math.max(hardMin, Math.round(value)));
}
