/**
 * 供应商额度探测。
 *
 * 两类信息分开收集、一起返回：
 *   - balance：有公开余额接口的供应商（OpenRouter / DeepSeek / Moonshot）
 *   - windows：从 /models 响应的 x-ratelimit-* / anthropic-ratelimit-* 头解析
 *
 * 只做只读探测，不发起对话请求，不消耗 token。失败信息不会包含任何密钥。
 */

import { getRuntime } from './chat.ts';
import { resolveSecret } from './credentials.ts';
import { getCustomProviderRecord, type CustomProviderRecord } from './providers.ts';

export interface QuotaBalanceDetail {
	label: string;
	amount: number;
}

export interface QuotaBalance {
	label: string;
	currency: string;
	remaining: number;
	total?: number;
	used?: number;
	details?: QuotaBalanceDetail[];
}

export interface QuotaWindow {
	label: string;
	limit?: number;
	remaining?: number;
	reset?: string;
	/** 订阅制额度使用百分比（0..100）。 */
	percent?: number;
	/** 当前窗口已限流。 */
	limited?: boolean;
}

export interface QuotaResult {
	providerId: string;
	status: 'ok' | 'unsupported' | 'error' | 'unconfigured';
	reachable: boolean;
	checkedAt: number;
	latencyMs?: number;
	balances: QuotaBalance[];
	windows: QuotaWindow[];
	plan?: string;
	sources: string[];
	warnings: string[];
	error?: string;
}

interface QuotaContext {
	providerId: string;
	record?: CustomProviderRecord;
	api: string;
	baseUrl?: string;
	apiKey?: string;
	authHeaders: Record<string, string>;
}

interface JsonResponse {
	json: any;
	headers: Headers;
	url: string;
	latencyMs: number;
}

const CACHE_TTL = 30_000;
const REQUEST_TIMEOUT = 8_000;
const cache = new Map<string, { at: number; result: QuotaResult }>();

export function invalidateQuotaCache(providerId?: string): void {
	if (providerId) cache.delete(providerId);
	else cache.clear();
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function numberValue(value: unknown): number | undefined {
	if (value === null || value === undefined || value === '') return undefined;
	const n = Number(String(value).replace(/,/g, ''));
	return Number.isFinite(n) ? n : undefined;
}

function stringValue(value: unknown): string {
	return value === null || value === undefined ? '' : String(value);
}

function headerValue(headers: Headers, names: string[]): string | undefined {
	for (const name of names) {
		const value = headers.get(name);
		if (value !== null && value !== undefined && value !== '') return value;
	}
	return undefined;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
	const lower = name.toLowerCase();
	return Object.keys(headers).some((key) => key.toLowerCase() === lower && Boolean(headers[key]));
}

function mergeHeaders(...sets: Array<Record<string, string | null | undefined>>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const set of sets) {
		for (const [key, value] of Object.entries(set ?? {})) {
			if (value !== null && value !== undefined && value !== '') out[key] = value;
		}
	}
	return out;
}

