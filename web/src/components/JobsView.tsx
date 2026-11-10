import { JobSettings } from '@/components/JobSettings';
import { MobileModuleStrip } from '@/components/MobileModuleStrip';
import { useIsMobile } from '@/hooks/use-mobile';

/**
 * 定时任务模块视图（rail 的「定时任务」入口）。
 *
 * 从设置弹窗迁出：任务配置 + 执行记录是整页的浏览/排障工作，弹窗里既挤又容易被
 * 「关闭设置」误关；放在模块视图里还能直接刷 hash 分享（`#/jobs`）。
 */
export function JobsView() {
	const isMobile = useIsMobile();
	return (
		<main className="module-view" id="module-jobs">
			{/* 移动端没有常驻 rail，非对话模块靠顶部模块条走回去 */}
			{isMobile ? <MobileModuleStrip /> : null}
			<div className="module-view-scroll">
				<header className="module-view-head">
					<div>
						<h1>定时任务</h1>
						<p>随 server 启动的进程内维护任务：启停、间隔配置、执行记录与异常。</p>
					</div>
				</header>
				<div className="module-view-body">
					<JobSettings />
				</div>
			</div>
		</main>
	);
}
