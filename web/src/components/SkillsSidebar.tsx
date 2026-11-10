import { useEffect } from 'react';
import { Download, LayoutGrid, Search, Star, Store, X } from 'lucide-react';
import { MobileModuleStrip } from '@/components/MobileModuleStrip';
import { useStore } from '@/lib/store';
import { useSkillMarket } from '@/lib/skillMarket';
import { BrandMark } from '@/components/BrandMark';

function compact(value: number): string {
	if (value >= 1000000) return `${(value / 1000000).toFixed(1)}m`;
	if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
	return String(value);
}

/**
 * 技能市场的上下文列：搜索、来源、分类、已安装筛选。
 * 卡片和详情在主面板，这里只负责把目录缩小到可浏览的范围。
 */
export function SkillsSidebar({ mobile = false, collapsed = false }: { mobile?: boolean; collapsed?: boolean }) {
	const drawer = useStore((s) => s.drawer);
	const closeDrawers = useStore((s) => s.closeDrawers);
	const catalog = useSkillMarket((s) => s.catalog);
	const loading = useSkillMarket((s) => s.loading);
	const error = useSkillMarket((s) => s.error);
	const query = useSkillMarket((s) => s.query);
	const category = useSkillMarket((s) => s.category);
	const sourceId = useSkillMarket((s) => s.sourceId);
	const onlyInstalled = useSkillMarket((s) => s.onlyInstalled);
	const load = useSkillMarket((s) => s.load);
	const setQuery = useSkillMarket((s) => s.setQuery);
	const setCategory = useSkillMarket((s) => s.setCategory);
	const setSource = useSkillMarket((s) => s.setSource);
	const setOnlyInstalled = useSkillMarket((s) => s.setOnlyInstalled);

	useEffect(() => {
		if (!catalog) void load();
	}, [catalog, load]);

	const sources = catalog?.sources ?? [];
	const categories = catalog?.categories ?? [];
	const skills = catalog?.skills ?? [];
	const installedCount = skills.filter((skill) => skill.installed).length;

	return (
		<aside
			className={`rail skills-rail${drawer === 'rail' ? ' open' : ''}${collapsed ? ' collapsed' : ''}`}
			inert={collapsed || undefined}
			aria-hidden={collapsed || undefined}
			aria-label="技能市场筛选"
		>
			{mobile ? <MobileModuleStrip /> : null}
			<div className="rail-head">
				<div className="rail-head-row">
					<div className="brand">
						<BrandMark />
						<div>
							<strong>技能市场</strong>
							<small>{sources.length} 个来源 · {skills.length} 个技能</small>
						</div>
					</div>
					{mobile ? (
						<button type="button" className="icon-btn rail-collapse" aria-label="关闭技能市场筛选" onClick={() => closeDrawers()}>
							<X aria-hidden="true" />
						</button>
					) : (
						<button
							type="button"
							id="skills-rail-collapse"
							className="icon-btn rail-collapse"
							title="收起筛选列（点左侧技能图标可再展开）"
							aria-label="收起技能市场筛选"
							aria-expanded="true"
							onClick={() => useStore.getState().setContextCollapsed(true)}
						>
							<X aria-hidden="true" />
						</button>
					)}
				</div>

				<label className="skills-search" htmlFor="skills-search">
					<Search aria-hidden="true" />
					<input
						id="skills-search"
						type="search"
						placeholder="搜索技能 / 描述 / 标签"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === 'Escape') {
								event.stopPropagation();
								setQuery('');
							}
						}}
					/>
				</label>

				<button
					type="button"
					className={`skills-filter skills-installed-toggle${onlyInstalled ? ' active' : ''}`}
					aria-pressed={onlyInstalled}
					onClick={() => setOnlyInstalled(!onlyInstalled)}
				>
					<Download aria-hidden="true" />
					只看已安装 · {installedCount}
				</button>
			</div>

			<div id="skills-list" className="rail-body skills-rail-body">
				{loading && !catalog ? <p className="skills-hint">正在拉取 GitHub 目录…</p> : null}
				{error && !catalog ? <p className="skills-hint err">{error}</p> : null}

				<div className="skills-filter-group">
					<span className="skills-filter-title">来源</span>
					<button
						type="button"
						className={`skills-source-row${sourceId === 'all' ? ' active' : ''}`}
						aria-pressed={sourceId === 'all'}
						onClick={() => setSource('all')}
					>
						<span className="skills-source-icon"><Store aria-hidden="true" /></span>
						<span className="skills-source-copy">
							<strong>全部来源</strong>
							<small>{sources.length} 个仓库</small>
						</span>
					</button>
					{sources.map((source) => (
						<button
							key={source.id}
							type="button"
							className={`skills-source-row${sourceId === source.id ? ' active' : ''}${source.error ? ' missing' : ''}`}
							aria-pressed={sourceId === source.id}
							title={source.error ?? source.note ?? source.description ?? source.repo}
							onClick={() => setSource(source.id)}
						>
							<span className="skills-source-icon"><LayoutGrid aria-hidden="true" /></span>
							<span className="skills-source-copy">
								<strong>{source.label}</strong>
								<small>
									<Star aria-hidden="true" /> {compact(source.stars)} · ⑂ {compact(source.forks)} · {source.skillCount} 个
								</small>
							</span>
							{source.deprecated ? <span className="skills-source-badge deprecated">弃用</span> : source.installed ? <span className="skills-source-badge">{source.installed}</span> : null}
						</button>
					))}
				</div>

				<div className="skills-filter-group">
					<span className="skills-filter-title">分类</span>
					<button
						type="button"
						className={`skills-category-row${category === 'all' ? ' active' : ''}`}
						aria-pressed={category === 'all'}
						onClick={() => setCategory('all')}
					>
						<span>全部</span>
						<small>{skills.length}</small>
					</button>
					{categories.map((item) => (
						<button
							key={item.id}
							type="button"
							className={`skills-category-row${category === item.id ? ' active' : ''}`}
							aria-pressed={category === item.id}
							onClick={() => setCategory(item.id)}
						>
							<span>{item.label}</span>
							<small>{item.count}</small>
						</button>
					))}
				</div>
			</div>

			<div className="skills-rail-foot">
				<span>{onlyInstalled ? '只看已安装' : '全部技能'}</span>
				<span>{catalog ? new Date(catalog.updatedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '—'}</span>
			</div>
		</aside>
	);
}
