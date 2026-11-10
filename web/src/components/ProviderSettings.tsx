import { useCallback, useEffect, useMemo, useState } from 'react';
import {
	AlertTriangle,
	ArrowLeft,
	Check,
	Download,
	Loader2,
	Pencil,
	Plus,
	RefreshCw,
	Search,
	Server,
	Trash2,
	Zap,
} from 'lucide-react';
import { ProviderMark, providerTone } from '@/components/ProviderMark';
import { CredentialEnvPicker } from '@/components/CredentialEnvPicker';
import { ProviderConnectivity, ProviderQuotaView } from '@/components/ProviderQuotaView';
import { api } from '@/lib/api';
import {
	buildQuotaRingLayers,
	quotaRingHeadline,
	quotaRingHot,
	updateQuotaRingPrefs,
	useQuotaRingPrefs,
} from '@/lib/quotaRing';
import { useStore } from '@/lib/store';
import type {
	CredentialCard,
	CredentialList,
	ProviderCard,
	ProviderConnectionResult,
	ProviderModelOption,
	ProviderModelsResult,
	ProviderQuota,
	ProviderQuotaWindow,
} from '@/lib/types';

const API_OPTIONS = [
	{ value: 'openai-completions', label: 'OpenAI · Chat Completions', hint: '兼容 /v1/chat/completions' },
	{ value: 'openai-responses', label: 'OpenAI · Responses', hint: '兼容 /v1/responses' },
	{ value: 'anthropic-messages', label: 'Anthropic · Messages', hint: '兼容 /v1/messages' },
	{ value: 'google-generative-ai', label: 'Google · Gemini', hint: '兼容 /v1beta/models' },
] as const;

const API_LABELS: Record<string, string> = Object.fromEntries(
	API_OPTIONS.map((option) => [option.value, option.label]),
);

/** 设置页预览用示意数据，避免和真实账号额度耦合。 */
const QUOTA_PREVIEW_WINDOWS: ProviderQuotaWindow[] = [
	{ label: '30d', percent: 54 },
	{ label: '7d', percent: 22 },
	{ label: '5h', percent: 8 },
];

interface ProviderPreset {
	key: string;
	id: string;
	name: string;
	api: string;
	baseUrl: string;
	apiKeyEnv: string;
	/** Pi 自带模型目录：保存时可以不拉取模型，直接沿用目录。 */
	builtin: boolean;
}

/**
 * 常用供应商预设。
 *
 * 选一个预设 → 协议 / Base URL / 默认环境变量名自动填好；
 * 内置供应商保存后直接使用 Pi 的模型目录，不需要先拉模型。
 */
const PROVIDER_PRESETS: ProviderPreset[] = [
	{
		key: 'openai',
		id: 'openai',
		name: 'OpenAI',
		api: 'openai-completions',
		baseUrl: 'https://api.openai.com/v1',
		apiKeyEnv: 'OPENAI_API_KEY',
		builtin: true,
	},
	{
		key: 'anthropic',
		id: 'anthropic',
		name: 'Anthropic',
		api: 'anthropic-messages',
		baseUrl: 'https://api.anthropic.com',
		apiKeyEnv: 'ANTHROPIC_API_KEY',
		builtin: true,
	},
	{
		key: 'google',
		id: 'google',
		name: 'Google Gemini',
		api: 'google-generative-ai',
		baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
		apiKeyEnv: 'GEMINI_API_KEY',
		builtin: true,
	},
	{
		key: 'openrouter',
		id: 'openrouter',
		name: 'OpenRouter',
		api: 'openai-completions',
		baseUrl: 'https://openrouter.ai/api/v1',
		apiKeyEnv: 'OPENROUTER_API_KEY',
		builtin: true,
	},
	{
		key: 'deepseek',
		id: 'deepseek',
		name: 'DeepSeek',
		api: 'openai-completions',
		baseUrl: 'https://api.deepseek.com',
		apiKeyEnv: 'DEEPSEEK_API_KEY',
		builtin: true,
	},
	{
		key: 'moonshot',
		id: 'moonshotai',
		name: 'Moonshot / Kimi',
		api: 'openai-completions',
		baseUrl: 'https://api.moonshot.ai/v1',
		apiKeyEnv: 'MOONSHOT_API_KEY',
		builtin: true,
	},
	{
		key: 'zai',
		id: 'zai',
		name: 'Z.ai / GLM',
		api: 'openai-completions',
		baseUrl: 'https://api.z.ai/api/coding/paas/v4',
		apiKeyEnv: 'ZAI_API_KEY',
		builtin: true,
	},
	{
		key: 'groq',
		id: 'groq',
		name: 'Groq',
		api: 'openai-completions',
		baseUrl: 'https://api.groq.com/openai/v1',
		apiKeyEnv: 'GROQ_API_KEY',
		builtin: true,
	},
	{
		key: 'xai',
		id: 'xai',
		name: 'xAI / Grok',
		api: 'openai-responses',
		baseUrl: 'https://api.x.ai/v1',
		apiKeyEnv: 'XAI_API_KEY',
		builtin: true,
	},
	{
		key: 'together',
		id: 'together',
		name: 'Together',
		api: 'openai-completions',
		baseUrl: 'https://api.together.ai/v1',
		apiKeyEnv: 'TOGETHER_API_KEY',
		builtin: true,
	},
	{
		key: 'fireworks',
		id: 'fireworks',
		name: 'Fireworks',
		api: 'openai-completions',
		baseUrl: 'https://api.fireworks.ai/inference',
		apiKeyEnv: 'FIREWORKS_API_KEY',
		builtin: true,
	},
	{
		key: 'cerebras',
		id: 'cerebras',
		name: 'Cerebras',
		api: 'openai-completions',
		baseUrl: 'https://api.cerebras.ai/v1',
		apiKeyEnv: 'CEREBRAS_API_KEY',
		builtin: true,
	},
];

