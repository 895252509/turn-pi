/**
 * 凭据管理器（v1 / P2）。
 *
 * 两条使用路径：
 *   - env 层：保存时写入 process.env，Pi SDK 每次请求都会重新读取，不需要重启；
 *   - scoped 层：agent 只拿短期租约 + loopback 代理 URL，真实密钥由本模块注入。
 *
 * 设计见 docs/credential-manager.md。这里只负责数据与能力，不碰 HTTP 路由。
 */

import {
	createCipheriv,
	createDecipheriv,
	randomBytes,
	randomUUID,
	timingSafeEqual,
	createHash,
} from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const RUNTIME_DIR = resolve(
	process.env.PI_RUNTIME_DIR ?? join(import.meta.dirname ?? '.', '..', 'runtime'),
);
const CREDENTIALS_FILE =
	process.env.PI_CREDENTIALS_FILE ?? join(RUNTIME_DIR, 'credentials.json');
const KEY_FILE = process.env.PI_CREDENTIAL_KEY_FILE ?? join(RUNTIME_DIR, 'credentials.key');
const AUDIT_FILE =
	process.env.PI_CREDENTIAL_AUDIT ?? join(RUNTIME_DIR, 'credential-audit.jsonl');
const AUDIT_MAX_BYTES = Number(process.env.PI_CREDENTIAL_AUDIT_MAX ?? 5 * 1024 * 1024);
const PORT = Number(process.env.PORT ?? 44100);
const LEASE_TTL_SECONDS = 600;
const APPROVAL_TIMEOUT_MS = 120_000;
const PROXY_TIMEOUT_MS = 30_000;
const PROXY_BODY_LIMIT = 2 * 1024 * 1024;
const ALLOW_INSECURE_HTTP = process.env.PI_CREDENTIAL_ALLOW_HTTP === '1';

export const CREDENTIAL_KINDS = ['bearer', 'api-key', 'basic', 'query', 'env'] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];
export type CredentialTier = 'env' | 'scoped';
export type CredentialPolicy = 'ask' | 'auto-read';

export interface SecretBox {
	v: 1;
	iv: string;
	tag: string;
	data: string;
}

export interface CredentialRecord {
	id: string;
	name: string;
	label?: string;
	kind: CredentialKind;
	tier: CredentialTier;
	/** 实际密文；用环境变量引用时为空。 */
	secret?: SecretBox;
	/** 以 CRED_ 开头的环境变量名；有值时在运行时从 process.env 解析。 */
	secretEnv?: string;
	headerName?: string;
	headerPrefix?: string;
	username?: string;
	queryParam?: string;
	envName?: string;
	baseUrl?: string;
	allowedHosts: string[];
	allowedPathPrefix?: string;
	allowedMethods: string[];
	scopes: string[];
	policy: CredentialPolicy;
	createdAt: number;
	updatedAt: number;
	lastUsedAt?: number;
	useCount: number;
}

export interface PublicCredential {
	id: string;
	name: string;
	label?: string;
	kind: CredentialKind;
	tier: CredentialTier;
	headerName?: string;
	headerPrefix?: string;
	username?: string;
	queryParam?: string;
	envName?: string;
	envPresent?: boolean;
	baseUrl?: string;
	allowedHosts: string[];
	allowedPathPrefix?: string;
	allowedMethods: string[];
	scopes: string[];
	policy: CredentialPolicy;
	createdAt: number;
	updatedAt: number;
	lastUsedAt?: number;
	useCount: number;
	hasSecret: boolean;
	secretEnv?: string;
	secretEnvPresent?: boolean;
}

export interface CredentialList {
	credentials: PublicCredential[];
	leases: number;
	sessionGrants: number;
	envHydrated: string[];
	importableEnv: string[];
	keySource: 'env' | 'file' | 'unknown';
}

interface Lease {
	id: string;
	credentialId: string;
	sessionId: string;
	chatId: string;
	scopes: string[];
	/** null = 会话级授权：随会话结束/撤销失效，不按时间过期。 */
	expiresAt: number | null;
	readOnly: boolean;
	decision: string;
}

interface PendingApproval {
	id: string;
	chatId: string;
	sessionId: string;
	credentialId: string;
	credentialName: string;
	scopes: string[];
	reason: string;
	expiresAt: number;
	resolve: (decision: ApprovalDecision) => void;
	timer: NodeJS.Timeout;
}

export type ApprovalDecision = 'once' | 'session' | 'deny';
export type ApprovalDecisionInput = 'once' | 'session' | 'deny';

export interface ApprovalRequestEvent {
	requestId: string;
	credential: {
		name: string;
		label: string;
		kind: CredentialKind;
		hosts: string[];
		scopes: string[];
	};
	reason: string;
	scopes: string[];
	sessionId: string;
	expiresAt: number;
}

export class CredentialError extends Error {
	status: number;
	constructor(message: string, status = 400) {
		super(message);
		this.status = status;
	}
}

function fail(message: string, status = 400): never {
	throw new CredentialError(message, status);
}

function text(value: unknown): string {
	return String(value ?? '').trim();
}

function bool(value: unknown): boolean {
	return value === true || value === 'true' || value === 1;
}

function listValue(value: unknown): string[] {
	if (Array.isArray(value)) {
		return [...new Set(value.map((item) => text(item)).filter(Boolean))];
	}
	if (typeof value === 'string') {
		return [...new Set(value.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean))];
	}
	return [];
}

/* ------------------------------------------------------------------ *
 * 加密与持久化
 * ------------------------------------------------------------------ */

let masterKey: Buffer | undefined;
let keySource: CredentialList['keySource'] = 'unknown';

function decodeKey(value: string): Buffer | undefined {
	const raw = value.trim();
	if (!raw) return undefined;
	try {
		const buffer = Buffer.from(raw, 'base64');
		if (buffer.length === 32) return buffer;
	} catch {
		/* 继续尝试 hex */
	}
	try {
		const buffer = Buffer.from(raw, 'hex');
		if (buffer.length === 32) return buffer;
	} catch {
		/* 忽略 */
	}
	return undefined;
}

