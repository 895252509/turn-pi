import { memo, useEffect, useRef, useState } from 'react';
import type { CSSProperties, FocusEvent, MouseEvent } from 'react';

export interface NavTurn {
	index: number;
	text: string;
	loaded: boolean;
	favorite: boolean;
}

type Tip = {
	index: number;
	text: string;
	loaded: boolean;
	favorite: boolean;
	left: number;
	top: number;
};

const TIP_WIDTH = 280;
const TIP_ESTIMATED_HEIGHT = 96;
/** 轮次多时最多显示这么多根短线，窗口跟随当前轮次滑动 */
const MAX_VISIBLE_TURNS = 24;

/**
 * 对话右侧的轮次导航条：每条短线代表一轮。
 * 当前正在看的轮次最长，已加载的中等，未加载的最短。
 */
export const TurnNavigator = memo(function TurnNavigator({
	turns,
	activeIndex,
	hidden = false,
	onJump,
}: {
	turns: NavTurn[];
	activeIndex: number | null;
	hidden?: boolean;
	onJump: (turnIndex: number) => void;
}) {
	const trackRef = useRef<HTMLDivElement | null>(null);
	const [height, setHeight] = useState(0);
	const [tip, setTip] = useState<Tip | null>(null);
	const measurable = !hidden && turns.length > 0;

	useEffect(() => {
		const el = trackRef.current;
		if (!el || typeof ResizeObserver !== 'function') return;
		const sync = (next: number) => {
			setHeight((value) => (Math.abs(value - next) > 1 ? next : value));
		};
		// 首次挂载时轮次可能还没加载，ref 为空；轮次出现后要在这里重新开始观察。
		sync(el.getBoundingClientRect().height);
		const observer = new ResizeObserver((entries) => {
			const rect = entries[0]?.contentRect;
			sync(rect?.height ?? el.getBoundingClientRect().height);
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, [measurable]);

	if (hidden || !turns.length) return null;

	const foundFocus = turns.findIndex((turn) => turn.index === activeIndex);
	const focusIndex = foundFocus >= 0 ? foundFocus : turns.length - 1;
	let windowStart = 0;
	if (turns.length > MAX_VISIBLE_TURNS) {
		windowStart = Math.max(
			0,
			Math.min(
				turns.length - MAX_VISIBLE_TURNS,
				focusIndex - Math.floor(MAX_VISIBLE_TURNS / 2),
			),
		);
	}
	const visibleTurns = turns.slice(windowStart, windowStart + MAX_VISIBLE_TURNS);
	const count = visibleTurns.length;
	const lineHeight = height > 0 ? Math.max(1, Math.min(3, Math.floor(height / count))) : 3;
	const gap =
		count > 1 && height > 0
			? Math.max(0, Math.min(8, Math.floor((height - lineHeight * count) / (count - 1))))
			: 8;

	const showTip = (event: MouseEvent<HTMLButtonElement> | FocusEvent<HTMLButtonElement>, turn: NavTurn) => {
		const rect = event.currentTarget.getBoundingClientRect();
		const left = Math.max(8, rect.left - TIP_WIDTH - 10);
		const top = Math.max(8, Math.min(window.innerHeight - TIP_ESTIMATED_HEIGHT - 8, rect.top - 10));
		setTip({ index: turn.index, text: turn.text, loaded: turn.loaded, favorite: turn.favorite, left, top });
	};

	return (
		<div className="turn-nav" ref={trackRef} aria-label="轮次导航" hidden={hidden}>
			<div
				className="turn-nav-lines"
				style={
					{
						'--nav-line-h': `${lineHeight}px`,
						'--nav-gap': `${gap}px`,
					} as CSSProperties
				}
			>
				{visibleTurns.map((turn) => {
					const current = turn.index === activeIndex;
					return (
						<button
							key={turn.index}
							type="button"
							className={`turn-nav-line ${current ? 'current' : turn.loaded ? 'loaded' : 'unloaded'}${turn.favorite ? ' favorite' : ''}`}
							aria-label={`第 ${turn.index} 轮${turn.favorite ? '（已收藏）' : ''}${turn.loaded ? '' : '（未加载）'}：${turn.text.slice(0, 80)}`}
							onClick={() => {
								setTip(null);
								onJump(turn.index);
							}}
							onMouseEnter={(event) => showTip(event, turn)}
							onMouseLeave={() => setTip(null)}
							onFocus={(event) => showTip(event, turn)}
							onBlur={() => setTip(null)}
						/>
					);
				})}
			</div>
			{tip ? (
				<div className="turn-nav-tip" role="tooltip" style={{ left: tip.left, top: tip.top }}>
					<div className="turn-nav-tip-head">
						第 {tip.index} 轮
						<span>
							{tip.favorite ? '★ 收藏 · ' : ''}
							{tip.loaded ? '已加载' : '未加载 · 点击跳转'}
						</span>
					</div>
					<div className="turn-nav-tip-text">{tip.text || '（空输入）'}</div>
				</div>
			) : null}
		</div>
	);
});
