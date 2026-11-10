/**
 * 自定义模型供应商。
 *
 * 这里只保存「怎么连」，不保存密钥本身：
 *   - apiKey 字段只记环境变量名，运行时交给 Pi 的 $NAME 插值去解析；
 *   - 供应商配置落在 runtime/providers.json，容器重建后仍然存在；
 *   - 保存/删除后立即注册到共享 ModelRuntime，新会话与 /api/models 都能看到。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { getRuntime } from './chat.ts';
import { resolveSecret } from './credentials.ts';

export const PROVIDER_APIS = [
	'openai-completions',
	'openai-responses',
	'anthropic-messages',
	'google-generative-ai',
] as const;

export type ProviderApi = (typeof PROVIDER_APIS)[number];

export interface ProviderModelRecord {
	id: string;
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
}

export interface CustomProviderRecord {
	id: string;
	name: string;
	api: ProviderApi;
	baseUrl: string;
	apiKeyEnv: string;
	models: ProviderModelRecord[];
	/** false 时保留配置但不注册到运行时。 */
	enabled?: boolean;
	/** true 表示沿用 Pi 内置模型目录，models 为空也不覆盖。 */
	useBuiltinModels?: boolean;
	createdAt: number;
	updatedAt: number;
}

export interface ProviderModelOption extends ProviderModelRecord {
	/** 远程 /models 返回的展示名，没有就和 id 相同。 */
	name: string;
}

export interface ProviderCard {
	id: string;
	name: string;
	kind: 'builtin' | 'custom';
	api?: string;
	apis: string[];
	baseUrl?: string;
	apiKeyEnv?: string;
	auth: {
		configured: boolean;
		source?: string;
		label?: string;
	};
	/** 当前凭证下可用模型数；内置供应商取可用目录，自定义取已保存列表。 */
	modelCount: number;
	modelTotal: number;
	/** 内置供应商恒为启用；自定义供应商可以保留配置但停用。 */
	enabled?: boolean;
	/** 自定义供应商的已保存模型；编辑表单直接回填。 */
	models?: ProviderModelOption[];
}

const CONFIG_PATH =
	process.env.PI_PROVIDER_CONFIG ??
	join(process.env.PI_RUNTIME_DIR ?? resolve(import.meta.dirname ?? '.', '..', 'runtime'), 'providers.json');

const API_SET = new Set<string>(PROVIDER_APIS);
const registered = new Set<string>();
let initialised = false;
let initialising: Promise<void> | undefined;

export class ProviderError extends Error {}

function fail(message: string): never {
	throw new ProviderError(message);
}

function unique<T>(items: T[]): T[] {
	return [...new Set(items)];
}

function normalizeApi(value: unknown): ProviderApi {
	const api = String(value ?? '').trim();
	if (!API_SET.has(api)) {
		fail(`不支持的 API 协议：${api || '（空）'}。可选：${PROVIDER_APIS.join('、')}`);
	}
	return api as ProviderApi;
}

/** 用户可能直接粘贴了完整的 chat 端点；保存前裁回 base URL。 */
function normalizeBaseUrl(value: unknown, api: ProviderApi): string {
	let base = String(value ?? '').trim();
	if (!base) fail('Base URL 不能为空');
	if (!/^https?:\/\//i.test(base)) fail('Base URL 需要以 http:// 或 https:// 开头');
	try {
		new URL(base);
	} catch {
		fail('Base URL 格式不正确');
	}
	base = base.replace(/\/+$/, '');
	if (api === 'google-generative-ai') {
		base = base.replace(/\/models$/i, '');
	} else {
		base = base.replace(/\/(?:chat\/completions|responses|messages)$/i, '');
	}
	return base.replace(/\/+$/, '');
}

function normalizeEnvName(value: unknown): string {
	const name = String(value ?? '').trim();
	if (!name) fail('API Key 环境变量名不能为空');
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
		fail('API Key 环境变量名只能包含字母、数字和下划线，且不能以数字开头');
	}
	return name;
}