const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

type Notice = { tone: 'ok' | 'error' | 'info'; text: string };

interface Draft {
	id: string;
	name: string;
	api: string;
	baseUrl: string;
	apiKeyEnv: string;
	models: ProviderModelOption[];
}

type Editor = { mode: 'add' } | { mode: 'edit'; provider: ProviderCard };

const EMPTY_DRAFT = (): Draft => ({
	id: '',
	name: '',
	api: 'openai-completions',
	baseUrl: '',
	apiKeyEnv: '',
	models: [],
});

function apiLabel(api?: string): string {
	if (!api) return '混合协议';
	return API_LABELS[api] ?? api;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function makeProviderId(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 40);
	return slug || `custom-${Date.now().toString(36).slice(-6)}`;
}

function contextLabel(model: ProviderModelOption): string {
	return model.contextWindow ? `${Math.round(model.contextWindow / 1000)}k context` : '';
}

function StatusDot({ ok }: { ok: boolean }) {
	return <span className={`provider-dot${ok ? ' ok' : ''}`} aria-hidden="true" />;
}

export function ProviderSettings() {
	const currentModel = useStore((s) => s.model);
	const loadModels = useStore((s) => s.loadModels);
	const showToast = useStore((s) => s.showToast);

	const [providers, setProviders] = useState<ProviderCard[]>([]);
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [editor, setEditor] = useState<Editor | null>(null);
	const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
	const [selectedPreset, setSelectedPreset] = useState<string | null>(null);
	const [remoteModels, setRemoteModels] = useState<ProviderModelOption[]>([]);
	const [modelQuery, setModelQuery] = useState('');
	const [manualModel, setManualModel] = useState('');
	const [notice, setNotice] = useState<Notice | null>(null);
	const [busy, setBusy] = useState<'test' | 'fetch' | 'save' | 'delete' | 'toggle' | null>(null);
	const [quotas, setQuotas] = useState<Record<string, ProviderQuota>>({});
	const [quotaBusy, setQuotaBusy] = useState<Record<string, boolean>>({});
	const [credentialOptions, setCredentialOptions] = useState<CredentialCard[]>([]);

	const currentProvider = currentModel.split('/')[0] ?? '';
	const ringPrefs = useQuotaRingPrefs();

	const loadProviders = useCallback(async () => {
		setLoading(true);
		setLoadError(null);
		try {
			setProviders(await api<ProviderCard[]>('/api/providers'));
		} catch (error) {
			setLoadError(errorText(error));
		} finally {
			setLoading(false);
		}
	}, []);

	const loadQuota = useCallback(async (providerId: string, force = false) => {
		setQuotaBusy((current) => ({ ...current, [providerId]: true }));
		try {
			const quota = await api<ProviderQuota>(
				`/api/providers/quota?id=${encodeURIComponent(providerId)}${force ? '&refresh=1' : ''}`,
			);
			setQuotas((current) => ({ ...current, [providerId]: quota }));
		} catch (error) {
			setQuotas((current) => ({
				...current,
				[providerId]: {
					providerId,
					status: 'error',
					reachable: false,
					checkedAt: Date.now(),
					balances: [],
					windows: [],
					sources: [],
					warnings: [],
					error: errorText(error),
				},
			}));
		} finally {
			setQuotaBusy((current) => ({ ...current, [providerId]: false }));
		}
	}, []);

	useEffect(() => {
		void loadProviders();
	}, [loadProviders]);

	const loadCredentialOptions = useCallback(async () => {
		try {
			const list = await api<CredentialList>('/api/credentials');
			setCredentialOptions(list.credentials.filter((item) => item.tier === 'env' && item.envName));
		} catch {
			// 凭据接口不可用时不影响供应商编辑，保留手动填写环境变量名。
		}
	}, []);

	useEffect(() => {
		void loadCredentialOptions();
	}, [loadCredentialOptions]);

	useEffect(() => {
		for (const provider of providers) {
			if (!provider.auth.configured || provider.enabled === false) continue;
			if (quotas[provider.id] || quotaBusy[provider.id]) continue;
			void loadQuota(provider.id);
		}
	}, [providers, loadQuota]);

	const openAdd = () => {
		void loadCredentialOptions();
		setDraft(EMPTY_DRAFT());
		setSelectedPreset(null);
		setRemoteModels([]);
		setModelQuery('');
		setManualModel('');
		setNotice(null);
		setEditor({ mode: 'add' });
	};

	const openEdit = (provider: ProviderCard) => {
		void loadCredentialOptions();
		const matching = PROVIDER_PRESETS.find((item) => item.id === provider.id);
		setSelectedPreset(matching?.key ?? null);
		setDraft({
			id: provider.id,
			name: provider.name,
			api: provider.api ?? 'openai-completions',
			baseUrl: provider.baseUrl ?? '',
			apiKeyEnv: provider.apiKeyEnv ?? '',
			models: provider.models ?? [],
		});
		setRemoteModels(provider.models ?? []);
		setModelQuery('');
		setManualModel('');
		setNotice(null);
		setEditor({ mode: 'edit', provider });
	};

	const choosePreset = (next: ProviderPreset | null) => {
		setSelectedPreset(next?.key ?? null);
		setDraft(
			next
				? {
						id: next.id,
						name: next.name,
						api: next.api,
						baseUrl: next.baseUrl,
						apiKeyEnv: next.apiKeyEnv,
						models: [],
					}
				: EMPTY_DRAFT(),
		);
		setRemoteModels([]);
		setModelQuery('');
		setManualModel('');
		setNotice(null);
	};

	const closeEditor = () => {
		if (busy === 'save') return;
		setEditor(null);
		setNotice(null);
	};

	/** 远程列表 + 已选列表合并：编辑旧供应商时，已保存但远程未返回的模型也不会消失。 */
	const availableModels = useMemo(() => {
		const map = new Map<string, ProviderModelOption>();
		for (const model of remoteModels) map.set(model.id, model);
		for (const model of draft.models) if (!map.has(model.id)) map.set(model.id, model);
		return [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
	}, [remoteModels, draft.models]);

	const filteredModels = useMemo(() => {
		const query = modelQuery.trim().toLowerCase();
		if (!query) return availableModels;
		return availableModels.filter(
			(model) => model.id.toLowerCase().includes(query) || model.name.toLowerCase().includes(query),
		);
	}, [availableModels, modelQuery]);

	const selectedIds = useMemo(() => new Set(draft.models.map((model) => model.id)), [draft.models]);
	const preset = useMemo(
		() => PROVIDER_PRESETS.find((item) => item.key === selectedPreset) ?? null,
		[selectedPreset],
	);
	const builtinCatalog = Boolean(preset?.builtin && draft.id.trim().toLowerCase() === preset.id);

	const patchDraft = (patch: Partial<Draft>) => {
		setDraft((current) => ({ ...current, ...patch }));
	};

	const forgetQuota = (providerId: string) => {
		setQuotas((current) => {
			const next = { ...current };
			delete next[providerId];
			return next;
		});
	};

	const toggleProvider = async (provider: ProviderCard, enabled: boolean) => {
		if (busy !== null) return;
		setBusy('toggle');
		try {
			const result = await api<{ ok: true; providers: ProviderCard[] }>('/api/providers/toggle', {
				id: provider.id,
				enabled,
			});
			setProviders(result.providers);
			forgetQuota(provider.id);
			await loadModels();
			showToast(
				enabled
					? `已启用供应商：${provider.name}`
					: currentProvider === provider.id
						? `已停用 ${provider.name}；当前会话仍指向该模型，请在输入框切换模型`
						: `已停用供应商：${provider.name}`,
			);
		} catch (error) {
			showToast(`切换失败：${errorText(error)}`);
		} finally {
			setBusy(null);
		}
	};

	const validateDraft = (): string | null => {
		if (!draft.name.trim()) return '请填写供应商显示名称';
		if (!draft.baseUrl.trim()) return '请填写 Base URL';
		if (!/^https?:\/\//i.test(draft.baseUrl.trim())) return 'Base URL 需要以 http:// 或 https:// 开头';
		if (!ENV_RE.test(draft.apiKeyEnv.trim())) {
			return 'API Key 环境变量名只能包含字母、数字和下划线，且不能以数字开头';
		}
		if (!draft.models.length && !builtinCatalog) {
			return '自定义供应商至少需要一个模型：先获取模型列表，或手动添加模型 ID';
		}
		return null;
	};

	const connectionBody = () => ({
		api: draft.api,
		baseUrl: draft.baseUrl,
		apiKeyEnv: draft.apiKeyEnv,
	});

	const runTest = async () => {
		setNotice(null);
		const problem = !draft.baseUrl.trim()
			? '请先填写 Base URL'
			: !ENV_RE.test(draft.apiKeyEnv.trim())
				? '请先填写合法的 API Key 环境变量名'
				: null;
		if (problem) {
			setNotice({ tone: 'error', text: problem });
			return;
		}
		setBusy('test');
		try {
			const result = await api<ProviderConnectionResult>('/api/providers/test', connectionBody());
			setNotice({
				tone: 'ok',
				text: `连接成功 · ${result.latencyMs}ms · 发现 ${result.modelCount} 个模型 · ${result.endpoint}`,
			});
		} catch (error) {
			setNotice({ tone: 'error', text: errorText(error) });
		} finally {
			setBusy(null);
		}
	};

	const fetchModels = async () => {
		setNotice(null);
		const problem = !draft.baseUrl.trim()
			? '请先填写 Base URL'
			: !ENV_RE.test(draft.apiKeyEnv.trim())
				? '请先填写合法的 API Key 环境变量名'
				: null;
		if (problem) {
			setNotice({ tone: 'error', text: problem });
			return;
		}
		setBusy('fetch');
		try {
			const result = await api<ProviderModelsResult>('/api/providers/models', connectionBody());
			setRemoteModels(result.models);
			if (!result.models.length) {
				setNotice({ tone: 'info', text: '连接成功，但接口没有返回模型；可以在下方手动添加模型 ID。' });
			} else {
				// 小列表直接勾选，大目录交给用户筛选，避免一次注册几百个模型。
				setDraft((current) =>
					current.models.length || result.models.length > 50
						? current
						: { ...current, models: result.models },
				);
				setNotice({
					tone: 'ok',
					text:
						result.models.length > 50
							? `获取到 ${result.models.length} 个模型，请勾选要启用的项。`
							: `获取到 ${result.models.length} 个模型，已默认选中。`,
				});
			}
		} catch (error) {
			setNotice({ tone: 'error', text: errorText(error) });
		} finally {
			setBusy(null);
		}
	};

	const addManualModel = () => {
		const id = manualModel.trim();
		if (!id) return;
		if (selectedIds.has(id)) {
			setManualModel('');
			return;
		}
		patchDraft({ models: [...draft.models, { id, name: id }] });
		setManualModel('');
	};

	const saveProvider = async () => {
		const problem = validateDraft();
		if (problem) {
			setNotice({ tone: 'error', text: problem });
			return;
		}
		setBusy('save');
		setNotice(null);
		try {
			const id = draft.id.trim() || makeProviderId(draft.name);
			const result = await api<{ provider: { id: string }; providers: ProviderCard[] }>('/api/providers', {
				id,
				name: draft.name.trim(),
				api: draft.api,
				baseUrl: draft.baseUrl.trim(),
				apiKeyEnv: draft.apiKeyEnv.trim(),
				models: draft.models,
			});
			setProviders(result.providers);
			forgetQuota(result.provider.id);
			setEditor(null);
			await loadModels();
			showToast(`供应商已保存：${draft.name.trim()}`);
		} catch (error) {
			setNotice({ tone: 'error', text: errorText(error) });
		} finally {
			setBusy(null);
		}
	};

	const removeProvider = async (provider: ProviderCard) => {
		if (!window.confirm(`删除自定义供应商「${provider.name}」？`)) return;
		setBusy('delete');
		try {
			const result = await api<{ ok: true; providers: ProviderCard[] }>('/api/providers/delete', {
				id: provider.id,
			});
			setProviders(result.providers);
			forgetQuota(provider.id);
			await loadModels();
			showToast(
				currentProvider === provider.id
					? `已删除 ${provider.name}；当前会话仍指向该模型，请在输入框切换模型`
					: `已删除供应商：${provider.name}`,
			);
		} catch (error) {
			showToast(`删除失败：${errorText(error)}`);
		} finally {
			setBusy(null);
		}
	};

	const renderEditor = () => {
		if (!editor) return null;
		const add = editor.mode === 'add';
		const option = API_OPTIONS.find((item) => item.value === draft.api) ?? API_OPTIONS[0];
		return (
			<section id="provider-editor" className="provider-editor" aria-labelledby="provider-editor-title">
				<header className="provider-editor-head">
					<button
						id="provider-cancel-top"
						type="button"
						className="provider-back"
						aria-label="返回供应商列表"
						title="返回供应商列表"
						onClick={closeEditor}
					>
						<ArrowLeft aria-hidden="true" />
					</button>
					<ProviderMark providerId={preset?.id ?? 'custom'} name={preset?.name ?? 'Custom'} />
					<div>
						<h3 id="provider-editor-title">{add ? '添加供应商' : `编辑：${editor.provider.name}`}</h3>
						<p>选择常用供应商预设，或手动填写协议与地址；密钥只保存环境变量名。</p>
					</div>
				</header>

				<section className="provider-presets" aria-labelledby="provider-presets-title">
					<div className="provider-presets-head">
						<div>
							<strong id="provider-presets-title">常用内置供应商</strong>
							<p>选一个预设，协议和 Base URL 会自动填好；通常只需要确认 API Key 环境变量名。</p>
						</div>
					</div>
					<div className="provider-preset-grid" role="radiogroup" aria-label="常用供应商">
						<button
							id="provider-preset-custom"
							type="button"
							role="radio"
							aria-checked={!preset}
							className={`provider-preset${!preset ? ' selected' : ''}`}
							onClick={() => choosePreset(null)}
						>
							<ProviderMark providerId="custom" name="自定义" size="sm" />
							<span className="provider-preset-copy">
								<strong>自定义</strong>
								<small>手动填写协议与地址</small>
							</span>
						</button>
						{PROVIDER_PRESETS.map((item) => (
							<button
								key={item.key}
								id={`provider-preset-${item.key}`}
								type="button"
								role="radio"
								aria-checked={preset?.key === item.key}
								className={`provider-preset${preset?.key === item.key ? ' selected' : ''}`}
								title={`${item.name} · ${item.apiKeyEnv}`}
								onClick={() => choosePreset(item)}
							>
								<ProviderMark providerId={item.id} name={item.name} size="sm" />
								<span className="provider-preset-copy">
									<strong>{item.name}</strong>
									<small>{item.apiKeyEnv}</small>
								</span>
							</button>
						))}
					</div>
					<p className="provider-preset-note">
						{preset
							? `已套用 ${preset.name} 预设：保存后直接使用 Pi 自带的模型目录，无需先拉取模型。`
							: '没有合适预设？保持「自定义」，手动填写协议、Base URL 和模型。'}
					</p>
				</section>

				<div className="provider-form-grid">
					<div className="settings-field provider-env-field">
						<label htmlFor="provider-env">API Key 环境变量</label>
						<CredentialEnvPicker
							id="provider-env"
							value={draft.apiKeyEnv}
							options={credentialOptions}
							placeholder="OPENAI_API_KEY，或选择凭据"
							onChange={(value) => patchDraft({ apiKeyEnv: value })}
						/>
						<p className="settings-note">
							可直接输入，也可从设置 → 凭据的 env 层条目选择；密钥值不写入供应商配置。
						</p>
					</div>
					<div className="settings-field">
						<label htmlFor="provider-name">显示名称</label>
						<input
							id="provider-name"
							value={draft.name}
							placeholder="例如：公司网关 / OpenRouter"
							autoComplete="off"
							spellCheck={false}
							onChange={(event) => patchDraft({ name: event.target.value })}
						/>
					</div>
				</div>

				<div className="provider-form-grid">
					<div className="settings-field">
						<label htmlFor="provider-id">供应商 ID</label>
						<input
							id="provider-id"
							value={draft.id}
							placeholder="留空自动生成"
							autoComplete="off"
							spellCheck={false}
							disabled={!add}
							onChange={(event) => patchDraft({ id: event.target.value.toLowerCase() })}
						/>
						<p className="settings-note">模型引用格式：{draft.id || 'provider-id'}/模型 ID</p>
					</div>
					<div className="settings-field">
						<label htmlFor="provider-api">API 协议</label>
						<select
							id="provider-api"
							className="select"
							value={draft.api}
							onChange={(event) => patchDraft({ api: event.target.value })}
						>
							{API_OPTIONS.map((item) => (
								<option key={item.value} value={item.value}>
									{item.label}
								</option>
							))}
						</select>
						<p className="settings-note">{option.hint}</p>
					</div>
				</div>

				<div className="settings-field">
					<label htmlFor="provider-base-url">Base URL</label>
					<input
						id="provider-base-url"
						value={draft.baseUrl}
						placeholder="https://api.openai.com/v1"
						autoComplete="off"
						spellCheck={false}
						onChange={(event) => patchDraft({ baseUrl: event.target.value })}
					/>
					<p className="settings-note">
						可填写站点根地址或带 /v1 的地址；连接时会自动尝试 /models 与 /v1/models。
					</p>
				</div>

				<div className="provider-test-row">
					<button
						id="provider-test"
						type="button"
						className="ghost provider-secondary"
						disabled={busy !== null}
						onClick={() => void runTest()}
					>
						{busy === 'test' ? <Loader2 className="spin" aria-hidden="true" /> : <Zap aria-hidden="true" />}
						测试连接
					</button>
					<button
						id="provider-fetch-models"
						type="button"
						className="ghost provider-secondary"
						disabled={busy !== null}
						onClick={() => void fetchModels()}
					>
						{busy === 'fetch' ? <Loader2 className="spin" aria-hidden="true" /> : <Download aria-hidden="true" />}
						获取模型列表
					</button>
					<span className="provider-test-hint">只读调用 /models，不产生对话费用</span>
				</div>

				{notice ? (
					<div id="provider-notice" className={`provider-status ${notice.tone}`} role="status">
						{notice.tone === 'error' ? <AlertTriangle aria-hidden="true" /> : <Check aria-hidden="true" />}
						<span>{notice.text}</span>
					</div>
				) : null}

				<section className="provider-models" aria-labelledby="provider-models-title">
					<header className="provider-models-head">
						<h4 id="provider-models-title">模型</h4>
						<span>
							{builtinCatalog && !draft.models.length ? (
								'使用内置模型目录'
							) : (
								<>
									已选 <strong>{draft.models.length}</strong> / 共 {availableModels.length}
								</>
							)}
						</span>
					</header>

					{availableModels.length ? (
						<>
							<div className="provider-model-tools">
								<div className="provider-model-search">
									<Search aria-hidden="true" />
									<input
										id="provider-model-search"
										value={modelQuery}
										placeholder="筛选模型 ID 或名称"
										autoComplete="off"
										spellCheck={false}
										onChange={(event) => setModelQuery(event.target.value)}
									/>
								</div>
								<button
									type="button"
									className="provider-text-btn"
									onClick={() => patchDraft({ models: availableModels })}
								>
									全选
								</button>
								<button
									type="button"
									className="provider-text-btn"
									onClick={() => patchDraft({ models: [] })}
								>
									清空
								</button>
							</div>
							<div className="provider-model-list" id="provider-model-list">
								{filteredModels.map((model) => {
									const checked = selectedIds.has(model.id);
									const context = contextLabel(model);
									return (
										<label key={model.id} className={`provider-model-row${checked ? ' selected' : ''}`}>
											<input
												type="checkbox"
												checked={checked}
												onChange={() => {
													patchDraft({
														models: checked
															? draft.models.filter((item) => item.id !== model.id)
															: [...draft.models, model],
													});
												}}
											/>
											<span className="provider-model-check" aria-hidden="true">
												{checked ? <Check /> : null}
											</span>
											<span className="provider-model-copy">
												<strong>{model.name !== model.id ? model.name : model.id}</strong>
												<small>
													{model.name !== model.id ? `${model.id} · ` : ''}
													{context || '上下文未声明'}
													{model.reasoning ? ' · reasoning' : ''}
												</small>
											</span>
										</label>
									);
								})}
								{!filteredModels.length ? <p className="provider-model-empty">没有匹配的模型</p> : null}
							</div>
						</>
					) : (
						<p className="provider-empty-note">
							{builtinCatalog
								? `将直接使用 Pi 内置的 ${preset?.name ?? ''} 模型目录，无需拉取；如需只开放部分模型，可点「获取模型列表」。`
								: '还没有模型。点击「获取模型列表」，或在下方手动添加模型 ID。'}
						</p>
					)}

					<div className="provider-manual-row">
						<input
							id="provider-manual-model"
							value={manualModel}
							placeholder="手动添加模型 ID，例如 gpt-4o-mini"
							autoComplete="off"
							spellCheck={false}
							onChange={(event) => setManualModel(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === 'Enter') {
									event.preventDefault();
									addManualModel();
								}
							}}
						/>
						<button
							type="button"
							className="ghost provider-secondary"
							disabled={!manualModel.trim()}
							onClick={addManualModel}
						>
							<Plus aria-hidden="true" />
							添加
						</button>
					</div>
				</section>

				<footer className="provider-editor-footer">
					<button id="provider-cancel" type="button" className="ghost provider-cancel" onClick={closeEditor}>
						取消
					</button>
					<button
						id="provider-save"
						type="button"
						className="provider-primary"
						disabled={busy !== null}
						onClick={() => void saveProvider()}
					>
						{busy === 'save' ? <Loader2 className="spin" aria-hidden="true" /> : <Check aria-hidden="true" />}
						保存供应商
					</button>
				</footer>
			</section>
		);
	};

	const previewLayers = buildQuotaRingLayers(QUOTA_PREVIEW_WINDOWS, ringPrefs);
	const previewPct = quotaRingHeadline(previewLayers, ringPrefs.metric);
	const previewHot = quotaRingHot(previewPct, ringPrefs.metric);

	return (
		<section
			id="settings-panel-providers"
			className="settings-panel provider-panel"
			role="tabpanel"
			aria-labelledby="settings-tab-providers"
		>
			{editor ? (
				renderEditor()
			) : (
				<>
					<div className="provider-toolbar">
						<div>
							<strong>{providers.length ? `${providers.length} 个供应商` : '供应商'}</strong>
							<p>卡片展示当前可用与自定义的模型供应商；内置供应商由服务端环境直接提供。</p>
						</div>
						<div className="provider-toolbar-actions">
							<button
								id="providers-refresh"
								type="button"
								className="provider-icon-btn"
								aria-label="刷新供应商"
								title="刷新供应商"
								onClick={() => void loadProviders()}
								disabled={loading}
							>
								<RefreshCw className={loading ? 'spin' : undefined} aria-hidden="true" />
							</button>
							<button id="providers-add" type="button" className="provider-primary" onClick={openAdd}>
								<Plus aria-hidden="true" />
								添加供应商
							</button>
						</div>
					</div>

					{loadError ? (
						<div className="provider-status error" role="alert">
							<AlertTriangle aria-hidden="true" />
							<span>{loadError}</span>
							<button type="button" className="provider-text-btn" onClick={() => void loadProviders()}>
								重试
							</button>
						</div>
					) : null}

					{loading && !providers.length ? (
						<div className="provider-loading">
							<Loader2 className="spin" aria-hidden="true" />
							正在读取供应商…
						</div>
					) : !providers.length && !loadError ? (
						<div className="provider-empty">
							<Server aria-hidden="true" />
							<strong>还没有可用供应商</strong>
							<p>内置供应商需要对应的 API Key 环境变量；也可以添加一个兼容 OpenAI / Anthropic 的自定义供应商。</p>
							<button type="button" className="provider-primary" onClick={openAdd}>
								<Plus aria-hidden="true" />
								添加第一个供应商
							</button>
						</div>
					) : (
						<div id="providers-list" className="provider-grid">
							{providers.map((provider) => {
								const custom = provider.kind === 'custom';
								const current = currentProvider === provider.id;
								const disabled = provider.enabled === false;
								const quota = quotas[provider.id];
								const quotaLoading = Boolean(quotaBusy[provider.id]);
								const credential = provider.apiKeyEnv || provider.auth.label || (provider.auth.configured ? '已配置' : '未配置');
								return (
									<article
										key={provider.id}
										className={`provider-card ${providerTone(provider.id)}${custom ? ' custom' : ''}${
											current ? ' current' : ''
										}${provider.auth.configured ? '' : ' unconfigured'}${disabled ? ' disabled' : ''}`}
										data-provider-id={provider.id}
									>
										<header className="provider-card-head">
											<ProviderMark providerId={provider.id} name={provider.name} />
											<div className="provider-card-title">
												<h3>{provider.name}</h3>
												<div className="provider-card-sub">
													<code>{provider.id}</code>
													<ProviderConnectivity
														quota={quota}
														loading={quotaLoading}
														configured={provider.auth.configured}
														enabled={!disabled}
													/>
												</div>
											</div>
											<span className={`provider-badge ${custom ? 'custom' : 'builtin'}${disabled ? ' disabled' : ''}`}>
												{disabled ? '已停用' : custom ? '自定义' : '内置'}
											</span>
										</header>

										{current ? <span className="provider-current">当前使用</span> : null}

										<dl className="provider-meta">
											<div>
												<dt>协议</dt>
												<dd title={provider.apis.map(apiLabel).join(' / ')}>
													{provider.api ? apiLabel(provider.api) : provider.apis.length ? `${provider.apis.length} 种协议` : '—'}
												</dd>
											</div>
											<div>
												<dt>模型</dt>
												<dd>
													{custom
														? `${provider.modelCount} 个`
														: `${provider.modelCount} 可用 / ${provider.modelTotal} 总计`}
												</dd>
											</div>
											<div className="wide">
												<dt>Base URL</dt>
												<dd title={provider.baseUrl || undefined}>
													{provider.baseUrl || '由内置 SDK 管理'}
												</dd>
											</div>
											<div className="wide">
												<dt>凭据</dt>
												<dd className="provider-credential">
													<StatusDot ok={provider.auth.configured} />
													<code>{credential}</code>
													<span className={provider.auth.configured ? 'ok' : 'missing'}>
														{provider.auth.configured ? '可用' : '缺少环境变量'}
													</span>
												</dd>
											</div>
										</dl>

										<ProviderQuotaView
											quota={quota}
											loading={quotaLoading}
											configured={provider.auth.configured}
											enabled={!disabled}
											onRefresh={() => void loadQuota(provider.id, true)}
										/>

										{custom ? (
											<div className="provider-card-actions">
												<label className="provider-enable" title={disabled ? '重新启用供应商' : '停用供应商（保留配置）'}>
													<span className="settings-switch">
														<input
															type="checkbox"
															checked={!disabled}
															disabled={busy !== null}
															onChange={(event) => void toggleProvider(provider, event.target.checked)}
														/>
														<span aria-hidden="true" />
													</span>
													<span>{disabled ? '已停用' : '启用'}</span>
												</label>
												<span className="provider-actions-spacer" />
												<button
													type="button"
													className="provider-card-btn"
													disabled={busy !== null}
													onClick={() => openEdit(provider)}
												>
													<Pencil aria-hidden="true" />
													编辑
												</button>
												<button
													type="button"
													className="provider-card-btn danger"
													disabled={busy !== null}
													onClick={() => void removeProvider(provider)}
												>
													<Trash2 aria-hidden="true" />
													删除
												</button>
											</div>
										) : (
											<div className="provider-card-foot">
												内置供应商的凭据由服务端环境变量或登录状态提供。
											</div>
										)}
									</article>
								);
							})}
						</div>
					)}

					<section
						id="quota-ring-settings"
						className="quota-ring-settings"
						aria-labelledby="quota-ring-settings-title"
					>
						<div className="quota-ring-settings-head">
							<div className="quota-ring-settings-copy">
								<strong id="quota-ring-settings-title">订阅额度环</strong>
								<p>状态栏三层环的显示方式，只保存在本机浏览器。</p>
							</div>
							<div className={`quota-ring-preview${previewHot ? ' hot' : ''}`} aria-hidden="true">
								<div id="quota-ring-preview" className="ring quota">
									<svg viewBox="0 0 36 36">
										{previewLayers.map((layer) => (
											<g key={layer.key}>
												<circle className="ring-track" cx="18" cy="18" r={layer.radius} />
												<circle
													className={`ring-fill ${layer.className}${layer.limited ? ' limited' : ''}`}
													cx="18"
													cy="18"
													r={layer.radius}
													pathLength={100}
													strokeDasharray="100"
													strokeDashoffset={100 - layer.percent}
												/>
											</g>
										))}
									</svg>
									<span className="ring-val">{previewPct}</span>
								</div>
								<span className="quota-ring-preview-caption">预览</span>
							</div>
						</div>
						<div className="quota-ring-setting-row">
							<div className="quota-ring-setting-copy">
								<strong>内外圈顺序</strong>
								<small>按时间跨度从外到内，或把最短的 5h 放外层。</small>
							</div>
							<div className="quota-ring-segmented" role="group" aria-label="内外圈顺序">
								<button
									id="quota-ring-order-30d"
									type="button"
									className={ringPrefs.order === '30d-outer' ? 'active' : undefined}
									aria-pressed={ringPrefs.order === '30d-outer'}
									onClick={() => updateQuotaRingPrefs({ order: '30d-outer' })}
								>
									外 30d → 内 5h
								</button>
								<button
									id="quota-ring-order-5h"
									type="button"
									className={ringPrefs.order === '5h-outer' ? 'active' : undefined}
									aria-pressed={ringPrefs.order === '5h-outer'}
									onClick={() => updateQuotaRingPrefs({ order: '5h-outer' })}
								>
									外 5h → 内 30d
								</button>
							</div>
						</div>
						<div className="quota-ring-setting-row">
							<div className="quota-ring-setting-copy">
								<strong>显示数值</strong>
								<small>环和中心数字显示已用百分比，还是剩余百分比。</small>
							</div>
							<div className="quota-ring-segmented" role="group" aria-label="显示数值">
								<button
									id="quota-ring-metric-used"
									type="button"
									className={ringPrefs.metric === 'used' ? 'active' : undefined}
									aria-pressed={ringPrefs.metric === 'used'}
									onClick={() => updateQuotaRingPrefs({ metric: 'used' })}
								>
									用量
								</button>
								<button
									id="quota-ring-metric-remaining"
									type="button"
									className={ringPrefs.metric === 'remaining' ? 'active' : undefined}
									aria-pressed={ringPrefs.metric === 'remaining'}
									onClick={() => updateQuotaRingPrefs({ metric: 'remaining' })}
								>
									余量
								</button>
							</div>
						</div>
					</section>

					<p className="settings-note provider-footnote">
						自定义供应商保存后立即注册到当前进程；模型可在输入框的模型菜单或「模型与工具」里切换。
					</p>
				</>
			)}
		</section>
	);
}