function joinUrl(base: string, path: string): string {
	return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function rootUrl(base: string, path: string): string {
	try {
		return new URL(`/${path.replace(/^\/+/, '')}`, base).toString();
	} catch {
		return joinUrl(base, path);
	}
}

function unique<T>(items: T[]): T[] {
	return [...new Set(items)];
}

function modelUrls(baseUrl: string, api: string): string[] {
	const base = baseUrl.replace(/\/+$/, '');
	const urls = [`${base}/models`];
	if (!/\/v\d+[a-z]*$/i.test(base)) {
		urls.push(`${base}/v1/models`);
		if (api === 'google-generative-ai') urls.push(`${base}/v1beta/models`);
	}
	return unique(urls);
}

function requestHeaders(ctx: QuotaContext): Array<Record<string, string>> {
	const base: Record<string, string> = { accept: 'application/json' };
	for (const [key, value] of Object.entries(ctx.authHeaders)) {
		if (value) base[key] = value;
	}

	const variants: Array<Record<string, string>> = [base];
	if (!ctx.apiKey) return variants;

	if (ctx.api === 'anthropic-messages') {
		if (!hasHeader(base, 'x-api-key')) {
			variants.push({ ...base, 'x-api-key': ctx.apiKey, 'anthropic-version': '2023-06-01' });
		}
		if (!hasHeader(base, 'authorization')) {
			variants.push({ ...base, authorization: `Bearer ${ctx.apiKey}`, 'anthropic-version': '2023-06-01' });
		}
	} else if (ctx.api === 'google-generative-ai') {
		if (!hasHeader(base, 'x-goog-api-key')) variants.push({ ...base, 'x-goog-api-key': ctx.apiKey });
	} else {
		if (!hasHeader(base, 'authorization')) variants.push({ ...base, authorization: `Bearer ${ctx.apiKey}` });
		if (!hasHeader(base, 'api-key')) variants.push({ ...base, 'api-key': ctx.apiKey });
	}
	return variants;
}

function authHeaders(ctx: QuotaContext): Record<string, string> {
	const variants = requestHeaders(ctx);
	return (
		variants.find(
			(headers) =>
				hasHeader(headers, 'authorization') ||
				hasHeader(headers, 'x-api-key') ||
				hasHeader(headers, 'api-key') ||
				hasHeader(headers, 'x-goog-api-key'),
		) ?? variants[0]
	);
}

function responseError(json: any, text: string, status: number): string {
	const detail =
		json?.error?.message ??
		json?.message ??
		(typeof json?.error === 'string' ? json.error : '') ??
		text;
	return `HTTP ${status}${detail ? `：${String(detail).replace(/\s+/g, ' ').slice(0, 220)}` : ''}`;
}

async function fetchJson(url: string, headers: Record<string, string>): Promise<JsonResponse> {
	const started = Date.now();
	const res = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT) });
	const text = await res.text();
	let json: any = null;
	try {
		json = text ? JSON.parse(text) : null;
	} catch {
		/* 非 JSON 错误体 */
	}
	if (!res.ok) throw new Error(responseError(json, text, res.status));
	return { json, headers: res.headers, url, latencyMs: Date.now() - started };
}