function normalizeProviderId(value: unknown): string {
	const id = String(value ?? '')
		.trim()
		.toLowerCase();
	if (!id) fail('供应商 ID 不能为空');
	if (!/^[a-z0-9][a-z0-9._-]{0,47}$/.test(id)) {
		fail('供应商 ID 只能使用小写字母、数字、点、下划线和短横线（最长 48 字符）');
	}
	return id;
}

function toNumber(value: unknown): number | undefined {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

function normalizeModels(value: unknown): ProviderModelRecord[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const models: ProviderModelRecord[] = [];
	for (const input of value) {
		const item = typeof input === 'string' ? { id: input } : input && typeof input === 'object' ? (input as any) : null;
		if (!item) continue;
		const id = String(item.id ?? item.model ?? '').trim();
		if (!id || seen.has(id)) continue;
		seen.add(id);
		const name = String(item.name ?? item.displayName ?? item.display_name ?? '').trim();
		const model: ProviderModelRecord = { id };
		if (name && name !== id) model.name = name;
		const contextWindow = toNumber(
			item.contextWindow ?? item.context_window ?? item.context_length ?? item.max_context_length ?? item.max_input_tokens,
		);
		if (contextWindow) model.contextWindow = contextWindow;
		const maxTokens = toNumber(item.maxTokens ?? item.max_output_tokens ?? item.output_token_limit);
		if (maxTokens) model.maxTokens = maxTokens;
		if (item.reasoning === true || item.supports_reasoning === true) model.reasoning = true;
		models.push(model);
	}
	return models;
}

function normalizeRecord(value: unknown): CustomProviderRecord | null {
	try {
		if (!value || typeof value !== 'object') return null;
		const input = value as any;
		const api = normalizeApi(input.api);
		const id = normalizeProviderId(input.id);
		const models = normalizeModels(input.models);
		return {
			id,
			name: String(input.name ?? '').trim() || id,
			api,
			baseUrl: normalizeBaseUrl(input.baseUrl, api),
			apiKeyEnv: normalizeEnvName(input.apiKeyEnv),
			models,
			enabled: input.enabled !== false,
			// 兼容旧配置：以前保存时必须有模型；空模型列表只可能是内置目录模式。
			useBuiltinModels: models.length ? false : input.useBuiltinModels !== false,
			createdAt: toNumber(input.createdAt) ?? Date.now(),
			updatedAt: toNumber(input.updatedAt) ?? Date.now(),
		};
	} catch {
		return null;
	}
}

async function readConfig(): Promise<CustomProviderRecord[]> {
	try {
		const raw = await readFile(CONFIG_PATH, 'utf8');
		const parsed = JSON.parse(raw);
		const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.providers) ? parsed.providers : [];
		const seen = new Set<string>();
		const records: CustomProviderRecord[] = [];
		for (const item of list) {
			const record = normalizeRecord(item);
			if (!record || seen.has(record.id)) continue;
			seen.add(record.id);
			records.push(record);
		}
		return records;
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
		process.stderr.write(`[providers] 读取 ${CONFIG_PATH} 失败：${error instanceof Error ? error.message : String(error)}\n`);
		return [];
	}
}

async function writeConfig(records: CustomProviderRecord[]): Promise<void> {
	await mkdir(dirname(CONFIG_PATH), { recursive: true });
	const tmp = `${CONFIG_PATH}.tmp`;
	await writeFile(
		tmp,
		JSON.stringify({ version: 1, providers: records }, null, 2) + '\n',
		'utf8',
	);
	await rename(tmp, CONFIG_PATH);
}

