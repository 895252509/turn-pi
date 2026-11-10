/**
 * 访问控制：bootstrap token → Cookie。
 *
 * 设计见 docs/credential-manager.md §0.1。
 *   - PI_ACCESS_TOKEN 优先；
 *   - 否则读 runtime/access-token，没有就生成 32 字节 base64url；
 *   - `/?token=xxx` 校验成功后发 HttpOnly Cookie 并 302 掉 query；
 *   - /api/health 与租约代理豁免（代理只允许 loopback）。
 *
 * 这层防的是同网段的其他浏览器/脚本，不防同容器同 uid 的 agent。
 */

import { timingSafeEqual, createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const RUNTIME_DIR = resolve(
	process.env.PI_RUNTIME_DIR ?? join(import.meta.dirname ?? '.', '..', 'runtime'),
);
const TOKEN_FILE = process.env.PI_ACCESS_TOKEN_FILE ?? join(RUNTIME_DIR, 'access-token');
const COOKIE_NAME = 'pi_access';
const COOKIE_MAX_AGE = 2_592_000;
const PORT = Number(process.env.PORT ?? 44100);
const INITIAL_ORIGIN = process.env.PI_ACCESS_ORIGIN?.trim().replace(/\/+$/, '');

let token = '';
let tokenSource: 'env' | 'file' | 'generated' = 'generated';
let initialised = false;

const attempts = new Map<string, { count: number; resetAt: number }>();

function sameSecret(a: string, b: string): boolean {
	if (!a || !b) return false;
	const left = createHash('sha256').update(a).digest();
	const right = createHash('sha256').update(b).digest();
	return timingSafeEqual(left, right);
}

export async function initAccessToken(): Promise<void> {
	if (initialised) return;
	const fromEnv = process.env.PI_ACCESS_TOKEN?.trim();
	if (fromEnv) {
		token = fromEnv;
		tokenSource = 'env';
	} else {
		try {
			const raw = (await readFile(TOKEN_FILE, 'utf8')).trim();
			if (raw) {
				token = raw;
				tokenSource = 'file';
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
		}
		if (!token) {
			token = randomBytes(32).toString('base64url');
			await mkdir(dirname(TOKEN_FILE), { recursive: true });
			await writeFile(TOKEN_FILE, token + '\n', { encoding: 'utf8', mode: 0o600 });
			tokenSource = 'generated';
		}
	}
	initialised = true;
	const origin = INITIAL_ORIGIN || `http://localhost:${PORT}`;
	process.stdout.write(`[auth] open ${origin}/?token=${token}\n`);
	process.stdout.write(
		tokenSource === 'env'
			? '[auth] token source: PI_ACCESS_TOKEN\n'
			: `[auth] token file: ${TOKEN_FILE}\n`,
	);
}

export function accessToken(): string {
	return token;
}

function parseCookies(header: string | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	if (!header) return out;
	for (const part of header.split(';')) {
		const index = part.indexOf('=');
		if (index < 0) continue;
		const name = part.slice(0, index).trim();
		const value = part.slice(index + 1).trim();
		if (!name) continue;
		try {
			out[name] = decodeURIComponent(value);
		} catch {
			out[name] = value;
		}
	}
	return out;
}

export function cookieToken(req: IncomingMessage): string {
	return parseCookies(req.headers.cookie)[COOKIE_NAME] ?? '';
}

export function tokenValid(value: string | undefined | null): boolean {
	return Boolean(value) && sameSecret(String(value), token);
}

export function setAccessCookie(res: ServerResponse) {
	res.setHeader(
		'set-cookie',
		`${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE}`,
	);
}

function clientIp(req: IncomingMessage): string {
	return req.socket.remoteAddress ?? 'unknown';
}

/** 只对失败的 token 尝试计数；32 字节 token 本身不可暴破，限速主要防日志刷屏。 */
export function tooManyAttempts(req: IncomingMessage): boolean {
	const item = attempts.get(clientIp(req));
	if (!item) return false;
	if (item.resetAt <= Date.now()) {
		attempts.delete(clientIp(req));
		return false;
	}
	return item.count >= 10;
}

export function noteFailedAttempt(req: IncomingMessage) {
	const ip = clientIp(req);
	const now = Date.now();
	const item = attempts.get(ip);
	if (!item || item.resetAt <= now) {
		attempts.set(ip, { count: 1, resetAt: now + 60_000 });
		return;
	}
	item.count += 1;
}

export function isLoopback(req: IncomingMessage): boolean {
	const address = req.socket.remoteAddress ?? '';
	return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/** 浏览器 POST 的 CSRF 第二道：同源校验；无 Origin 的 curl/agent 放行。 */
export function sameOrigin(req: IncomingMessage): boolean {
	const origin = req.headers.origin;
	if (!origin) return true;
	if (INITIAL_ORIGIN && origin === INITIAL_ORIGIN) return true;
	try {
		const originUrl = new URL(origin);
		const hosts = [req.headers.host, req.headers['x-forwarded-host']]
			.flatMap((value) => (Array.isArray(value) ? value : value ? String(value).split(',') : []))
			.map((value) => value.trim())
			.filter(Boolean);
		return hosts.includes(originUrl.host);
	} catch {
		return false;
	}
}

/**
 * 根目录下的静态壳资源（manifest、图标、robots 之类）。
 * 浏览器取 PWA 清单和图标按规范可以不带 Cookie（Chrome 默认 credentials mode = omit，
 * 除非 link 上写了 crossorigin="use-credentials"），所以这些路径必须放行，
 * 否则控制台会整天刷 `/manifest.webmanifest 401`，PWA 也装不上。它们本就不含任何私密内容。
 * 注意只认根目录：`/assets/*.js|css` 是应用本体，仍然要 Cookie。
 */
const PUBLIC_SHELL_FILE = /^\/[^/]+\.(webmanifest|svg|png|ico|txt)$/i;

export function authRequiredPath(pathname: string): boolean {
	if (pathname === '/api/health') return false;
	if (/^\/api\/cred\/[^/]+\/proxy$/.test(pathname)) return false;
	if (PUBLIC_SHELL_FILE.test(pathname)) return false;
	return true;
}

export function redirectWithoutToken(url: URL): string {
	const next = new URL(url.toString());
	next.searchParams.delete('token');
	return `${next.pathname}${next.search}`;
}

export function unauthorized(res: ServerResponse, api: boolean, message = '需要访问令牌') {
	if (api) {
		const payload = JSON.stringify({ error: message });
		res.writeHead(401, {
			'content-type': 'application/json; charset=utf-8',
			'cache-control': 'no-store',
		});
		res.end(payload);
		return;
	}
	const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>需要访问令牌</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1115;color:#e6e8ee;font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{width:min(420px,calc(100vw - 32px));padding:28px;border:1px solid #2a2f3a;border-radius:14px;background:#161a21}
h1{margin:0 0 8px;font-size:20px}p{margin:0 0 18px;color:#9aa3b2}
label{display:block;font-size:13px;color:#9aa3b2;margin-bottom:6px}
input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:1px solid #333a47;background:#0f1115;color:#e6e8ee}
button{margin-top:14px;width:100%;padding:10px 12px;border:0;border-radius:8px;background:#6ea8fe;color:#0b1220;font-weight:600;cursor:pointer}
small{display:block;margin-top:14px;color:#6f7888}
</style>
</head>
<body><main>
<h1>需要访问令牌</h1>
<p>请输入服务启动日志里的 token，或使用带 <code>?token=</code> 的完整链接。</p>
<form method="get" action="/">
<label for="token">访问令牌</label>
<input id="token" name="token" autocomplete="off" autofocus spellcheck="false">
<button type="submit">进入</button>
</form>
<small>日志：docker compose logs webchat | grep '\\[auth\\]'</small>
</main></body></html>`;
	res.writeHead(401, {
		'content-type': 'text/html; charset=utf-8',
		'cache-control': 'no-store',
		'referrer-policy': 'no-referrer',
	});
	res.end(html);
}