async function loadMasterKey(): Promise<Buffer> {
	if (masterKey) return masterKey;
	const fromEnv = decodeKey(process.env.PI_CREDENTIAL_KEY ?? '');
	if (fromEnv) {
		masterKey = fromEnv;
		keySource = 'env';
		return masterKey;
	}
	try {
		const raw = await readFile(KEY_FILE, 'utf8');
		const parsed = decodeKey(raw);
		if (parsed) {
			masterKey = parsed;
			keySource = 'file';
			return masterKey;
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
	}
	const generated = randomBytes(32);
	await mkdir(dirname(KEY_FILE), { recursive: true });
	await writeFile(KEY_FILE, generated.toString('base64') + '\n', { encoding: 'utf8', mode: 0o600 });
	masterKey = generated;
	keySource = 'file';
	return masterKey;
}

function aadFor(record: { id: string; name: string }): Buffer {
	return Buffer.from(`${record.id}|${record.name}|1`, 'utf8');
}

function encryptSecret(value: string, record: { id: string; name: string }, key: Buffer): SecretBox {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', key, iv);
	cipher.setAAD(aadFor(record));
	const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
	return {
		v: 1,
		iv: iv.toString('base64'),
		tag: cipher.getAuthTag().toString('base64'),
		data: data.toString('base64'),
	};
}

function decryptSecret(box: SecretBox, record: { id: string; name: string }, key: Buffer): string {
	if (!box || box.v !== 1) fail('凭据密文格式不正确', 500);
	const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
	decipher.setAAD(aadFor(record));
	decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
	try {
		return Buffer.concat([
			decipher.update(Buffer.from(box.data, 'base64')),
			decipher.final(),
		]).toString('utf8');
	} catch {
		fail('凭据解密失败：主密钥不匹配或文件损坏', 500);
	}
}

let records: CredentialRecord[] = [];
let initialised = false;
let initialising: Promise<void> | undefined;
const hydratedEnv = new Set<string>();
const originalEnv = new Map<string, string | undefined>();
const redactionValues = new Set<string>();
let redactionList: string[] = [];
let redactionDirty = true;

function rememberSecret(value: string) {
	if (!value || value.length < 6) return;
	const escaped = JSON.stringify(value).slice(1, -1);
	redactionValues.add(value);
	if (escaped !== value) redactionValues.add(escaped);
	redactionDirty = true;
}

function forgetSecret(value: string) {
	if (!value) return;
	redactionValues.delete(value);
	redactionValues.delete(JSON.stringify(value).slice(1, -1));
	redactionDirty = true;
}

/** 对文本做已知 secret 替换；SSE、代理响应和错误信息共用。 */
export function redact(value: string): string {
	if (!redactionValues.size) return value;
	if (redactionDirty) {
		redactionList = [...redactionValues].sort((a, b) => b.length - a.length);
		redactionDirty = false;
	}
	let out = value;
	for (const secret of redactionList) {
		if (out.includes(secret)) out = out.split(secret).join('***');
	}
	return out;
}

function sanitizePathPrefix(value: unknown): string | undefined {
	const raw = text(value);
	if (!raw) return undefined;
	if (!raw.startsWith('/')) fail('允许的路径前缀必须以 / 开头');
	return raw;
}

function validHostPattern(host: string): boolean {
	if (!host || host === '*') return false;
	if (host.startsWith('*.')) {
		const rest = host.slice(2);
		return Boolean(rest) && !rest.includes('*') && !rest.includes('/');
	}
	return !host.includes('*') && !host.includes('/') && !host.includes(':');
}

function normalizeHosts(value: unknown): string[] {
	const hosts = listValue(value).map((host) => host.toLowerCase());
	if (!hosts.length) fail('scoped 凭据至少需要一个 allowedHosts');
	for (const host of hosts) {
		if (!validHostPattern(host)) fail(`不允许的 host：${host}（精确 host 或 *.example.com）`);
	}
	return [...new Set(hosts)];
}

function normalizeMethods(value: unknown): string[] {
	const methods = listValue(value).map((method) => method.toUpperCase());
	const out = methods.length ? methods : ['GET'];
	const allowed = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
	for (const method of out) {
		if (!allowed.has(method)) fail(`不支持的方法：${method}`);
	}
	return [...new Set(out)];
}

function normalizeName(value: unknown): string {
	const name = text(value).toLowerCase();
	if (!/^[a-z][a-z0-9-]{1,31}$/.test(name)) {
		fail('凭据名只能使用小写字母、数字和短横线，且以字母开头（2–32 字符）');
	}
	return name;
}

function normalizeEnvName(value: unknown): string {
	const name = text(value);
	if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
		fail('env 层凭据需要合法的环境变量名（大写字母、数字、下划线，且以字母开头）');
	}
	return name;
}

function normalizeBaseUrl(value: unknown): string {
	const raw = text(value);
	if (!raw) fail('scoped 凭据需要 baseUrl');
	if (!/^https?:\/\//i.test(raw)) fail('baseUrl 需要以 http:// 或 https:// 开头');
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		fail('baseUrl 格式不正确');
	}
	url.hash = '';
	url.search = '';
	return url.toString().replace(/\/+$/, '');
}

function hostMatches(host: string, patterns: string[]): boolean {
	const target = host.toLowerCase();
	return patterns.some((pattern) => {
		const rule = pattern.toLowerCase();
		if (rule === target) return true;
		if (rule.startsWith('*.')) {
			const suffix = rule.slice(1);
			return target.endsWith(suffix) && target.length > suffix.length;
		}
		return false;
	});
}

function defaultHeaders(kind: CredentialKind, input: any): { headerName?: string; headerPrefix?: string } {
	if (kind === 'bearer') {
		return {
			headerName: text(input.headerName) || 'Authorization',
			headerPrefix: input.headerPrefix === undefined ? 'Bearer ' : String(input.headerPrefix),
		};
	}
	if (kind === 'api-key') {
		return {
			headerName: text(input.headerName) || 'X-API-Key',
			headerPrefix: input.headerPrefix === undefined ? '' : String(input.headerPrefix),
		};
	}
	if (kind === 'basic') {
		return { headerName: 'Authorization', headerPrefix: 'Basic ' };
	}
	return {};
}

function normalizeSecretEnv(value: unknown): string | undefined {
	const name = text(value);
	if (!name) return undefined;
	if (!/^CRED_[A-Z0-9_]+$/.test(name)) {
		fail('环境变量名必须以 CRED_ 开头，且只包含大写字母、数字和下划线');
	}
	return name;
}

function normalizeRecord(input: any, existing?: CredentialRecord): CredentialRecord {
	const name = normalizeName(input.name);
	const tier: CredentialTier = input.tier === 'env' ? 'env' : input.tier === 'scoped' ? 'scoped' : 'scoped';
	let kind = CREDENTIAL_KINDS.includes(input.kind) ? (input.kind as CredentialKind) : 'bearer';
	if (tier === 'env') kind = 'env';
	if (tier === 'scoped' && kind === 'env') fail('scoped 层不能使用 env 类型');
	const secretEnv = normalizeSecretEnv(input.secretEnv) ?? existing?.secretEnv;
	if (tier === 'env') {
		const envName = normalizeEnvName(input.envName);
		return {
			id: existing?.id || text(input.id) || `cred_${randomBytes(9).toString('base64url')}`,
			name,
			label: text(input.label) || undefined,
			kind,
			tier,
			secret: existing?.secret,
			secretEnv,
			envName,
			allowedHosts: [],
			allowedMethods: [],
			scopes: [],
			policy: 'ask',
			createdAt: existing?.createdAt ?? Date.now(),
			updatedAt: Date.now(),
			lastUsedAt: existing?.lastUsedAt,
			useCount: existing?.useCount ?? 0,
		};
	}

	const baseUrl = normalizeBaseUrl(input.baseUrl);
	const baseHost = new URL(baseUrl).hostname;
	const allowedHosts = normalizeHosts(input.allowedHosts);
	if (!hostMatches(baseHost, allowedHosts)) {
		fail(`baseUrl 的 host（${baseHost}）不在 allowedHosts 中`);
	}
	const allowedMethods = normalizeMethods(input.allowedMethods);
	const scopes = listValue(input.scopes);
	if (!scopes.length) fail('scoped 凭据至少需要一个 scope 标签');
	const headers = defaultHeaders(kind, input);
	return {
		id: existing?.id || text(input.id) || `cred_${randomBytes(9).toString('base64url')}`,
		name,
		label: text(input.label) || undefined,
		kind,
		tier,
		secret: existing?.secret,
		secretEnv,
		headerName: headers.headerName,
		headerPrefix: headers.headerPrefix,
		username: kind === 'basic' ? text(input.username) : undefined,
		queryParam: kind === 'query' ? text(input.queryParam) || 'token' : undefined,
		envName: undefined,
		baseUrl,
		allowedHosts,
		allowedPathPrefix: sanitizePathPrefix(input.allowedPathPrefix),
		allowedMethods,
		scopes,
		policy: input.policy === 'auto-read' ? 'auto-read' : 'ask',
		createdAt: existing?.createdAt ?? Date.now(),
		updatedAt: Date.now(),
		lastUsedAt: existing?.lastUsedAt,
		useCount: existing?.useCount ?? 0,
	};
}

