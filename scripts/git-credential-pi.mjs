#!/usr/bin/env node
/**
 * git credential helper：用 Turn Pi 的租约换 Gitea token。
 *
 * 用法（git 会自己调用 `get`）：
 *   PI_CRED_LEASE=cr_... PI_BASE_URL=http://127.0.0.1:44100 \
 *   git -c credential.helper='!node scripts/git-credential-pi.mjs' \
 *     push origin HEAD
 *
 * helper 路径相对当前 checkout；服务端不硬编码宿主路径。
 *
 * 为什么需要它：
 *   scoped 凭据的 HTTP 代理承载不了 git 智能 HTTP（路径和 x-pi-target 都不匹配）。
 *   helper 只把 token 交给 git 子进程，不写进工具结果/会话记录；服务端按租约、
 *   host 和 *:git:* scope 校验，并写 `git-credential` 审计。
 */
import { readFileSync } from 'node:fs';

const operation = process.argv[2] ?? '';
if (operation !== 'get') process.exit(0);

const lease = process.env.PI_CRED_LEASE?.trim();
if (!lease) {
	process.stderr.write('PI_CRED_LEASE is required\n');
	process.exit(1);
}

const base = (process.env.PI_BASE_URL ?? 'http://127.0.0.1:44100').replace(/\/+$/, '');
const input = {};
for (const line of readFileSync(0, 'utf8').split('\n')) {
	const index = line.indexOf('=');
	if (index > 0) input[line.slice(0, index)] = line.slice(index + 1);
}

try {
	const res = await fetch(`${base}/api/cred/${encodeURIComponent(lease)}/git-credential`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ protocol: input.protocol, host: input.host }),
	});
	if (!res.ok) {
		process.stderr.write((await res.text()).trim() + '\n');
		process.exit(1);
	}
	const { username, password } = await res.json();
	if (!username || !password) process.exit(1);
	process.stdout.write(`username=${username}\npassword=${password}\n`);
} catch (error) {
	process.stderr.write(String(error) + '\n');
	process.exit(1);
}
