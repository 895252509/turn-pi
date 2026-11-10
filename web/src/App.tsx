import { useEffect, type CSSProperties } from 'react';
import { AgentsView } from '@/components/AgentsView';
import { ChatPane } from '@/components/ChatPane';
import { JobsView } from '@/components/JobsView';
import { McpView } from '@/components/McpView';
import { ModuleRail } from '@/components/ModuleRail';
import { RightPanel } from '@/components/RightPanel';
import { SkillsSidebar } from '@/components/SkillsSidebar';
import { SkillsView } from '@/components/SkillsView';
import { Sidebar } from '@/components/Sidebar';
import { Splitter } from '@/components/Splitter';
import { Toast } from '@/components/Toast';
import { useIsMobile } from '@/hooks/use-mobile';
import { clearDoneTitle, primeAudio } from '@/lib/notify';
import { applyTheme } from '@/lib/theme';
import { useContextHidden, useStore } from '@/lib/store';

function syncHeight() {
	const viewport = window.visualViewport;
	const height = viewport ? viewport.height : window.innerHeight;
	document.documentElement.style.setProperty('--app-height', `${Math.round(height)}px`);
}

export default function App() {
	const panelVisible = useStore((s) => s.panelVisible);
	const panelWidth = useStore((s) => s.panelWidth);
	const drawer = useStore((s) => s.drawer);
	const closeDrawers = useStore((s) => s.closeDrawers);
	const boot = useStore((s) => s.boot);
	const isMobile = useIsMobile();
	const theme = useStore((s) => s.theme);
	const view = useStore((s) => s.view);
	const syncViewFromHash = useStore((s) => s.syncViewFromHash);
	const contextWidth = useStore((s) => s.contextWidth);
	const layoutWidth = useStore((s) => s.layoutWidth);
	const setLayoutWidth = useStore((s) => s.setLayoutWidth);
	const contextHiddenByUser = useContextHidden();
	const railExpanded = useStore((s) => s.railExpanded);
	// 上下文列只在桌面端折叠；移动端它就是抽屉，永远由 ☰ 开关。
	// 对话 = 历史会话，技能 = 技能列表；两者共用同一条上下文轴，各记各的宽度/折叠状态。
	const hasContext = view === 'chat' || view === 'skills';
	const contextHidden = hasContext && !isMobile && contextHiddenByUser;

	useEffect(() => {
		const onResize = () => setLayoutWidth(window.innerWidth);
		onResize();
		window.addEventListener('resize', onResize);
		return () => window.removeEventListener('resize', onResize);
	}, [setLayoutWidth]);

	// hash 是视图的真相：前进/后退/手改地址都从这里同步回来
	useEffect(() => {
		const onHashChange = () => syncViewFromHash();
		window.addEventListener('hashchange', onHashChange);
		return () => window.removeEventListener('hashchange', onHashChange);
	}, [syncViewFromHash]);

	useEffect(() => {
		boot().catch((error) => console.error('boot failed', error));
	}, [boot]);

	useEffect(() => {
		applyTheme(theme);
		if (theme !== 'system') return;
		const media = window.matchMedia('(prefers-color-scheme: dark)');
		const onChange = () => applyTheme('system');
		media.addEventListener?.('change', onChange);
		return () => media.removeEventListener?.('change', onChange);
	}, [theme]);

	useEffect(() => {
		const viewport = window.visualViewport;
		const onResize = () => syncHeight();
		const onOrientation = () => window.setTimeout(syncHeight, 120);
		viewport?.addEventListener('resize', onResize);
		viewport?.addEventListener('scroll', onResize);
		/* Android Edge 地址栏伸缩有时只触发 window.resize，不触发 visualViewport */
		window.addEventListener('resize', onResize);
		window.addEventListener('orientationchange', onOrientation);
		syncHeight();
		return () => {
			viewport?.removeEventListener('resize', onResize);
			viewport?.removeEventListener('scroll', onResize);
			window.removeEventListener('resize', onResize);
			window.removeEventListener('orientationchange', onOrientation);
		};
	}, []);

	useEffect(() => {
		const prime = () => primeAudio();
		const clear = () => clearDoneTitle();
		const onVisibility = () => {
			if (!document.hidden) clearDoneTitle();
		};
		window.addEventListener('pointerdown', prime, { capture: true, passive: true });
		window.addEventListener('keydown', prime, { capture: true });
		window.addEventListener('focus', clear);
		document.addEventListener('visibilitychange', onVisibility);
		return () => {
			window.removeEventListener('pointerdown', prime, true);
			window.removeEventListener('keydown', prime, true);
			window.removeEventListener('focus', clear);
			document.removeEventListener('visibilitychange', onVisibility);
		};
	}, []);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === 'Escape') closeDrawers();
		};
		const onResize = () => {
			// 桌面端重新变宽时把抽屉收掉（移动端抽屉只在一栏布局里有效）
			if (!window.matchMedia('(max-width: 980px)').matches) closeDrawers();
		};
		window.addEventListener('keydown', onKey);
		window.addEventListener('resize', onResize);
		return () => {
			window.removeEventListener('keydown', onKey);
			window.removeEventListener('resize', onResize);
		};
	}, [closeDrawers]);

	useEffect(() => {
		document.body.classList.toggle('drawer-open', Boolean(drawer));
	}, [drawer]);

	// 移动端（含从桌面缩下来 / 旋转）进入时一律先关抽屉：右栏需要点击才打开。
	useEffect(() => {
		if (isMobile) closeDrawers();
	}, [isMobile, closeDrawers]);

	const style = {
		...(panelWidth != null ? { '--panel-w': `${panelWidth}px` } : {}),
		...(contextWidth != null ? { '--ctx-w': `${contextWidth}px` } : {}),
	} as CSSProperties;

	return (
		<>
			<div
				className={`app${panelVisible ? '' : ' no-panel'}${
					view === 'chat' ? '' : view === 'skills' ? ' view-skills' : ' view-module'
				}${contextHidden ? ' ctx-collapsed' : ''}${railExpanded ? ' rail-wide' : ''}`}
				style={style}
			>
				{isMobile ? null : <ModuleRail />}
				{view === 'chat' ? (
					<>
						{/* 常驻挂载：收起/展开靠 --ctx-f 过渡，卸载就没有动画了 */}
						<Sidebar mobile={isMobile} collapsed={contextHidden} />
						{contextHidden ? null : <Splitter target="context" />}
						<ChatPane />
						<Splitter />
						<RightPanel isMobile={isMobile} open={drawer === 'panel'} />
					</>
				) : view === 'skills' ? (
					<>
						<SkillsSidebar mobile={isMobile} collapsed={contextHidden} />
						{contextHidden ? null : <Splitter target="context" />}
						<SkillsView />
					</>
				) : view === 'jobs' ? (
					<JobsView />
				) : view === 'agents' ? (
					<AgentsView />
				) : (
					<McpView />
				)}
			</div>
			<div
				id="backdrop"
				className={`backdrop${drawer ? ' show' : ''}`}
				hidden={!drawer}
				onClick={closeDrawers}
			/>
			<Toast />
		</>
	);
}