function normalizeStored(value: any): CredentialRecord | null {
	try {
		if (!value || typeof value !== 'object') return null;
		const hasBox = value.secret && typeof value.secret === 'object';
		const secretEnv = normalizeSecretEnv(value.secretEnv);
		if (!hasBox && !secretEnv) return null;
		const record = normalizeRecord(value);
		record.id = text(value.id) || record.id;
		record.secret = hasBox ? (value.secret as SecretBox) : undefined;
		record.secretEnv = secretEnv;
		record.createdAt = Number(value.createdAt) || record.createdAt;
		record.updatedAt = Number(value.updatedAt) || record.updatedAt;
		record.lastUsedAt = Number(value.lastUsedAt) || undefined;
		record.useCount = Number(value.useCount) || 0;
		return record;
	} catch {
		return null;
	}
}

async function readRecords(): Promise<CredentialRecord[]> {
	try {
		const raw = await readFile(CREDENTIALS_FILE, 'utf8');
		const parsed = JSON.parse(raw);
		const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.credentials) ? parsed.credentials : [];
		const out: CredentialRecord[] = [];
		const seen = new Set<string>();
		for (const item of list) {
			const record = normalizeStored(item);
			if (!record || seen.has(record.id)) continue;
			seen.add(record.id);
			out.push(record);
		}
		return out;
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
		throw error;
	}
}

async function writeRecords(next: CredentialRecord[]): Promise<void> {
	await mkdir(dirname(CREDENTIALS_FILE), { recursive: true });
	const tmp = `${CREDENTIALS_FILE}.tmp`;
	await writeFile(
		tmp,
		JSON.stringify({ version: 1, credentials: next }, null, 2) + '\n',
		{ encoding: 'utf8', mode: 0o600 },
	);
	await rename(tmp, CREDENTIALS_FILE);
}

function applyEnv(name: string, value: string) {
	if (!hydratedEnv.has(name)) originalEnv.set(name, process.env[name]);
	hydratedEnv.add(name);
	process.env[name] = value;
}

function restoreEnv(name: string) {
	if (!hydratedEnv.has(name)) return;
	const original = originalEnv.get(name);
	if (original === undefined) delete process.env[name];
	else process.env[name] = original;
	hydratedEnv.delete(name);
	originalEnv.delete(name);
}

async function hydrateEnvTier() {
	for (const record of records) {
		if (record.tier !== 'env' || !record.envName) continue;
		try {
			const value = plaintext(record);
			applyEnv(record.envName, value);
			rememberSecret(value);
		} catch (error) {
			process.stderr.write(
				`[credentials] 无法恢复 ${record.name} 到环境变量：${error instanceof Error ? error.message : String(error)}\n`,
			);
		}
	}
}

/** 启动时调用一次；并发调用共享同一个 Promise。 */
export async function initCredentials(): Promise<void> {
	if (initialised) return;
	initialising ??= (async () => {
		try {
			await loadMasterKey();
			records = await readRecords();
			// 先收集所有明文用于 SSE 脱敏，再 hydrate env 层。
			for (const record of records) {
				try {
					rememberSecret(plaintext(record));
				} catch {
					/* 环境变量暂未设置或密文损坏：列表仍可见，由用户修复 */
				}
			}
			await hydrateEnvTier();
			initialised = true;
			if (records.length) {
				process.stdout.write(
					`[credentials] loaded ${records.length} record(s) from ${CREDENTIALS_FILE}\n`,
				);
			}
		} finally {
			initialising = undefined;
		}
	})();
	return initialising;
}

/* ------------------------------------------------------------------ *
 * 查询 / CRUD
 * ------------------------------------------------------------------ */

function plaintext(record: CredentialRecord): string {
	if (record.secretEnv) {
		const value = process.env[record.secretEnv];
		if (!value) fail(`环境变量 ${record.secretEnv} 未设置`, 500);
		rememberSecret(value);
		return value;
	}
	if (!record.secret?.data) fail('凭据没有可用的 secret，请重新填写或设置环境变量引用', 500);
	return decryptSecret(record.secret, record, masterKey!);
}

function publicView(record: CredentialRecord): PublicCredential {
	return {
		id: record.id,
		name: record.name,
		label: record.label,
		kind: record.kind,
		tier: record.tier,
		headerName: record.headerName,
		headerPrefix: record.headerPrefix,
		username: record.username,
		queryParam: record.queryParam,
		envName: record.envName,
		envPresent: record.envName ? process.env[record.envName] !== undefined : undefined,
		baseUrl: record.baseUrl,
		allowedHosts: [...record.allowedHosts],
		allowedPathPrefix: record.allowedPathPrefix,
		allowedMethods: [...record.allowedMethods],
		scopes: [...record.scopes],
		policy: record.policy,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		lastUsedAt: record.lastUsedAt,
		useCount: record.useCount,
		hasSecret: Boolean(record.secret?.data || record.secretEnv),
		secretEnv: record.secretEnv,
		secretEnvPresent: record.secretEnv ? Boolean(process.env[record.secretEnv]) : undefined,
	};
}

function importableEnvNames(): string[] {
	if (!initialised) return [];
	const used = new Set(records.map((record) => record.envName).filter(Boolean));
	const referenced = new Set(records.map((record) => record.secretEnv).filter(Boolean));
	const reserved = new Set(['PI_ACCESS_TOKEN', 'PI_CREDENTIAL_KEY']);
	return Object.keys(process.env)
		.filter((name) => !used.has(name) && !referenced.has(name) && !reserved.has(name))
		.filter((name) => /(?:^|_)(?:API_?KEY|KEY|TOKEN|SECRET|PASSWORD)$/i.test(name))
		.filter((name) => Boolean(process.env[name]?.trim()))
		.sort();
}