function toRuntimeConfig(record: CustomProviderRecord) {
	return {
		name: record.name,
		baseUrl: record.baseUrl,
		api: record.api,
		// Pi 会在请求时解析 $NAME；文件里永远不出现真实 key。
		apiKey: `$${record.apiKeyEnv}`,
		// 常用供应商不拉模型时沿用 Pi 内置目录；只有用户主动拉取/勾选后才覆盖。
		...(record.models.length
			? {
					models: record.models.map((model) => ({
						id: model.id,
						name: model.name ?? model.id,
						input: ['text'] as ('text' | 'image')[],
						contextWindow: model.contextWindow ?? 128_000,
						maxTokens: model.maxTokens ?? 16_384,
						reasoning: Boolean(model.reasoning),
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					})),
				}
			: {}),
	};
}

async function registerRecord(record: CustomProviderRecord): Promise<void> {
	const runtime = await getRuntime();
	runtime.registerProvider(record.id, toRuntimeConfig(record));
	registered.add(record.id);
	// registerProvider 自己会异步刷新；这里再等一次，让紧接着的 /api/models 立刻拿到新目录。
	await runtime.refresh({ allowNetwork: false, providers: [record.id] }).catch(() => {});
}

async function unregisterRecord(id: string): Promise<void> {
	const runtime = await getRuntime();
	runtime.unregisterProvider(id);
	registered.delete(id);
}

async function syncRecords(records: CustomProviderRecord[]): Promise<void> {
	const wanted = new Set(records.filter((record) => record.enabled !== false).map((record) => record.id));
	for (const id of [...registered]) {
		if (!wanted.has(id)) await unregisterRecord(id);
	}
	for (const record of records) {
		if (record.enabled === false) continue;
		try {
			await registerRecord(record);
		} catch (error) {
			// 单条配置坏掉时跳过它，其它供应商仍然可用。
			process.stderr.write(
				`[providers] 注册 ${record.id} 失败：${error instanceof Error ? error.message : String(error)}\n`,
			);
		}
	}
}

/** 启动时调用一次；并发调用共享同一个初始化 Promise。 */
export async function initCustomProviders(): Promise<void> {
	if (initialised) return;
	initialising ??= (async () => {
		try {
			const records = await readConfig();
			await syncRecords(records);
			initialised = true;
			if (records.length) {
				process.stdout.write(`[providers] loaded ${records.length} custom provider(s) from ${CONFIG_PATH}\n`);
			}
		} finally {
			initialising = undefined;
		}
	})();
	return initialising;
}

export async function listProviders(): Promise<ProviderCard[]> {
	await initCustomProviders();
	const runtime = await getRuntime();
	// 刷新一次可用目录，保证卡片上的「已配置 / 模型数」与 /api/models 一致。
	await runtime.getAvailable().catch(() => {});
	const available = runtime.getAvailableSnapshot?.() ?? [];
	const counts = new Map<string, number>();
	for (const model of available) counts.set(model.provider, (counts.get(model.provider) ?? 0) + 1);

	const records = await readConfig();
	const recordById = new Map(records.map((record) => [record.id, record]));
	const providers = runtime.getProviders();
	const providerIds = new Set(providers.map((provider) => provider.id));
	const cards: ProviderCard[] = [];

	for (const provider of providers) {
		const record = recordById.get(provider.id);
		if (!record && !runtime.hasConfiguredAuth(provider.id)) continue;
		const providerModels = runtime.getModels(provider.id) ?? [];
		const apis = unique<string>(
			providerModels
				.map((model: any) => String(model.api ?? ''))
				.filter(Boolean),
		);
		const status = runtime.getProviderAuthStatus(provider.id);
		cards.push({
			id: provider.id,
			name: record?.name || provider.name || provider.id,
			kind: record ? 'custom' : 'builtin',
			api: record?.api ?? (apis.length === 1 ? apis[0] : undefined),
			apis,
			baseUrl: record?.baseUrl || provider.baseUrl || '',
			apiKeyEnv: record?.apiKeyEnv,
			auth: {
				configured: Boolean(status?.configured),
				source: status?.source,
				label: status?.label,
			},
			modelCount: record?.models.length
				? record.models.length
				: (counts.get(provider.id) ?? 0),
			modelTotal: providerModels.length,
			enabled: record ? record.enabled !== false : true,
			models: record?.models.map((model) => ({ ...model, name: model.name ?? model.id })),
		});
	}

	// 停用的自定义供应商不会注册到 runtime，但卡片仍要显示，方便重新启用。
	for (const record of records) {
		if (providerIds.has(record.id)) continue;
		const configured = Boolean(await resolveSecret(record.apiKeyEnv));
		cards.push({
			id: record.id,
			name: record.name,
			kind: 'custom',
			api: record.api,
			apis: [record.api],
			baseUrl: record.baseUrl,
			apiKeyEnv: record.apiKeyEnv,
			auth: {
				configured,
				source: configured ? 'environment' : undefined,
				label: record.apiKeyEnv,
			},
			modelCount: record.models.length,
			modelTotal: record.models.length,
			enabled: false,
			models: record.models.map((model) => ({ ...model, name: model.name ?? model.id })),
		});
	}

	cards.sort((a, b) => {
		if (a.kind !== b.kind) return a.kind === 'custom' ? -1 : 1;
		if ((a.enabled === false) !== (b.enabled === false)) return a.enabled === false ? 1 : -1;
		return a.name.localeCompare(b.name, 'zh-Hans-CN');
	});
	return cards;
}

