/**
 * MCP 配置：平台托管**一份** mcp.json，默认 `$PI_RUNTIME_DIR/mcp.json`。
 *
 * 为什么不直接用 SDK 的默认发现（`$PI_AGENT_DIR/mcp.json` + 受信项目的 `.pi/mcp.json`）：
 *   - compose 里 `/root/.pi/agent` 没有挂卷，写在里面的配置重启就没了；
 *   - 项目文件要 project trust，多一层会"配了但不生效"的静默失败；
 *   - 配置来源只留一处，和技能库 / 提示词同一个原则：同一份配置在任何机器上装出同一个 agent。
 *
 * 形状与其他 MCP 客户端一致（`mcpServers`），方便从 Claude Desktop / Cursor 直接抄过来。
 * 这里只负责读盘 + 校验 + 报错，连接与工具注册全在 SDK 的 mcp 扩展里。
 */

import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { LoadedMcpConfig, McpServerConfig, McpServerEntry } from '@earendil-works/pi-coding-agent';

const RUNTIME_DIR = resolve(process.env.PI_RUNTIME_DIR ?? join(import.meta.dirname ?? '.', '..', 'runtime'));

/** 平台托管的 MCP 配置文件。 */
export const MCP_FILE = resolve(process.env.PI_MCP_FILE ?? join(RUNTIME_DIR, 'mcp.json'));

/** 会话是否接 MCP。`PI_MCP=0` 全局关掉（排障用），默认开。 */
export const MCP_ENABLED = process.env.PI_MCP !== '0';

/** 服务器名只允许字母数字下划线横线：工具名是 `mcp__<server>__<tool>`，别的字符会被 SDK 改写。 */
const NAME_RE = /^[A-Za-z0-9_-]+$/;
const EXPOSURES = new Set(['codemode', 'deferred', 'direct', 'hidden']);

