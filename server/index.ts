/**
 * HTTP 服务：静态页面 + SSE 事件流 + JSON API。
 *
 * 没有 WebSocket 依赖：服务端 → 浏览器走 SSE，浏览器 → 服务端走普通 POST。
 */

import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { ChatRegistry, findSessionInfo, forkSession, HISTORY_PAGE_TURNS, historyPageForSession, listModels, listSessions, readArchivedSessionRecords, readFavorites, renameSession, sessionSnapshotStats, setFavoriteTurn, setSessionArchived } from './chat.ts';

import {
	deleteCustomProvider,
	fetchProviderModels,
	initCustomProviders,
	listProviders,
	saveCustomProvider,
	setCustomProviderEnabled,
	testProviderConnection,
} from './providers.ts';
import { invalidateQuotaCache, providerQuota } from './quota.ts';
import {
	appendAudit,
	CredentialError,
	decideCredentialRequest,
	deleteCredential,
	executeProxy,
	gitCredential,
	importEnvCredential,
	initCredentials,
	listCredentials,
	pendingApprovalEvents,
	pendingApprovalSessionIds,
	readAudit,
	redact,
	revokeAllLeases,
	revokeLeases,
	rotateCredential,
	saveCredential,
	setApprovalOnlineProbe,
	testCredential,
} from './credentials.ts';
import {
	authRequiredPath,
	cookieToken,
	initAccessToken,
	isLoopback,
	noteFailedAttempt,
	redirectWithoutToken,
	sameOrigin,
	setAccessCookie,
	tokenValid,
	tooManyAttempts,
	unauthorized,
} from './auth.ts';
import { VERSION as PI_VERSION } from '@earendil-works/pi-coding-agent';
import { handleFiles } from './files.ts';
import { handleGit } from './git.ts';
import { readReportedByTurn } from './file-report.ts';
import { addWorkspace, initWorkspaces, listWorkspaces, reloadWorkspaces } from './workspaces.ts';
import { getWorktree, initWorktrees, listWorktrees, removeWorktree, worktreeStatus } from './worktrees.ts';
import { getJobsSnapshot, registerJob, runJob, startScheduler, stopScheduler, updateJob } from './scheduler.ts';
import { auditSkill, installSkill, listSkills, refreshSkills, removeSkill, selectSkills, SkillError } from './skills.ts';
import {
	deleteMcpServer,
	MCP_ENABLED,
	McpConfigError,
	probeMcpServer,
	readMcpFile,
	saveMcpServer,
	setMcpServerEnabled,
	validateServer,
} from './mcp.ts';
import { getMarketCatalog, getMarketSkill, translateMarketSkill, MarketError } from './skill-market.ts';
import { createWorktreeGcJob } from './worktree-gc.ts';
import { searchStatus, testSearch } from './search.ts';
import {
	availableSkills,
	cardById,
	forkAgent,
	listAgents,
	mergeApply,
	mergeDiff,
	PINNED_TOOLS,
	previewAgent,
	saveAgent,
	toolRegistry,
} from './agents.ts';

const PORT = Number(process.env.PORT ?? 44100);
const HOST = process.env.HOST ?? '0.0.0.0';
/** 代理允许的 HTTP 方法；实际能用哪些还要过凭据的 allowedMethods。 */
const PROXY_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
// 前端是 Vite 构建产物：npm run build:web → web/dist
const WEB_DIR = resolve(process.env.PI_WEB_DIR ?? join(import.meta.dirname ?? '.', '..', 'web', 'dist'));

const chats = new ChatRegistry();
const clients = new Map<string, Set<ServerResponse>>();
/**
 * 工作区注册表变了（新增/重载）之后，已打开会话的工具白名单必须重算：
 * readonly 是运行时状态，只在会话创建时算一次会让只读承诺失效。
 * 生成中的会话不动它，下一轮 prompt 开始时自己对齐。
 */
function refreshChatTools(): number {
	let changed = 0;
	for (const chat of chats.all()) {
		if (chat.refreshToolAllowlist()) changed += 1;
	}
	return changed;
}
/**
 * 已经接过线的 Chat 实例：监听器只能挂一次，否则第 N 条消息会被广播 N 次。
 * 不能按 chat.id 记：同一个浏览器打开多个会话时 clientId 相同，按 id 去重会把
 * 后打开的会话误判成“已接线”，导致那个会话的 SSE 永远收不到增量。
 */
const wired = new WeakSet<object>();

/** 事件同时投递到 clientId 与 pi sessionId：客户端可能只订阅其中任意一个。 */
function fanout(chat: { id: string; sessionId?: string }, event: string, data: unknown) {
	broadcast(chat.id, event, data);
	if (chat.sessionId && chat.sessionId !== chat.id) broadcast(chat.sessionId, event, data);
}

function wire(chat: { id: string; sessionId?: string; on: Function }) {
	if (wired.has(chat)) return;
	wired.add(chat);
	chat.on('delta', (payload: unknown) => fanout(chat, 'delta', payload));
	chat.on('thinking', (payload: unknown) => fanout(chat, 'thinking', payload));
	chat.on('tool', (payload: unknown) => fanout(chat, 'tool', payload));
	chat.on('retry', (payload: unknown) => fanout(chat, 'retry', payload));
	chat.on('stats', (payload: unknown) => fanout(chat, 'stats', payload));
	chat.on('error', (payload: unknown) => fanout(chat, 'error', payload));
	chat.on('queue', (payload: unknown) => fanout(chat, 'queue', payload));
	chat.on('user', (payload: unknown) => fanout(chat, 'user', payload));
	chat.on('credential_request', (payload: unknown) => fanout(chat, 'credential_request', payload));
	chat.on('presented', (payload: unknown) => fanout(chat, 'presented', payload));
	chat.on('search_sources', (payload: unknown) => fanout(chat, 'search_sources', payload));
	chat.on('settled', () => {
		fanout(chat, 'settled', {});
	});
}

const MIME: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.ico': 'image/x-icon',
	'.webmanifest': 'application/manifest+json; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
};

function json(res: ServerResponse, status: number, body: unknown, options: { redact?: boolean } = {}) {
	const payload = options.redact === false ? JSON.stringify(body) : redact(JSON.stringify(body));
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
	res.end(payload);
}