export async function saveCustomProvider(input: unknown): Promise<{ provider: CustomProviderRecord; providers: ProviderCard[] }> {
	await initCustomProviders();
	if (!input || typeof input !== 'object') fail('供应商配置不能为空');
	const body = input as any;
	const id = normalizeProviderId(body.id);
	const records = await readConfig();
	const index = records.findIndex((record) => record.id === id);
	const runtime = await getRuntime();
	const existing = index >= 0 ? records[index] : undefined;
	const registeredIds = new Set(runtime.getRegisteredProviderIds());
	const hasBuiltinCatalog =
		runtime.getProviders().some((provider) => provider.id === id) && !registeredIds.has(id);

	const api = normalizeApi(body.api);
	const models = normalizeModels(body.models);
	const inheritBuiltinModels =
		!models.length && (hasBuiltinCatalog || Boolean(existing?.useBuiltinModels));
	if (!models.length && !inheritBuiltinModels) {
		fail('自定义供应商至少需要一个模型：请先获取模型列表并勾选，或手动添加模型 ID');
	}

	const now = Date.now();
	const record: CustomProviderRecord = {
		id,
		name: String(body.name ?? '').trim() || id,
		api,
		baseUrl: normalizeBaseUrl(body.baseUrl, api),
		apiKeyEnv: normalizeEnvName(body.apiKeyEnv),
		models,
		enabled: body.enabled === undefined ? (existing?.enabled ?? true) : body.enabled !== false,
		useBuiltinModels: inheritBuiltinModels,
		createdAt: index >= 0 ? records[index].createdAt : now,
		updatedAt: now,
	};

	if (index >= 0) records[index] = record;
	else records.push(record);
	await writeConfig(records);
	// 编辑一个已停用的供应商时，保存配置不能把它偷偷重新注册。
	if (record.enabled !== false) await registerRecord(record);
	else await unregisterRecord(record.id);
	return { provider: record, providers: await listProviders() };
}

export async function deleteCustomProvider(id: unknown): Promise<ProviderCard[]> {
	await initCustomProviders();
	const providerId = normalizeProviderId(id);
	const records = await readConfig();
	const next = records.filter((record) => record.id !== providerId);
	if (next.length === records.length) fail(`自定义供应商「${providerId}」不存在`);
	await writeConfig(next);
	await unregisterRecord(providerId);
	return listProviders();
}

