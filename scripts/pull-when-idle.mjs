/**
 * 安全拉取：先 fetch，确认只影响非 watch 路径就直接快进；
 * 如果改了 server/**，等所有会话都不 busy，再快进，并验证 node --watch 真的重启了。
 *
 * 用法：
 *   node scripts/pull-when-idle.mjs [remote] [branch]
 *   node scripts/pull-when-idle.mjs --dry-run
 *   node scripts/pull-when-idle.mjs --force        # 服务不可达时跳过 idle 守卫（慎用）
 *
 * 为什么不能直接 git pull：
 *   server/ 在 node --watch 的监听路径里，pull 写文件会立即重启进程，
 *   正在生成的轮次会丢。这个脚本把“等空闲”放在“写文件”之前。
 *
 * 注意：不要在一个正在生成的会话里执行真正的拉取——脚本会检测到
 * PI_SESSION_ID 仍 busy 并拒绝，因为重启必然打断本轮。请从宿主机 shell 运行。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, readlinkSync, statSync, utimesSync } from 'node:fs';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((arg) => arg.startsWith('--')));
const positional = argv.filter((arg) => !arg.startsWith('--'));
const remote = positional[0] ?? 'origin';
const branch = positional[1] ?? 'main';
const dryRun = flags.has('--dry-run');
const force = flags.has('--force');

const base = process.env.PI_BASE_URL ?? 'http://127.0.0.1:44100';
const SELF = process.env.PI_SESSION_ID;
/** 与 server/auth.ts 的默认位置一致；宿主机和容器内都能找到。 */
const TOKEN_FILES = [
	process.env.PI_ACCESS_TOKEN_FILE,
	join(process.env.PI_RUNTIME_DIR ?? 'runtime', 'access-token'),
	'runtime/access-token',
]
	.filter(Boolean)
	.map((file) => resolve(file));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...args) => console.log(new Date().toISOString(), ...args);

let cookie = '';
let cookieTried = false;

function accessToken() {
	const fromEnv = process.env.PI_ACCESS_TOKEN?.trim();
	if (fromEnv) return fromEnv;
	for (const file of TOKEN_FILES) {
		try {
			const value = readFileSync(file, 'utf8').trim();
			if (value) return value;
		} catch {
			/* 试下一个位置 */
		}
	}
	return '';
}

/** 用 bootstrap token 换 Cookie；服务没开认证时返回空串。 */
async function ensureCookie(force = false) {
	if (cookie && !force) return cookie;
	if (cookieTried && !force) return cookie;
	cookieTried = true;
	const token = accessToken();
	if (!token) return cookie;
	try {
		const res = await fetch(`${base}/?token=${encodeURIComponent(token)}`, {
			redirect: 'manual',
			signal: AbortSignal.timeout(5000),
		});
		const raw = res.headers.getSetCookie?.()[0] ?? res.headers.get('set-cookie') ?? '';
		if (raw) cookie = raw.split(';')[0];
	} catch {
		/* 服务未就绪时保持无 Cookie，由调用方报错 */
	}
	return cookie;
}