/** `/api/mcp` 的形状：配置 + 原始条目（UI 保存时合并，保留 auth 等不认识的键）。 */
function mcpPayload() {
	const state = readMcpFile();
	return {
		ok: true,
		enabled: MCP_ENABLED,
		file: state.file,
		exists: state.exists,
		autoEnableCodemode: state.autoEnableCodemode,
		servers: state.servers.map((entry) => ({
			name: entry.name,
			transport: 'url' in entry.config ? 'http' : 'stdio',
			config: entry.config,
			raw: state.rawServers[entry.name] ?? {},
		})),
		errors: state.errors,
	};
}

async function readBody(req: IncomingMessage): Promise<any> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	if (!chunks.length) return {};
	try {
		return JSON.parse(Buffer.concat(chunks).toString('utf8'));
	} catch {
		throw new Error('请求体不是合法 JSON');
	}
}

async function readRawBody(req: IncomingMessage, limit: number): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of req) {
		const buffer = chunk as Buffer;
		total += buffer.length;
		if (total > limit) {
			const error: any = new Error('请求体超过大小上限');
			error.status = 413;
			throw error;
		}
		chunks.push(buffer);
	}
	return Buffer.concat(chunks);
}

function send(client: ServerResponse, event: string, data: unknown) {
	client.write(`event: ${event}\ndata: ${redact(JSON.stringify(data))}\n\n`);
}

function broadcast(sessionId: string, event: string, data: unknown) {
	for (const client of clients.get(sessionId) ?? []) send(client, event, data);
}

async function serveStatic(res: ServerResponse, urlPath: string) {
	const relative = normalize(urlPath === '/' ? '/index.html' : urlPath).replace(/^(\.\.[/\\])+/, '');
	const file = join(WEB_DIR, relative);
	if (!file.startsWith(WEB_DIR)) return json(res, 403, { error: 'forbidden' });
	try {
		const info = await stat(file);
		if (!info.isFile()) return json(res, 404, { error: 'not found' });
		res.writeHead(200, {
			'content-type': MIME[extname(file)] ?? 'application/octet-stream',
			// 没有任何构建步骤：改完刷新即可
			'cache-control': 'no-store',
		});
		createReadStream(file).pipe(res);
	} catch {
		json(res, 404, { error: 'not found' });
	}
}

function attach(sessionId: string, res: ServerResponse) {
	res.writeHead(200, {
		'content-type': 'text/event-stream; charset=utf-8',
		'cache-control': 'no-store',
		connection: 'keep-alive',
		'x-accel-buffering': 'no',
	});
	res.write('retry: 1500\n\n');
	const set = clients.get(sessionId) ?? new Set();
	set.add(res);
	clients.set(sessionId, set);
	const keepAlive = setInterval(() => res.write(': ping\n\n'), 15_000);
	// SSE 重连或新标签页打开时，补发还没处理的凭据审批。
	for (const event of pendingApprovalEvents(sessionId)) send(res, 'credential_request', event);
	res.on('close', () => {
		clearInterval(keepAlive);
		set.delete(res);
		if (!set.size) clients.delete(sessionId);
	});
}