async function fetchFirst(urls: string[], headers: Record<string, string>): Promise<JsonResponse> {
	let lastError: unknown;
	for (const url of unique(urls)) {
		try {
			return await fetchJson(url, headers);
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError instanceof Error ? lastError : new Error('请求失败');
}

function balanceDetails(data: any): QuotaBalanceDetail[] {
	const details: QuotaBalanceDetail[] = [];
	const pairs: Array<[string, string]> = [
		['赠送', 'granted_balance'],
		['充值', 'topped_up_balance'],
		['代金券', 'voucher_balance'],
		['现金', 'cash_balance'],
	];
	for (const [label, key] of pairs) {
		const amount = numberValue(data?.[key]);
		if (amount !== undefined) details.push({ label, amount });
	}
	return details;
}

async function openRouterBalance(ctx: QuotaContext): Promise<{
	balances: QuotaBalance[];
	plan?: string;
	sources: string[];
	warnings: string[];
	response?: JsonResponse;
}> {
	const base = ctx.baseUrl!;
	const headers = authHeaders(ctx);
	const balances: QuotaBalance[] = [];
	const sources: string[] = [];
	const warnings: string[] = [];
	let plan: string | undefined;
	let response: JsonResponse | undefined;

	try {
		const result = await fetchJson(joinUrl(base, 'credits'), headers);
		response = result;
		sources.push(result.url);
		const data = result.json?.data ?? result.json;
		const total = numberValue(data?.total_credits ?? data?.totalCredits);
		const used = numberValue(data?.total_usage ?? data?.totalUsage);
		if (total !== undefined || used !== undefined) {
			const remaining = (total ?? 0) - (used ?? 0);
			balances.push({ label: 'Credits', currency: 'USD', remaining, total, used });
		}
	} catch (error) {
		warnings.push(`credits：${message(error)}`);
	}

	try {
		const result = await fetchJson(joinUrl(base, 'key'), headers);
		response ??= result;
		sources.push(result.url);
		const data = result.json?.data ?? result.json;
		if (data?.is_free_tier === true) plan = 'Free tier';
		const limit = numberValue(data?.limit);
		const used = numberValue(data?.usage);
		if (limit !== undefined) {
			balances.push({
				label: 'Key 额度',
				currency: 'USD',
				remaining: limit - (used ?? 0),
				total: limit,
				used,
			});
		}
	} catch (error) {
		warnings.push(`key：${message(error)}`);
	}

	return { balances, plan, sources: unique(sources), warnings, response };
}

async function deepSeekBalance(ctx: QuotaContext): Promise<{
	balances: QuotaBalance[];
	sources: string[];
	warnings: string[];
	response?: JsonResponse;
}> {
	const headers = authHeaders(ctx);
	const urls = unique([
		joinUrl(ctx.baseUrl!.replace(/\/v1\/?$/i, ''), 'user/balance'),
		rootUrl(ctx.baseUrl!, 'user/balance'),
	]);
	const warnings: string[] = [];
	try {
		const result = await fetchFirst(urls, headers);
		const infos = Array.isArray(result.json?.balance_infos) ? result.json.balance_infos : [];
		const balances = infos
			.map((info: any): QuotaBalance | null => {
				const remaining = numberValue(info?.total_balance);
				if (remaining === undefined) return null;
				const details = balanceDetails(info);
				return {
					label: '可用余额',
					currency: stringValue(info?.currency) || 'CNY',
					remaining,
					details: details.length ? details : undefined,
				};
			})
			.filter(Boolean) as QuotaBalance[];
		return { balances, sources: [result.url], warnings, response: result };
	} catch (error) {
		warnings.push(`balance：${message(error)}`);
		return { balances: [], sources: [], warnings };
	}
}

async function moonshotBalance(ctx: QuotaContext): Promise<{
	balances: QuotaBalance[];
	sources: string[];
	warnings: string[];
	response?: JsonResponse;
}> {
	const headers = authHeaders(ctx);
	const base = ctx.baseUrl!.replace(/\/+$/, '');
	const urls = unique([
		joinUrl(base, 'users/me/balance'),
		joinUrl(base, 'v1/users/me/balance'),
		rootUrl(base, 'v1/users/me/balance'),
	]);
	const warnings: string[] = [];
	try {
		const result = await fetchFirst(urls, headers);
		const data = result.json?.data ?? result.json;
		const remaining = numberValue(data?.available_balance ?? data?.availableBalance);
		if (remaining === undefined) {
			return { balances: [], sources: [result.url], warnings: ['balance 未返回可用余额'], response: result };
		}
		const details = balanceDetails(data);
		return {
			balances: [
				{
					label: '可用余额',
					currency: stringValue(data?.currency) || 'CNY',
					remaining,
					details: details.length ? details : undefined,
				},
			],
			sources: [result.url],
			warnings,
			response: result,
		};
	} catch (error) {
		warnings.push(`balance：${message(error)}`);
		return { balances: [], sources: [], warnings };
	}
}

async function openCodeGoUsage(ctx: QuotaContext): Promise<{
	balances: QuotaBalance[];
	windows: QuotaWindow[];
	plan?: string;
	sources: string[];
	warnings: string[];
	response?: JsonResponse;
}> {
	const warnings: string[] = [];
	const headers: Record<string, string> = {
		accept: 'application/json',
		...ctx.authHeaders,
	};
	// /zen/go/v1/usage accepts the API key as a Bearer token, unlike the
	// Anthropic-compatible inference endpoints which prefer x-api-key.
	if (ctx.apiKey) headers.authorization = `Bearer ${ctx.apiKey}`;

	try {
		// 自定义 Base URL 可能只是代理；订阅额度仍以 OpenCode 官方 origin 为准。
		let origin = 'https://opencode.ai';
		try {
			const url = new URL(ctx.baseUrl!);
			if (hostMatches(url.hostname.toLowerCase(), 'opencode.ai')) origin = url.origin;
		} catch {
			/* use official origin */
		}
		const result = await fetchJson(`${origin}/zen/go/v1/usage`, headers);
		const usage = result.json?.usage ?? result.json;
		const windows: QuotaWindow[] = [];
		for (const [key, label] of [
			['rolling', '5h'],
			['weekly', '7d'],
			['monthly', '30d'],
		] as const) {
			const meter = usage?.[key];
			if (!meter || typeof meter !== 'object') continue;
			const percent = numberValue(meter.percent);
			if (percent === undefined) continue;
			windows.push({
				label,
				percent: Math.max(0, Math.min(100, percent)),
				reset: stringValue(meter.resetsAt) || undefined,
				limited: meter.status === 'rate-limited' || meter.limited === true,
			});
		}
		return {
			balances: [],
			windows,
			sources: [result.url],
			warnings: windows.length ? warnings : ['Go 未返回额度窗口'],
			response: result,
		};
	} catch (error) {
		warnings.push(`Go 额度：${message(error)}`);
		return { balances: [], windows: [], sources: [], warnings };
	}
}

type QuotaAdapter = (
	ctx: QuotaContext,
) => Promise<{
	balances: QuotaBalance[];
	windows?: QuotaWindow[];
	plan?: string;
	sources: string[];
	warnings: string[];
	response?: JsonResponse;
}>;

function hostMatches(host: string, domain: string): boolean {
	return host === domain || host.endsWith(`.${domain}`);
}

function balanceAdapter(ctx: QuotaContext): QuotaAdapter | undefined {
	if (ctx.providerId === 'opencode-go') return openCodeGoUsage;
	let host = '';
	try {
		host = new URL(ctx.baseUrl ?? '').hostname.toLowerCase();
	} catch {
		/* ignore */
	}
	if (ctx.providerId === 'openrouter' || hostMatches(host, 'openrouter.ai')) return openRouterBalance;
	if (ctx.providerId === 'deepseek' || hostMatches(host, 'deepseek.com')) return deepSeekBalance;
	if (
		ctx.providerId.startsWith('moonshotai') ||
		hostMatches(host, 'moonshot.ai') ||
		hostMatches(host, 'moonshot.cn')
	) {
		return moonshotBalance;
	}
	return undefined;
}

function parseRateWindows(headers: Headers): QuotaWindow[] {
	const definitions: Array<{
		label: string;
		limit: string[];
		remaining: string[];
		reset: string[];
	}> = [
		{
			label: '请求',
			limit: ['x-ratelimit-limit-requests', 'anthropic-ratelimit-requests-limit', 'ratelimit-limit-requests'],
			remaining: [
				'x-ratelimit-remaining-requests',
				'anthropic-ratelimit-requests-remaining',
				'ratelimit-remaining-requests',
			],
			reset: ['x-ratelimit-reset-requests', 'anthropic-ratelimit-requests-reset', 'ratelimit-reset-requests'],
		},
		{
			label: '输入 Token',
			limit: [
				'x-ratelimit-limit-input-tokens',
				'anthropic-ratelimit-input-tokens-limit',
				'x-ratelimit-input-tokens-limit',
			],
			remaining: [
				'x-ratelimit-remaining-input-tokens',
				'anthropic-ratelimit-input-tokens-remaining',
				'x-ratelimit-input-tokens-remaining',
			],
			reset: [
				'x-ratelimit-reset-input-tokens',
				'anthropic-ratelimit-input-tokens-reset',
				'x-ratelimit-input-tokens-reset',
			],
		},
		{
			label: '输出 Token',
			limit: [
				'x-ratelimit-limit-output-tokens',
				'anthropic-ratelimit-output-tokens-limit',
				'x-ratelimit-output-tokens-limit',
			],
			remaining: [
				'x-ratelimit-remaining-output-tokens',
				'anthropic-ratelimit-output-tokens-remaining',
				'x-ratelimit-output-tokens-remaining',
			],
			reset: [
				'x-ratelimit-reset-output-tokens',
				'anthropic-ratelimit-output-tokens-reset',
				'x-ratelimit-output-tokens-reset',
			],
		},
		{
			label: 'Token',
			limit: ['x-ratelimit-limit-tokens', 'anthropic-ratelimit-tokens-limit', 'ratelimit-limit-tokens'],
			remaining: [
				'x-ratelimit-remaining-tokens',
				'anthropic-ratelimit-tokens-remaining',
				'ratelimit-remaining-tokens',
			],
			reset: ['x-ratelimit-reset-tokens', 'anthropic-ratelimit-tokens-reset', 'ratelimit-reset-tokens'],
		},
		{
			label: '速率',
			limit: ['x-ratelimit-limit', 'ratelimit-limit'],
			remaining: ['x-ratelimit-remaining', 'ratelimit-remaining'],
			reset: ['x-ratelimit-reset', 'ratelimit-reset'],
		},
	];

	const windows: QuotaWindow[] = [];
	const seen = new Set<string>();
	for (const definition of definitions) {
		if (seen.has(definition.label)) continue;
		const limit = headerValue(headers, definition.limit);
		const remaining = headerValue(headers, definition.remaining);
		if (limit === undefined && remaining === undefined) continue;
		seen.add(definition.label);
		windows.push({
			label: definition.label,
			limit: numberValue(limit),
			remaining: numberValue(remaining),
			reset: headerValue(headers, definition.reset),
		});
	}
	return windows;
}

async function probeRateLimit(ctx: QuotaContext): Promise<{
	reachable: boolean;
	windows: QuotaWindow[];
	latencyMs?: number;
	source?: string;
	headers?: Headers;
	error?: string;
}> {
	const variants = requestHeaders(ctx);
	let lastError: unknown;
	for (const url of modelUrls(ctx.baseUrl!, ctx.api)) {
		for (const headers of variants) {
			try {
				const result = await fetchJson(url, headers);
				return {
					reachable: true,
					windows: parseRateWindows(result.headers),
					latencyMs: result.latencyMs,
					source: result.url,
					headers: result.headers,
				};
			} catch (error) {
				lastError = error;
			}
		}
	}
	return { reachable: false, windows: [], error: message(lastError ?? '请求失败') };
}

async function buildContext(providerId: string): Promise<{ context?: QuotaContext; result?: QuotaResult }> {
	const runtime = await getRuntime();
	const provider = runtime.getProvider(providerId);
	const record = await getCustomProviderRecord(providerId);
	if (!provider && !record) {
		return {
			result: {
				providerId,
				status: 'error',
				reachable: false,
				checkedAt: Date.now(),
				balances: [],
				windows: [],
				sources: [],
				warnings: [],
				error: '供应商不存在',
			},
		};
	}

	const status = runtime.getProviderAuthStatus(providerId);
	if (!status?.configured) {
		return {
			result: {
				providerId,
				status: 'unconfigured',
				reachable: false,
				checkedAt: Date.now(),
				balances: [],
				windows: [],
				sources: [],
				warnings: [],
				error: `未配置凭据${record?.apiKeyEnv ? `（${record.apiKeyEnv}）` : ''}`,
			},
		};
	}

	let auth: any;
	try {
		auth = await runtime.getAuth(providerId);
	} catch {
		/* 用 record 的环境变量兜底 */
	}
	const models = runtime.getModels(providerId) ?? [];
	const model = models.find((item: any) => item?.api && item?.baseUrl) ?? models[0];
	const api = record?.api ?? String(model?.api ?? 'openai-completions');
	const baseUrl = record?.baseUrl || auth?.auth?.baseUrl || provider?.baseUrl || model?.baseUrl;
	const apiKey = auth?.auth?.apiKey || (record ? await resolveSecret(record.apiKeyEnv) : undefined);
	const authHeaders = mergeHeaders(auth?.auth?.headers);

	if (!baseUrl) {
		return {
			result: {
				providerId,
				status: 'unsupported',
				reachable: false,
				checkedAt: Date.now(),
				balances: [],
				windows: [],
				sources: [],
				warnings: [],
				error: '供应商没有可用的 Base URL',
			},
		};
	}

	return {
		context: {
			providerId,
			record,
			api,
			baseUrl,
			apiKey,
			authHeaders,
		},
	};
}

async function probe(providerId: string): Promise<QuotaResult> {
	const prepared = await buildContext(providerId);
	if (prepared.result) return prepared.result;
	const ctx = prepared.context!;

	const warnings: string[] = [];
	const sources: string[] = [];
	const balances: QuotaBalance[] = [];
	let windows: QuotaWindow[] = [];
	let plan: string | undefined;
	let reachable = false;
	let latencyMs: number | undefined;
	let headers: Headers | undefined;

	const adapter = balanceAdapter(ctx);
	if (adapter) {
		const result = await adapter(ctx);
		balances.push(...result.balances);
		windows.push(...(result.windows ?? []));
		warnings.push(...result.warnings);
		sources.push(...result.sources);
		plan = result.plan;
		if (result.response) {
			reachable = true;
			latencyMs = result.response.latencyMs;
			headers = result.response.headers;
		}
	}

	// 余额/订阅接口没结果时再探测 /models 的速率额度头。
	if (!balances.length && !windows.length) {
		const rate = await probeRateLimit(ctx);
		if (rate.reachable) {
			reachable = true;
			latencyMs = rate.latencyMs;
			headers = rate.headers;
			windows = rate.windows;
			if (rate.source) sources.push(rate.source);
		} else if (rate.error) {
			warnings.push(`速率额度：${rate.error}`);
		}
	}

	// 余额接口的响应头也可能带速率额度。
	if (!windows.length && headers) windows = parseRateWindows(headers);

	const ok = balances.length > 0 || windows.length > 0;
	const error = warnings.length ? warnings.join('；') : undefined;
	return {
		providerId,
		status: ok ? 'ok' : reachable ? 'unsupported' : 'error',
		reachable,
		checkedAt: Date.now(),
		latencyMs,
		balances,
		windows,
		plan,
		sources: unique(sources),
		warnings,
		...(ok ? {} : { error: error ?? (reachable ? '接口没有返回余额或速率额度' : '无法连接额度接口') }),
	};
}

export async function providerQuota(providerId: string, options: { force?: boolean } = {}): Promise<QuotaResult> {
	const key = String(providerId ?? '');
	if (!key) throw new Error('providerId required');
	const cached = cache.get(key);
	if (!options.force && cached && Date.now() - cached.at < CACHE_TTL) return cached.result;
	const result = await probe(key);
	cache.set(key, { at: Date.now(), result });
	return result;
}