function git(...args) {
	return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function childStarts() {
	const found = [];
	for (const pid of readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
		try {
			const comm = readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
			if (!comm.startsWith('node')) continue;
			const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
			if (cmd.includes('pull-when-idle') || cmd.includes('--watch-path')) continue;
			if (cmd.includes('server/index.ts')) {
				found.push(`${pid}:${readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ')[21]}`);
			}
		} catch {
			/* 进程可能刚退出 */
		}
	}
	return found.sort().join(',');
}

/** 找到 node --watch 父进程（容器内外 PID 可能不同，统一扫 /proc）。 */
function watcherPids() {
	const found = [];
	for (const pid of readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
		try {
			const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
			if (cmd.includes('--watch-path=./server')) found.push(pid);
		} catch {
			/* 进程可能刚退出 */
		}
	}
	return found;
}

/** 读 watcher 的 inotify watch 列表；git merge 换 inode 后，只有旧 inode 还在列表里。 */
function watchedInodes(pid) {
	const inodes = new Set();
	let fds = [];
	try {
		fds = readdirSync(`/proc/${pid}/fd`);
	} catch {
		return inodes;
	}
	for (const fd of fds) {
		try {
			if (!readlinkSync(`/proc/${pid}/fd/${fd}`).includes('inotify')) continue;
			const info = readFileSync(`/proc/${pid}/fdinfo/${fd}`, 'utf8');
			for (const match of info.matchAll(/ino:([0-9a-f]+)/g)) inodes.add(Number.parseInt(match[1], 16));
		} catch {
			/* fd 可能刚关闭 */
		}
	}
	return inodes;
}

/**
 * 选一个 watcher 当前真的在盯、且本次不会被覆盖的文件来 touch。
 * 固定 touch index.ts 在 git merge 换 inode 后会失效。
 */
function pickTouchTarget(changed) {
	let files = [];
	try {
		files = readdirSync('server')
			.filter((file) => file.endsWith('.ts'))
			.map((file) => `server/${file}`);
	} catch {
		return resolve('server/index.ts');
	}
	const candidates = files.filter((file) => !changed.includes(file));
	const inodes = new Set();
	for (const pid of watcherPids()) {
		for (const ino of watchedInodes(pid)) inodes.add(ino);
	}
	for (const file of candidates) {
		try {
			if (inodes.has(statSync(file).ino)) return resolve(file);
		} catch {
			/* 文件可能刚被删除 */
		}
	}
	for (const file of ['server/auth.ts', 'server/files.ts']) {
		if (candidates.includes(file)) return resolve(file);
	}
	return resolve(candidates[0] ?? 'server/index.ts');
}

async function fetchJson(path, ms = 3000) {
	const call = (value) =>
		fetch(`${base}${path}`, {
			headers: value ? { cookie: value } : {},
			signal: AbortSignal.timeout(ms),
		});
	let res = await call(await ensureCookie());
	if (res.status === 401) {
		cookie = '';
		res = await call(await ensureCookie(true));
	}
	if (!res.ok) {
		const hint =
			res.status === 401 ? '（需要访问令牌：检查 runtime/access-token 或 PI_ACCESS_TOKEN）' : '';
		throw new Error(`HTTP ${res.status}${hint}`);
	}
	return res.json();
}

async function busySessions() {
	const list = await fetchJson('/api/sessions');
	return (Array.isArray(list) ? list : (list.sessions ?? [])).filter((s) => s.busy);
}

async function waitIdle() {
	let lastLog = 0;
	for (;;) {
		let busy;
		try {
			busy = await busySessions();
		} catch (error) {
			if (force) {
				log('server unreachable, --force: skip idle guard', { error: String(error) });
				return;
			}
			throw new Error(
				`服务不可达（${base}）：${error instanceof Error ? error.message : String(error)}。确认没有会话后加 --force。`,
			);
		}
		if (!busy.length) {
			await sleep(3000);
			const again = await busySessions();
			if (!again.length) return;
			busy = again;
		}
		const selfBusy = SELF && busy.some((s) => s.id === SELF);
		if (selfBusy) {
			throw new Error(
				`当前会话 ${SELF} 正在生成中。重启会打断本轮，不能在这里执行；请在宿主机 shell 里运行，或等本轮结束。`,
			);
		}
		const now = Date.now();
		if (now - lastLog > 30_000) {
			lastLog = now;
			log('waiting for idle', { busy: busy.map((s) => s.id) });
		}
		await sleep(2000);
	}
}

// 1) fetch 只动 .git，不在 watch 路径里
log('fetching', { remote, branch });
execFileSync('git', ['fetch', remote, branch], { stdio: ['ignore', 'ignore', 'inherit'] });

const head = git('rev-parse', 'HEAD');
const target = git('rev-parse', 'FETCH_HEAD');
if (head === target) {
	log('already up to date', { head: head.slice(0, 8) });
	process.exit(0);
}

try {
	git('merge-base', '--is-ancestor', 'HEAD', target);
} catch {
	console.error(`不是快进：${head.slice(0, 8)} → ${target.slice(0, 8)}。请手动 merge/rebase 后再走本脚本。`);
	process.exit(1);
}

const changed = git('diff', '--name-only', 'HEAD', target).split('\n').filter(Boolean);
const watched = changed.filter((file) => file.startsWith('server/'));
log('incoming', {
	commits: Number(git('rev-list', '--count', `HEAD..${target}`)),
	files: changed.length,
	watched: watched.length,
});
if (watched.length) console.log(watched.map((f) => `  - ${f}`).join('\n'));

// 2.5) 只拒绝会被本次快进覆盖的本地修改；脚本自身和无关脏文件可以保留。
const dirty = git('diff', '--name-only', 'HEAD').split('\n').filter(Boolean);
const overlap = dirty.filter((file) => changed.includes(file));
if (overlap.length && !dryRun) {
	console.error('这些本地修改会被本次拉取覆盖，先处理：\n' + overlap.map((f) => `  - ${f}`).join('\n'));
	process.exit(1);
}
if (overlap.length) log('dry-run: overlapping dirty files, real pull would refuse', { files: overlap });

let busy = [];
try {
	busy = await busySessions();
} catch (error) {
	log('server unreachable', { error: String(error) });
}

if (dryRun) {
	log('dry-run: no changes applied', {
		busy: busy.map((s) => s.id),
		wouldWait: watched.length > 0 && busy.length > 0,
	});
	process.exit(0);
}

// 3) 只有 server/** 变化才需要 idle 守卫；纯 web/docs 随时可拉
if (watched.length) {
	if (busy.some((s) => s.id === SELF)) {
		console.error(`当前会话 ${SELF} 正在生成中，重启会打断本轮。请在宿主机 shell 运行本脚本。`);
		process.exit(1);
	}
	if (busy.length) log('waiting for idle before touching server/', { busy: busy.map((s) => s.id) });
	await waitIdle();
}

// 4) 快进。watched 有变化时，这里会触发 node --watch 重启
const before = watched.length ? childStarts() : '';
log('fast-forwarding', { to: target.slice(0, 8) });
execFileSync('git', ['merge', '--ff-only', target], { stdio: 'inherit' });

if (!watched.length) {
	log('pulled (no server/ changes, no restart needed)', { head: target.slice(0, 8) });
	process.exit(0);
}

// 5) 验证重启：watch 偶尔漏掉 mtime，touch 入口最多重试 3 次
let after = childStarts();
const touchTarget = pickTouchTarget(watched);
// 先给 watch 一点自然反应的时间（约 5s）：刚写完文件就 touch 会触发第二次重启，
// 健康检查撞在第二次重启的窗口上，会把成功误报成失败。
for (let tick = 0; after === before && tick < 10; tick += 1) {
	await sleep(500);
	after = childStarts();
}
for (let attempt = 1; after === before && attempt <= 3; attempt += 1) {
	log('watch did not react, touching watched file', { attempt, file: touchTarget, before, after });
	utimesSync(touchTarget, new Date(), new Date());
	for (let tick = 0; tick < 10 && after === before; tick += 1) {
		await sleep(500);
		after = childStarts();
	}
}
for (let tick = 0; after === before && tick < 30; tick += 1) {
	await sleep(500);
	after = childStarts();
}

if (!after || after === before) {
	console.error('重启未验证成功。请手动 docker compose restart webchat，并检查日志。');
	process.exit(1);
}

// 重启刚落地时端口会短暂拒连（fetch failed / ECONNREFUSED），单次探测必然误报。
try {
	let lastError = null;
	for (let attempt = 1; attempt <= 10; attempt += 1) {
		try {
			await fetchJson('/api/health', 5000);
			lastError = null;
			break;
		} catch (error) {
			lastError = error;
			if (attempt < 10) await sleep(1000);
		}
	}
	if (lastError) throw lastError;
} catch (error) {
	console.error(`进程已重启但健康检查失败：${String(error)}。请看日志。`);
	process.exit(1);
}

log('reloaded', { before, after, head: target.slice(0, 8) });
