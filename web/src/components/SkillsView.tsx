import { useEffect, useMemo, useState } from 'react';
import {
	AlertTriangle,
	Check,
	Download,
	ExternalLink,
	GitFork,
	Languages,
	Menu,
	RefreshCw,
	Search,
	ShieldAlert,
	ShieldCheck,
	Sparkles,
	Star,
	X,
} from 'lucide-react';
import { MobileModuleStrip } from '@/components/MobileModuleStrip';
import { useIsMobile } from '@/hooks/use-mobile';
import { api } from '@/lib/api';
import { renderMarkdown } from '@/lib/markdown';
import { useSkillMarket, type MarketItem, type MarketSkill } from '@/lib/skillMarket';
import { useSkills } from '@/lib/skills';
import { useStore } from '@/lib/store';

function compact(value: number): string {
	if (value >= 1000000) return `${(value / 1000000).toFixed(1)}m`;
	if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
	return String(value);
}

function shortRef(ref: string): string {
	return ref ? ref.slice(0, 10) : '—';
}

function Matches({ skill, query, category, sourceId, onlyInstalled }: {
	skill: MarketSkill;
	query: string;
	category: string;
	sourceId: string;
	onlyInstalled: boolean;
}) {
	const needle = query.trim().toLowerCase();
	if (onlyInstalled && !skill.installed) return false;
	if (category !== 'all' && skill.category !== category) return false;
	if (sourceId !== 'all' && skill.sourceId !== sourceId) return false;
	if (!needle) return true;
	return [
		skill.name,
		skill.description,
		skill.category,
		skill.sourceLabel,
		skill.path,
		...skill.tags,
	].join(' ').toLowerCase().includes(needle);
}

function InstallButton({ skill, pending, onInstall }: { skill: MarketSkill; pending: boolean; onInstall: () => void }) {
	return (
		<button
			type="button"
			className={`skill-install-btn${skill.installed ? ' installed' : ''}`}
			disabled={pending}
			onClick={(event) => {
				event.stopPropagation();
				onInstall();
			}}
		>
			{skill.installed ? <Check aria-hidden="true" /> : <Download aria-hidden="true" />}
			{skill.installed ? '重新安装' : '安装'}
		</button>
	);
}

function SkillCard({ skill, onOpen, onInstall, pending }: {
	skill: MarketSkill;
	onOpen: () => void;
	onInstall: () => void;
	pending: boolean;
}) {
	return (
		<article
			className="skill-card"
			tabIndex={0}
			role="button"
			aria-label={`查看 ${skill.name}`}
			onClick={onOpen}
			onKeyDown={(event) => {
				if (event.key === 'Enter' || event.key === ' ') {
					event.preventDefault();
					onOpen();
				}
			}}
		>
			<div className="skill-card-head">
				<span className="skill-card-source">{skill.sourceLabel}</span>
				<span className="skill-card-category">{skill.category}</span>
				{skill.deprecated ? <span className="skill-card-deprecated">弃用</span> : null}
				{skill.installed ? <span className="skill-card-installed">已装</span> : null}
			</div>
			<h3>{skill.name}</h3>
			<p>{skill.description || '（这个技能没有写 description）'}</p>
			<div className="skill-card-tags">
				{skill.tags.slice(0, 3).map((tag) => <span key={tag}>{tag}</span>)}
			</div>
			<footer className="skill-card-foot">
				<span className="skill-card-stats">
					<span title="GitHub star"><Star aria-hidden="true" /> {compact(skill.stars)}</span>
					<span title="GitHub fork"><GitFork aria-hidden="true" /> {compact(skill.forks)}</span>
					<span title="本地安装数"><Download aria-hidden="true" /> {skill.installs}</span>
				</span>
				<InstallButton skill={skill} pending={pending} onInstall={onInstall} />
			</footer>
		</article>
	);
}

