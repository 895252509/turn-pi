import type { ReactNode } from 'react';
import { ChevronUp } from 'lucide-react';

/**
 * 输入区上方卡片的通用外壳。
 *
 * 这里只负责「所有卡片都长一样」的部分：图标、标题、摘要、右上角的展开箭头，
 * 以及 peek / default / expanded 三档状态。卡片里的按钮、计数、详情都归具体功能
 * （凭据审批、待发送队列……）自己渲染，外壳不碰它们的布局和事件。
 *
 * 主题：`data-tone` 只负责把 `--card-tone` 换掉；app.css 里每种 tone 一条
 * `--card-tone` 覆盖即可。加新主题 = 加一个 ComposerCardTone + 一条 CSS，
 * 不需要改卡片结构。图标底色、边框、渐变都由 `--card-tone` 派生。
 */
export type ComposerCardState = 'peek' | 'default' | 'expanded';

export type ComposerCardTone =
	| 'neutral'
	| 'approval'
	| 'steering'
	| 'followUp'
	| 'info'
	| 'success'
	| 'danger';

/** 点击共用的展开箭头时按三档循环：细条 → 默认 → 完整 → 细条。 */
export function nextComposerCardState(state: ComposerCardState): ComposerCardState {
	if (state === 'peek') return 'default';
	if (state === 'default') return 'expanded';
	return 'peek';
}

export function composerCardStateLabel(state: ComposerCardState): string {
	if (state === 'peek') return '展开卡片';
	if (state === 'default') return '展开详情';
	return '收起到只留一条边';
}

interface ComposerCardProps {
	tone?: ComposerCardTone;
	icon: ReactNode;
	title: ReactNode;
	summary?: ReactNode;
	state: ComposerCardState;
	onCycle: () => void;
	/** 功能自己的内容：按钮、列表、详情都放这里，只在 default / expanded 显示。 */
	children?: ReactNode;
	className?: string;
	/** 具体功能想给摘要按钮加的类名（比如让测试/样式定位）。 */
	summaryClassName?: string;
}

export function ComposerCard({
	tone = 'neutral',
	icon,
	title,
	summary,
	state,
	onCycle,
	children,
	className,
	summaryClassName,
}: ComposerCardProps) {
	const label = composerCardStateLabel(state);
	const classes = ['composer-card', className].filter(Boolean).join(' ');

	if (state === 'peek') {
		return (
			<article className={classes} data-tone={tone} data-state={state}>
				<button
					type="button"
					className="composer-card-peek"
					title={label}
					aria-label={label}
					onClick={onCycle}
				/>
			</article>
		);
	}

	return (
		<article className={classes} data-tone={tone} data-state={state}>
			<div className="composer-card-head">
				<button
					type="button"
					className={['composer-card-summary', summaryClassName].filter(Boolean).join(' ')}
					aria-expanded={state === 'expanded'}
					title={label}
					onClick={onCycle}
				>
					<span className="composer-card-icon">{icon}</span>
					<span className="composer-card-copy">
						<strong>{title}</strong>
						{summary ? <small>{summary}</small> : null}
					</span>
					<ChevronUp className="composer-card-chevron" aria-hidden="true" />
				</button>
			</div>
			<div className="composer-card-content">{children}</div>
		</article>
	);
}
