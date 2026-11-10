import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
	AlertTriangle,
	Bot,
	Check,
	GitFork,
	Merge,
	Plus,
	RefreshCw,
	Save,
	Sparkles,
	Wrench,
} from 'lucide-react';
import { MobileModuleStrip } from '@/components/MobileModuleStrip';
import { useIsMobile } from '@/hooks/use-mobile';
import { api } from '@/lib/api';
import { useStore } from '@/lib/store';
import type {
	AgentMergeChange,
	AgentPreview,
	AgentSkillRef,
	AgentSummary,
	AgentToolInfo,
} from '@/lib/types';

interface AgentsPayload {
	agents: AgentSummary[];
	tools: AgentToolInfo[];
	skills: AgentSkillRef[];
	pinnedTools: string[];
}

interface Draft {
	id: string;
	description: string;
	kind: AgentSummary['kind'];
	domain: string;
	tools: string[];
	skills: string[];
	model: string;
	thinking: string;
	prompt: string;
	parent: string | null;
	maxActive: number;
	external: boolean;
	status: string;
	writable: boolean;
	/** 还没落盘（fork 之后在编辑，或者刚打开"新建"） */
	isNew: boolean;
}

const THINKING_LEVELS = ['off', 'low', 'medium', 'high'];

function toDraft(card: AgentSummary): Draft {
	return {
		id: card.id,
		description: card.description ?? '',
		kind: card.kind,
		domain: card.domain,
		tools: [...card.tools],
		skills: [...card.skills],
		model: card.model,
		thinking: card.thinking || 'high',
		prompt: card.prompt ?? '',
		parent: card.parent ?? null,
		maxActive: card.maxActive ?? 1,
		external: Boolean(card.external),
		status: card.status || 'active',
		writable: card.writable !== false,
		isNew: false,
	};
}

const KIND_LABELS: Record<Draft['kind'], string> = {
	base: '原型',
	domain: '岗位',
	variant: '临时工',
	orchestrator: '主脑',
};