function SkillDetail({ skill, onClose, onInstall, pending }: {
	skill: MarketSkill;
	onClose: () => void;
	onInstall: () => void;
	pending: boolean;
}) {
	const [item, setItem] = useState<MarketItem | null>(null);
	const [contentError, setContentError] = useState<string | null>(null);
	const [translation, setTranslation] = useState<string>('');
	const [translationError, setTranslationError] = useState<string | null>(null);
	const [translationModel, setTranslationModel] = useState<string | null>(null);
	const [translating, setTranslating] = useState(false);
	const audit = useSkills((s) => s.audit);
	const loadSkills = useSkills((s) => s.load);
	const skillsSnapshot = useSkills((s) => s.snapshot);
	const loadMarket = useSkillMarket((s) => s.load);
	const showToast = useStore((s) => s.showToast);

	const installedEntry = skillsSnapshot?.entries.find(
		(entry) => entry.name === skill.name && entry.source.kind === 'market' && (entry.source.url ?? entry.source.id).includes(skill.repo),
	);

	useEffect(() => {
		let cancelled = false;
		let loaded = false;
		setItem(null);
		setContentError(null);
		setTranslation('');
		setTranslationError(null);
		setTranslationModel(null);
		setTranslating(false);

		const params = new URLSearchParams({ source: skill.sourceId, path: skill.path });
		api<MarketItem>(`/api/skills/market/item?${params}`)
			.then((data) => {
				if (cancelled) return;
				loaded = true;
				setItem(data);
				setTranslating(true);
				return api<{ translation: string; cached: boolean; model: string }>('/api/skills/market/translate', {
					source: skill.sourceId,
					path: skill.path,
				});
			})
			.then((result) => {
				if (cancelled || !result) return;
				setTranslation(result.translation);
				setTranslationModel(result.model);
			})
			.catch((error) => {
				if (cancelled) return;
				const message = error instanceof Error ? error.message : String(error);
				if (!loaded) setContentError(message);
				else setTranslationError(message);
			})
			.finally(() => {
				if (!cancelled) setTranslating(false);
			});

		return () => {
			cancelled = true;
		};
	}, [skill.sourceId, skill.path]);

	async function retryTranslation() {
		setTranslating(true);
		setTranslationError(null);
		try {
			const result = await api<{ translation: string; cached: boolean; model: string }>('/api/skills/market/translate', {
				source: skill.sourceId,
				path: skill.path,
			});
			setTranslation(result.translation);
			setTranslationModel(result.model);
		} catch (error) {
			setTranslationError(error instanceof Error ? error.message : String(error));
		} finally {
			setTranslating(false);
		}
	}

	async function setTrust(trust: 'audited' | 'unreviewed' | 'blocked') {
		if (!installedEntry) return;
		try {
			await audit(installedEntry.name, installedEntry.treeHash, trust);
			await Promise.all([loadSkills(), loadMarket()]);
			showToast(trust === 'audited' ? `${skill.name} 已审计` : trust === 'blocked' ? `${skill.name} 已拉黑` : `${skill.name} 回到未审计`);
		} catch (error) {
			showToast(error instanceof Error ? error.message : String(error));
		}
	}

	return (
		<div className="skill-detail-backdrop" role="dialog" aria-modal="true" aria-label={`${skill.name} 详情`} onClick={onClose}>
			<div className="skill-detail" onClick={(event) => event.stopPropagation()}>
				<header className="skill-detail-head">
					<div className="skill-detail-title">
						<span className="skill-detail-icon"><Sparkles aria-hidden="true" /></span>
						<div>
							<h2>{skill.name}</h2>
							<p>
								{skill.sourceLabel} · {skill.category} · {skill.license ?? 'license 未知'} · ref {shortRef(skill.tree || skill.ref)}
								{skill.deprecated ? ' · 官方已弃用' : ''}
							</p>
						</div>
					</div>
					<button type="button" className="icon-btn skill-detail-close" aria-label="关闭详情" onClick={onClose}>
						<X aria-hidden="true" />
					</button>
				</header>

				<div className="skill-detail-meta">
					<span><Star aria-hidden="true" /> {compact(skill.stars)} stars</span>
					<span><GitFork aria-hidden="true" /> {compact(skill.forks)} forks</span>
					<span><Download aria-hidden="true" /> {skill.installs} 安装</span>
					<a href={`https://github.com/${skill.repo}/tree/${skill.ref}/${skill.path}`} target="_blank" rel="noreferrer">
						<ExternalLink aria-hidden="true" /> GitHub
					</a>
				</div>

				<div className="skill-detail-actions">
					<InstallButton skill={skill} pending={pending} onInstall={onInstall} />
					{installedEntry ? (
						<>
							<span className={`skills-badge ${installedEntry.trust === 'audited' ? 'ok' : 'warn'}`}>
								{installedEntry.trust === 'audited' ? <ShieldCheck aria-hidden="true" /> : <ShieldAlert aria-hidden="true" />}
								{installedEntry.trust === 'audited' ? '已审计' : installedEntry.trust === 'blocked' ? '已拉黑' : '未审计 · 仅手动调用'}
							</span>
							{installedEntry.trust !== 'audited' ? (
								<button type="button" className="ghost small" onClick={() => void setTrust('audited')}>
									<ShieldCheck aria-hidden="true" /> 审计并启用
								</button>
							) : null}
						</>
					) : null}
				</div>

				{contentError ? (
					<div className="skills-banner err inline">
						<AlertTriangle aria-hidden="true" />
						<span>{contentError}</span>
					</div>
				) : null}

				<div className="skill-detail-panes">
					<section className="skill-detail-pane">
						<header>
							<span>原文 · SKILL.md</span>
							<small>{item ? `${item.content.length} chars` : '读取中…'}</small>
						</header>
						<div className="skill-markdown">
							{item ? <div dangerouslySetInnerHTML={{ __html: renderMarkdown(item.content) }} /> : <p className="skills-hint">正在读取 GitHub 原文…</p>}
						</div>
					</section>
					<section className="skill-detail-pane translated">
						<header>
							<span><Languages aria-hidden="true" /> 中文对照</span>
							<small>{translating ? '默认模型翻译中…' : translationModel ? `by ${translationModel}` : '等待翻译'}</small>
							{translationError ? (
								<button type="button" className="ghost small" onClick={() => void retryTranslation()}>
									重试
								</button>
							) : null}
						</header>
						<div className="skill-markdown">
							{translation ? (
								<div dangerouslySetInnerHTML={{ __html: renderMarkdown(translation) }} />
							) : (
								<p className="skills-hint">
									{translating ? '正在用默认大模型翻译，长文档会分块处理…' : translationError ?? '还没有翻译。'}
								</p>
							)}
						</div>
					</section>
				</div>
			</div>
		</div>
	);
}

