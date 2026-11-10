import { useRef } from 'react';
import { Bot, Clock, MessageSquare, PanelLeftClose, PanelLeftOpen, Plug, Plus, Sparkles } from 'lucide-react';
import { GlobalFoot } from '@/components/GlobalFoot';
import { useContextHidden, useStore } from '@/lib/store';
import type { AppView } from '@/lib/view';
import { BrandMark } from '@/components/BrandMark';

export const MODULES: Array<{ id: AppView; label: string; hint: string; icon: typeof MessageSquare }> = [
	{ id: 'chat', label: '对话', hint: '对话与会话历史', icon: MessageSquare },
	{ id: 'agents', label: 'Agent', hint: 'Agent 模板（CARD）与工具、提示词', icon: Bot },
	{ id: 'skills', label: '技能', hint: '技能库', icon: Sparkles },
	{ id: 'mcp', label: 'MCP', hint: 'MCP 服务', icon: Plug },
	{ id: 'jobs', label: '定时任务', hint: '定时任务与执行记录', icon: Clock },
];

/**
 * 最左侧的模块导航（窄条 56px / 宽条 184px，桌面端常驻）。
 *
 * 只做一件事：切换模块。模块内的上下文列由模块自己管（对话模块 = 历史会话）。
 * 已经在对话模块时再点一次对话图标 = 展开/收起历史会话列。
 *
 * 两点布局约束：
 *  1. 每个入口都带小字标签 —— 只有图标时初次使用认不出来；
 *  2. 「新对话」的槽位**永远占位**（不可用时 visibility:hidden），
 *     否则它在消失/出现时会把下面的模块图标顶上顶下。
 */
export function ModuleRail() {
	const view = useStore((s) => s.view);
	const setView = useStore((s) => s.setView);
	const toggleContextColumn = useStore((s) => s.toggleContextColumn);
	const contextHidden = useContextHidden();
	const railExpanded = useStore((s) => s.railExpanded);
	const toggleRail = useStore((s) => s.toggleRail);
	const busy = useStore((s) => s.busy);
	const newChat = useStore((s) => s.newChat);
	const navRef = useRef<HTMLElement>(null);

	// 方向键在模块间移动焦点；Enter/Space 交给按钮自己
	function onKeyDown(event: React.KeyboardEvent<HTMLElement>) {
		const keys = ['ArrowUp', 'ArrowDown', 'Home', 'End'];
		if (!keys.includes(event.key)) return;
		const buttons = [...(navRef.current?.querySelectorAll<HTMLButtonElement>('button[data-module]') ?? [])];
		if (!buttons.length) return;
		event.preventDefault();
		const current = buttons.findIndex((button) => button === document.activeElement);
		const last = buttons.length - 1;
		let next = current;
		if (event.key === 'ArrowDown') next = current < 0 ? 0 : (current + 1) % buttons.length;
		if (event.key === 'ArrowUp') next = current < 0 ? last : (current - 1 + buttons.length) % buttons.length;
		if (event.key === 'Home') next = 0;
		if (event.key === 'End') next = last;
		buttons[next]?.focus();
	}

	return (
		<nav className="rail-nav" aria-label="模块" ref={navRef} onKeyDown={onKeyDown}>
			<div className="rail-nav-mark">
				<BrandMark className="brand-mark rail-nav-brand" />
				<span className="rail-nav-title">Turn Pi</span>
			</div>

			<div className="rail-nav-mods">
				{/* 槽位常驻：历史会话列展开时只是隐藏，不参与布局变化 */}
				<button
					type="button"
					id="rail-new-chat"
					className={`rail-nav-btn rail-nav-new${contextHidden ? '' : ' rail-nav-slot'}`}
					aria-hidden={contextHidden ? undefined : true}
					tabIndex={contextHidden ? undefined : -1}
					title="新对话"
					onClick={() => newChat()}
				>
					<Plus aria-hidden="true" />
					<span className="rail-nav-label">新对话</span>
				</button>

				{MODULES.map((module) => {
					const Icon = module.icon;
					const active = view === module.id;
					const hasContext = module.id === 'chat' || module.id === 'skills';
					const collapsedHint = active && hasContext && contextHidden;
					const contextName = module.id === 'skills' ? '技能列表' : '会话历史';
					const baseLabel =
						active && hasContext
							? collapsedHint
								? `${module.label}（${contextName}已收起）`
								: `${module.label}（${contextName}已展开）`
							: module.hint;
					const label = module.id === 'chat' && busy ? `${baseLabel} · 生成中` : baseLabel;
					return (
						<button
							key={module.id}
							type="button"
							data-module={module.id}
							className={`rail-nav-btn${active ? ' active' : ''}`}
							aria-current={active ? 'page' : undefined}
							aria-label={label}
							title={label}
							onClick={() => {
								if (active && hasContext) toggleContextColumn();
								else setView(module.id);
							}}
						>
							<Icon aria-hidden="true" />
							<span className="rail-nav-label">{module.label}</span>
							{module.id === 'chat' && busy ? <span className="rail-nav-live" aria-hidden="true" /> : null}
						</button>
					);
				})}
			</div>

			<div className="rail-nav-bottom">
				<button
					type="button"
					id="rail-wide-toggle"
					className="rail-nav-btn rail-nav-wide"
					aria-pressed={railExpanded}
					title={railExpanded ? '收起导航栏' : '展开导航栏（显示完整名称）'}
					onClick={() => toggleRail()}
				>
					{railExpanded ? <PanelLeftClose aria-hidden="true" /> : <PanelLeftOpen aria-hidden="true" />}
					<span className="rail-nav-label">{railExpanded ? '收起' : '展开'}</span>
				</button>
				<GlobalFoot />
			</div>
		</nav>
	);
}
