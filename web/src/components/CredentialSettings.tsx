import { useCallback, useEffect, useState } from 'react';
import {
	ArrowLeft,
	FileClock,
	KeyRound,
	Loader2,
	Pencil,
	Plus,
	RefreshCw,
	RotateCw,
	ShieldOff,
	Trash2,
	Upload,
	Zap,
} from 'lucide-react';
import { api } from '@/lib/api';
import { useStore } from '@/lib/store';
import type {
	CredentialAuditEntry,
	CredentialCard,
	CredentialKind,
	CredentialList,
	CredentialPolicy,
	CredentialTestResult,
	CredentialTier,
} from '@/lib/types';

type Notice = { tone: 'ok' | 'error' | 'info'; text: string } | null;

const KINDS: Array<{ value: CredentialKind; label: string; hint: string }> = [
	{ value: 'bearer', label: 'Bearer token', hint: 'Authorization: Bearer <secret>' },
	{ value: 'api-key', label: 'API Key 头', hint: 'X-API-Key: <secret>' },
	{ value: 'basic', label: 'Basic auth', hint: 'Authorization: Basic base64(user:secret)' },
	{ value: 'query', label: 'Query 参数', hint: '?<参数名>=<secret>' },
];

interface FormState {
	id?: string;
	name: string;
	label: string;
	tier: CredentialTier;
	kind: CredentialKind;
	envName: string;
	baseUrl: string;
	allowedHosts: string;
	allowedPathPrefix: string;
	allowedMethods: string;
	scopes: string;
	policy: CredentialPolicy;
	headerName: string;
	headerPrefix: string;
	username: string;
	queryParam: string;
	secret: string;
}

const EMPTY_FORM = (): FormState => ({
	name: '',
	label: '',
	tier: 'scoped',
	kind: 'bearer',
	envName: '',
	baseUrl: '',
	allowedHosts: '',
	allowedPathPrefix: '',
	allowedMethods: 'GET',
	scopes: '',
	policy: 'ask',
	headerName: '',
	headerPrefix: '',
	username: '',
	queryParam: 'token',
	secret: '',
});

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function fmtTime(value?: number): string {
	if (!value) return '—';
	try {
		return new Date(value).toLocaleString();
	} catch {
		return '—';
	}
}

function formFromCard(card: CredentialCard): FormState {
	return {
		id: card.id,
		name: card.name,
		label: card.label ?? '',
		tier: card.tier,
		kind: card.kind === 'env' ? 'bearer' : card.kind,
		envName: card.envName ?? '',
		baseUrl: card.baseUrl ?? '',
		allowedHosts: card.allowedHosts.join(', '),
		allowedPathPrefix: card.allowedPathPrefix ?? '',
		allowedMethods: card.allowedMethods.join(', '),
		scopes: card.scopes.join(', '),
		policy: card.policy,
		headerName: card.headerName ?? '',
		headerPrefix: card.headerPrefix ?? '',
		username: card.username ?? '',
		queryParam: card.queryParam ?? 'token',
		secret: '',
	};
}