async function handler(req: IncomingMessage, res: ServerResponse) {
	const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
	const path = url.pathname;

	try {
		// 租约代理不走 Cookie：agent 的 bash 在容器内没有浏览器会话，租约本身就是能力令牌。
		const proxyMatch = path.match(/^\/api\/cred\/([^/]+)\/proxy$/);
		if (proxyMatch) {
			if (!isLoopback(req)) return json(res, 403, { error: '代理只接受 loopback 来源' });
			const method = String(req.method ?? '').toUpperCase();
			if (!PROXY_METHODS.has(method)) return json(res, 405, { error: 'method not allowed' });
			const target = String(req.headers['x-pi-target'] ?? '').trim();
			if (!target) return json(res, 400, { error: 'x-pi-target required' });
			try {
				const body = await readRawBody(req, 2 * 1024 * 1024);
				const out = await executeProxy({
					leaseId: decodeURIComponent(proxyMatch[1]),
					method,
					target,
					headers: req.headers,
					body: body.length ? body : undefined,
				});
				res.writeHead(out.status, {
					...out.headers,
					'content-length': String(out.body.length),
					'cache-control': 'no-store',
				});
				res.end(out.body);
				return;
			} catch (error) {
				const status = Number((error as any)?.status) || 502;
				return json(res, status, { error: error instanceof Error ? error.message : String(error) });
			}
		}

		// git credential helper 换取端点：租约本身就是能力令牌，不走 Cookie。
		const gitMatch = path.match(/^\/api\/cred\/([^/]+)\/git-credential$/);
		if (gitMatch) {
			if (!isLoopback(req)) return json(res, 403, { error: 'git credential 只接受 loopback 来源' });
			if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
			try {
				const body = await readBody(req);
				const out = await gitCredential({
					leaseId: decodeURIComponent(gitMatch[1]),
					protocol: typeof body?.protocol === 'string' ? body.protocol : undefined,
					host: typeof body?.host === 'string' ? body.host : undefined,
				});
				// token 已登记进脱敏表；这个响应必须原样交给 git，否则会被替换成 ***。
				return json(res, 200, out, { redact: false });
			} catch (error) {
				const status = Number((error as any)?.status) || 400;
				return json(res, status, { error: error instanceof Error ? error.message : String(error) });
			}
		}

		// 访问控制：bootstrap token → Cookie；health 与代理已在上方处理。
		if (authRequiredPath(path)) {
			const queryToken = url.searchParams.get('token') ?? '';
			if (queryToken && !tooManyAttempts(req) && tokenValid(queryToken)) {
				setAccessCookie(res);
				res.writeHead(302, {
					location: redirectWithoutToken(url),
					'cache-control': 'no-store',
					'referrer-policy': 'no-referrer',
				});
				res.end();
				return;
			}
			if (!tokenValid(cookieToken(req))) {
				if (queryToken) noteFailedAttempt(req);
				if (tooManyAttempts(req)) {
					return json(res, 429, { error: '尝试次数过多，请一分钟后再试' });
				}
				return unauthorized(res, path.startsWith('/api/'), '需要访问令牌');
			}
			if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? 'GET') && !sameOrigin(req)) {
				return json(res, 403, { error: '跨站请求被拒绝' });
			}
		}

		if (req.method === 'GET' && path === '/api/events') {
			// 订阅键 = pi sessionId（新对话在创建前用客户端临时 id）
			const key = url.searchParams.get('sessionId') ?? url.searchParams.get('sid');
			if (!key) return json(res, 400, { error: 'sessionId required' });
			return attach(key, res);
		}

		if (req.method === 'GET' && path === '/api/health') {
			return json(res, 200, {
				ok: true,
				port: PORT,
				piVersion: PI_VERSION,
				workspaces: listWorkspaces().length,
				worktrees: listWorktrees().length,
			});
		}

		if (req.method === 'GET' && path === '/api/worktrees') {
			return json(res, 200, { worktrees: listWorktrees() });
		}

		if (req.method === 'GET' && path === '/api/worktrees/status') {
			const id = url.searchParams.get('id')?.trim();
			if (!id) return json(res, 400, { error: 'id required' });
			try {
				return json(res, 200, await worktreeStatus(id));
			} catch (error) {
				return json(res, 404, { error: error instanceof Error ? error.message : String(error) });
			}
		}

		if (req.method === 'POST' && path === '/api/worktrees/remove') {
			const body = await readBody(req);
			const id = String(body.id ?? '').trim();
			if (!id) return json(res, 400, { error: 'id required' });
			const worktree = getWorktree(id);
			if (!worktree) return json(res, 404, { error: `未知 worktree：${id}` });
			const active = chats.all().filter((chat) => chat.cwd === worktree.path || chat.cwd.startsWith(worktree.path + '/'));
			if (active.some((chat) => chat.busy)) {
				return json(res, 409, { error: 'worktree 还有会话在生成，结束再删除' });
			}
			try {
				return json(res, 200, {
					ok: true,
					worktree: await removeWorktree(id, { force: body.force === true }),
				});
			} catch (error) {
				return json(res, 409, { error: error instanceof Error ? error.message : String(error) });
			}
		}

		if (req.method === 'GET' && path === '/api/jobs') {
			return json(res, 200, await getJobsSnapshot());
		}

		if (req.method === 'POST' && path === '/api/jobs/update') {
			const body = await readBody(req);
			const id = String(body.id ?? '').trim();
			if (!id) return json(res, 400, { error: 'id required' });
			try {
				const job = await updateJob(id, {
					enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
					dryRun: typeof body.dryRun === 'boolean' ? body.dryRun : undefined,
					intervalMs: body.intervalMs == null ? undefined : Number(body.intervalMs),
					config: body.config && typeof body.config === 'object' ? body.config : undefined,
				});
				return json(res, 200, { ok: true, job });
			} catch (error) {
				return json(res, 400, { error: error instanceof Error ? error.message : String(error) });
			}
		}

		if (req.method === 'POST' && path === '/api/jobs/run') {
			const body = await readBody(req);
			const id = String(body.id ?? '').trim();
			if (!id) return json(res, 400, { error: 'id required' });
			try {
				const result = await runJob(id, {
					dryRun: typeof body.dryRun === 'boolean' ? body.dryRun : undefined,
					trigger: 'manual',
				});
				return json(res, result.ok ? 200 : 409, result);
			} catch (error) {
				return json(res, 404, { error: error instanceof Error ? error.message : String(error) });
			}
		}

		if (req.method === 'GET' && path === '/api/workspaces') {
			return json(res, 200, { workspaces: listWorkspaces() });
		}

		if (req.method === 'POST' && path === '/api/workspaces/reload') {
			try {
				const workspaces = await reloadWorkspaces();
				const refreshed = refreshChatTools();
				return json(res, 200, { ok: true, workspaces, count: workspaces.length, refreshed });
			} catch (error) {
				return json(res, 500, { error: error instanceof Error ? error.message : String(error) });
			}
		}

		if (req.method === 'POST' && path === '/api/workspaces') {
			const body = await readBody(req);
			try {
				const workspace = await addWorkspace({
					path: String(body.path ?? ''),
					label: typeof body.label === 'string' ? body.label : undefined,
					readonly: Boolean(body.readonly),
				});
				// 新登记/覆盖的工作区可能改变已有会话 cwd 的归属，同样重算。
				const refreshed = refreshChatTools();
				return json(res, 200, { ok: true, workspace, refreshed });
			} catch (error) {
				return json(res, 400, { error: error instanceof Error ? error.message : String(error) });
			}
		}

		/* -------------------------- Agent 模板（CARD） -------------------------- */

		if (req.method === 'GET' && path === '/api/agents') {
			try {
				const domain = url.searchParams.get('domain') ?? 'general';
				const [agents, tools, skills] = await Promise.all([listAgents(), toolRegistry(), availableSkills()]);
				return json(res, 200, { agents, tools, skills, pinnedTools: PINNED_TOOLS });
			} catch (error) {
				return json(res, 500, { error: error instanceof Error ? error.message : String(error) });
			}
		}

		if (req.method === 'POST' && path === '/api/agents/preview') {
			const body = await readBody(req);
			try {
				return json(res, 200, await previewAgent(body.card ?? body));
			} catch (error) {
				return json(res, Number((error as any)?.status) || 400, {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		if (req.method === 'POST' && path === '/api/agents/save') {
			const body = await readBody(req);
			try {
				return json(res, 200, await saveAgent(body.card ?? body));
			} catch (error) {
				return json(res, Number((error as any)?.status) || 400, {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		if (req.method === 'POST' && path === '/api/agents/fork') {
			const body = await readBody(req);
			try {
				const card = await forkAgent(String(body.id ?? ''), {
					name: typeof body.name === 'string' ? body.name : undefined,
					domain: typeof body.domain === 'string' ? body.domain : undefined,
				});
				return json(res, 200, card);
			} catch (error) {
				return json(res, Number((error as any)?.status) || 400, {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		if (req.method === 'POST' && path === '/api/agents/merge-diff') {
			const body = await readBody(req);
			try {
				return json(res, 200, await mergeDiff(String(body.id ?? '')));
			} catch (error) {
				return json(res, Number((error as any)?.status) || 400, {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		if (req.method === 'POST' && path === '/api/agents/merge') {
			const body = await readBody(req);
			try {
				const fields = Array.isArray(body.fields) ? body.fields.map(String) : undefined;
				return json(res, 200, await mergeApply(String(body.id ?? ''), fields));
			} catch (error) {
				return json(res, Number((error as any)?.status) || 400, {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		// 只读工作区文件 API；必须在静态文件兜底之前。
		if (path.startsWith('/api/files/')) return handleFiles(req, res, url);
		// Git 面板：仓库清单 + 只读状态；同样必须在静态文件兜底之前。
		if (path.startsWith('/api/git/')) return handleGit(req, res, url);

		/* ------------------------------ 技能库 ------------------------------ */

		if (req.method === 'GET' && path === '/api/skills') {
			try {
				return json(res, 200, await listSkills());
			} catch (error) {
				const status = error instanceof SkillError ? error.status : 500;
				return json(res, status, { error: error instanceof Error ? error.message : String(error) });
			}
		}

		if (req.method === 'GET' && path === '/api/skills/market') {
			try {
				return json(res, 200, await getMarketCatalog({ refresh: url.searchParams.get('refresh') === '1' }));
			} catch (error) {
				const status = error instanceof MarketError ? error.status : 502;
				return json(res, status, { error: error instanceof Error ? error.message : String(error) });
			}
		}

		if (req.method === 'GET' && path === '/api/skills/market/item') {
			const source = url.searchParams.get('source') ?? '';
			const skillPath = url.searchParams.get('path') ?? '';
			if (!source || !skillPath) return json(res, 400, { error: 'source and path required' });
			try {
				return json(res, 200, await getMarketSkill(source, skillPath));
			} catch (error) {
				const status = error instanceof MarketError ? error.status : 502;
				return json(res, status, { error: error instanceof Error ? error.message : String(error) });
			}
		}

		if (req.method === 'POST' && path === '/api/skills/market/translate') {
			const body = await readBody(req);
			try {
				return json(res, 200, {
					ok: true,
					...(await translateMarketSkill(String(body.source ?? ''), String(body.path ?? ''))),
				});
			} catch (error) {
				const status = error instanceof MarketError ? error.status : 502;
				return json(res, status, { error: error instanceof Error ? error.message : String(error) });
			}
		}

		if (req.method === 'POST' && path === '/api/skills/install') {
			const body = await readBody(req);
			try {
				const result = await installSkill(body);
				if (body.activate === true && result.installed.length) {
					const current = await listSkills();
					const refs = [...current.selection.refs];
					for (const entry of result.installed) {
						const prefix = `${entry.name}@`;
						for (let index = refs.length - 1; index >= 0; index--) {
							if (refs[index].startsWith(prefix)) refs.splice(index, 1);
						}
						refs.push(`${entry.name}@sha256:${entry.treeHash}`);
					}
					const snapshot = await selectSkills({
						refs,
						mode: current.selection.mode,
						policy: current.selection.policy,
					});
					return json(res, 200, { ok: true, ...result, snapshot, entries: snapshot.entries, selection: snapshot.selection });
				}
				return json(res, 200, { ok: true, ...result });
			} catch (error) {
				const status = error instanceof SkillError ? error.status : 400;
				return json(res, status, { error: error instanceof Error ? error.message : String(error) });
			}
		}

		if (req.method === 'POST' && path === '/api/skills/audit') {
			const body = await readBody(req);
			try {
				return json(res, 200, { ok: true, ...(await auditSkill(body)) });
			} catch (error) {
				const status = error instanceof SkillError ? error.status : 400;
				return json(res, status, { error: error instanceof Error ? error.message : String(error) });
			}
		}

		if (req.method === 'POST' && path === '/api/skills/remove') {
			const body = await readBody(req);
			try {
				return json(res, 200, { ok: true, ...(await removeSkill(body)) });
			} catch (error) {
				const status = error instanceof SkillError ? error.status : 400;
				return json(res, status, { error: error instanceof Error ? error.message : String(error) });
			}
		}

		if (req.method === 'POST' && path === '/api/skills/select') {
			const body = await readBody(req);
			try {
				return json(res, 200, { ok: true, ...(await selectSkills(body)) });
			} catch (error) {
				const status = error instanceof SkillError ? error.status : 400;
				return json(res, status, { error: error instanceof Error ? error.message : String(error) });
			}
		}

		if (req.method === 'POST' && path === '/api/skills/refresh') {
			const body = await readBody(req);
			try {
				return json(res, 200, { ok: true, ...(await refreshSkills(body)) });
			} catch (error) {
				const status = error instanceof SkillError ? error.status : 400;
				return json(res, status, { error: error instanceof Error ? error.message : String(error) });
			}
		}

		const sessionSkillApply = path.match(/^\/api\/session\/([^/]+)\/skills\/apply$/);
		if (req.method === 'POST' && (sessionSkillApply || path === '/api/skills/apply')) {
			const body = sessionSkillApply ? {} : await readBody(req);
			const id = sessionSkillApply ? decodeURIComponent(sessionSkillApply[1]) : String(body.sessionId ?? body.sid ?? '');
			const chat = chats.find(id);
			if (!chat) return json(res, 404, { error: 'session not found' });
			try {
				const applied = await chat.applySkills();
				return json(res, 200, { ok: true, ...applied, stats: chat.stats() });
			} catch (error) {
				const status = Number((error as any)?.status) || (error instanceof SkillError ? error.status : 400);
				return json(res, status, { error: error instanceof Error ? error.message : String(error) });
			}
		}

		/* -------------------------------- MCP -------------------------------- */

		if (req.method === 'GET' && path === '/api/mcp') {
			return json(res, 200, mcpPayload());
		}

		if (req.method === 'POST' && path === '/api/mcp/save') {
			const body = await readBody(req);
			try {
				const name = String(body.name ?? '');
				if (!name) return json(res, 400, { error: 'name required' });
				saveMcpServer(name, body.config);
				return json(res, 200, mcpPayload());
			} catch (error) {
				const status = error instanceof McpConfigError ? error.status : 400;
				return json(res, status, { error: error instanceof Error ? error.message : String(error) });
			}
		}

		if (req.method === 'POST' && path === '/api/mcp/remove') {
			const body = await readBody(req);
			try {
				deleteMcpServer(String(body.name ?? ''));
				return json(res, 200, mcpPayload());
			} catch (error) {
				const status = error instanceof McpConfigError ? error.status : 400;
				return json(res, status, { error: error instanceof Error ? error.message : String(error) });
			}
		}

		if (req.method === 'POST' && path === '/api/mcp/enable') {
			const body = await readBody(req);
			try {
				setMcpServerEnabled(String(body.name ?? ''), body.enabled !== false);
				return json(res, 200, mcpPayload());
			} catch (error) {
				const status = error instanceof McpConfigError ? error.status : 400;
				return json(res, status, { error: error instanceof Error ? error.message : String(error) });
			}
		}

		// 测试连接：带 config 就测草稿（不写盘），只带 name 就测已保存的那条。
		if (req.method === 'POST' && path === '/api/mcp/test') {
			const body = await readBody(req);
			const name = String(body.name ?? '');
			if (!name) return json(res, 400, { error: 'name required' });
			try {
				let entry = readMcpFile().servers.find((server) => server.name === name);
				if (body.config !== undefined && body.config !== null) {
					const checked = validateServer(name, body.config);
					if ('error' in checked) return json(res, 400, { error: checked.error });
					entry = { name, config: checked.config, source: 'draft', scope: 'global' };
				}
				if (!entry) return json(res, 404, { error: `没有服务器 "${name}"` });
				const cwd = typeof body.cwd === 'string' && body.cwd ? body.cwd : process.cwd();
				const rawTimeout = Number(body.timeoutMs);
				const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? Math.min(60_000, Math.max(1_000, rawTimeout)) : undefined;
				const probe = await probeMcpServer(entry, { cwd, timeoutMs });
				return json(res, 200, { ok: true, enabled: MCP_ENABLED, probe });
			} catch (error) {
				const status = error instanceof McpConfigError ? error.status : 500;
				return json(res, status, { error: error instanceof Error ? error.message : String(error) });
			}
		}

		// 改了 mcp.json 对已经在跑的会话不生效，直到 session.reload()（重发 session_start）。
		if (req.method === 'POST' && path === '/api/mcp/apply') {
			const applied: string[] = [];
			const skipped: Array<{ id: string; reason: string }> = [];
			const failed: Array<{ id: string; error: string }> = [];
			for (const chat of chats.all()) {
				if (chat.busy) {
					skipped.push({ id: chat.sessionId, reason: '生成中，结束再重连' });
					continue;
				}
				try {
					await chat.applyMcp();
					applied.push(chat.sessionId);
				} catch (error) {
					failed.push({ id: chat.sessionId, error: error instanceof Error ? error.message : String(error) });
				}
			}
			return json(res, 200, { ok: true, applied, skipped, failed });
		}

		if (req.method === 'POST' && path === '/api/chat') {
			const body = await readBody(req);
			const text = String(body.text ?? '');
			const images = (Array.isArray(body.images) ? body.images : [])
				.filter(
					(image: any) =>
						image?.type === 'image' &&
						typeof image.data === 'string' &&
						image.data.length > 0 &&
						typeof image.mimeType === 'string' &&
						image.mimeType.startsWith('image/'),
				)
				.slice(0, 8)
				.map((image: any) => ({
					type: 'image' as const,
					data: String(image.data),
					mimeType: String(image.mimeType),
				}));
			if (!text.trim() && !images.length) return json(res, 400, { error: 'text or image required' });
			const references = (Array.isArray(body.references) ? body.references : [])
				.filter(
					(ref: any) =>
						ref?.kind === 'session' &&
						typeof ref.id === 'string' &&
						/^[A-Za-z0-9._-]+$/.test(ref.id),
				)
				.slice(0, 3)
				.map((ref: any) => ({
					kind: 'session' as const,
					id: String(ref.id),
					...(typeof ref.title === 'string' && ref.title.trim() ? { title: String(ref.title).slice(0, 200) } : {}),
					...(Number.isInteger(Number(ref.turn)) && Number(ref.turn) > 0 ? { turn: Number(ref.turn) } : {}),
				}));
			const clientId = body.clientId ?? body.sid ?? `web-${Math.random().toString(16).slice(2, 8)}`;
			// 选了 AgentTemplate 就用它；没选 = 老行为（环境默认工具集）。
			// 选了但不存在直接报错，不静默回退到 web-xxx：那会让“页面配了但没生效”变成默认行为。
			const requestedAgent = typeof body.agentId === 'string' ? body.agentId.trim() : '';
			const card = requestedAgent ? await cardById(requestedAgent).catch(() => undefined) : undefined;
			if (requestedAgent && !card) return json(res, 400, { error: `未知 agent 模板：${requestedAgent}` });
			const agentId = card?.id ?? `web-${clientId.slice(0, 8)}`;
			let chat = body.sessionId ? chats.find(body.sessionId) : undefined;
			if (!chat && body.sessionId) {
				chat = await chats.open({
					clientId,
					agentId,
					domain: body.domain ?? 'general',
					sessionId: body.sessionId,
					card,
				});
			}
			if (!chat) {
				try {
					const worktreeRequested =
						body.worktree === true ||
						(Boolean(body.worktree) && typeof body.worktree === 'object' && body.worktree.enabled !== false);
					const worktree = worktreeRequested
						? {
								baseRef:
									typeof body.worktree?.baseRef === 'string' ? body.worktree.baseRef : undefined,
							}
						: undefined;
					chat = await chats.start({
						clientId,
						agentId,
						domain: body.domain ?? 'general',
						workspaceId: typeof body.workspaceId === 'string' ? body.workspaceId : undefined,
						worktree,
						codemode:
							body.codemode === 'on' || body.codemode === 'off' || body.codemode === 'auto'
								? body.codemode
								: undefined,
						card,
						// 首条消息前在 UI 选的模型：和建会话同一次请求带过来
						model: typeof body.model === 'string' ? body.model.trim() || undefined : undefined,
					});
				} catch (error) {
					return json(res, 400, { error: error instanceof Error ? error.message : String(error) });
				}
			}
			if (body.domain && body.domain !== chat.domain) chat.domain = body.domain;
			wire(chat);
			const mode = body.mode === 'steer' || body.mode === 'followUp' ? body.mode : 'prompt';
			process.stdout.write(`[chat ${chat.id.slice(0, 8)}] <- ${text.length} chars${images.length ? ` + ${images.length} image(s)` : ''} mode=${mode} (session ${chat.sessionId.slice(0, 8)}) busy=${chat.busy}\n`);
			// 生成中的插话/排队很快返回；等它落进 SDK 队列再回响应，前端才能回滚失败。
			if (chat.busy && mode !== 'prompt') {
				try {
					await chat.prompt(text, mode, images, references);
					return json(res, 200, { ok: true, ...chat.stats() });
				} catch (error) {
					return json(res, 409, { error: error instanceof Error ? error.message : String(error) });
				}
			}
			json(res, 202, { ok: true, agentId: chat.agentId, sessionId: chat.sessionId });
			chat.prompt(text, 'prompt', images, references).catch((error) => {
				const message = error instanceof Error ? error.message : String(error);
				process.stderr.write(`[chat ${chat.id.slice(0, 8)}] prompt failed: ${message}\n`);
				broadcast(chat.id, 'error', { message });
			});
			return;
		}

		if (req.method === 'POST' && path === '/api/queue/update') {
			const body = await readBody(req);
			const chat = chats.find(body.sessionId ?? body.sid ?? '');
			if (!chat) return json(res, 404, { error: 'session not found' });
			try {
				const queue = await chat.updateQueue({
					kind: body.kind,
					placement: body.placement,
					index: Number(body.index),
					text: typeof body.text === 'string' ? body.text : undefined,
				});
				return json(res, 200, { ok: true, queue });
			} catch (error) {
				return json(res, 409, { error: error instanceof Error ? error.message : String(error) });
			}
		}

		if (req.method === 'POST' && path === '/api/queue/clear') {
			const body = await readBody(req);
			const chat = chats.find(body.sessionId ?? body.sid ?? '');
			if (!chat) return json(res, 404, { error: 'session not found' });
			return json(res, 200, { ok: true, ...chat.clearQueue() });
		}

		if (req.method === 'POST' && path === '/api/abort') {
			const body = await readBody(req);
			const chat = chats.find(body.sessionId ?? body.sid ?? '');
			chat?.abort().catch(() => {});
			return json(res, 200, { ok: true });
		}

		if (req.method === 'GET' && path === '/api/models') {
			return json(res, 200, await listModels());
		}

		if (req.method === 'GET' && path === '/api/providers') {
			return json(res, 200, await listProviders());
		}

		if (req.method === 'POST' && path === '/api/providers') {
			const body = await readBody(req);
			try {
				const result = await saveCustomProvider(body);
				invalidateQuotaCache(result.provider.id);
				return json(res, 200, result);
			} catch (error) {
				return json(res, 400, { error: error instanceof Error ? error.message : String(error) });
			}
		}

		if (req.method === 'POST' && path === '/api/providers/delete') {
			const body = await readBody(req);
			try {
				const providers = await deleteCustomProvider(body.id);
				invalidateQuotaCache(String(body.id ?? ''));
				return json(res, 200, { ok: true, providers });
			} catch (error) {
				return json(res, 400, { error: error instanceof Error ? error.message : String(error) });
			}
		}

		if (req.method === 'POST' && path === '/api/providers/toggle') {
			const body = await readBody(req);
			try {
				const providers = await setCustomProviderEnabled(body.id, body.enabled);
				invalidateQuotaCache(String(body.id ?? ''));
				return json(res, 200, { ok: true, providers });
			} catch (error) {
				return json(res, 400, { error: error instanceof Error ? error.message : String(error) });
			}
		}

		if (req.method === 'GET' && path === '/api/providers/quota') {
			const providerId = url.searchParams.get('id')?.trim() ?? '';
			if (!providerId) return json(res, 400, { error: 'id required' });
			try {
				return json(
					res,
					200,
					await providerQuota(providerId, { force: url.searchParams.get('refresh') === '1' }),
				);
			} catch (error) {
				return json(res, 502, { error: error instanceof Error ? error.message : String(error) });
			}
		}

		if (req.method === 'POST' && path === '/api/providers/models') {
			const body = await readBody(req);
			try {
				return json(res, 200, await fetchProviderModels(body));
			} catch (error) {
				return json(res, 502, { error: error instanceof Error ? error.message : String(error) });
			}
		}

		if (req.method === 'POST' && path === '/api/providers/test') {
			const body = await readBody(req);
			try {
				return json(res, 200, await testProviderConnection(body));
			} catch (error) {
				return json(res, 502, { error: error instanceof Error ? error.message : String(error) });
			}
		}

		/* ---------------------------- 凭据管理器 ---------------------------- */

		// 联网搜索：状态（不泄露 key）+ 设置页的真实探测。
		if (req.method === 'GET' && path === '/api/search') {
			return json(res, 200, await searchStatus());
		}

		if (req.method === 'POST' && path === '/api/search/test') {
			const body = await readBody(req);
			const out = await testSearch(typeof body?.query === 'string' ? body.query : undefined);
			return json(res, out.ok ? 200 : 502, out);
		}

		if (req.method === 'GET' && path === '/api/credentials') {
			return json(res, 200, await listCredentials());
		}

		if (req.method === 'POST' && path === '/api/credentials') {
			const body = await readBody(req);
			try {
				const result = await saveCredential(body);
				invalidateQuotaCache();
				return json(res, 200, { ok: true, ...result });
			} catch (error) {
				const status = error instanceof CredentialError ? error.status : 400;
				return json(res, status, { error: error instanceof Error ? error.message : String(error) });
			}
		}

		if (req.method === 'POST' && path === '/api/credentials/delete') {
			const body = await readBody(req);
			try {
				const result = await deleteCredential(body);
				invalidateQuotaCache();
				return json(res, 200, { ok: true, ...result });
			} catch (error) {
				const status = error instanceof CredentialError ? error.status : 400;
				return json(res, status, { error: error instanceof Error ? error.message : String(error) });
			}
		}

		if (req.method === 'POST' && path === '/api/credentials/rotate') {
			const body = await readBody(req);
			try {
				const result = await rotateCredential(body);
				invalidateQuotaCache();
				return json(res, 200, { ok: true, ...result });
			} catch (error) {
				const status = error instanceof CredentialError ? error.status : 400;
				return json(res, status, { error: error instanceof Error ? error.message : String(error) });
			}
		}

		if (req.method === 'POST' && path === '/api/credentials/import-env') {
			const body = await readBody(req);
			try {
				const result = await importEnvCredential(body);
				invalidateQuotaCache();
				return json(res, 200, { ok: true, ...result });
			} catch (error) {
				const status = error instanceof CredentialError ? error.status : 400;
				return json(res, status, { error: error instanceof Error ? error.message : String(error) });
			}
		}

		if (req.method === 'POST' && path === '/api/credentials/test') {
			const body = await readBody(req);
			try {
				return json(res, 200, await testCredential(body));
			} catch (error) {
				const status = error instanceof CredentialError ? error.status : 502;
				return json(res, status, { error: error instanceof Error ? error.message : String(error) });
			}
		}

		if (req.method === 'GET' && path === '/api/credentials/audit') {
			const limit = Number(url.searchParams.get('limit') ?? 200);
			return json(res, 200, { audit: await readAudit(Number.isFinite(limit) ? limit : 200) });
		}

		if (req.method === 'POST' && path === '/api/credentials/lease/revoke') {
			const body = await readBody(req);
			const lease = typeof body.lease === 'string' ? body.lease : undefined;
			const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined;
			const count = lease || sessionId ? revokeLeases({ lease, sessionId }) : revokeAllLeases();
			appendAudit({ actor: 'user', action: 'revoke', lease, sessionId, ...(count ? { status: 200 } : {}) });
			return json(res, 200, { ok: true, revoked: count, ...(await listCredentials()) });
		}

		if (req.method === 'POST' && path === '/api/credentials/decision') {
			const body = await readBody(req);
			const requestId = String(body.requestId ?? '').trim();
			if (!requestId) return json(res, 400, { error: 'requestId required' });
			const ok = decideCredentialRequest(requestId, String(body.decision ?? 'deny'));
			return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: '审批请求不存在或已超时' });
		}

		if (req.method === 'GET' && path === '/api/sessions') {
			const workspaceId = url.searchParams.get('workspaceId')?.trim();
			const worktreeId = url.searchParams.get('worktreeId')?.trim();
			const list = (await listSessions()).filter(
				(session) =>
					(!workspaceId || session.workspaceId === workspaceId) &&
					(!worktreeId || session.worktreeId === worktreeId),
			);
			const busyPaths = new Set<string>();
			for (const chat of chats.all()) {
				if (!chat.busy) continue;
				const path = chat.sessionPathNow();
				if (path) busyPaths.add(path);
			}
			const approvalSessions = new Set(pendingApprovalSessionIds());
			return json(
				res,
				200,
				list.map((s) => ({
					...s,
					busy: busyPaths.has(s.path),
					approvalPending: approvalSessions.has(s.id),
				})),
			);
		}

		if (req.method === 'GET' && path === '/api/trajectory/payload') {
			const key = url.searchParams.get('sessionId') ?? url.searchParams.get('sid') ?? '';
			const stepId = url.searchParams.get('stepId') ?? '';
			if (!key) return json(res, 400, { error: 'sessionId required' });
			if (!stepId) return json(res, 400, { error: 'stepId required' });
			const chat = chats.find(key);
			if (!chat) return json(res, 404, { error: 'session not open' });
			wire(chat);
			return json(res, 200, await chat.trajectoryPayload(stepId));
		}

		if (req.method === 'GET' && path === '/api/trajectory/context') {
			const key = url.searchParams.get('sessionId') ?? url.searchParams.get('sid') ?? '';
			const stepId = url.searchParams.get('stepId') ?? '';
			if (!key) return json(res, 400, { error: 'sessionId required' });
			if (!stepId) return json(res, 400, { error: 'stepId required' });
			const chat = chats.find(key);
			if (!chat) return json(res, 404, { error: 'session not open' });
			wire(chat);
			return json(res, 200, await chat.trajectoryContext(stepId));
		}

		if (req.method === 'GET' && path === '/api/trajectory') {
			const key = url.searchParams.get('sessionId') ?? url.searchParams.get('sid') ?? '';
			if (!key) return json(res, 400, { error: 'sessionId required' });
			const chat = chats.find(key);
			if (!chat) return json(res, 404, { error: 'session not open' });
			wire(chat);
			return json(res, 200, await chat.trajectory());
		}

		if (req.method === 'GET' && path === '/api/session/history') {
			const key = url.searchParams.get('sessionId') ?? url.searchParams.get('sid') ?? '';
			if (!key) return json(res, 400, { error: 'sessionId required' });
			const turns = Number(url.searchParams.get('turns'));
			const rawBefore = url.searchParams.get('before');
			const before = rawBefore == null || rawBefore === '' ? undefined : Number(rawBefore);
			const options = {
				turns: Number.isFinite(turns) && turns > 0 ? turns : HISTORY_PAGE_TURNS,
				before: Number.isFinite(before) ? before : undefined,
			};
			const chat = chats.find(key);
			if (chat) {
				wire(chat);
				const page = await chat.historyPage(options);
				return json(res, 200, {
					ok: true,
					sessionId: chat.sessionId,
					history: page.history,
					historyMeta: page.meta,
					turnOverview: await chat.turnOverview(),
					presentedByTurn: await readReportedByTurn(chat.sessionId),
				});
			}
			// 首屏历史加载可能和 /api/session/open 并行：Chat 还没建好时直接从文件读。
			try {
				const page = await historyPageForSession(key, options);
				return json(res, 200, {
					ok: true,
					sessionId: page.sessionId,
					history: page.history,
					historyMeta: page.historyMeta,
					turnOverview: page.turnOverview,
					presentedByTurn: await readReportedByTurn(page.sessionId),
				});
			} catch (error) {
				return json(res, 404, { error: error instanceof Error ? error.message : String(error) });
			}
		}

		if (req.method === 'GET' && path === '/api/session/snapshot') {
			const key = url.searchParams.get('sessionId') ?? url.searchParams.get('sid') ?? '';
			if (!key) return json(res, 400, { error: 'sessionId required' });
			const chat = chats.find(key);
			if (chat) {
				wire(chat);
				return json(res, 200, {
					...chat.stats(),
					favorites: await readFavorites(chat.sessionId),
				});
			}
			const snapshot = await sessionSnapshotStats(key);
			if (!snapshot) return json(res, 404, { error: 'session not found' });
			return json(res, 200, snapshot);
		}

		if (req.method === 'GET' && path === '/api/session') {
			const key = url.searchParams.get('sessionId') ?? url.searchParams.get('sid') ?? '';
			if (!key) return json(res, 400, { error: 'sessionId required' });
			const chat = chats.find(key);
			if (!chat) return json(res, 404, { error: 'session not open' });
			wire(chat);
			const turns = Number(url.searchParams.get('historyTurns'));
			const page = await chat.historyPage({
				turns: Number.isFinite(turns) && turns > 0 ? turns : HISTORY_PAGE_TURNS,
			});
			return json(res, 200, {
				...chat.stats(),
				history: page.history,
				historyMeta: page.meta,
				turnOverview: await chat.turnOverview(),
				favorites: await readFavorites(chat.sessionId),
				presentedByTurn: await readReportedByTurn(chat.sessionId),
			});
		}

		if (req.method === 'POST' && path === '/api/session/open') {
			const body = await readBody(req);
			const clientId = body.clientId ?? body.sid ?? '';
			const target = await findSessionInfo(String(body.sessionId ?? ''));
			if (!target) return json(res, 404, { error: 'session not found' });
			// 只切换视图：不 dispose、不中止正在跑的那一轮
			const chat = await chats.open({
				clientId: clientId || `web-${Math.random().toString(16).slice(2, 8)}`,
				agentId: body.agentId ?? `web-${String(clientId || target.id).slice(0, 8)}`,
				domain: body.domain ?? 'general',
				sessionId: target.id,
			});
			wire(chat);
			// 新前端先拿快照，再并行拉历史；这里可以跳过历史，只返回完整实时 stats。
			if (body.history === false) {
				return json(res, 200, {
					...chat.stats(),
					favorites: await readFavorites(chat.sessionId),
					});
			}
			const page = await chat.historyPage({
				turns:
					Number.isFinite(Number(body.historyTurns)) && Number(body.historyTurns) > 0
						? Number(body.historyTurns)
						: HISTORY_PAGE_TURNS,
			});
			return json(res, 200, {
				...chat.stats(),
				history: page.history,
				historyMeta: page.meta,
				turnOverview: await chat.turnOverview(),
				favorites: await readFavorites(chat.sessionId),
				presentedByTurn: await readReportedByTurn(chat.sessionId),
			});
		}

		if (req.method === 'POST' && path === '/api/session/favorite') {
			const body = await readBody(req);
			const id = body.sessionId ?? body.sid ?? '';
			const turn = Number(body.turn);
			if (!id) return json(res, 400, { error: 'sessionId required' });
			if (!Number.isInteger(turn) || turn <= 0) return json(res, 400, { error: 'invalid turn' });
			const chat = chats.find(id);
			const sessionId = chat?.sessionId ?? id;
			const turns = await setFavoriteTurn(sessionId, turn, Boolean(body.favorite));
			return json(res, 200, { ok: true, sessionId, turns });
		}

		if (req.method === 'POST' && path === '/api/session/archive') {
			const body = await readBody(req);
			const id = body.sessionId ?? body.sid ?? '';
			if (!id) return json(res, 400, { error: 'sessionId required' });
			const chat = chats.find(id);
			const sessionId = chat?.sessionId ?? id;
			const archived = body.archived !== false;
			try {
				return json(res, 200, { ok: true, ...(await setSessionArchived(sessionId, archived)) });
			} catch (error) {
				return json(res, 404, { error: error instanceof Error ? error.message : String(error) });
			}
		}

		if (req.method === 'POST' && path === '/api/session/fork') {
			const body = await readBody(req);
			const id = body.sessionId ?? body.sid ?? '';
			if (!id) return json(res, 400, { error: 'sessionId required' });
			const chat = chats.find(id);
			if (chat?.busy) return json(res, 409, { error: '这一轮还没结束，结束再 fork' });
			const source = chat?.sessionPathNow() ?? id;
			const turn = Number(body.turn);
			return json(res, 200, {
				ok: true,
				...(await forkSession(source, {
					turn: Number.isFinite(turn) && turn > 0 ? turn : undefined,
					workspaceId: typeof body.workspaceId === 'string' ? body.workspaceId : undefined,
					worktreeId: typeof body.worktreeId === 'string' ? body.worktreeId : undefined,
				})),
			});
		}

		if (req.method === 'POST' && path === '/api/session/rename') {
			const body = await readBody(req);
			const id = body.sessionId ?? body.sid ?? '';
			if (!id) return json(res, 400, { error: 'sessionId required' });
			const chat = chats.find(id);
			// 当前打开会话走 SDK（会记 session_info）；没打开的磁盘会话直接写文件
			const out = chat
				? { sessionId: chat.sessionId, name: chat.rename(body.name ?? '') }
				: await renameSession(id, body.name ?? '');
			return json(res, 200, { ok: true, ...out });
		}

		if (req.method === 'POST' && path === '/api/session/settings') {
			const body = await readBody(req);
			const chat = chats.find(body.sessionId ?? body.sid);
			if (!chat) return json(res, 404, { error: 'session not found' });
			if (body.model) await chat.setModel(body.model);
			if (body.thinking) chat.setThinking(body.thinking);
			if (Array.isArray(body.tools) && body.tools.length) chat.setTools(body.tools);
			return json(res, 200, chat.stats());
		}

		if (req.method === 'POST' && path === '/api/session/compact') {
			const body = await readBody(req);
			const chat = chats.find(body.sessionId ?? body.sid);
			if (!chat) return json(res, 404, { error: 'session not found' });
			const out = await chat.compact(body.instructions);
			return json(res, 200, out.stats);
		}

		if (req.method === 'POST' && path === '/api/session/new') {
			// 新建对话不销毁任何东西：正在跑的会话在后台继续，回来看还能还原
			return json(res, 200, { ok: true });
		}

		if (req.method === 'GET') return serveStatic(res, path);
		return json(res, 405, { error: 'method not allowed' });
	} catch (error) {
		return json(res, 500, { error: error instanceof Error ? error.message : String(error) });
	}
}

await initWorkspaces();
await initWorktrees();
registerJob(
	createWorktreeGcJob({
		listSessions,
		readArchivedSessions: readArchivedSessionRecords,
		liveChats: () => chats.all().map((chat) => ({ cwd: chat.cwd, busy: chat.busy, sessionId: chat.sessionId })),
	}),
);
await startScheduler();
// 访问控制先就绪；凭据必须在 initCustomProviders 之前 hydrate env 层。
await initAccessToken();
await initCredentials();
setApprovalOnlineProbe(
	(chatId, sessionId) =>
		(clients.get(chatId)?.size ?? 0) > 0 ||
		(Boolean(sessionId) && (clients.get(sessionId)?.size ?? 0) > 0),
);
try {
	await initCustomProviders();
} catch (error) {
	process.stderr.write(`[providers] 初始化失败：${error instanceof Error ? error.message : String(error)}\n`);
}
const server = createServer((req, res) => {
	handler(req, res).catch((error) => json(res, 500, { error: String(error) }));
});

server.listen(PORT, HOST, () => {
	process.stdout.write(`turn-pi listening on http://${HOST}:${PORT}\n`);
	process.stdout.write(`[web] serving ${WEB_DIR}\n`);
	if (!existsSync(join(WEB_DIR, 'index.html'))) {
		process.stderr.write('[web] 没有构建产物，先跑 `npm run build:web`（或 make build-web）\n');
	}
});

/**
 * 退出时必须主动断开 SSE：EventSource 是长连接，server.close() 会一直等它，
 * 于是 node --watch 的“热重启”会卡在 Waiting for graceful termination。
 */
function shutdown() {
	stopScheduler();
	for (const set of clients.values()) {
		for (const res of set) {
			try {
				res.end();
			} catch {
				/* 已断开 */
			}
		}
	}
	clients.clear();
	chats.disposeAll();
	server.close(() => process.exit(0));
	server.closeAllConnections?.();
	setTimeout(() => process.exit(0), 1500).unref();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, shutdown);