export async function setCustomProviderEnabled(id: unknown, enabled: unknown): Promise<ProviderCard[]> {
	await initCustomProviders();
	const providerId = normalizeProviderId(id);
	const records = await readConfig();
	const record = records.find((item) => item.id === providerId);
	if (!record) fail(`自定义供应商「${providerId}」不存在`);
	const next = enabled !== false;
	if (record.enabled === next) return listProviders();
	record.enabled = next;
	record.updatedAt = Date.now();
	await writeConfig(records);
	if (next) await registerRecord(record);
	else await unregisterRecord(providerId);
	return listProviders();
}

/** 配额探测需要拿到自定义供应商的环境变量名和 Base URL。 */
export async function getCustomProviderRecord(id: string): Promise<CustomProviderRecord | undefined> {
	await initCustomProviders();
	const records = await readConfig();
	return records.find((record) => record.id === id);
}

/* ------------------------------------------------------------------ *
 * 连通性测试 / 拉取远程模型列表
 * ------------------------------------------------------------------ */

interface ConnectionInput {
	api: ProviderApi;
	baseUrl: string;
	apiKeyEnv: string;
}

function connectionInput(input: unknown): ConnectionInput {
	if (!input || typeof input !== 'object') fail('连接配置不能为空');
	const body = input as any;
	const api = normalizeApi(body.api);
	return {
		api,
		baseUrl: normalizeBaseUrl(body.baseUrl, api),
		apiKeyEnv: normalizeEnvName(body.apiKeyEnv),
	};
}

async function resolveEnvKey(name: string): Promise<string> {
	const key = await resolveSecret(name);
	if (!key) {
		fail(`服务进程里没有环境变量 ${name}。请在「设置 → 凭据」新增同名 env 层凭据，或把它加入 .env / docker compose 环境。`);
	}
	return key;
}

function candidateModelUrls(baseUrl: string, api: ProviderApi): string[] {
	const urls = [`${baseUrl}/models`];
	if (!/\/v\d+[a-z]*$/i.test(baseUrl)) {
		urls.push(`${baseUrl}/v1/models`);
		if (api === 'google-generative-ai') urls.push(`${baseUrl}/v1beta/models`);
	}
	return unique(urls);
}

function authHeaderVariants(api: ProviderApi, key: string): Array<Record<string, string>> {
	if (api === 'anthropic-messages') {
		return [
			{ 'x-api-key': key, 'anthropic-version': '2023-06-01' },
			// 很多 Anthropic 兼容网关实际走 Bearer；第一组失败后再试一次。
			{ authorization: `Bearer ${key}`, 'anthropic-version': '2023-06-01' },
		];
	}
	if (api === 'google-generative-ai') {
		return [{ 'x-goog-api-key': key }, { authorization: `Bearer ${key}` }];
	}
	return [
		{ authorization: `Bearer ${key}` },
		// Azure / 部分兼容网关用 api-key。
		{ 'api-key': key },
	];
}

function errorMessage(json: any, text: string, status: number): string {
	const message =
		json?.error?.message ??
		json?.error?.type ??
		json?.message ??
		(typeof json?.error === 'string' ? json.error : '');
	const detail = String(message || text || '').replace(/\s+/g, ' ').slice(0, 280);
	return `HTTP ${status}${detail ? `：${detail}` : ''}`;
}

function extractItems(json: any): any[] {
	if (Array.isArray(json)) return json;
	if (Array.isArray(json?.data)) return json.data;
	if (Array.isArray(json?.models)) return json.models;
	if (Array.isArray(json?.items)) return json.items;
	return [];
}