export async function listCredentials(): Promise<CredentialList> {
	await initCredentials();
	return {
		credentials: [...records].sort((a, b) => a.name.localeCompare(b.name)).map(publicView),
		leases: leases.size,
		sessionGrants: [...sessionGrants.values()].reduce((sum, byCred) => sum + byCred.size, 0),
		envHydrated: [...hydratedEnv].sort(),
		importableEnv: importableEnvNames(),
		keySource,
	};
}

/** agent 只看到能力，不看到 secret / 内部字段。 */
export async function listCredentialCardsForAgent() {
	await initCredentials();
	return {
		credentials: records
			.filter((record) => record.tier === 'scoped')
			.map((record) => ({
				name: record.name,
				label: record.label ?? record.name,
				kind: record.kind,
				hosts: [...record.allowedHosts],
				scopes: [...record.scopes],
				policy: record.policy,
				usage: `cred_use({ name: '${record.name}', reason, scope })`,
			})),
	};
}

/** provider / quota 的统一读取入口：vault 优先，其次进程环境。 */
export async function resolveSecret(name: string): Promise<string | undefined> {
	await initCredentials();
	const record = records.find((item) => item.envName === name);
	if (record) {
		try {
			return plaintext(record);
		} catch {
			/* 解密失败时退回 process.env */
		}
	}
	return process.env[name];
}

function secretEnvironmentRef(value: string): string | undefined {
	const raw = value.trim();
	if (!raw) return undefined;
	if (!/^CRED_/i.test(raw)) return undefined;
	if (!/^CRED_[A-Z0-9_]+$/.test(raw)) {
		fail('以 CRED_ 开头时按环境变量名解析，只能包含大写字母、数字和下划线');
	}
	return raw;
}

export async function saveCredential(input: unknown): Promise<CredentialList> {
	await initCredentials();
	if (!input || typeof input !== 'object') fail('凭据配置不能为空');
	const body = input as any;
	const id = text(body.id);
	const existing = id ? records.find((record) => record.id === id) : undefined;
	if (id && !existing) fail(`凭据不存在：${id}`, 404);
	const record = normalizeRecord(body, existing);

	const duplicate = records.find((item) => item.name === record.name && item.id !== existing?.id);
	if (duplicate) fail(`凭据名已存在：${record.name}`);

	const secretInput = body.secret === undefined ? '' : String(body.secret).trim();
	const secretRef = body.secretIsEnvRef === false ? undefined : secretEnvironmentRef(secretInput);
	if (!existing && !secretInput) fail('新建凭据时必须提供 secret 或 CRED_ 环境变量名');
	if (existing?.tier === 'env' && existing.envName && (record.tier !== 'env' || record.envName !== existing.envName)) {
		restoreEnv(existing.envName);
	}

	if (secretInput) {
		if (existing) {
			try {
				forgetSecret(plaintext(existing));
			} catch {
				/* 旧密文损坏或环境变量暂未设置，不影响新值 */
			}
		}
		if (secretRef) {
			record.secretEnv = secretRef;
			record.secret = undefined;
			const live = process.env[secretRef];
			if (live) rememberSecret(live);
		} else {
			record.secretEnv = undefined;
			record.secret = encryptSecret(secretInput, record, masterKey!);
			rememberSecret(secretInput);
		}
	} else if (existing) {
		record.secret = existing.secret;
		record.secretEnv = existing.secretEnv;
		if (existing.name !== record.name && record.secret) {
			// AAD 绑定 name，改名必须用旧名解出明文后重新加密。
			record.secret = encryptSecret(plaintext(existing), record, masterKey!);
		}
	}
	if (!record.secret?.data && !record.secretEnv) fail('凭据缺少 secret，请重新填写或设置 CRED_ 环境变量引用');

	if (secretsChanged(existing, record, secretInput)) revokeLeases({ credentialId: record.id });

	if (existing) {
		const index = records.indexOf(existing);
		records[index] = record;
	} else {
		records.push(record);
	}
	if (record.tier === 'env' && record.envName) {
		try {
			const value = plaintext(record);
			if (value) applyEnv(record.envName, value);
		} catch (error) {
			process.stderr.write(
				`[credentials] ${record.name} 暂时无法写入 ${record.envName}：${error instanceof Error ? error.message : String(error)}\n`,
			);
		}
	}
	await writeRecords(records);
	return listCredentials();
}

function secretsChanged(
	existing: CredentialRecord | undefined,
	next: CredentialRecord,
	secretInput: string,
): boolean {
	if (!existing) return false;
	if (secretInput) return true;
	return (
		existing.name !== next.name ||
		existing.secretEnv !== next.secretEnv ||
		existing.tier !== next.tier ||
		existing.kind !== next.kind ||
		existing.baseUrl !== next.baseUrl ||
		existing.allowedPathPrefix !== next.allowedPathPrefix ||
		JSON.stringify(existing.allowedHosts) !== JSON.stringify(next.allowedHosts) ||
		JSON.stringify(existing.allowedMethods) !== JSON.stringify(next.allowedMethods) ||
		JSON.stringify(existing.scopes) !== JSON.stringify(next.scopes)
	);
}

export async function deleteCredential(input: unknown): Promise<CredentialList> {
	await initCredentials();
	const id = text((input as any)?.id ?? input);
	const record = records.find((item) => item.id === id);
	if (!record) fail(`凭据不存在：${id}`, 404);
	const secret = (() => {
		try {
			return plaintext(record);
		} catch {
			return '';
		}
	})();
	if (record.tier === 'env' && record.envName) restoreEnv(record.envName);
	forgetSecret(secret);
	records = records.filter((item) => item.id !== record.id);
	revokeLeases({ credentialId: record.id });
	clearCredentialGrants(record.id);
	for (const [requestId, pending] of [...approvals]) {
		if (pending.credentialId !== record.id) continue;
		clearTimeout(pending.timer);
		approvals.delete(requestId);
		pending.resolve('deny');
	}
	await writeRecords(records);
	return listCredentials();
}

export async function rotateCredential(input: unknown): Promise<CredentialList> {
	await initCredentials();
	const body = input as any;
	const id = text(body?.id);
	const secret = String(body?.secret ?? '').trim();
	const secretRef = body?.secretIsEnvRef === false ? undefined : secretEnvironmentRef(secret);
	if (!id) fail('缺少凭据 id');
	if (!secret) fail('轮换需要新的 secret 或 CRED_ 环境变量名');
	const record = records.find((item) => item.id === id);
	if (!record) fail(`凭据不存在：${id}`, 404);
	const old = (() => {
		try {
			return plaintext(record);
		} catch {
			return '';
		}
	})();
	forgetSecret(old);
	if (secretRef) {
		record.secretEnv = secretRef;
		record.secret = undefined;
		const live = process.env[secretRef];
		if (live) rememberSecret(live);
	} else {
		record.secretEnv = undefined;
		record.secret = encryptSecret(secret, record, masterKey!);
		rememberSecret(secret);
	}
	record.updatedAt = Date.now();
	if (record.tier === 'env' && record.envName) {
		try {
			const value = plaintext(record);
			if (value) applyEnv(record.envName, value);
		} catch {
			/* 环境变量暂未设置：保留引用，等它出现后再 hydrate */
		}
	}
	revokeLeases({ credentialId: record.id });
	await writeRecords(records);
	appendAudit({ actor: 'user', credential: record.name, action: 'rotate' });
	return listCredentials();
}

