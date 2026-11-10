/** 输入框上方的通用候选菜单：/ 命令和 @ 会话引用共用。 */
import { Fragment } from 'react';
import { Command, MessageSquare } from 'lucide-react';
import type { TriggerCandidate } from '@/lib/input-trigger/types';

interface Props {
	open: boolean;
	items: readonly TriggerCandidate[];
	highlight: number;
	loading: boolean;
	onHover(index: number): void;
	onPick(index: number): void;
}

export function InputTriggerMenu({ open, items, highlight, loading, onHover, onPick }: Props) {
	if (!open) return null;
	return (
		<div className="input-trigger-menu" id="input-trigger-menu">
			<div className="input-trigger-viewport" role="listbox" aria-label="输入建议">
				{loading && items.length === 0 ? (
					<div className="input-trigger-empty" role="status">加载中…</div>
				) : null}
				{!loading && items.length === 0 ? (
					<div className="input-trigger-empty">没有匹配项</div>
				) : null}
				{items.map((item, index) => {
					const Icon = item.source === 'session' ? MessageSquare : Command;
					return (
						<Fragment key={item.id}>
							{item.section && item.section !== items[index - 1]?.section ? (
								<div className="input-trigger-section" role="presentation">{item.section}</div>
							) : null}
							<button
								id={`input-trigger-option-${index}`}
								type="button"
								role="option"
								data-source={item.source}
								aria-selected={index === highlight}
								className={`input-trigger-item${index === highlight ? ' active' : ''}${item.disabled ? ' unavailable' : ''}`}
								aria-disabled={item.disabled || undefined}
								onMouseDown={(event) => {
									event.preventDefault();
									onPick(index);
								}}
								onMouseMove={() => {
									if (index !== highlight) onHover(index);
								}}
							>
								<span className="input-trigger-icon" aria-hidden="true">
									<Icon size={14} />
								</span>
								<span className="input-trigger-title">{item.title}</span>
								{item.meta ? <span className="input-trigger-meta">{item.meta}</span> : null}
								{item.hint ? <span className="input-trigger-hint">{item.hint}</span> : null}
								{item.description ? <span className="input-trigger-desc">{item.description}</span> : null}
								{item.badge ? <span className="input-trigger-badge">{item.badge}</span> : null}
							</button>
						</Fragment>
					);
				})}
			</div>
			<div className="input-trigger-footer" aria-hidden="true">
				<span>↑↓ 选择</span>
				<span>Enter/Tab 确认</span>
				<span>Esc 关闭</span>
			</div>
		</div>
	);
}