function k(value: number): string {
	if (!Number.isFinite(value)) return '—';
	if (value < 1000) return String(Math.round(value));
	return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)}k`;
}

/** 三列：模板列表 / 编辑器 / 预览。预览来自服务端 dry-run 会话，不是前端重拼。 */
export function AgentsView() {
	const isMobile = useIsMobile();
	const models = useStore((s) => s.models);
	const setAgentTemplate = useStore((s) => s.setAgentTemplate);
	const selectAgentTemplate = useStore((s) => s.agentTemplateId);
	const setView = useStore((s) => s.setView);
	const showToast = useStore((s) => s.showToast);

	const [payload, setPayload] = useState<AgentsPayload | null>(null);
	const [selected, setSelected] = useState<string | null>(null);
	const [draft, setDraft] = useState<Draft | null>(null);
	const [saved, setSaved] = useState<Draft | null>(null);
	const [preview, setPreview] = useState<AgentPreview | null>(null);
	const [previewError, setPreviewError] = useState<string | null>(null);
	const [previewCodemode, setPreviewCodemode] = useState(false);
	const [saving, setSaving] = useState(false);
	const [loading, setLoading] = useState(true);
	const [forkName, setForkName] = useState('');
	const [merge, setMerge] = useState<{ changes: AgentMergeChange[]; blocked?: string } | null>(null);
	const [mergePicked, setMergePicked] = useState<string[]>([]);
	const [error, setError] = useState<string | null>(null);
	/** 移动端一次只显示一块：模板 / 编辑 / 预览（桌面端忽略） */
	const [pane, setPane] = useState<'list' | 'edit' | 'preview'>('list');
	const previewSeq = useRef(0);

	const load = useCallback(async (select?: string) => {
		setLoading(true);
		try {
			const data = await api<AgentsPayload>('/api/agents');
			setPayload(data);
			// 默认落在可用的岗位上：main 是主脑（不直接执行），base 是只读原型，
			// 默认打开它们只会让人看到一堆不能动的东西。
			const rank = (kind: string) => (kind === 'domain' ? 0 : kind === 'variant' ? 1 : kind === 'orchestrator' ? 2 : 3);
			const preferred = [...data.agents].sort((a, b) => rank(a.kind) - rank(b.kind))[0]?.id ?? null;
			const next = select ?? selected ?? preferred;
			setSelected(next);
			const card = data.agents.find((agent) => agent.id === next);
			if (card) {
				setDraft(toDraft(card));
				setSaved(toDraft(card));
			} else {
				setDraft(null);
				setSaved(null);
			}
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, [selected]);

	useEffect(() => {
		load().catch(() => {});
		// 只在挂载时拉一次；后续刷新走显式按钮
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const dirty = useMemo(() => {
		if (!draft || !saved) return false;
		return JSON.stringify({ ...draft, writable: 0 }) !== JSON.stringify({ ...saved, writable: 0 });
	}, [draft, saved]);

	// 预览：防抖 + 序号防串（比 AbortController 简单，也够用）
	useEffect(() => {
		if (!draft) return;
		const seq = ++previewSeq.current;
		const timer = window.setTimeout(() => {
			api<AgentPreview>('/api/agents/preview', {
				card: { ...draft, codemode: previewCodemode ? 'on' : 'auto' },
			})
				.then((data) => {
					if (seq !== previewSeq.current) return;
					setPreview(data);
					setPreviewError(null);
				})
				.catch((err) => {
					if (seq !== previewSeq.current) return;
					setPreview(null);
					setPreviewError(err instanceof Error ? err.message : String(err));
				});
		}, 400);
		return () => window.clearTimeout(timer);
	}, [draft, previewCodemode]);

	const tools = useMemo(() => {
		const list = payload?.tools ?? [];
		const pinned = payload?.pinnedTools ?? [];
		const known = new Set(list.map((tool) => tool.name));
		// 声明了但注册表里没有的工具也要列出来：它们正是“配了却不生效”的来源。
		const extra: AgentToolInfo[] = (draft?.tools ?? [])
			.filter((name) => !known.has(name) && !pinned.includes(name))
			.map((name) => ({ name }));
		return [...list, ...extra];
	}, [payload, draft]);

	function patch(next: Partial<Draft>) {
		setDraft((current) => (current ? { ...current, ...next } : current));
	}

	function toggleTool(name: string) {
		if (!draft) return;
		const has = draft.tools.includes(name);
		patch({ tools: has ? draft.tools.filter((item) => item !== name) : [...draft.tools, name] });
	}

	function toggleSkill(id: string) {
		if (!draft) return;
		const has = draft.skills.some((ref) => ref.split('@')[0] === id);
		patch({
			skills: has
				? draft.skills.filter((ref) => ref.split('@')[0] !== id)
				: [...draft.skills, id],
		});
	}

	async function save() {
		if (!draft) return;
		setSaving(true);
		try {
			const card = await api<AgentSummary>('/api/agents/save', { card: draft });
			showToast(`已保存 ${card.id}（CARD.md）`);
			await load(card.id);
		} catch (err) {
			showToast(`保存失败：${err instanceof Error ? err.message : String(err)}`);
		} finally {
			setSaving(false);
		}
	}

	async function fork() {
		if (!draft) return;
		try {
			const card = await api<AgentSummary>('/api/agents/fork', { id: draft.id, name: forkName.trim() || undefined });
			setForkName('');
			showToast(`已 fork ${card.id}（${KIND_LABELS[card.kind]}）`);
			await load(card.id);
		} catch (err) {
			showToast(`fork 失败：${err instanceof Error ? err.message : String(err)}`);
		}
	}

	async function openMerge() {
		if (!draft) return;
		try {
			const diff = await api<{ changes: AgentMergeChange[]; blocked?: string }>('/api/agents/merge-diff', { id: draft.id });
			setMerge(diff);
			setMergePicked(diff.changes.map((change) => change.field));
		} catch (err) {
			showToast(`读取差异失败：${err instanceof Error ? err.message : String(err)}`);
		}
	}

	async function applyMerge() {
		if (!draft) return;
		try {
			await api('/api/agents/merge', { id: draft.id, fields: mergePicked });
			setMerge(null);
			showToast('已合并回父模板');
			await load(draft.parent ?? draft.id);
		} catch (err) {
			showToast(`合并失败：${err instanceof Error ? err.message : String(err)}`);
		}
	}

	function useInNewChat() {
		if (!draft) return;
		if (draft.kind === 'base') {
			showToast('base 是原型，不能直接激活：先 fork 出一个岗位');
			return;
		}
		setAgentTemplate(draft.id);
		setView('chat');
		showToast(`下一条新对话使用 ${draft.id}`);
	}

	const total = preview?.tokens.total ?? 0;
	const contextWindow = preview?.contextWindow ?? 0;
	const skills = payload?.skills ?? [];

	return (
		<main className="agents-view" id="module-agents" data-pane={pane}>
			{isMobile ? <MobileModuleStrip /> : null}
			{/* 移动端三块堆在一列里必然互相挤：改成一次只看一块 */}
			{isMobile ? (
				<div className="agents-tabs" role="tablist" aria-label="Agent 面板">
					{(
						[
							{ id: 'list' as const, label: '模板', badge: `${payload?.agents.length ?? 0}` },
							{ id: 'edit' as const, label: '编辑', badge: draft?.id ?? '' },
							{ id: 'preview' as const, label: '预览', badge: preview ? k(preview.tokens.total) : '—' },
						]
					).map((tab) => (
						<button
							key={tab.id}
							type="button"
							role="tab"
							aria-selected={pane === tab.id}
							className={`agents-tab${pane === tab.id ? ' on' : ''}`}
							onClick={() => setPane(tab.id)}
						>
							<span>{tab.label}</span>
							{tab.badge ? <small>{tab.badge}</small> : null}
						</button>
					))}
				</div>
			) : null}

			<aside className="agents-list" aria-label="Agent 模板列表">
				<div className="agents-list-head">
					<h1>Agent</h1>
					<button type="button" className="ghost" onClick={() => load().catch(() => {})} title="重新读取 CARD.md">
						<RefreshCw aria-hidden="true" />
					</button>
				</div>
				{loading ? <p className="agents-hint">读取中…</p> : null}
				{error ? <p className="agents-error">{error}</p> : null}
				<ul>
					{(payload?.agents ?? []).map((card) => (
						<li key={card.id}>
							<button
								type="button"
								className={`agents-pick${selected === card.id ? ' on' : ''}`}
								onClick={() => {
									setSelected(card.id);
									setDraft(toDraft(card));
									setSaved(toDraft(card));
									setMerge(null);
									// 手机上点模板 = 要看它，直接进编辑，不用再点一次 tab
									if (isMobile) setPane('edit');
								}}
							>
								<span className="agents-pick-id">
									{card.id}
									{selectAgentTemplate === card.id ? <Check aria-hidden="true" /> : null}
								</span>
								<span className="agents-pick-meta">
									{KIND_LABELS[card.kind]} · {card.tools.length} 工具 · {card.skills.length} 技能
								</span>
								{card.description ? <span className="agents-pick-desc">{card.description}</span> : null}
							</button>
						</li>
					))}
				</ul>
				<div className="agents-fork">
					<label htmlFor="agents-fork-name">从当前模板 fork</label>
					<div>
						<input
							id="agents-fork-name"
							className="agents-input"
							value={forkName}
							placeholder="新岗位名，如 hr"
							spellCheck={false}
							onChange={(event) => setForkName(event.target.value)}
						/>
						<button type="button" className="ghost" onClick={fork} disabled={!draft} title="fork 当前模板">
							<GitFork aria-hidden="true" />
						</button>
					</div>
					<p className="agents-hint">
						base → 岗位（永不并回）；岗位 → 临时工（可并回父模板）
					</p>
				</div>
			</aside>

			<section className="agents-editor">
				{!draft ? (
					<div className="agents-empty">
						<Bot aria-hidden="true" />
						<p>挑一个模板，或者从列表底部 fork 一个。</p>
					</div>
				) : (
					<>
						<header className="agents-head">
							<div>
								<h2>
									{draft.id}
									<span className={`agents-kind kind-${draft.kind}`}>{KIND_LABELS[draft.kind]}</span>
									{dirty ? <span className="agents-dirty">未保存</span> : null}
								</h2>
								<p>
									声明与生效都来自这一份 CARD.md：保存后新会话才生效；已有会话不换工具集。
								</p>
							</div>
							<div className="agents-head-actions">
								<button type="button" className="ghost" onClick={openMerge} disabled={!draft.parent}>
									<Merge aria-hidden="true" />
									合并回
								</button>
								<button type="button" className="primary" onClick={save} disabled={!draft.writable || saving}>
									<Save aria-hidden="true" />
									{saving ? '保存中…' : '保存'}
								</button>
								<button type="button" className="primary agents-cta" onClick={useInNewChat}>
									<Plus aria-hidden="true" />
									用这个开新对话
								</button>
							</div>
						</header>

						{draft.kind === 'base' ? (
							<p className="agents-note">
								base 是只读原型：所有岗位从这里 fork，改这里等于改所有未来岗位的默认值。
							</p>
						) : null}

						<div className="agents-form">
							<div className="agents-row">
								<label htmlFor="agent-desc">说明</label>
								<input
									id="agent-desc"
									className="agents-input"
									value={draft.description}
									placeholder="一行说明（新对话选择器里也会显示）"
									onChange={(event) => patch({ description: event.target.value })}
								/>
							</div>
							<div className="agents-row">
								<label htmlFor="agent-domain">域</label>
								<input
									id="agent-domain"
									className="agents-input"
									value={draft.domain}
									spellCheck={false}
									onChange={(event) => patch({ domain: event.target.value })}
								/>
								<span className="agents-hint">技能来自技能库；钉几个就用几个，一个都不钉就不注入。</span>
							</div>
							<div className="agents-row">
								<label htmlFor="agent-model">模型</label>
								<input
									id="agent-model"
									className="agents-input"
									value={draft.model}
									list="agents-model-options"
									spellCheck={false}
									onChange={(event) => patch({ model: event.target.value })}
								/>
								<datalist id="agents-model-options">
									{models.map((model) => (
										<option key={model.key} value={model.key}>
											{model.name}
										</option>
									))}
								</datalist>
								<label htmlFor="agent-thinking" className="agents-inline">
									思考
								</label>
								<select
									id="agent-thinking"
									className="select"
									value={draft.thinking}
									onChange={(event) => patch({ thinking: event.target.value })}
								>
									{THINKING_LEVELS.map((level) => (
										<option key={level} value={level}>
											{level}
										</option>
									))}
								</select>
							</div>
						</div>

						<div className="agents-block">
							<h3>
								<Wrench aria-hidden="true" />
								工具
								<span>{draft.tools.length} 个</span>
							</h3>
							<div className="tools-toggle">
								{tools.map((tool) => {
									const pinned = (payload?.pinnedTools ?? []).includes(tool.name);
									const active = pinned || draft.tools.includes(tool.name);
									const unknown = !(payload?.tools ?? []).some((known) => known.name === tool.name) && !pinned;
									return (
										<label
											key={tool.name}
											className={`tool-toggle${active ? ' on' : ''}${pinned ? ' pinned' : ''}${unknown ? ' missing' : ''}`}
											title={tool.description ?? undefined}
										>
											<input
												type="checkbox"
												checked={active}
												disabled={pinned}
												onChange={() => toggleTool(tool.name)}
											/>
											<span>{tool.name}</span>
											{pinned ? <small className="agents-badge">固定</small> : null}
											{unknown ? <small className="agents-badge missing">未注册</small> : null}
										</label>
									);
								})}
							</div>
							<p className="agents-hint">
								codemode 也在这里开：不开的会话里模型看不到脚本入口；强制走脚本由新对话的 codemode 策略决定。
							</p>
						</div>

						<div className="agents-block">
							<h3>
								<Sparkles aria-hidden="true" />
								技能
								<span>{skills.length} 个可用</span>
							</h3>
							{skills.length ? (
								<div className="tools-toggle">
									{skills.map((skill) => {
										const active = draft.skills.some((ref) => ref.split('@')[0] === skill.id);
										return (
											<label key={skill.id} className={`tool-toggle${active ? ' on' : ''}`}>
												<input type="checkbox" checked={active} onChange={() => toggleSkill(skill.id)} />
												<span>{skill.main || skill.id}</span>
												<small className="agents-badge">{skill.state}</small>
											</label>
										);
									})}
								</div>
							) : (
								<p className="agents-hint">技能库还是空的，先去左侧「技能」模块装一个。</p>
							)}
							<p className="agents-hint">
								钉住之后只注入这几个（写 id，运行时校验内容）；一个都不选 = 跟域自动授权。
							</p>
						</div>

						<div className="agents-block">
							<h3>系统提示词</h3>
							<textarea
								id="agent-prompt"
								className="agents-textarea"
								value={draft.prompt}
								rows={10}
								spellCheck={false}
								placeholder="岗位说明：它负责什么、边界在哪、拿不准时怎么办。"
								onChange={(event) => patch({ prompt: event.target.value })}
							/>
							<p className="agents-hint">
								{Math.ceil(draft.prompt.length / 4)} tokens · 追加在 SDK 基础提示词之后（
								{isMobile ? '「预览」里能看到全文' : '右侧能看到全文'}）
							</p>
						</div>

						{merge ? (
							<div className="agents-merge">
								<h3>合并回 {draft.parent}</h3>
								{merge.blocked ? <p className="agents-warn">{merge.blocked}</p> : null}
								{merge.changes.map((change) => (
									<label key={change.field} className="agents-merge-row">
										<input
											type="checkbox"
											checked={mergePicked.includes(change.field)}
											onChange={() =>
												setMergePicked((current) =>
													current.includes(change.field)
														? current.filter((field) => field !== change.field)
														: [...current, change.field],
												)
											}
										/>
										<span>
											<strong>{change.label}</strong>
											<small className="agents-diff-from">{change.from}</small>
											<small className="agents-diff-to">{change.to}</small>
										</span>
									</label>
								))}
								<div className="agents-merge-actions">
									<button type="button" className="ghost" onClick={() => setMerge(null)}>
										取消
									</button>
									<button
										type="button"
										className="primary"
										disabled={Boolean(merge.blocked) || !mergePicked.length}
										onClick={applyMerge}
									>
										合并选中项
									</button>
								</div>
							</div>
						) : null}
					</>
				)}
			</section>

			<aside className="agents-preview" aria-label="模型实际收到的内容">
				<div className="agents-preview-head">
					<h2>预览</h2>
					<label className="agents-inline">
						<input
							type="checkbox"
							checked={previewCodemode}
							onChange={(event) => setPreviewCodemode(event.target.checked)}
						/>
						codemode 强制
					</label>
				</div>
				{previewError ? <p className="agents-error">{previewError}</p> : null}
				{!preview && !previewError ? <p className="agents-hint">生成中…</p> : null}
				{preview ? (
					<>
						{preview.degraded ? <p className="agents-warn">{preview.degraded}</p> : null}
						<div className="agents-budget">
							{/* 外层长度 = 占上下文的比例（留 2% 下限否则看不见），内层按 token 切三段 */}
							<div className="agents-budget-bar">
								<span
									className="agents-budget-fill"
									style={{ width: `${contextWindow > 0 ? Math.max(2, Math.min(100, (total / contextWindow) * 100)) : 100}%` }}
								>
									<i className="seg-system" style={{ flex: `${preview.tokens.system} 1 0` }} />
									<i className="seg-tools" style={{ flex: `${preview.tokens.tools} 1 0` }} />
									<i className="seg-skills" style={{ flex: `${preview.tokens.skills} 1 0` }} />
								</span>
							</div>
							<p>
								<strong>{k(total)}</strong> / {k(contextWindow)} tokens
								{contextWindow > 0 ? `（占上下文 ${((total / contextWindow) * 100).toFixed(total / contextWindow < 0.1 ? 2 : 1)}%）` : ''}
							</p>
							<ul>
								<li>
									<i className="seg-system" /> system {k(preview.tokens.system)}
								</li>
								<li>
									<i className="seg-tools" /> tools {k(preview.tokens.tools)}
								</li>
								<li>
									<i className="seg-skills" /> skills {k(preview.tokens.skills)}
								</li>
							</ul>
						</div>

						<details className="agents-preview-block" open>
							<summary>工具 {preview.tools.length} 个</summary>
							<ul className="agents-token-list">
								{preview.tools.map((tool) => (
									<li key={tool.name}>
										<span>{tool.name}</span>
										<small>{k(tool.tokens)}</small>
									</li>
								))}
								{preview.pinnedTools.map((name) => (
									<li key={name} className="dim">
										<span>{name}</span>
										<small>固定</small>
									</li>
								))}
							</ul>
							<p className="agents-hint">固定工具（cred_list / cred_use）不计入上面的估算。</p>
						</details>

						<details className="agents-preview-block">
							<summary>技能 {preview.skills.length} 个</summary>
							{preview.skills.length ? (
								<ul className="agents-token-list">
									{preview.skills.map((skill) => (
										<li key={skill.id}>
											<span>{skill.id}</span>
											<small>{k(skill.tokens)}</small>
										</li>
									))}
								</ul>
							) : (
								<p className="agents-hint">没有钉住技能。</p>
							)}
						</details>

						<details className="agents-preview-block">
							<summary>系统提示词（dry-run 真实文本）</summary>
							<pre className="agents-pre">{preview.system}</pre>
						</details>

						<details className="agents-preview-block">
							<summary>工具 schema（发给模型的 JSON）</summary>
							<pre className="agents-pre">{preview.toolsText}</pre>
						</details>

						{preview.warnings.length ? (
							<div className="agents-warn">
								<AlertTriangle aria-hidden="true" />
								<ul>
									{preview.warnings.map((warning) => (
										<li key={warning}>{warning}</li>
									))}
								</ul>
							</div>
						) : null}
					</>
				) : null}
			</aside>
		</main>
	);
}