export async function importEnvCredential(input: unknown): Promise<CredentialList> {
	await initCredentials();
	const body = input as any;
	const envName = normalizeEnvName(body?.envName);
	const value = process.env[envName]?.trim();
	if (!value) fail(`进程环境里没有 ${envName}`);
	const name = normalizeName(body?.name || envName.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, ''));
	return saveCredential({
		name,
		label: text(body?.label) || envName,
		tier: 'env',
		kind: 'env',
		envName,
		secret: value,
		// 导入的是环境变量的值；即使值本身以 CRED_ 开头也按字面密钥处理。
		secretIsEnvRef: false,
	});
}

/* ------------------------------------------------------------------ *
 * 测试连接
 * ------------------------------------------------------------------ */

export interface CredentialTestResult {
	ok: boolean;
	status: number;
	latencyMs: number;
	endpoint: string;
	message: string;
}

export function injectionFor(
	record: Pick<CredentialRecord, 'kind' | 'headerName' | 'headerPrefix' | 'username' | 'queryParam'>,
	secret: string,
	headers: Record<string, string>,
	url: URL,
) {
	if (record.kind === 'query') {
		url.searchParams.set(record.queryParam || 'token', secret);
		return;
	}
	if (record.kind === 'basic') {
		headers.authorization = `Basic ${Buffer.from(`${record.username ?? ''}:${secret}`).toString('base64')}`;
		return;
	}
	const name = record.headerName || (record.kind === 'api-key' ? 'X-API-Key' : 'Authorization');
	// 用 || 而不是 ??：界面上的前缀输入框清空后存的是空字符串，不是 undefined。
	// 空字符串配上 bearer 会发出 `Authorization: <裸 token>`，服务端一律 401，
	// 而报错看起来像 token 无效——留空就按 bearer 的默认前缀走。
	headers[name.toLowerCase()] = `${record.headerPrefix || (record.kind === 'bearer' ? 'Bearer ' : '')}${secret}`;
}