export function SkillsView() {
	const isMobile = useIsMobile();
	const catalog = useSkillMarket((s) => s.catalog);
	const loading = useSkillMarket((s) => s.loading);
	const refreshing = useSkillMarket((s) => s.refreshing);
	const error = useSkillMarket((s) => s.error);
	const query = useSkillMarket((s) => s.query);
	const category = useSkillMarket((s) => s.category);
	const sourceId = useSkillMarket((s) => s.sourceId);
	const onlyInstalled = useSkillMarket((s) => s.onlyInstalled);
	const selectedKey = useSkillMarket((s) => s.selectedKey);
	const load = useSkillMarket((s) => s.load);
	const install = useSkillMarket((s) => s.install);
	const setQuery = useSkillMarket((s) => s.setQuery);
	const setCategory = useSkillMarket((s) => s.setCategory);
	const setSource = useSkillMarket((s) => s.setSource);
	const setOnlyInstalled = useSkillMarket((s) => s.setOnlyInstalled);
	const select = useSkillMarket((s) => s.select);

	const sessionId = useStore((s) => s.sessionId);
	const busy = useStore((s) => s.busy);
	const showToast = useStore((s) => s.showToast);
	const setDrawer = useStore((s) => s.setDrawer);
	const applySkills = useSkills((s) => s.apply);
	const loadSkills = useSkills((s) => s.load);

	const [pendingInstall, setPendingInstall] = useState<string | null>(null);
	const [toast, setToast] = useState<string | null>(null);

	useEffect(() => {
		void load();
		void loadSkills();
	}, [load, loadSkills]);

	const skills = catalog?.skills ?? [];
	const sources = catalog?.sources ?? [];
	const categories = catalog?.categories ?? [];
	const filtered = useMemo(
		() => skills.filter((skill) => Matches({ skill, query, category, sourceId, onlyInstalled })),
		[skills, query, category, sourceId, onlyInstalled],
	);
	const selected = selectedKey ? skills.find((skill) => skill.key === selectedKey) : undefined;
	const installed = skills.filter((skill) => skill.installed).length;
	const totalStars = sources.reduce((sum, source) => sum + source.stars, 0);

	function notify(message: string) {
		setToast(message);
		showToast(message);
		window.setTimeout(() => setToast((current) => (current === message ? null : current)), 3200);
	}

	async function installSkill(skill: MarketSkill) {
		setPendingInstall(skill.key);
		try {
			await install(skill);
			notify(`已安装 ${skill.name}，并加入当前组合`);
		} catch (reason) {
			notify(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setPendingInstall(null);
		}
	}

	async function applyToSession() {
		if (!sessionId) {
			notify('先发一条消息创建会话，再应用技能');
			return;
		}
		try {
			const result = await applySkills(sessionId);
			notify(`已应用到本会话：${result.skills.length} 个技能，下一轮生效`);
		} catch (reason) {
			notify(reason instanceof Error ? reason.message : String(reason));
		}
	}

	return (
		<main className="skills-view" id="skills-view">
			{isMobile ? <MobileModuleStrip /> : null}

			<header className="skills-head">
				<div className="skills-head-title">
					{isMobile ? (
						<button type="button" id="skills-menu" className="icon-btn only-mobile" aria-label="打开筛选" onClick={() => setDrawer('rail')}>
							<Menu aria-hidden="true" />
						</button>
					) : null}
					<Sparkles aria-hidden="true" />
					<div>
						<h1>技能市场</h1>
						<p>只收录几个公开技能库；卡片可看详情、原文与中文对照。</p>
					</div>
				</div>
				<div className="skills-head-actions">
					<label className="skills-search skills-search-main">
						<Search aria-hidden="true" />
						<input
							id="skills-search-main"
							type="search"
							placeholder="搜索技能 / 描述 / 标签"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
						/>
					</label>
					<button type="button" className="ghost small" onClick={() => void load(true)} disabled={refreshing}>
						<RefreshCw aria-hidden="true" className={refreshing ? 'spin' : undefined} />
						{refreshing ? '刷新中…' : '刷新目录'}
					</button>
					<button
						type="button"
						className="ghost small primary"
						onClick={() => void applyToSession()}
						disabled={!sessionId || busy}
						title={!sessionId ? '先发一条消息创建会话' : busy ? '生成中不能 reload' : '把已安装技能应用到本会话'}
					>
						应用到本会话
					</button>
				</div>
			</header>

			{error ? (
				<div className="skills-banner err">
					<AlertTriangle aria-hidden="true" />
					<span>{error}</span>
					<button type="button" className="ghost small" onClick={() => void load(true)}>重试</button>
				</div>
			) : null}
			{catalog?.diagnostics.length ? (
				<div className="skills-banner warn">
					<AlertTriangle aria-hidden="true" />
					<span>{catalog.diagnostics.join('；')}</span>
				</div>
			) : null}

			<div className="skills-stats" aria-label="市场统计">
				<div className="skills-stat">
					<span>技能库来源</span>
					<strong>{sources.length}</strong>
				</div>
				<div className="skills-stat">
					<span>技能总数</span>
					<strong>{skills.length}</strong>
				</div>
				<div className="skills-stat">
					<span>本地已安装</span>
					<strong>{installed}</strong>
				</div>
				<div className="skills-stat">
					<span>来源总 stars</span>
					<strong>{compact(totalStars)}</strong>
				</div>
			</div>

			<div className="skills-market-toolbar">
				<div className="skills-category-chips" role="group" aria-label="分类">
					<button type="button" className={category === 'all' ? 'active' : ''} onClick={() => setCategory('all')}>
						全部 <small>{skills.length}</small>
					</button>
					{categories.map((item) => (
						<button key={item.id} type="button" className={category === item.id ? 'active' : ''} onClick={() => setCategory(item.id)}>
							{item.label} <small>{item.count}</small>
						</button>
					))}
				</div>
				<button
					type="button"
					className={`skills-chip-toggle${onlyInstalled ? ' active' : ''}`}
					aria-pressed={onlyInstalled}
					onClick={() => setOnlyInstalled(!onlyInstalled)}
				>
					<Download aria-hidden="true" /> 只看已安装
				</button>
			</div>

			<div className="skills-card-scroll">
				{loading && !catalog ? (
					<div className="skills-empty">
						<RefreshCw aria-hidden="true" className="spin" />
						<h2>正在拉取 GitHub 技能目录…</h2>
						<p>第一次需要访问 GitHub API 和 raw.githubusercontent.com，之后会缓存 15 分钟。</p>
					</div>
				) : null}
				{!loading && !filtered.length ? (
					<div className="skills-empty">
						<Search aria-hidden="true" />
						<h2>没有匹配的技能</h2>
						<p>换一个关键词，或清除分类 / 来源 / 只看已安装筛选。</p>
						<button
							type="button"
							className="ghost small"
							onClick={() => {
								setQuery('');
								setCategory('all');
								setSource('all');
								setOnlyInstalled(false);
							}}
						>
							清除筛选
						</button>
					</div>
				) : null}
				<div className="skill-card-grid">
					{filtered.map((skill) => (
						<SkillCard
							key={skill.key}
							skill={skill}
							pending={pendingInstall === skill.key}
							onOpen={() => select(skill.key)}
							onInstall={() => void installSkill(skill)}
						/>
					))}
				</div>
			</div>

			{selected ? (
				<SkillDetail
					skill={selected}
					pending={pendingInstall === selected.key}
					onClose={() => select(null)}
					onInstall={() => void installSkill(selected)}
				/>
			) : null}

			{toast ? <div className="skills-toast" role="status">{toast}</div> : null}
		</main>
	);
}
