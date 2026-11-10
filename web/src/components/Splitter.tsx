import { useCallback, useEffect, useRef, useState } from 'react';
import { CONTEXT_MAX_WIDTH, CONTEXT_MIN_WIDTH, clampContextWidth, currentContextWidth } from '@/lib/contextColumn';
import { RAIL_NARROW_WIDTH, RAIL_WIDE_WIDTH, contextWidthForViewport } from '@/lib/layout';
import { PANEL_MIN_WIDTH, clampPanelWidth, currentPanelWidth, panelMaxWidth } from '@/lib/panel';
import { useContextHidden, useStore } from '@/lib/store';

type SplitterTarget = 'panel' | 'context';

/**
 * 列宽拖拽分隔条：`target="panel"` 是聊天区/右栏之间，`target="context"` 是模块上下文列/主视图之间。
 * 拖动改宽度，双击恢复默认；方向键微调（上下文列在左，ArrowRight 变宽；右栏在右，ArrowLeft 变宽）。
 */
export function Splitter({ target = 'panel' }: { target?: SplitterTarget }) {
	const isPanel = target === 'panel';
	const panelVisible = useStore((s) => s.panelVisible);
	const panelWidth = useStore((s) => s.panelWidth);
	const setPanelWidth = useStore((s) => s.setPanelWidth);
	const contextWidth = useStore((s) => s.contextWidth);
	const setContextWidth = useStore((s) => s.setContextWidth);
	const layoutWidth = useStore((s) => s.layoutWidth);
	const railExpanded = useStore((s) => s.railExpanded);
	const view = useStore((s) => s.view);
	const contextHiddenByUser = useContextHidden();

	// 右栏最宽能拖到哪，取决于模块 rail + 上下文列当前占掉多少
	const hasContext = view === 'chat' || view === 'skills';
	const contextHidden = hasContext && layoutWidth > 980 && contextHiddenByUser;
	// 没拖过的上下文列宽度按断点算（和 CSS 的 --ctx-w 默认值一致），别用 248 高估
	const contextColumnWidth =
		contextWidth != null ? currentContextWidth(contextWidth) : contextWidthForViewport(layoutWidth);
	const reservedLeft =
		layoutWidth > 980
			? (railExpanded ? RAIL_WIDE_WIDTH : RAIL_NARROW_WIDTH) + (contextHidden ? 0 : contextColumnWidth)
			: 0;

	const [dragging, setDragging] = useState(false);
	const drag = useRef<{ startX: number; startWidth: number } | null>(null);

	const width = isPanel ? currentPanelWidth(panelWidth) : currentContextWidth(contextWidth);
	const min = isPanel ? PANEL_MIN_WIDTH : CONTEXT_MIN_WIDTH;
	const max = isPanel ? panelMaxWidth(reservedLeft) : CONTEXT_MAX_WIDTH;

	const commit = useCallback(
		(value: number, persist = true) => {
			if (isPanel) setPanelWidth(clampPanelWidth(value, reservedLeft), persist);
			else setContextWidth(clampContextWidth(value), persist);
		},
		[isPanel, reservedLeft, setContextWidth, setPanelWidth],
	);

	const finish = useCallback(() => {
		const state = drag.current;
		drag.current = null;
		setDragging(false);
		document.body.style.removeProperty('user-select');
		document.body.style.removeProperty('cursor');
		if (!state) return;
		const store = useStore.getState();
		if (isPanel) setPanelWidth(clampPanelWidth(currentPanelWidth(store.panelWidth), reservedLeft));
		else setContextWidth(clampContextWidth(currentContextWidth(store.contextWidth)));
	}, [isPanel, reservedLeft, setContextWidth, setPanelWidth]);

	// 窗口尺寸、模块 rail 宽窄、上下文列收放/宽度变化后重新夹取：
	// 拖出来的宽右栏不能把聊天区吃掉。persist=false 表示这次只是布局所迫的收缩，
	// 不去覆盖上一次手动拖出来的宽度。
	useEffect(() => {
		const store = useStore.getState();
		if (isPanel) {
			const current = store.panelWidth;
			if (current == null) return;
			const next = clampPanelWidth(current, reservedLeft);
			if (next !== current) setPanelWidth(next, false);
			return;
		}
		const current = store.contextWidth;
		if (current == null) return;
		const next = clampContextWidth(current);
		if (next !== current) setContextWidth(next);
	}, [isPanel, layoutWidth, reservedLeft, setContextWidth, setPanelWidth]);

	if (isPanel && !panelVisible) return null;

	return (
		<div
			className={`splitter${dragging ? ' dragging' : ''}`}
			data-target={target}
			role="separator"
			aria-orientation="vertical"
			aria-label={isPanel ? '拖动调整聊天区与右侧面板宽度' : '拖动调整会话列表与聊天区宽度'}
			aria-valuemin={min}
			aria-valuemax={max}
			aria-valuenow={Math.round(width)}
			tabIndex={0}
			title="拖动调整宽度 · 双击恢复默认"
			onDoubleClick={() => (isPanel ? setPanelWidth(null) : setContextWidth(null))}
			onKeyDown={(event) => {
				const direction = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
				if (direction) {
					event.preventDefault();
					const delta = isPanel ? -direction * 16 : direction * 16;
					const current = isPanel
						? currentPanelWidth(useStore.getState().panelWidth)
						: currentContextWidth(useStore.getState().contextWidth);
					commit(current + delta);
				} else if (event.key === 'Home') {
					event.preventDefault();
					if (isPanel) setPanelWidth(null);
					else setContextWidth(null);
				}
			}}
			onPointerDown={(event) => {
				if (event.button !== 0) return;
				event.preventDefault();
				event.currentTarget.setPointerCapture(event.pointerId);
				drag.current = { startX: event.clientX, startWidth: width };
				setDragging(true);
				document.body.style.userSelect = 'none';
				document.body.style.cursor = 'col-resize';
			}}
			onPointerMove={(event) => {
				const state = drag.current;
				if (!state) return;
				const delta = event.clientX - state.startX;
				// 上下文列在左（往右拖变宽），右栏在右（往左拖变宽）
				commit(state.startWidth + (isPanel ? -delta : delta), false);
			}}
			onPointerUp={(event) => {
				if (!drag.current) return;
				if (event.currentTarget.hasPointerCapture(event.pointerId)) {
					event.currentTarget.releasePointerCapture(event.pointerId);
				}
				finish();
			}}
			onPointerCancel={finish}
			onLostPointerCapture={() => {
				if (drag.current) finish();
			}}
		/>
	);
}
