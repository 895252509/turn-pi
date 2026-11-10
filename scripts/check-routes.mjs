#!/usr/bin/env node
// 前端 ↔ 后端端点契约检查。
//
// 起因（2026-11-10 两次事故）：turn-pi 页面里的 agent 工作目录就是本项目，它做重构时
// 把 server/index.ts 里的 POST /api/chat 整段删了，前端还在调，请求落进末尾兜底
//   if (req.method === 'GET') return serveStatic(res, path);
//   return json(res, 405, { error: 'method not allowed' });
// 页面于是只显示「发送失败：method not allowed」。这类破坏完全是静态可查的：
// 前端引用的 /api 路径，后端必须有对应路由。make check 以前只做语法检查，抓不到。
//
// 检查两件事：
//   1. web/src 里出现的每个 /api 路径，server 里都要有精确路由或前缀路由；
//   2. CRITICAL 里的核心端点必须存在（聊天主链路，删了页面直接不能用）。
//
// 三种引用形态都要认：
//   '/api/chat'                        精确
//   `/api/files/${endpoint}`           模板拼接 → 按前缀 /api/files/ 校验
//   '/api/files/raw?root=x'           带查询串 → 截到 ? 之前
// 服务端用 path.match(/^\/api\/session\/.../) 声明的正则也算前缀路由。

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const WEB_DIR = join(ROOT, 'web', 'src');
const SERVER_DIR = join(ROOT, 'server');

/** 聊天主链路：少一个页面就残，必须显式存在。 */
const CRITICAL = [
	['/api/chat', '发消息的主入口，删了页面只会显示「发送失败」'],
	['/api/abort', '停止生成'],
	['/api/queue/update', '生成中排队/插话'],
	['/api/queue/clear', '清空队列'],
	['/api/events', 'SSE 订阅，删了界面不更新'],
	['/api/health', '健康检查与容器探活'],
];

/**
 * 不是本项目后端的路径：`/api/v1/repos/` 是凭据表单里"路径前缀"的占位符示例，
 * 指的是被代理的外部 API，不由 server/index.ts 提供。
 */
const IGNORE = [/^\/api\/v1\//];

function walk(dir, exts, out = []) {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
			walk(full, exts, out);
		} else if (exts.some((ext) => entry.name.endsWith(ext))) {
			out.push(full);
		}
	}
	return out;
}

/** 前端引用：字面量 /api/...，在 $ ? 引号反引号空白处截断；保留尾斜杠（模板前缀）。 */
function frontendPaths() {
	const found = new Map();
	for (const file of walk(WEB_DIR, ['.ts', '.tsx'])) {
		const lines = readFileSync(file, 'utf8').split('\n');
		lines.forEach((line, index) => {
			const re = /['"`](\/api\/[^'"`$?\s]*)/g;
			let match;
			while ((match = re.exec(line))) {
				const raw = match[1];
				const path = raw.endsWith('/') ? raw : raw.replace(/\/+$/, '');
				if (!path || path === '/api') continue;
				if (IGNORE.some((pattern) => pattern.test(path))) continue;
				if (!found.has(path)) found.set(path, []);
				found.get(path).push(relative(ROOT, file) + ':' + (index + 1));
			}
		});
	}
	return found;
}

/** 收一条前缀路由；`/api` 这种只剩一层的太泛，会把护栏变成"永远通过"。 */
function addPrefix(prefixes, raw) {
	const prefix = String(raw).replace(/\/+$/, '');
	if (!prefix.startsWith('/api/')) return;
	if (prefix.split('/').filter(Boolean).length < 2) return;
	prefixes.add(prefix);
}

/** 后端路由：精确、前缀、正则三种声明方式（前缀统一去掉尾斜杠再比较）。 */
function serverRoutes() {
	const exact = new Set();
	const prefixes = new Set();
	for (const file of walk(SERVER_DIR, ['.ts'])) {
		const text = readFileSync(file, 'utf8');
		for (const match of text.matchAll(/path\s*===\s*['"`](\/api\/[^'"`$?\s]*)['"`]/g)) {
			exact.add(match[1].replace(/\/+$/, ''));
		}
		for (const match of text.matchAll(/path\s*\.startsWith\(\s*['"`](\/api\/[^'"`$?\s]*)/g)) {
			// 至少 `/api/xxx` 两级才算路由前缀：`path.startsWith('/api/')` 是鉴权/统计判据，
			// 不是路由，收进来看似更宽松，实际会把任何 /api 路径都判成"有后端"，护栏就失效了。
			addPrefix(prefixes, match[1]);
		}
		// path.match(/^\/api\/session\/([^/]+)\/skills\/apply$/) → 前缀 /api/session
		for (const match of text.matchAll(/path\s*\.match\(\s*\/\^(.+?)\$?\/[a-z]*\)/g)) {
			const raw = match[1].replace(/\\\//g, '/');
			const cut = raw.search(/[\(\[]/);
			const prefix = cut >= 0 ? raw.slice(0, cut) : raw;
			addPrefix(prefixes, prefix);
		}
	}
	return { exact, prefixes };
}

/**
 * F 可能是精确路径，也可能是模板前缀（以 / 结尾）。
 * 精确：等于某条精确路由，或落在某条前缀路由之下。
 * 模板前缀：某条精确/前缀路由在它之下（或正好是它）。
 */
function covered(path, { exact, prefixes }) {
	const templated = path.endsWith('/');
	const target = templated ? path.slice(0, -1) : path;
	if (exact.has(target)) return true;
	for (const prefix of prefixes) {
		if (target === prefix || target.startsWith(prefix + '/')) return true;
		if (templated && prefix.startsWith(target + '/')) return true;
	}
	return false;
}

const front = frontendPaths();
const routes = serverRoutes();
const missing = [];
for (const [path, where] of front) {
	if (!covered(path, routes)) missing.push({ path, where });
}
const missingCritical = CRITICAL.filter(([path]) => !covered(path, routes));

let failed = false;
if (missing.length) {
	failed = true;
	console.error('前端调用但后端没有对应路由：');
	for (const item of missing.sort((a, b) => a.path.localeCompare(b.path))) {
		console.error('  ✗ ' + item.path + '   被引用 ' + item.where.length + ' 处：' + item.where.slice(0, 3).join(', '));
	}
	console.error('');
	console.error('  页面会拿到 405 method not allowed（落进 server/index.ts 末尾兜底）。');
}
if (missingCritical.length) {
	failed = true;
	console.error('核心端点缺失：');
	for (const [path, why] of missingCritical) console.error('  ✗ ' + path + '   ' + why);
}

if (failed) {
	console.error('');
	console.error('前后端契约对不上。要么把后端路由补回来，要么同步改前端调用点。');
	process.exit(1);
}
console.log(
	'ok: ' + front.size + ' 个前端 /api 路径都能在后端路由表里找到（' +
	routes.exact.size + ' 条精确 + ' + routes.prefixes.size + ' 条前缀）',
);
