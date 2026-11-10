import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Cpu, Info, KeyRound, Monitor, Moon, Server, SlidersHorizontal, Sun, X } from 'lucide-react';
import { ProviderSettings } from '@/components/ProviderSettings';
import { CredentialSettings } from '@/components/CredentialSettings';
import { useStore } from '@/lib/store';

type SettingsTab = 'general' | 'providers' | 'credentials' | 'runtime' | 'about';

const THEME_OPTIONS = [
	{ id: 'system' as const, label: '跟随系统', icon: Monitor },
	{ id: 'light' as const, label: '亮色', icon: Sun },
	{ id: 'dark' as const, label: '暗色', icon: Moon },
];

const TABS: Array<{
	id: SettingsTab;
	label: string;
	hint: string;
	icon: typeof SlidersHorizontal;
}> = [
	{ id: 'general', label: '通用设置', hint: '通知与声音', icon: SlidersHorizontal },
	{ id: 'providers', label: '模型供应商', hint: 'API 协议、地址与凭据', icon: Server },
	{ id: 'credentials', label: '凭据', hint: 'env / scoped、租约与审计', icon: KeyRound },
	{ id: 'runtime', label: '模型与工具', hint: '当前模型、思考、域与工具', icon: Cpu },
	{ id: 'about', label: '关于', hint: '运行状态与版本', icon: Info },
];

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
	const [tab, setTab] = useState<SettingsTab>('general');
	const [domainDraft, setDomainDraft] = useState('');

	const models = useStore((s) => s.models);
	const model = useStore((s) => s.model);
	const setModel = useStore((s) => s.setModel);

	const thinking = useStore((s) => s.thinking);
	const thinkingLevels = useStore((s) => s.thinkingLevels);
	const setThinking = useStore((s) => s.setThinking);

	const domain = useStore((s) => s.domain);
	const setDomain = useStore((s) => s.setDomain);
	const pinnedTools = useStore((s) => s.pinnedTools);

	const theme = useStore((s) => s.theme);
	const setTheme = useStore((s) => s.setTheme);

	const fileCardsEnabled = useStore((s) => s.fileCardsEnabled);
	const fileCardsMinImportance = useStore((s) => s.fileCardsMinImportance);
	const setFileCardsEnabled = useStore((s) => s.setFileCardsEnabled);
	const setFileCardsMinImportance = useStore((s) => s.setFileCardsMinImportance);

	const notify = useStore((s) => s.notify);
	const notifyPermission = useStore((s) => s.notifyPermission);
	const toggleNotify = useStore((s) => s.toggleNotify);
	const setNotifySound = useStore((s) => s.setNotifySound);
	const previewNotifySound = useStore((s) => s.previewNotifySound);
	const setApprovalSound = useStore((s) => s.setApprovalSound);
	const previewApprovalSound = useStore((s) => s.previewApprovalSound);

	const tools = useStore((s) => s.tools);
	const toolCatalog = useStore((s) => s.toolCatalog);
	const toggleTool = useStore((s) => s.toggleTool);

	const agentId = useStore((s) => s.agentId);
	const piVersion = useStore((s) => s.piVersion);

	const dialogRef = useRef<HTMLDivElement | null>(null);
	const closeRef = useRef<HTMLButtonElement | null>(null);
	const restoreFocusRef = useRef<HTMLElement | null>(null);
	const onCloseRef = useRef(onClose);

	useEffect(() => {
		onCloseRef.current = onClose;
	}, [onClose]);

	useEffect(() => {
		setDomainDraft(domain);
	}, [domain]);

	useEffect(() => {
		if (!open) return;
		restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		document.body.classList.add('settings-open');
		const focusTimer = window.setTimeout(() => closeRef.current?.focus(), 20);

		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				event.stopImmediatePropagation();
				onCloseRef.current();
				return;
			}
			if (event.key !== 'Tab') return;
			const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
				'button:not([disabled]), select:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
			);
			if (!focusable?.length) return;
			const first = focusable[0];
			const last = focusable[focusable.length - 1];
			if (event.shiftKey && document.activeElement === first) {
				event.preventDefault();
				last.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first.focus();
			}
		};

		document.addEventListener('keydown', onKeyDown, true);
		return () => {
			window.clearTimeout(focusTimer);
			document.removeEventListener('keydown', onKeyDown, true);
			document.body.classList.remove('settings-open');
			restoreFocusRef.current?.focus();
		};
	}, [open]);

	if (!open) return null;

	const groups = new Map<string, typeof models>();
	for (const item of models) {
		if (!groups.has(item.provider)) groups.set(item.provider, []);
		groups.get(item.provider)!.push(item);
	}
	const catalog = toolCatalog.length ? toolCatalog : tools.map((name) => ({ name }));
	const activeTab = TABS.find((item) => item.id === tab) ?? TABS[0];

	const commitDomain = () => {
		const next = domainDraft.trim() || 'general';
		setDomainDraft(next);
		if (next !== domain) setDomain(next);
	};

	return createPortal(
		<div
			className="settings-backdrop"
			onClick={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<div
				ref={dialogRef}
				id="settings-dialog"
				className="settings-dialog"
				role="dialog"
				aria-modal="true"
				aria-labelledby="settings-title"
			>
				<button
					ref={closeRef}
					id="settings-close"
					type="button"
					className="settings-close"
					aria-label="关闭设置"
					title="关闭设置"
					onClick={onClose}
				>
					<X aria-hidden="true" />
				</button>

				<aside className="settings-nav">
					<div id="settings-title" className="settings-nav-title">设置</div>
					<nav className="settings-tabs" role="tablist" aria-orientation="vertical">
						{TABS.map((item) => {
							const Icon = item.icon;
							const active = item.id === tab;
							return (
								<button
									key={item.id}
									id={`settings-tab-${item.id}`}
									type="button"
									role="tab"
									aria-selected={active}
									aria-controls={`settings-panel-${item.id}`}
									className={`settings-tab${active ? ' active' : ''}`}
									onClick={() => setTab(item.id)}
								>
									<Icon aria-hidden="true" />
									<span>{item.label}</span>
								</button>
							);
						})}
					</nav>
				</aside>

				<main className="settings-main">
					<header className="settings-main-head">
						<h2>{activeTab.label}</h2>
						<p>{activeTab.hint}</p>
					</header>

					{tab === 'general' ? (
						<section
							id="settings-panel-general"
							className="settings-panel"
							role="tabpanel"
							aria-labelledby="settings-tab-general"
						>
							<div className="settings-section">
								<h3>外观</h3>
								<div className="settings-theme-options" role="radiogroup" aria-label="主题">
									{THEME_OPTIONS.map((option) => {
										const Icon = option.icon;
										const active = theme === option.id;
										return (
											<button
												key={option.id}
												id={`theme-${option.id}`}
												type="button"
												role="radio"
												aria-checked={active}
												className={`settings-theme-option${active ? ' active' : ''}`}
												onClick={() => setTheme(option.id)}
											>
												<Icon aria-hidden="true" />
												<span>{option.label}</span>
											</button>
										);
									})}
								</div>
								<p className="settings-note">跟随系统会随操作系统的亮暗外观自动切换。</p>
							</div>

							<div className="settings-section">
								<h3>完成提醒</h3>
								<div className="settings-card">
									<label className="settings-row">
										<span className="settings-row-copy">
											<strong>完成提醒</strong>
											<small>本轮结束时提示；后台时发送系统通知并标记标题</small>
										</span>
										<span className="settings-switch">
											<input
												id="settings-notify-enabled"
												type="checkbox"
												checked={notify.enabled}
												onChange={() => {
													toggleNotify().catch(() => {});
												}}
											/>
											<span aria-hidden="true" />
										</span>
									</label>
									<label className="settings-row">
										<span className="settings-row-copy">
											<strong>提示音</strong>
											<small>完成时播放一次轻提示音</small>
										</span>
										<span className="settings-switch">
											<input
												id="settings-notify-sound"
												type="checkbox"
												checked={notify.sound}
												disabled={!notify.enabled}
												onChange={(event) => setNotifySound(event.target.checked)}
											/>
											<span aria-hidden="true" />
										</span>
									</label>
									<div className="settings-row">
										<span className="settings-row-copy">
											<strong>试听</strong>
											<small>立即播放一次提示音</small>
										</span>
										<button
											id="settings-notify-preview"
											type="button"
											className="ghost small settings-preview-btn"
											disabled={!notify.enabled || !notify.sound}
											onClick={previewNotifySound}
										>
											试听
										</button>
									</div>
								</div>
								{notify.enabled && notifyPermission !== 'granted' ? (
									<p className="settings-note">浏览器通知不可用，仍会提示音 + 标题标记。</p>
								) : null}
							</div>

							<div className="settings-section">
								<h3>审核提醒</h3>
								<div className="settings-card">
									<label className="settings-row">
										<span className="settings-row-copy">
											<strong>审批提示音</strong>
											<small>会话等待你审批凭据使用时响铃，左侧会话列表同步闪动</small>
										</span>
										<span className="settings-switch">
											<input
												id="settings-approval-sound"
												type="checkbox"
												checked={notify.approvalSound !== false}
												onChange={(event) => setApprovalSound(event.target.checked)}
											/>
											<span aria-hidden="true" />
										</span>
									</label>
									<div className="settings-row">
										<span className="settings-row-copy">
											<strong>试听</strong>
											<small>播放一次审核铃声</small>
										</span>
										<button
											id="settings-approval-preview"
											type="button"
											className="ghost small settings-preview-btn"
											disabled={notify.approvalSound === false}
											onClick={previewApprovalSound}
										>
											试听
										</button>
									</div>
								</div>
							</div>

							<div className="settings-section">
								<h3>文件卡片</h3>
								<div className="settings-card">
									<label className="settings-row">
										<span className="settings-row-copy">
											<strong>显示本轮文件卡片</strong>
											<small>agent 通过 report_files 汇报创建/修改的文件</small>
										</span>
										<span className="settings-switch">
											<input
												id="settings-file-cards-enabled"
												type="checkbox"
												checked={fileCardsEnabled}
												onChange={(event) => setFileCardsEnabled(event.target.checked)}
											/>
											<span aria-hidden="true" />
										</span>
									</label>
									<div className="settings-row">
										<span className="settings-row-copy">
											<strong>最低重要度</strong>
											<small>低于该重要度的文件默认折叠或隐藏</small>
										</span>
										<select
											id="settings-file-cards-importance"
											className="select"
											style={{ width: 140 }}
											value={fileCardsMinImportance}
											disabled={!fileCardsEnabled}
											onChange={(event) =>
												setFileCardsMinImportance(event.target.value as 'low' | 'normal' | 'high')
											}
										>
											<option value="low">全部显示</option>
											<option value="normal">隐藏次要</option>
											<option value="high">只看主要</option>
										</select>
									</div>
								</div>
								<p className="settings-note">卡片只展示 agent 主动汇报的文件，不自动扫描工作区，也不做 diff。</p>
							</div>
						</section>
					) : null}

					{tab === 'providers' ? <ProviderSettings /> : null}

					{tab === 'credentials' ? <CredentialSettings /> : null}

					{tab === 'runtime' ? (
						<section
							id="settings-panel-runtime"
							className="settings-panel"
							role="tabpanel"
							aria-labelledby="settings-tab-runtime"
						>
							<div className="settings-field">
								<label htmlFor="model">模型</label>
								<select
									id="model"
									className="select"
									value={model}
									onChange={(event) => {
										setModel(event.target.value).catch(() => {});
									}}
								>
									{[...groups.entries()].map(([groupProvider, list]) => (
										<optgroup key={groupProvider} label={groupProvider}>
											{list.map((item) => (
												<option key={item.key} value={item.key}>
													{`${item.name}${item.reasoning ? ' · reasoning' : ''}`}
												</option>
											))}
										</optgroup>
									))}
								</select>
							</div>

							<div className="settings-field">
								<label htmlFor="thinking">思考级别</label>
								<select
									id="thinking"
									className="select"
									value={thinking}
									disabled={thinkingLevels.length <= 1}
									onChange={(event) => {
										setThinking(event.target.value).catch(() => {});
									}}
								>
									{(thinkingLevels.length ? thinkingLevels : ['off']).map((level) => (
										<option key={level} value={level}>
											{level}
										</option>
									))}
								</select>
							</div>

							<div className="settings-field">
								<label htmlFor="domain">域（domain）</label>
								<input
									id="domain"
									value={domainDraft}
									spellCheck={false}
									onChange={(event) => setDomainDraft(event.target.value)}
									onBlur={commitDomain}
									onKeyDown={(event) => {
										if (event.key === 'Enter') {
											event.preventDefault();
											commitDomain();
											event.currentTarget.blur();
										}
									}}
								/>
								<p className="settings-note">域目前只作标签用，同一个域才会互相撞车。</p>
							</div>

							<div className="settings-section">
								<h3>工具</h3>
								<div id="tools" className="tools-toggle">
									{catalog.map((tool) => {
										const active = tools.includes(tool.name);
										const pinned = pinnedTools.includes(tool.name);
										return (
											<label
												key={tool.name}
												className={`tool-toggle${active ? ' on' : ''}${pinned ? ' pinned' : ''}`}
											>
												<input
													type="checkbox"
													checked={active}
													disabled={pinned}
													onChange={() => {
														toggleTool(tool.name).catch(() => {});
													}}
												/>
												<span>{tool.name}</span>
											</label>
										);
									})}
								</div>
							</div>
						</section>
					) : null}

					{tab === 'about' ? (
						<section
							id="settings-panel-about"
							className="settings-panel"
							role="tabpanel"
							aria-labelledby="settings-tab-about"
						>
							<div className="settings-about-brand">
								<img
									className="settings-about-mark"
									src="/brand-mark-128.png"
									width={128}
									height={128}
									alt=""
									aria-hidden="true"
								/>
								<div>
									<strong>Turn Pi</strong>
									<small>SDK 内嵌 · 自托管</small>
								</div>
							</div>
							<div className="settings-kv">
								<div className="settings-kv-row">
									<span>会话</span>
									<code id="agent-id">{agentId ?? '—'}</code>
								</div>
								<div className="settings-kv-row">
									<span>Pi 版本</span>
									<code id="pi-version">{piVersion ? `v${piVersion}` : '—'}</code>
								</div>
							</div>
						</section>
					) : null}
				</main>
			</div>
		</div>,
		document.body,
	);
}
