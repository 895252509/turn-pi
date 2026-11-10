import { MODULES } from '@/components/ModuleRail';
import { useStore } from '@/lib/store';

/**
 * 移动端的模块条：抽屉顶部一行，替代桌面端的常驻 icon rail。
 *
 * 不做常驻底部 tab bar —— 底部要留给 composer / safe-area / iOS 自带工具条，
 * 而手机上 95% 时间是对话，低频模块不值得常驻。
 */
export function MobileModuleStrip() {
	const view = useStore((s) => s.view);
	const setView = useStore((s) => s.setView);
	const closeDrawers = useStore((s) => s.closeDrawers);

	return (
		<div id="rail-mods" className="rail-mods" role="group" aria-label="模块">
			{MODULES.map((module) => {
				const Icon = module.icon;
				const active = view === module.id;
				return (
					<button
						key={module.id}
						type="button"
						data-module={module.id}
						className={`rail-mods-btn${active ? ' active' : ''}`}
						aria-current={active ? 'page' : undefined}
						title={module.hint}
						onClick={() => {
							if (!active) setView(module.id);
							closeDrawers();
						}}
					>
						<Icon aria-hidden="true" />
						<span>{module.label}</span>
					</button>
				);
			})}
		</div>
	);
}