export function CredentialSettings() {
	const showToast = useStore((s) => s.showToast);
	const [state, setState] = useState<CredentialList | null>(null);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState<string | null>(null);
	const [notice, setNotice] = useState<Notice>(null);
	const [form, setForm] = useState<FormState | null>(null);
	const [audit, setAudit] = useState<CredentialAuditEntry[] | null>(null);

	const load = useCallback(async () => {
		setLoading(true);
		try {
			setState(await api<CredentialList>('/api/credentials'));
			setNotice(null);
		} catch (error) {
			setNotice({ tone: 'error', text: errorText(error) });
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const patch = (next: Partial<FormState>) => {
		setForm((current) => (current ? { ...current, ...next } : current));
	};

	const openAdd = () => {
		setNotice(null);
		setForm(EMPTY_FORM());
	};

	const openEdit = (card: CredentialCard) => {
		setNotice(null);
		setForm(formFromCard(card));
	};

	const save = async () => {
		if (!form) return;
		const secret = form.secret.trim();
		if (!form.id && !secret) {
			setNotice({ tone: 'error', text: '新建凭据必须填写 secret' });
			return;
		}
		setBusy('save');
		setNotice(null);
		try {
			const body: Record<string, unknown> = {
				name: form.name.trim(),
				label: form.label.trim() || undefined,
				tier: form.tier,
				kind: form.tier === 'env' ? 'env' : form.kind,
			};
			if (form.id) body.id = form.id;
			if (secret) body.secret = secret;
			if (form.tier === 'env') {
				body.envName = form.envName.trim();
			} else {
				body.baseUrl = form.baseUrl.trim();
				body.allowedHosts = form.allowedHosts;
				body.allowedPathPrefix = form.allowedPathPrefix.trim() || undefined;
				body.allowedMethods = form.allowedMethods;
				body.scopes = form.scopes;
				body.policy = form.policy;
				body.headerName = form.headerName.trim() || undefined;
				body.headerPrefix = form.headerPrefix;
				body.username = form.username.trim() || undefined;
				body.queryParam = form.queryParam.trim() || undefined;
			}
			const result = await api<CredentialList & { ok: true }>('/api/credentials', body);
			setState(result);
			setForm(null);
			showToast(`凭据已保存：${form.name.trim()}`);
		} catch (error) {
			setNotice({ tone: 'error', text: errorText(error) });
		} finally {
			setBusy(null);
		}
	};

	const remove = async (card: CredentialCard) => {
		if (!window.confirm(`删除凭据「${card.name}」？相关租约会立即失效。`)) return;
		setBusy(`delete:${card.id}`);
		try {
			const result = await api<CredentialList>('/api/credentials/delete', { id: card.id });
			setState(result);
			showToast(`已删除凭据：${card.name}`);
		} catch (error) {
			showToast(`删除失败：${errorText(error)}`);
		} finally {
			setBusy(null);
		}
	};

	const rotate = async (card: CredentialCard) => {
		const secret = window.prompt(`输入「${card.name}」的新 secret，或 CRED_ 环境变量名（旧租约会立即失效）`);
		if (!secret) return;
		setBusy(`rotate:${card.id}`);
		try {
			const result = await api<CredentialList>('/api/credentials/rotate', { id: card.id, secret });
			setState(result);
			showToast(`已轮换：${card.name}`);
		} catch (error) {
			showToast(`轮换失败：${errorText(error)}`);
		} finally {
			setBusy(null);
		}
	};

	const test = async (card: CredentialCard) => {
		setBusy(`test:${card.id}`);
		setNotice(null);
		try {
			const result = await api<CredentialTestResult>('/api/credentials/test', { id: card.id });
			setNotice({ tone: result.ok ? 'ok' : 'error', text: `${card.name}：${result.message}` });
		} catch (error) {
			setNotice({ tone: 'error', text: errorText(error) });
		} finally {
			setBusy(null);
		}
	};

	const importEnv = async (envName: string) => {
		setBusy(`import:${envName}`);
		try {
			const result = await api<CredentialList>('/api/credentials/import-env', { envName });
			setState(result);
			showToast(`已从环境导入 ${envName}`);
		} catch (error) {
			showToast(`导入失败：${errorText(error)}`);
		} finally {
			setBusy(null);
		}
	};

	const revokeLeases = async () => {
		setBusy('revoke');
		try {
			const result = await api<CredentialList>('/api/credentials/lease/revoke', {});
			setState(result);
			showToast('已撤销全部租约');
		} catch (error) {
			showToast(`撤销失败：${errorText(error)}`);
		} finally {
			setBusy(null);
		}
	};

	const loadAudit = async () => {
		if (audit) {
			setAudit(null);
			return;
		}
		setBusy('audit');
		try {
			const result = await api<{ audit: CredentialAuditEntry[] }>('/api/credentials/audit?limit=80');
			setAudit(result.audit);
		} catch (error) {
			showToast(`读取审计失败：${errorText(error)}`);
		} finally {
			setBusy(null);
		}
	};

	const renderForm = () => {
		if (!form) return null;
		const add = !form.id;
		return (
			<section className="settings-section" aria-labelledby="credential-editor-title">
				<header className="provider-editor-head">
					<button
						type="button"
						className="provider-back"
						aria-label="返回凭据列表"
						title="返回凭据列表"
						onClick={() => setForm(null)}
					>
						<ArrowLeft aria-hidden="true" />
					</button>
					<span className="credential-editor-mark">
						<KeyRound aria-hidden="true" />
					</span>
					<div>
						<h3 id="credential-editor-title">{add ? '新增凭据' : `编辑：${form.name}`}</h3>
						<p>env 层会进入所有 bash 子进程环境；scoped 层只通过短租约代理使用，agent 看不到明文。</p>
					</div>
				</header>

				<div className="credential-form">
					<div className="credential-form-row">
						<div className="settings-field">
							<label htmlFor="credential-name">名称（slug）</label>
							<input
								id="credential-name"
								value={form.name}
								placeholder="gitea"
								spellCheck={false}
								onChange={(event) => patch({ name: event.target.value.toLowerCase() })}
							/>
							<p className="settings-note">小写字母、数字、短横线；agent 用这个名字申请。</p>
						</div>
						<div className="settings-field">
							<label htmlFor="credential-label">展示名</label>
							<input
								id="credential-label"
								value={form.label}
								placeholder="Gitea"
								onChange={(event) => patch({ label: event.target.value })}
							/>
						</div>
					</div>

					<div className="credential-form-row">
						<div className="settings-field">
							<label htmlFor="credential-tier">层级</label>
							<select
								id="credential-tier"
								className="select"
								value={form.tier}
								onChange={(event) => patch({ tier: event.target.value as CredentialTier })}
							>
								<option value="scoped">scoped（代理，agent 看不到）</option>
								<option value="env">env（写入 process.env）</option>
							</select>
						</div>
						{form.tier === 'env' ? (
							<div className="settings-field">
								<label htmlFor="credential-env">环境变量名</label>
								<input
									id="credential-env"
									value={form.envName}
									placeholder="OPENCODE_API_KEY"
									spellCheck={false}
									onChange={(event) => patch({ envName: event.target.value.toUpperCase() })}
								/>
							</div>
						) : (
							<div className="settings-field">
								<label htmlFor="credential-kind">注入方式</label>
								<select
									id="credential-kind"
									className="select"
									value={form.kind}
									onChange={(event) => patch({ kind: event.target.value as CredentialKind })}
								>
									{KINDS.map((kind) => (
										<option key={kind.value} value={kind.value}>
											{kind.label} · {kind.hint}
										</option>
									))}
								</select>
							</div>
						)}
					</div>

					<div className="settings-field">
						<label htmlFor="credential-secret">
							{add ? 'Secret 或 CRED_ 环境变量' : '新 secret / CRED_ 环境变量（留空不修改）'}
						</label>
						<input
							id="credential-secret"
							type="password"
							value={form.secret}
							autoComplete="new-password"
							placeholder={add ? 'sk-… 或 CRED_GITEA_TOKEN' : '留空保持原值'}
							onChange={(event) => patch({ secret: event.target.value })}
						/>
						<p className="settings-note">
							以 <code>CRED_</code> 开头的值（如 <code>CRED_GITEA_TOKEN</code>）按环境变量名解析，不写入 vault；其他值加密保存。
						</p>
					</div>

					{form.tier === 'scoped' ? (
						<>
							<div className="credential-form-row">
								<div className="settings-field">
									<label htmlFor="credential-base">Base URL</label>
									<input
										id="credential-base"
										value={form.baseUrl}
										placeholder="https://git.example.com"
										spellCheck={false}
										onChange={(event) => patch({ baseUrl: event.target.value })}
									/>
								</div>
								<div className="settings-field">
									<label htmlFor="credential-hosts">允许的 host</label>
									<input
										id="credential-hosts"
										value={form.allowedHosts}
										placeholder="git.example.com, *.example.com"
										spellCheck={false}
										onChange={(event) => patch({ allowedHosts: event.target.value })}
									/>
									<p className="settings-note">逗号分隔；精确 host 或 *.example.com，不接受 *。</p>
								</div>
							</div>

							<div className="credential-form-row">
								<div className="settings-field">
									<label htmlFor="credential-path">路径前缀</label>
									<input
										id="credential-path"
										value={form.allowedPathPrefix}
										placeholder="/api/v1/repos/"
										spellCheck={false}
										onChange={(event) => patch({ allowedPathPrefix: event.target.value })}
									/>
								</div>
								<div className="settings-field">
									<label htmlFor="credential-methods">允许的方法</label>
									<input
										id="credential-methods"
										value={form.allowedMethods}
										placeholder="GET, POST"
										spellCheck={false}
										onChange={(event) => patch({ allowedMethods: event.target.value.toUpperCase() })}
									/>
								</div>
							</div>

							<div className="credential-form-row">
								<div className="settings-field">
									<label htmlFor="credential-scopes">Scopes</label>
									<input
										id="credential-scopes"
										value={form.scopes}
										placeholder="gitea:issue:read, gitea:issue:write"
										spellCheck={false}
										onChange={(event) => patch({ scopes: event.target.value })}
									/>
									<p className="settings-note">审批时展示给用户；agent 只能申请这里的子集。</p>
								</div>
								<div className="settings-field">
									<label htmlFor="credential-policy">审批策略</label>
									<select
										id="credential-policy"
										className="select"
										value={form.policy}
										onChange={(event) => patch({ policy: event.target.value as CredentialPolicy })}
									>
										<option value="ask">ask（每次审批）</option>
										<option value="auto-read">auto-read（只读 scope 免审批，仅 GET/HEAD）</option>
									</select>
								</div>
							</div>

							<div className="credential-form-row">
								<div className="settings-field">
									<label htmlFor="credential-header">Header 名（可选）</label>
									<input
										id="credential-header"
										value={form.headerName}
										placeholder={form.kind === 'api-key' ? 'X-API-Key' : 'Authorization'}
										spellCheck={false}
										onChange={(event) => patch({ headerName: event.target.value })}
									/>
								</div>
								<div className="settings-field">
									<label htmlFor="credential-prefix">Header 前缀（可选）</label>
									<input
										id="credential-prefix"
										value={form.headerPrefix}
										placeholder={form.kind === 'bearer' ? 'Bearer ' : ''}
										spellCheck={false}
										onChange={(event) => patch({ headerPrefix: event.target.value })}
									/>
								</div>
							</div>

							{form.kind === 'basic' ? (
								<div className="settings-field">
									<label htmlFor="credential-username">Basic 用户名</label>
									<input
										id="credential-username"
										value={form.username}
										spellCheck={false}
										onChange={(event) => patch({ username: event.target.value })}
									/>
								</div>
							) : null}
							{form.kind === 'query' ? (
								<div className="settings-field">
									<label htmlFor="credential-query">Query 参数名</label>
									<input
										id="credential-query"
										value={form.queryParam}
										spellCheck={false}
										onChange={(event) => patch({ queryParam: event.target.value })}
									/>
								</div>
							) : null}
						</>
					) : null}

					<div className="provider-editor-footer">
						<button type="button" className="ghost provider-cancel" onClick={() => setForm(null)}>
							取消
						</button>
						<button
							type="button"
							className="provider-primary"
							disabled={busy === 'save'}
							onClick={() => void save()}
						>
							{busy === 'save' ? <Loader2 className="spin" aria-hidden="true" /> : <Zap aria-hidden="true" />}
							保存
						</button>
					</div>
				</div>
			</section>
		);
	};

	const credentials = state?.credentials ?? [];

	return (
		<section id="settings-panel-credentials" className="settings-panel" role="tabpanel" aria-labelledby="settings-tab-credentials">
			<div className="settings-section">
				<div className="provider-toolbar">
					<div>
						<strong>凭据</strong>
						<p className="settings-note">
							env 层保存后立即写入进程环境（供应商 key 不用重启）；scoped 层通过短租约代理使用，agent 看不到明文。
						</p>
					</div>
					<div className="provider-toolbar-actions">
						<button type="button" className="provider-card-btn" onClick={() => void loadAudit()}>
							<FileClock aria-hidden="true" />
							{audit ? '收起审计' : '审计'}
						</button>
						{state && state.leases > 0 ? (
							<button
								type="button"
								className="provider-card-btn"
								disabled={busy === 'revoke'}
								onClick={() => void revokeLeases()}
							>
								<ShieldOff aria-hidden="true" />
								撤销租约（{state.leases}）
							</button>
						) : null}
						<button type="button" className="provider-card-btn" onClick={() => void load()}>
							<RefreshCw aria-hidden="true" />
							刷新
						</button>
						<button type="button" className="provider-primary" onClick={openAdd}>
							<Plus aria-hidden="true" />
							新增凭据
						</button>
					</div>
				</div>

				{notice ? <p className={`credential-notice ${notice.tone}`}>{notice.text}</p> : null}

				{state && state.importableEnv.length ? (
					<div className="credential-import">
						<span className="settings-note">从进程环境导入：</span>
						{state.importableEnv.map((envName) => (
							<button
								key={envName}
								type="button"
								className="provider-card-btn"
								disabled={busy === `import:${envName}`}
								onClick={() => void importEnv(envName)}
							>
								<Upload aria-hidden="true" />
								{envName}
							</button>
						))}
					</div>
				) : null}

				{loading ? (
					<div className="credential-empty">
						<Loader2 className="spin" aria-hidden="true" /> 正在读取凭据…
					</div>
				) : form ? (
					renderForm()
				) : credentials.length ? (
					<div className="credential-list">
						{credentials.map((card) => (
							<article key={card.id} className="credential-card">
								<div className="credential-card-head">
									<div>
										<div className="credential-card-title">
											<strong>{card.label || card.name}</strong>
											<code>{card.name}</code>
											<span className={`credential-badge ${card.tier}`}>{card.tier}</span>
											<span className="credential-badge">{card.kind}</span>
											{card.policy === 'auto-read' ? <span className="credential-badge">auto-read</span> : null}
										</div>
										<div className="credential-card-meta">
											{card.tier === 'env' ? (
												<span>
													变量 <code>{card.envName}</code>
													{card.envPresent ? ' · 已注入' : ' · 未注入'}
												</span>
											) : (
												<>
													<span>
														目标 <code>{card.baseUrl}</code>
													</span>
													<span>host {card.allowedHosts.join('、')}</span>
													<span>方法 {card.allowedMethods.join('、')}</span>
													<span>scope {card.scopes.join('、')}</span>
													{card.allowedPathPrefix ? <span>路径 {card.allowedPathPrefix}</span> : null}
												</>
											)}
											<span>
												{card.secretEnv ? (
													<>
														密钥 <code>{card.secretEnv}</code>
														{card.secretEnvPresent ? ' · 已设置' : ' · 未设置'}
													</>
												) : (
													'密钥已加密'
												)}
											</span>
											<span>使用 {card.useCount} 次</span>
											<span>最后 {fmtTime(card.lastUsedAt)}</span>
										</div>
									</div>
									<div className="credential-card-actions">
										<button
											type="button"
											className="provider-card-btn"
											disabled={busy === `test:${card.id}`}
											onClick={() => void test(card)}
										>
											{busy === `test:${card.id}` ? <Loader2 className="spin" aria-hidden="true" /> : <Zap aria-hidden="true" />}
											测试
										</button>
										<button type="button" className="provider-card-btn" onClick={() => openEdit(card)}>
											<Pencil aria-hidden="true" />
											编辑
										</button>
										<button
											type="button"
											className="provider-card-btn"
											disabled={busy === `rotate:${card.id}`}
											onClick={() => void rotate(card)}
										>
											<RotateCw aria-hidden="true" />
											轮换
										</button>
										<button
											type="button"
											className="provider-card-btn danger"
											disabled={busy === `delete:${card.id}`}
											onClick={() => void remove(card)}
										>
											<Trash2 aria-hidden="true" />
											删除
										</button>
									</div>
								</div>
							</article>
						))}
					</div>
				) : (
					<div className="credential-empty">
						还没有凭据。先把现有 <code>.env</code> 里的 key 导入，或新增一个 scoped 凭据给 agent 用。
					</div>
				)}

				{state ? (
					<p className="settings-note">
						vault：{state.credentials.length} 条 · 活跃租约：{state.leases} · 会话授权：
						{state.sessionGrants} · 主密钥来源：{state.keySource === 'env' ? 'PI_CREDENTIAL_KEY' : state.keySource === 'file' ? 'runtime/credentials.key' : '—'}
					</p>
				) : null}

				{audit ? (
					<div className="credential-audit">
						{audit.length ? (
							audit.map((entry, index) => (
								<div key={`${entry.ts}-${index}`}>
									{new Date(entry.ts).toLocaleString()} · {entry.actor} · {entry.action}
									{entry.credential ? ` · ${entry.credential}` : ''}
									{entry.method ? ` · ${entry.method}` : ''}
									{entry.host ? ` ${entry.host}` : ''}
									{entry.path ? entry.path : ''}
									{entry.status ? ` · ${entry.status}` : ''}
									{entry.decision ? ` · ${entry.decision}` : ''}
									{entry.error ? ` · ${entry.error}` : ''}
								</div>
							))
						) : (
							<div>暂无审计记录</div>
						)}
					</div>
				) : null}
			</div>
		</section>
	);
}
