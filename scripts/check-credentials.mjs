#!/usr/bin/env node
/**
 * 回归检查：凭据注入的请求头，必须是目标服务真能认出来的形状。
 *
 *   node scripts/check-credentials.mjs
 *
 * 为什么要这个：界面上「Header 前缀」清空后存的是**空字符串**，不是 undefined。
 * 早先这里用 `?? ` 判断，空串不回退，于是 bearer 类型会发出
 * `Authorization: <裸 token>` —— 服务端一律回 401 "Requires authentication"，
 * 报错看起来像 token 失效，实际是少了个 `Bearer `。实测踩过一次，所以锁死。
 */

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const { injectionFor } = await import(join(root, 'server/credentials.ts'));

const SECRET = 'TKN-123';
let passed = 0;
function ok(name, fn) {
	fn();
	passed += 1;
	console.log('ok  :', name);
}

/** 只跑注入函数，返回被塞进去的 headers 和（query 类型会改的）URL。 */
function inject(record, url = 'https://api.example.com/x') {
	const headers = {};
	const parsed = new URL(url);
	injectionFor(record, SECRET, headers, parsed);
	return { headers, url: parsed };
}

ok('bearer + 空前缀 → Bearer <token>', () => {
	const { headers } = inject({ kind: 'bearer', headerName: 'Authorization', headerPrefix: '' });
	assert.equal(headers.authorization, `Bearer ${SECRET}`);
});

ok('bearer + undefined 前缀 → Bearer <token>', () => {
	const { headers } = inject({ kind: 'bearer', headerName: 'Authorization' });
	assert.equal(headers.authorization, `Bearer ${SECRET}`);
});

ok('bearer + 显式前缀不被覆盖', () => {
	const { headers } = inject({ kind: 'bearer', headerName: 'Authorization', headerPrefix: 'token ' });
	assert.equal(headers.authorization, `token ${SECRET}`);
});

ok('bearer + 自定义 header 名也带前缀', () => {
	const { headers } = inject({ kind: 'bearer', headerName: 'X-Token', headerPrefix: '' });
	assert.equal(headers['x-token'], `Bearer ${SECRET}`);
	assert.equal(headers.authorization, undefined);
});

ok('api-key 没写 header 名 → X-API-Key，且不加前缀', () => {
	const { headers } = inject({ kind: 'api-key' });
	assert.equal(headers['x-api-key'], SECRET);
});

ok('basic → Basic base64(用户:密钥)', () => {
	const { headers } = inject({ kind: 'basic', username: 'u' });
	assert.equal(headers.authorization, `Basic ${Buffer.from(`u:${SECRET}`).toString('base64')}`);
});

ok('query → 写进 URL 参数，不动 headers', () => {
	const { headers, url } = inject({ kind: 'query', queryParam: 'access_token' });
	assert.equal(url.searchParams.get('access_token'), SECRET);
	assert.deepEqual(headers, {});
});

console.log(`\nok: ${passed} passed, 0 failed`);