function normalizeRemoteModels(items: any[], api: ProviderApi): ProviderModelOption[] {
	const out = new Map<string, ProviderModelOption>();
	for (const item of items) {
		const raw = typeof item === 'string' ? item : String(item?.id ?? item?.name ?? item?.model ?? '').trim();
		if (!raw) continue;
		let id = raw;
		// Gemini 返回 models/gemini-2.5-pro，配置里用不带前缀的 id。
		if (api === 'google-generative-ai') id = id.replace(/^models\//, '');
		if (!id || out.has(id)) continue;
		const name = String(item?.displayName ?? item?.display_name ?? item?.name ?? id).trim() || id;
		const contextWindow = toNumber(
			item?.contextWindow ??
				item?.context_window ??
				item?.context_length ??
				item?.max_context_length ??
				item?.max_input_tokens ??
				item?.input_token_limit,
		);
		const maxTokens = toNumber(item?.maxTokens ?? item?.max_output_tokens ?? item?.output_token_limit);
		const option: ProviderModelOption = { id, name };
		if (contextWindow) option.contextWindow = contextWindow;
		if (maxTokens) option.maxTokens = maxTokens;
		if (item?.reasoning === true || item?.supports_reasoning === true) option.reasoning = true;
		out.set(id, option);
	}
	return [...out.values()].sort((a, b) => a.id.localeCompare(b.id));
}

async function requestModels(
	endpoint: string,
	api: ProviderApi,
	headers: Record<string, string>,
): Promise<{ models: ProviderModelOption[]; endpoint: string }> {
	const request = async (url: string) => {
		const signal = AbortSignal.timeout(15_000);
		const res = await fetch(url, {
			headers: { accept: 'application/json', ...headers },
			signal,
		});
		const text = await res.text();
		let json: any = null;
		try {
			json = text ? JSON.parse(text) : null;
		} catch {
			/* 非 JSON 错误体，下面用纯文本展示 */
		}
		if (!res.ok) throw new Error(errorMessage(json, text, res.status));
		return { json, url };
	};

	let { json, url } = await request(endpoint);
	const items = [...extractItems(json)];

	// Anthropic /models 默认只返回一页；按 has_more + last_id 继续翻。
	if (api === 'anthropic-messages') {
		let lastId = String(json?.last_id ?? '').trim();
		let more = Boolean(json?.has_more);
		for (let page = 0; more && lastId && page < 10; page++) {
			const next = new URL(url);
			next.searchParams.set('after_id', lastId);
			const result = await request(next.toString());
			json = result.json;
			url = result.url;
			items.push(...extractItems(json));
			more = Boolean(json?.has_more);
			lastId = String(json?.last_id ?? '').trim();
		}
	}

	return { models: normalizeRemoteModels(items, api), endpoint: url };
}

async function discoverModels(input: unknown): Promise<{
	models: ProviderModelOption[];
	endpoint: string;
	envVar: string;
	latencyMs: number;
}> {
	const config = connectionInput(input);
	const key = await resolveEnvKey(config.apiKeyEnv);
	const started = Date.now();
	const candidates = candidateModelUrls(config.baseUrl, config.api);
	const headers = authHeaderVariants(config.api, key);
	let lastError: unknown;

	for (const endpoint of candidates) {
		for (const variant of headers) {
			try {
				const result = await requestModels(endpoint, config.api, variant);
				return {
					...result,
					envVar: config.apiKeyEnv,
					latencyMs: Date.now() - started,
				};
			} catch (error) {
				lastError = error;
			}
		}
	}

	const message = lastError instanceof Error ? lastError.message : String(lastError);
	throw new ProviderError(
		`连接失败（${config.baseUrl}）：${message}。请检查地址、协议和环境变量 ${config.apiKeyEnv}。`,
	);
}

export async function fetchProviderModels(input: unknown) {
	const result = await discoverModels(input);
	return {
		ok: true as const,
		...result,
	};
}

export async function testProviderConnection(input: unknown) {
	const result = await discoverModels(input);
	return {
		ok: true as const,
		latencyMs: result.latencyMs,
		modelCount: result.models.length,
		endpoint: result.endpoint,
		envVar: result.envVar,
		models: result.models.slice(0, 5),
	};
}