export async function testCredential(input: unknown): Promise<CredentialTestResult> {
	await initCredentials();
	const body = input as any;
	let record: Partial<CredentialRecord>;
	let secret: string;
	let endpoint: string;
	if (body?.id) {
		const stored = records.find((item) => item.id === text(body.id));
		if (!stored) fail(`凭据不存在：${body.id}`, 404);
		if (stored.tier === 'env') {
			return {
				ok: true,
				status: 0,
				latencyMs: 0,
				endpoint: stored.envName ?? '',
				message: `env 层凭据已注入进程环境（${stored.envName}）；请用「模型供应商 → 测试连接」验证上游。`,
			};
		}
		record = stored;
		secret = plaintext(stored);
		endpoint = stored.baseUrl ?? '';
		if (!endpoint) fail('凭据没有 baseUrl，无法测试');
	} else {
		const kind = CREDENTIAL_KINDS.includes(body?.kind) ? (body.kind as CredentialKind) : 'bearer';
		if (kind === 'env') fail('临时测试需要 scoped 类型的凭据');
		secret = String(body?.secret ?? '');
		if (!secret) fail('测试需要 secret');
		endpoint = normalizeBaseUrl(body?.baseUrl);
		record = {
			...defaultHeaders(kind, body),
			kind,
			username: text(body?.username) || undefined,
			queryParam: text(body?.queryParam) || 'token',
		};
	}
	const started = Date.now();
	const headers: Record<string, string> = { accept: '*/*' };
	const url = new URL(endpoint);
	injectionFor(record as any, secret, headers, url);
	let response: Response;
	try {
		response = await fetch(url, {
			method: 'GET',
			headers,
			redirect: 'manual',
			signal: AbortSignal.timeout(10_000),
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		appendAudit({
			actor: 'user',
			credential: (record as any).name,
			action: 'test',
			status: 0,
			error: message,
		});
		return {
			ok: false,
			status: 0,
			latencyMs: Date.now() - started,
			endpoint,
			message: `连接失败：${message}`,
		};
	}
	const ok = response.status !== 401 && response.status !== 403 && response.status < 500;
	appendAudit({
		actor: 'user',
		credential: (record as any).name,
		action: 'test',
		status: response.status,
		path: url.pathname,
		host: url.hostname,
	});
	return {
		ok,
		status: response.status,
		latencyMs: Date.now() - started,
		endpoint: url.toString(),
		message: ok
			? `连接成功：HTTP ${response.status}`
			: `服务可达但凭据可能无效：HTTP ${response.status}`,
	};
}

/* ------------------------------------------------------------------ *
 * 审批、租约与会话级授权
 * ------------------------------------------------------------------ */

const leases = new Map<string, Lease>();
const approvals = new Map<string, PendingApproval>();
const sessionGrants = new Map<string, Map<string, Set<string>>>();
let onlineProbe: (chatId: string, sessionId: string) => boolean = () => false;

/** index.ts 注入：该会话当前是否有 SSE 订阅者。 */
export function setApprovalOnlineProbe(probe: (chatId: string, sessionId: string) => boolean) {
	onlineProbe = probe;
}

function readScope(scopes: string[]): boolean {
	return scopes.every((scope) => /(?:^|:)(?:read|list|get|view|search)(?::|$)/i.test(scope));
}

function hasGrant(sessionId: string, credentialId: string, scopes: string[]): boolean {
	const granted = sessionGrants.get(sessionId)?.get(credentialId);
	if (!granted) return false;
	return scopes.every((scope) => granted.has(scope));
}

function addGrant(sessionId: string, credentialId: string, scopes: string[]) {
	const byCred = sessionGrants.get(sessionId) ?? new Map<string, Set<string>>();
	const granted = byCred.get(credentialId) ?? new Set<string>();
	for (const scope of scopes) granted.add(scope);
	byCred.set(credentialId, granted);
	sessionGrants.set(sessionId, byCred);
}

function clearCredentialGrants(credentialId: string) {
	for (const [sessionId, byCred] of sessionGrants) {
		byCred.delete(credentialId);
		if (!byCred.size) sessionGrants.delete(sessionId);
	}
}

function createLease(
	record: CredentialRecord,
	options: { chatId: string; sessionId: string; scopes: string[]; decision: string; readOnly?: boolean; sessionBound?: boolean },
): Lease {
	const lease: Lease = {
		id: `cr_${randomBytes(32).toString('base64url')}`,
		credentialId: record.id,
		sessionId: options.sessionId,
		chatId: options.chatId,
		scopes: [...options.scopes],
		expiresAt: options.sessionBound ? null : Date.now() + LEASE_TTL_SECONDS * 1000,
		readOnly: Boolean(options.readOnly),
		decision: options.decision,
	};
	leases.set(lease.id, lease);
	return lease;
}

export function getLease(id: string): Lease | undefined {
	const lease = leases.get(id);
	if (!lease) return undefined;
	if (lease.expiresAt !== null && lease.expiresAt <= Date.now()) {
		leases.delete(id);
		return undefined;
	}
	return lease;
}

export function revokeLeases(filter: { lease?: string; sessionId?: string; credentialId?: string }): number {
	let count = 0;
	for (const [id, lease] of [...leases]) {
		const match =
			(filter.lease && filter.lease === id) ||
			(filter.sessionId && filter.sessionId === lease.sessionId) ||
			(filter.credentialId && filter.credentialId === lease.credentialId);
		if (!match) continue;
		leases.delete(id);
		count += 1;
	}
	return count;
}

export function revokeAllLeases(): number {
	const count = leases.size;
	leases.clear();
	sessionGrants.clear();
	return count;
}

export function revokeSessionCredentials(sessionId: string): number {
	// 会话结束/销毁时把挂起的审批一起拒绝，避免 agent 的工具调用一直等到超时。
	for (const [id, pending] of [...approvals]) {
		if (pending.sessionId !== sessionId) continue;
		clearTimeout(pending.timer);
		approvals.delete(id);
		pending.resolve('deny');
	}
	const count = revokeLeases({ sessionId });
	sessionGrants.delete(sessionId);
	return count;
}

/** SSE 重连/新标签页时补发尚未处理的审批请求。 */
export function pendingApprovalEvents(sessionId: string): ApprovalRequestEvent[] {
	const out: ApprovalRequestEvent[] = [];
	for (const pending of approvals.values()) {
		if (pending.sessionId !== sessionId && pending.chatId !== sessionId) continue;
		const record = records.find((item) => item.id === pending.credentialId);
		if (!record) continue;
		out.push({
			requestId: pending.id,
			credential: {
				name: record.name,
				label: record.label ?? record.name,
				kind: record.kind,
				hosts: [...record.allowedHosts],
				scopes: [...record.scopes],
			},
			reason: pending.reason,
			scopes: pending.scopes,
			sessionId: pending.sessionId,
			expiresAt: pending.expiresAt,
		});
	}
	return out;
}

/** 当前正在等待用户审批的 pi session id；用于在左侧会话列表闪动提醒。 */
export function pendingApprovalSessionIds(): string[] {
	return [...new Set([...approvals.values()].map((pending) => pending.sessionId))];
}

export function clearAllLeases(): void {
	leases.clear();
	approvals.clear();
	sessionGrants.clear();
}

export function decideCredentialRequest(requestId: string, decision: string): boolean {
	const pending = approvals.get(requestId);
	if (!pending) return false;
	const normalized: ApprovalDecision =
		decision === 'session' ? 'session' : decision === 'deny' ? 'deny' : 'once';
	clearTimeout(pending.timer);
	approvals.delete(requestId);
	appendAudit({
		actor: 'user',
		sessionId: pending.sessionId,
		credential: pending.credentialName,
		action: 'decision',
		decision: normalized,
	});
	pending.resolve(normalized);
	return true;
}

export interface AuthorizeInput {
	name: string;
	reason: string;
	scope?: string;
	ttlSeconds?: number;
	chatId: string;
	sessionId: string;
	emit: (event: ApprovalRequestEvent) => void;
}

export interface AuthorizeResult {
	lease: string;
	proxy: string;
	target: string;
	/** null 表示会话级授权，随会话结束或撤销失效。 */
	expiresAt: number | null;
	sessionBound: boolean;
	usage: string;
	/** 仅当 scope 含 *:git:read/write 时返回；给 git credential helper 用。 */
	git?: {
		helper: string;
		env: Record<string, string>;
		usage: string;
	};
}

/**
 * helper 路径优先固定/可执行的位置：
 *   1. PI_GIT_HELPER
 *   2. 主 checkout（旧 worktree 可能没有 scripts/）
 *   3. server 同级的 scripts/（镜像或 volume 带了就有）
 *   4. 相对当前 checkout（最后兜底）
 */
function resolveGitHelper(): string {
	const workspace = process.env.PI_WORKSPACE ?? '/workspace';
	const candidates = [
		process.env.PI_GIT_HELPER,
		// 仓库目录名。改名是渐进的：磁盘上的目录可能还叫旧名，两个都试，
		// 写死一个会在改名完成前把 git 凭据整条链断掉。
		join(workspace, 'turn-pi/scripts/git-credential-pi.mjs'),
		join(workspace, 'pi-webchat/scripts/git-credential-pi.mjs'),
		resolve(import.meta.dirname ?? '.', '..', 'scripts', 'git-credential-pi.mjs'),
	];
	for (const candidate of candidates) {
		if (candidate && existsSync(candidate)) return candidate;
	}
	return 'scripts/git-credential-pi.mjs';
}

export async function authorizeCredentialUse(input: AuthorizeInput): Promise<AuthorizeResult> {
	await initCredentials();
	const record = records.find((item) => item.name === text(input.name).toLowerCase());
	if (!record) fail(`没有名为「${input.name}」的凭据，先调用 cred_list`, 404);
	if (record.tier !== 'scoped') fail('env 层凭据不能通过 cred_use 使用；它在环境变量里', 400);
	const scopes = listValue(input.scope);
	const requested = scopes.length ? scopes : [...record.scopes];
	const unknown = requested.filter((scope) => !record.scopes.includes(scope));
	if (unknown.length) fail(`凭据 ${record.name} 没有 scope：${unknown.join('、')}`);

	const decision = await decideUse(record, requested, input);
	const ttl = Math.min(Math.max(Number(input.ttlSeconds) || LEASE_TTL_SECONDS, 30), LEASE_TTL_SECONDS);
	const sessionBound = decision === 'session';
	const lease = createLease(record, {
		chatId: input.chatId,
		sessionId: input.sessionId,
		scopes: requested,
		decision,
		readOnly: decision === 'auto-read',
		sessionBound,
	});
	if (!sessionBound) lease.expiresAt = Date.now() + ttl * 1000;
	appendAudit({
		actor: 'agent',
		sessionId: input.sessionId,
		credential: record.name,
		action: 'lease',
		decision,
		scopes: requested.join(','),
	});
	const gitScope = requested.find((scope) => /:git:(read|write)$/.test(scope));
	const helper = resolveGitHelper();
	const git = gitScope
		? {
				helper,
				env: {
					PI_CRED_LEASE: lease.id,
					PI_BASE_URL: `http://127.0.0.1:${PORT}`,
				},
				usage:
					`PI_CRED_LEASE=${lease.id} PI_BASE_URL=http://127.0.0.1:${PORT} ` +
					`git -c credential.helper='!node ${helper}' push <remote> <branch>` +
					'（helper 由服务端探测主 checkout/镜像路径；也可用 PI_GIT_HELPER 替换成任意实现 git credential 协议的程序）',
			}
		: undefined;
	return {
		lease: lease.id,
		proxy: `http://127.0.0.1:${PORT}/api/cred/${encodeURIComponent(lease.id)}/proxy`,
		target: record.baseUrl ?? '',
		expiresAt: lease.expiresAt,
		sessionBound,
		usage:
			`用目标 HTTP 方法请求 $proxy，带 x-pi-target: <完整 URL>。可用方法：${record.allowedMethods.join(', ')}。` +
			'不要在命令里写真实 token。',
		git,
	};
}

export interface GitCredentialInput {
	leaseId: string;
	protocol?: string;
	host?: string;
}

export interface GitCredentialOutput {
	username: string;
	password: string;
}

/**
 * git credential helper 的换取端点：租约 + 匹配 host + *:git:* scope 才返回 token。
 * 只从 loopback 调用；token 只交给 git 进程，不进入工具结果。
 */
export async function gitCredential(input: GitCredentialInput): Promise<GitCredentialOutput> {
	await initCredentials();
	const lease = getLease(input.leaseId);
	if (!lease) {
		appendAudit({ actor: 'agent', action: 'git-credential', status: 401, error: 'lease-expired' });
		fail('租约不存在或已过期', 401);
	}
	const record = records.find((item) => item.id === lease.credentialId);
	if (!record) fail('凭据已被删除', 401);
	const protocol = text(input.protocol).toLowerCase();
	if (protocol && protocol !== 'https') fail('git credential 只支持 https', 400);
	const rawHost = text(input.host).toLowerCase();
	// git 会把非默认端口一起放进 host（如 gitea.zxcloud.zone:4343），allowedHosts 只存 hostname。
	let host = rawHost;
	try {
		host = new URL(`https://${rawHost}`).hostname;
	} catch {
		/* 保留原值，下面按不在白名单处理 */
	}
	if (!host || !hostMatches(host, record.allowedHosts)) {
		fail(`目标 host 不在允许列表：${rawHost || '（空）'}`, 403);
	}
	if (!lease.scopes.some((scope) => /:git:(read|write)$/.test(scope))) {
		fail('该租约不允许 git 操作', 403);
	}
	const secret = plaintext(record);
	rememberSecret(secret);
	record.lastUsedAt = Date.now();
	record.useCount = (record.useCount ?? 0) + 1;
	await writeRecords(records).catch(() => {});
	appendAudit({
		actor: 'agent',
		sessionId: lease.sessionId,
		credential: record.name,
		action: 'git-credential',
		host,
		decision: lease.decision,
		lease: lease.id,
	});
	return { username: record.username || 'oauth2', password: secret };
}

async function decideUse(
	record: CredentialRecord,
	scopes: string[],
	input: AuthorizeInput,
): Promise<string> {
	if (hasGrant(input.sessionId, record.id, scopes)) return 'session';
	if (record.policy === 'auto-read' && readScope(scopes)) return 'auto-read';
	if (!onlineProbe(input.chatId, input.sessionId)) {
		appendAudit({
			actor: 'agent',
			sessionId: input.sessionId,
			credential: record.name,
			action: 'request',
			decision: 'deny',
			error: 'no-ui-online',
		});
		fail('当前没有前端在线，无法审批凭据使用；请让用户在设置里打开会话后重试', 403);
	}

	const requestId = randomUUID();
	const expiresAt = Date.now() + APPROVAL_TIMEOUT_MS;
	const decision = await new Promise<ApprovalDecision>((resolve) => {
		const timer = setTimeout(() => {
			if (!approvals.has(requestId)) return;
			approvals.delete(requestId);
			appendAudit({
				actor: 'agent',
				sessionId: input.sessionId,
				credential: record.name,
				action: 'request',
				decision: 'deny',
				error: 'timeout',
			});
			resolve('deny');
		}, APPROVAL_TIMEOUT_MS);
		timer.unref?.();
		approvals.set(requestId, {
			id: requestId,
			chatId: input.chatId,
			sessionId: input.sessionId,
			credentialId: record.id,
			credentialName: record.name,
			scopes,
			reason: input.reason,
			expiresAt,
			resolve,
			timer,
		});
		input.emit({
			requestId,
			credential: {
				name: record.name,
				label: record.label ?? record.name,
				kind: record.kind,
				hosts: [...record.allowedHosts],
				scopes: [...record.scopes],
			},
			reason: input.reason,
			scopes,
			sessionId: input.sessionId,
			expiresAt,
		});
	});
	if (decision === 'deny') fail('用户拒绝了凭据使用请求（或审批超时）', 403);
	if (decision === 'session') addGrant(input.sessionId, record.id, scopes);
	return decision;
}

/* ------------------------------------------------------------------ *
 * 审计
 * ------------------------------------------------------------------ */

interface AuditEntry {
	ts?: number;
	actor: string;
	sessionId?: string;
	credential?: string;
	action: string;
	method?: string;
	host?: string;
	path?: string;
	status?: number;
	decision?: string;
	lease?: string;
	scopes?: string;
	error?: string;
}

let auditQueue: Promise<void> = Promise.resolve();

/** append-only；超过上限时保留最近一份并滚动到 .1。 */
export function appendAudit(entry: AuditEntry): void {
	const line = JSON.stringify({ ts: Date.now(), ...entry }) + '\n';
	auditQueue = auditQueue
		.then(async () => {
			await mkdir(dirname(AUDIT_FILE), { recursive: true });
			try {
				const info = await stat(AUDIT_FILE);
				if (info.size > AUDIT_MAX_BYTES) await rename(AUDIT_FILE, `${AUDIT_FILE}.1`);
			} catch (error) {
				if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
			}
			await appendFile(AUDIT_FILE, line, { encoding: 'utf8', mode: 0o600 });
		})
		.catch((error) => {
			process.stderr.write(
				`[credentials] 审计写入失败：${error instanceof Error ? error.message : String(error)}\n`,
			);
		});
}

export async function readAudit(limit = 200): Promise<AuditEntry[]> {
	try {
		const raw = await readFile(AUDIT_FILE, 'utf8');
		const lines = raw.trim().split('\n').filter(Boolean);
		const out: AuditEntry[] = [];
		for (const line of lines.slice(-Math.max(1, Math.min(limit, 1000)))) {
			try {
				out.push(JSON.parse(line));
			} catch {
				/* 忽略坏行 */
			}
		}
		return out.reverse();
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
		throw error;
	}
}

/* ------------------------------------------------------------------ *
 * scoped 代理
 * ------------------------------------------------------------------ */

export interface ProxyInput {
	leaseId: string;
	method: string;
	target: string;
	headers: Record<string, string | string[] | undefined>;
	body?: Buffer;
}

export interface ProxyOutput {
	status: number;
	headers: Record<string, string>;
	body: Buffer;
	credential: string;
}

function lowerHeaders(input: Record<string, string | string[] | undefined>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(input)) {
		if (value === undefined) continue;
		const key = name.toLowerCase();
		if (['authorization', 'cookie', 'host', 'x-pi-target', 'content-length', 'connection'].includes(key)) {
			continue;
		}
		out[key] = Array.isArray(value) ? value.join(', ') : String(value);
	}
	return out;
}

function validateTarget(
	record: CredentialRecord,
	lease: Lease,
	target: URL,
	method: string,
): void {
	if (target.protocol !== 'https:' && !isLoopbackHost(target.hostname) && !ALLOW_INSECURE_HTTP) {
		fail('代理目标必须是 https（http 仅允许 loopback，或显式设置 PI_CREDENTIAL_ALLOW_HTTP=1）', 403);
	}
	if (!hostMatches(target.hostname, record.allowedHosts)) {
		fail(`目标 host 不在允许列表：${target.hostname}`, 403);
	}
	if (record.allowedPathPrefix && !target.pathname.startsWith(record.allowedPathPrefix)) {
		fail(`目标路径不在允许前缀：${target.pathname}`, 403);
	}
	if (!record.allowedMethods.includes(method)) {
		fail(`方法未被允许：${method}`, 403);
	}
	if (lease.readOnly && !['GET', 'HEAD'].includes(method)) {
		fail('该租约只允许只读请求', 403);
	}
}

function isLoopbackHost(host: string): boolean {
	return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost');
}

function auditProxyFailure(input: ProxyInput, status: number, message: string) {
	let host: string | undefined;
	let path: string | undefined;
	try {
		const url = new URL(input.target);
		host = url.hostname;
		path = url.pathname;
	} catch {
		/* target 可能不是合法 URL */
	}
	appendAudit({
		actor: 'agent',
		action: 'proxy',
		method: input.method,
		host,
		path,
		status,
		lease: input.leaseId,
		error: message,
	});
}

export async function executeProxy(input: ProxyInput): Promise<ProxyOutput> {
	await initCredentials();
	const lease = getLease(input.leaseId);
	if (!lease) {
		auditProxyFailure(input, 401, 'lease-expired');
		fail('租约不存在或已过期', 401);
	}
	const record = records.find((item) => item.id === lease.credentialId);
	if (!record) {
		auditProxyFailure(input, 401, 'credential-missing');
		fail('凭据已被删除', 401);
	}
	const method = input.method.toUpperCase();
	let current: URL;
	try {
		current = new URL(input.target);
	} catch {
		auditProxyFailure(input, 400, 'bad-target');
		fail('x-pi-target 不是合法 URL', 400);
	}

	let body = input.body;
	let currentMethod = method;
	let response: Response | undefined;
	for (let hop = 0; hop <= 3; hop++) {
		try {
			validateTarget(record, lease, current, currentMethod);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			auditProxyFailure({ ...input, target: current.toString(), method: currentMethod }, 403, message);
			throw error;
		}
		const headers = lowerHeaders(input.headers);
		const secret = plaintext(record);
		rememberSecret(secret);
		injectionFor(record, secret, headers, current);
		try {
			response = await fetch(current, {
				method: currentMethod,
				headers,
				body: currentMethod === 'GET' || currentMethod === 'HEAD' ? undefined : body,
				redirect: 'manual',
				signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			auditProxyFailure({ ...input, target: current.toString(), method: currentMethod }, 502, message);
			fail(`上游请求失败：${message}`, 502);
		}
		const location = response.headers.get('location');
		if ([301, 302, 303, 307, 308].includes(response.status) && location && hop < 3) {
			const next = new URL(location, current);
			if (response.status === 303 || ((response.status === 301 || response.status === 302) && currentMethod !== 'GET' && currentMethod !== 'HEAD')) {
				currentMethod = 'GET';
				body = undefined;
			}
			current = next;
			continue;
		}
		break;
	}
	if (!response) fail('上游没有响应', 502);

	const length = Number(response.headers.get('content-length') ?? 0);
	if (length > PROXY_BODY_LIMIT) {
		auditProxyFailure({ ...input, target: current.toString(), method: currentMethod }, 502, 'response-too-large');
		fail('上游响应超过 2 MB 上限', 502);
	}
	const buffer = Buffer.from(await response.arrayBuffer());
	if (buffer.length > PROXY_BODY_LIMIT) {
		auditProxyFailure({ ...input, target: current.toString(), method: currentMethod }, 502, 'response-too-large');
		fail('上游响应超过 2 MB 上限', 502);
	}

	const outHeaders: Record<string, string> = {};
	const type = response.headers.get('content-type') ?? '';
	if (type) outHeaders['content-type'] = type;
	const disposition = response.headers.get('content-disposition');
	if (disposition) outHeaders['content-disposition'] = disposition;
	const requestId = response.headers.get('x-request-id') ?? response.headers.get('x-gitea-request-id');
	if (requestId) outHeaders['x-request-id'] = requestId;

	let outBody = buffer;
	if (/json|text|xml|javascript|x-www-form-urlencoded/i.test(type)) {
		const redacted = redact(buffer.toString('utf8'));
		outBody = Buffer.from(redacted, 'utf8');
	}

	record.lastUsedAt = Date.now();
	record.useCount = (record.useCount ?? 0) + 1;
	await writeRecords(records).catch(() => {});
	appendAudit({
		actor: 'agent',
		sessionId: lease.sessionId,
		credential: record.name,
		action: 'proxy',
		method: currentMethod,
		host: current.hostname,
		path: current.pathname,
		status: response.status,
		decision: lease.decision,
		lease: lease.id,
	});
	return {
		status: response.status,
		headers: outHeaders,
		body: outBody,
		credential: record.name,
	};
}

/* ------------------------------------------------------------------ *
 * 主密钥轮换（P2；保留旧文件 .bak 以便回滚）
 * ------------------------------------------------------------------ */

export async function rotateMasterKey(): Promise<{ keySource: CredentialList['keySource'] }> {
	await initCredentials();
	const oldKey = masterKey!;
	const oldSource = keySource;
	try {
		const raw = await readFile(KEY_FILE, 'utf8').catch(() => '');
		if (raw) await writeFile(`${KEY_FILE}.bak`, raw, { encoding: 'utf8', mode: 0o600 });
	} catch {
		/* 环境变量模式没有 key 文件 */
	}
	const next = randomBytes(32);
	masterKey = next;
	keySource = 'file';
	redactionValues.clear();
	redactionDirty = true;
	for (const record of records) {
		let value: string;
		try {
			value = decryptSecret(record.secret, record, oldKey);
		} catch {
			masterKey = oldKey;
			keySource = oldSource;
			fail('主密钥轮换中止：有凭据无法用旧 key 解密', 500);
		}
		record.secret = encryptSecret(value, record, next);
		rememberSecret(value);
	}
	await writeRecords(records);
	await writeFile(KEY_FILE, next.toString('base64') + '\n', { encoding: 'utf8', mode: 0o600 });
	return { keySource };
}

/** 常数时间比较，供访问控制复用（避免 token 长度侧信道）。 */
export function constantTimeEqual(a: string, b: string): boolean {
	const left = createHash('sha256').update(a).digest();
	const right = createHash('sha256').update(b).digest();
	return timingSafeEqual(left, right);
}