export interface McpFileState {
	file: string;
	exists: boolean;
	servers: McpServerEntry[];
	errors: string[];
	/** 平台文件里的顶层开关，缺省走 SDK 默认（true）。 */
	autoEnableCodemode?: boolean;
	/**
	 * 原始条目（未校验），键是服务器名。UI 编辑时把它合进表单提交，
	 * 这样 `auth` 之类前端不认识的键不会被一次保存抹掉。
	 */
	rawServers: Record<string, unknown>;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringMap(value: unknown): value is Record<string, string> {
	return isObject(value) && Object.values(value).every((item) => typeof item === 'string');
}

/**
 * 校验一条 `mcpServers` 条目。返回规范化后的 config 或一条错误。
 *
 * 与 SDK 的规则对齐（docs/mcp.md「Configuration rules」）：`command` = stdio，`url` = streamable HTTP，
 * `sse` 不支持；`command` 是一个可执行文件，不是 shell 命令串。
 */
export function validateServer(name: string, raw: unknown): { config: McpServerConfig } | { error: string } {
	if (!NAME_RE.test(name)) return { error: `服务器名 "${name}" 不合法：只允许字母、数字、_ 和 -` };
	if (!isObject(raw)) return { error: `${name}: 条目必须是对象` };

	const type = raw.type;
	if (type !== undefined && type !== 'stdio' && type !== 'http' && type !== 'streamable-http') {
		return { error: `${name}: type 只能是 stdio / http / streamable-http（收到 ${String(type)}）` };
	}
	if (type === 'sse') return { error: `${name}: 不支持 SSE，改用 streamable HTTP（通常是 /mcp 端点）` };

	const exposure = raw.exposure;
	if (exposure !== undefined && (typeof exposure !== 'string' || !EXPOSURES.has(exposure))) {
		return { error: `${name}: exposure 只能是 codemode / deferred / direct / hidden` };
	}
	if (raw.toolExposure !== undefined && !stringMap(raw.toolExposure)) {
		return { error: `${name}: toolExposure 必须是 {工具名: exposure} 的字符串映射` };
	}
	if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') return { error: `${name}: enabled 必须是布尔值` };
	if (raw.timeout !== undefined && (typeof raw.timeout !== 'number' || !(raw.timeout > 0))) {
		return { error: `${name}: timeout 必须是正数（秒）` };
	}
	if (raw.description !== undefined && typeof raw.description !== 'string') {
		return { error: `${name}: description 必须是字符串` };
	}

	const common: Record<string, unknown> = {};
	for (const key of ['type', 'exposure', 'enabled', 'timeout', 'description', 'toolExposure'] as const) {
		if (raw[key] !== undefined) common[key] = raw[key];
	}

	// stdio：有 command 就是 stdio；只写 type: 'stdio' 而没有 command 是错的
	const wantsStdio = type === 'stdio' || (type === undefined && raw.command !== undefined);
	const wantsHttp = type === 'http' || type === 'streamable-http' || (type === undefined && raw.url !== undefined);

	if (wantsStdio) {
		if (typeof raw.command !== 'string' || !raw.command.trim()) return { error: `${name}: stdio 服务器缺少 command` };
		if (raw.args !== undefined && (!Array.isArray(raw.args) || raw.args.some((a) => typeof a !== 'string'))) {
			return { error: `${name}: args 必须是字符串数组` };
		}
		if (raw.env !== undefined && !stringMap(raw.env)) return { error: `${name}: env 必须是字符串映射` };
		if (raw.cwd !== undefined && typeof raw.cwd !== 'string') return { error: `${name}: cwd 必须是字符串` };
		return {
			config: {
				...common,
				type: 'stdio',
				command: raw.command,
				...(raw.args === undefined ? {} : { args: raw.args }),
				...(raw.env === undefined ? {} : { env: raw.env }),
				...(raw.cwd === undefined ? {} : { cwd: raw.cwd }),
			} as McpServerConfig,
		};
	}

	if (wantsHttp) {
		if (typeof raw.url !== 'string' || !/^https?:\/\//.test(raw.url)) {
			return { error: `${name}: url 必须是 http(s) 地址` };
		}
		if (raw.headers !== undefined && !stringMap(raw.headers)) return { error: `${name}: headers 必须是字符串映射` };
		return {
			config: {
				...common,
				type: 'http',
				url: raw.url,
				...(raw.headers === undefined ? {} : { headers: raw.headers }),
			} as McpServerConfig,
		};
	}

	return { error: `${name}: 缺少 command（stdio）或 url（http）` };
}

/**
 * 读平台 MCP 文件。文件不存在 = 没配服务器（不是错误）；坏条目单独报错并跳过，不影响其他服务器。
 */
export function readMcpFile(file: string = MCP_FILE): McpFileState {
	let raw: string;
	try {
		raw = readFileSync(file, 'utf8');
	} catch (error: any) {
		if (error?.code === 'ENOENT') return { file, exists: false, servers: [], errors: [], rawServers: {} };
		return { file, exists: false, servers: [], errors: [`${file}: 读不到（${error?.message ?? error}）`], rawServers: {} };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return {
			file,
			exists: true,
			servers: [],
			errors: [`${file}: JSON 解析失败（${error instanceof Error ? error.message : String(error)}）`],
			rawServers: {},
		};
	}
	if (!isObject(parsed) || !isObject(parsed.mcpServers)) {
		return {
			file,
			exists: true,
			servers: [],
			errors: [`${file}: 顶层必须是 { "mcpServers": { ... } }`],
			rawServers: {},
		};
	}

	const rawServers = parsed.mcpServers as Record<string, unknown>;
	const servers: McpServerEntry[] = [];
	const errors: string[] = [];
	for (const [name, entry] of Object.entries(rawServers)) {
		const checked = validateServer(name, entry);
		if ('error' in checked) {
			errors.push(checked.error);
			continue;
		}
		servers.push({ name, config: checked.config, source: file, scope: 'global' });
	}
	const autoEnableCodemode = typeof parsed.autoEnableCodemode === 'boolean' ? parsed.autoEnableCodemode : undefined;
	return { file, exists: true, servers, errors, rawServers, ...(autoEnableCodemode === undefined ? {} : { autoEnableCodemode }) };
}

/** `createMcpExtension({ loadConfig })` 要的形状。 */
export function loadPlatformMcpConfig(file: string = MCP_FILE): LoadedMcpConfig {
	const state = readMcpFile(file);
	return {
		servers: state.servers,
		errors: state.errors,
		...(state.autoEnableCodemode === undefined ? {} : { autoEnableCodemode: state.autoEnableCodemode }),
	};
}

/** 已经警告过的文件状态：每次建会话都会读一次，同一个错误只吵一次。 */
let warned = '';

/**
 * 建会话时调一次：把配置问题写到 stderr（MCP 起不来不该拖垮对话，但也不能静默）。
 * 返回 true 表示有服务器可连。
 */
export function reportMcpFileState(file: string = MCP_FILE): boolean {
	let stamp = '';
	try {
		stamp = `${statSync(file).mtimeMs}:${statSync(file).size}`;
	} catch {
		stamp = 'missing';
	}
	const state = readMcpFile(file);
	const key = `${stamp}\u0000${state.errors.join('\u0000')}`;
	if (state.errors.length && key !== warned) {
		warned = key;
		for (const error of state.errors) process.stderr.write(`[mcp] 配置问题：${error}\n`);
	}
	return state.servers.some((server) => server.config.enabled !== false);
}

/* ------------------------------------------------------------------ *
 * 写盘（M1：管理界面用）
 * ------------------------------------------------------------------ */

/** 管理界面的配置写入错误：`status` 给 HTTP 层用，消息直接给用户看。 */
export class McpConfigError extends Error {
	status: number;
	constructor(message: string, status = 400) {
		super(message);
		this.name = 'McpConfigError';
		this.status = status;
	}
}

/** 读整个文件，保留顶层不认识的键（`autoEnableCodemode`、将来 SDK 加的字段）。 */
function readRawObject(file: string): Record<string, unknown> {
	let raw: string;
	try {
		raw = readFileSync(file, 'utf8');
	} catch (error: any) {
		if (error?.code === 'ENOENT') return { mcpServers: {} };
		throw new McpConfigError(`${file}: 读不到（${error?.message ?? error}）`, 500);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		// 文件坏掉时不允许覆盖：让人先把 JSON 修好，否则一次保存会丢掉整份配置。
		throw new McpConfigError(`${file}: JSON 解析失败（${error instanceof Error ? error.message : String(error)}），先修好文件再保存`, 500);
	}
	if (!isObject(parsed)) throw new McpConfigError(`${file}: 顶层必须是对象`, 500);
	const servers = parsed.mcpServers;
	if (servers !== undefined && !isObject(servers)) {
		throw new McpConfigError(`${file}: mcpServers 必须是对象`, 500);
	}
	return { ...parsed, mcpServers: (servers as Record<string, unknown> | undefined) ?? {} };
}

function writeRawObject(file: string, data: Record<string, unknown>): void {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
	renameSync(tmp, file);
}

/**
 * 响应经过 `redact()`，已知凭据值会变成 `***`。如果 UI 拿到的是掩码又原样提交回来，
 * 保存时把原值恢复回去，别把真值写成 "***"。只恢复一层嵌套（`env` / `headers` 够用）。
 */
function restoreMasked(incoming: Record<string, unknown>, existing: unknown): Record<string, unknown> {
	if (!isObject(existing)) return incoming;
	const out: Record<string, unknown> = { ...incoming };
	for (const [key, value] of Object.entries(out)) {
		const previous = existing[key];
		if (value === '***' && typeof previous === 'string') {
			out[key] = previous;
			continue;
		}
		if (isObject(value) && isObject(previous)) {
			const nested: Record<string, unknown> = { ...value };
			for (const [innerKey, innerValue] of Object.entries(nested)) {
				if (innerValue === '***' && typeof previous[innerKey] === 'string') nested[innerKey] = previous[innerKey];
			}
			out[key] = nested;
		}
	}
	return out;
}

/** 保存（或替换）一个服务器。条目本身走 `validateServer` 的同一套校验。 */
export function saveMcpServer(name: string, config: unknown, file: string = MCP_FILE): McpFileState {
	const checked = validateServer(name, config);
	if ('error' in checked) throw new McpConfigError(checked.error);
	const data = readRawObject(file);
	// 规范化只认识一部分键（command / url / env / headers / exposure…）。
	// 把手写的 `auth` 之类原样带回去，否则管理界面保存一次就会把它抹掉。
	const incoming = isObject(config) ? config : {};
	const merged = restoreMasked({ ...incoming, ...checked.config }, (data.mcpServers as Record<string, unknown>)[name]);
	if (checked.config.type === 'stdio') {
		delete merged.url;
		delete merged.headers;
	} else {
		delete merged.command;
		delete merged.args;
		delete merged.env;
		delete merged.cwd;
	}
	(data.mcpServers as Record<string, unknown>)[name] = merged;
	writeRawObject(file, data);
	return readMcpFile(file);
}

export function deleteMcpServer(name: string, file: string = MCP_FILE): McpFileState {
	const data = readRawObject(file);
	const servers = data.mcpServers as Record<string, unknown>;
	if (!(name in servers)) throw new McpConfigError(`没有服务器 "${name}"`, 404);
	delete servers[name];
	writeRawObject(file, data);
	return readMcpFile(file);
}

/** 只改 `enabled`，其他字段原样保留（包括前端不认识的键）。 */
export function setMcpServerEnabled(name: string, enabled: boolean, file: string = MCP_FILE): McpFileState {
	const data = readRawObject(file);
	const servers = data.mcpServers as Record<string, unknown>;
	const entry = servers[name];
	if (entry === undefined) throw new McpConfigError(`没有服务器 "${name}"`, 404);
	if (!isObject(entry)) throw new McpConfigError(`${name}: 条目必须是对象`, 400);
	servers[name] = { ...entry, enabled };
	writeRawObject(file, data);
	return readMcpFile(file);
}

/* ------------------------------------------------------------------ *
 * 连接探测（管理界面的「测试」按钮）
 * ------------------------------------------------------------------ */

/** `env` / `headers` 里支持 `${NAME}`、`$NAME`、`$$`、`$!` 和 `!command`，与 SDK 的口径一致。 */
function resolveTemplate(value: string, what: string): string {
	let resolved = '';
	let index = 0;
	while (index < value.length) {
		const char = value[index];
		if (char !== '$') {
			resolved += char;
			index += 1;
			continue;
		}
		const next = value[index + 1];
		if (next === '$' || next === '!') {
			resolved += next;
			index += 2;
			continue;
		}
		if (next === '{') {
			const end = value.indexOf('}', index + 2);
			const name = end < 0 ? '' : value.slice(index + 2, end);
			if (end < 0 || !NAME_RE.test(name)) {
				resolved += '$';
				index += 1;
				continue;
			}
			const envValue = process.env[name];
			if (envValue === undefined) throw new McpConfigError(`${what}: 环境变量 ${name} 没有设置`);
			resolved += envValue;
			index = end + 1;
			continue;
		}
		const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(value.slice(index + 1));
		if (match) {
			const envValue = process.env[match[0]];
			if (envValue === undefined) throw new McpConfigError(`${what}: 环境变量 ${match[0]} 没有设置`);
			resolved += envValue;
			index += 1 + match[0].length;
			continue;
		}
		resolved += '$';
		index += 1;
	}
	return resolved;
}

function resolveSecret(value: string, what: string): string {
	if (!value.startsWith('!')) return resolveTemplate(value, what);
	const command = value.slice(1);
	try {
		const output = execSync(command, { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
		if (output) return output;
	} catch {
		/* 走下面的统一报错 */
	}
	throw new McpConfigError(`${what}: 命令 ${command} 没有返回可用值`);
}

/** `~` / `~/…` 展开成 home，和 SDK 的 transport 一致。 */
function expandHome(value: string): string {
	if (value === '~') return process.env.HOME ?? value;
	if (value.startsWith('~/')) return join(process.env.HOME ?? '', value.slice(2));
	return value;
}

export interface McpProbeTool {
	name: string;
	title?: string;
	description?: string;
}

export interface McpProbeResult {
	ok: boolean;
	name: string;
	transport: 'stdio' | 'http';
	ms: number;
	serverInfo?: { name: string; version: string };
	protocolVersion?: string;
	instructions?: string;
	tools: McpProbeTool[];
	error?: string;
	/** stdio 服务器失败时的 stderr 尾巴，排障比 "connection closed" 有用。 */
	stderr?: string;
}

const PROBE_TIMEOUT_MS = 15_000;
const STDERR_TAIL = 2_000;

/**
 * 连一次服务器并列出工具，然后关掉。
 *
 * 不复用会话里的连接：MCP 是每会话一份（见 docs/mcp.md），探测要能测"还没保存的草稿"，
 * 而且不碰正在跑的会话。这里直接用 pi-mcp 的 client + transport，行为与 SDK 的
 * `createDefaultTransport` 对齐（env/header 解析、`~` 展开、stdio cwd 相对会话目录）。
 */
export async function probeMcpServer(
	entry: McpServerEntry,
	options: { cwd?: string; timeoutMs?: number } = {},
): Promise<McpProbeResult> {
	const startedAt = Date.now();
	const config = entry.config;
	const transportKind: 'stdio' | 'http' = 'url' in config ? 'http' : 'stdio';
	const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
	const base: McpProbeResult = { ok: false, name: entry.name, transport: transportKind, ms: 0, tools: [] };

	let client: any;
	let stderr = '';
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const { McpClient, StdioTransport, StreamableHttpTransport } = await import('@earendil-works/pi-mcp');
		client = new McpClient({ name: 'turn-pi', version: '0.2.0', requestTimeoutMs: timeoutMs });
		const transport =
			transportKind === 'http'
				? new StreamableHttpTransport({
						url: (config as any).url,
						headers: Object.fromEntries(
							Object.entries((config as any).headers ?? {}).map(([key, value]) => [
								key,
								resolveSecret(String(value), `MCP 服务器 "${entry.name}" 的 header ${key}`),
							]),
						),
					})
				: new StdioTransport({
						command: expandHome(String((config as any).command)),
						args: ((config as any).args as string[] | undefined)?.map(expandHome),
						cwd: resolve(options.cwd ?? process.cwd(), expandHome(String((config as any).cwd ?? '.'))),
						env: Object.fromEntries(
							Object.entries((config as any).env ?? {}).map(([key, value]) => [
								key,
								resolveSecret(String(value), `MCP 服务器 "${entry.name}" 的 env ${key}`),
							]),
						),
						stderr: 'pipe' as const,
						onStderr: (chunk: string) => {
							stderr = (stderr + chunk).slice(-STDERR_TAIL);
						},
					});

		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`连接超时（${timeoutMs}ms）`)), timeoutMs);
		});
		const init: any = await Promise.race([client.connect(transport), timeout]);
		const tools: any[] = await Promise.race([client.listTools(), timeout]);
		return {
			ok: true,
			name: entry.name,
			transport: transportKind,
			ms: Date.now() - startedAt,
			serverInfo: init?.serverInfo,
			protocolVersion: init?.protocolVersion,
			instructions: typeof init?.instructions === 'string' ? init.instructions : undefined,
			tools: tools.map((tool) => ({ name: tool.name, title: tool.title, description: tool.description })),
			...(stderr ? { stderr } : {}),
		};
	} catch (error) {
		return {
			...base,
			ms: Date.now() - startedAt,
			error: error instanceof Error ? error.message : String(error),
			...(stderr ? { stderr } : {}),
		};
	} finally {
		if (timer) clearTimeout(timer);
		try {
			await client?.close();
		} catch {
			/* 关不掉就算了，子进程有 SDK 的 SIGTERM/SIGKILL 兜底 */
		}
	}
}
