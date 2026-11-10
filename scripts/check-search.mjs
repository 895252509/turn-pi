#!/usr/bin/env node
/**
 * 联网搜索/抓取的离线回归检查。
 *
 * 不连外网：用假的 globalThis.fetch 顶掉 provider 请求，只验证我们自己的逻辑——
 *   - provider 归一化、去重、站点评分、条数上限
 *   - 缓存命中与失败分类（401 / 429 / 空结果）
 *   - 每会话限流
 *   - web_fetch 的 SSRF 拒绝（私网字面量、localhost、DNS 结果里混私有地址）
 *   - HTML → 文本的骨架提取
 *
 *   node scripts/check-search.mjs
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = await mkdtemp(join(tmpdir(), 'pi-search-check-'));
process.env.PI_RUNTIME_DIR = join(root, 'runtime');
process.env.PI_SEARCH_PROVIDERS = 'tavily';
process.env.TAVILY_API_KEY = 'test-key-not-real';
process.env.PI_SEARCH_MAX_PER_10MIN = '3';

let failed = 0;
let passed = 0;
function check(name, condition, detail = '') {
	if (condition) {
		passed += 1;
		process.stdout.write(`  ok  ${name}\n`);
		return;
	}
	failed += 1;
	process.stdout.write(`FAIL  ${name}${detail ? ` — ${detail}` : ''}\n`);
}

const favorites = [];
globalThis.fetch = async (url, init) => {
	favorites.push({ url: String(url), init });
	return new Response(
		JSON.stringify({
			results: [
				{
					title: 'First result',
					url: 'https://Example.com/doc/?utm_source=feed',
					content: 'alpha '.repeat(400),
					score: 0.9,
				},
				{ title: 'Duplicate', url: 'https://example.com/doc', content: 'same page via mirror' },
				{ title: 'Blocked domain', url: 'https://spam.example.net/x', content: 'nope' },
				{ title: 'Second result', url: 'https://docs.example.org/b', content: 'beta' },
			],
		}),
		{ status: 200, headers: { 'content-type': 'application/json' } },
	);
};

const serverDir = join(resolve(fileURLToPath(new URL('..', import.meta.url))), 'server');
const search = await import(join(serverDir, 'search.ts'));
const fetchMod = await import(join(serverDir, 'fetch.ts'));

process.stdout.write('\n[search]\n');
const first = await search.searchWeb({ query: 'alpha beta', count: 5, excludeDomains: ['spam.example.net'] });
check('返回条数受 count 约束', first.hits.length === 2, `got ${first.hits.length}`);
check('UTM 参数被规范化后去重', first.hits.filter((h) => h.url.includes('example.com/doc')).length === 1);
check('excludeDomains 生效', !first.hits.some((h) => h.url.includes('spam.example.net')));
check('snippet 被截断', first.hits[0].snippet.length <= 321, `len=${first.hits[0].snippet.length}`);
check('provider 标记正确', first.provider === 'tavily');
check('首次请求不是缓存', first.cached === false);

const second = await search.searchWeb({ query: 'alpha beta', count: 5, excludeDomains: ['spam.example.net'] });
check('相同查询命中缓存', second.cached === true);
check('缓存没有多发请求', favorites.length === 1, `requests=${favorites.length}`);

const callsBefore = favorites.length;
const rate = [];
for (let i = 0; i < 4; i += 1) {
	try {
		await search.searchWeb({ query: `unique-${i}`, sessionId: 'sess-A' });
		rate.push('ok');
	} catch (error) {
		rate.push(error instanceof search.SearchError ? error.code : 'unknown');
	}
}
check('每会话限流触发', rate.includes('rate'), JSON.stringify(rate));
check('限流前仍放行了 3 次', rate.filter((r) => r === 'ok').length === 3, JSON.stringify(rate));
check('限流不计请求数以外的失败', favorites.length >= callsBefore);

const rendered = search.renderSearchHits(first);
check('渲染带 URL', rendered.includes('https://example.com/doc'));
check('渲染带不可信声明', rendered.includes('第三方网页内容'));

globalThis.fetch = async () => new Response('invalid key', { status: 401 });
let authCode = '';
try {
	await search.searchWeb({ query: 'auth probe' });
} catch (error) {
	authCode = error.code;
}
check('401 归类为 auth', authCode === 'auth', authCode);

globalThis.fetch = async () => new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
const empty = await search.searchWeb({ query: 'nothing here' });
check('空结果保留 hits=0', empty.hits.length === 0);
check('空结果带说明', typeof empty.degraded === 'string' && empty.degraded.includes('0 条'));

process.stdout.write('\n[fetch]\n');
const blocked = [
	'http://127.0.0.1/',
	'http://localhost:8080/',
	'http://169.254.169.254/latest/meta-data/',
	'http://10.1.2.3/',
	'http://[::1]/',
	'http://[fd00::1]/',
	'http://metadata.google.internal/computeMetadata/v1/',
	'file:///etc/passwd',
	'http://user:pass@example.com/',
];
for (const url of blocked) {
	let code = '';
	try {
		await fetchMod.fetchReadable(url);
	} catch (error) {
		code = error.code;
	}
	check(`拒绝 ${url}`, Boolean(code), '没有抛错');
}

const html = '<html><head><title>T &amp; A</title><style>x{}</style></head><body><nav>menu</nav><h1>Title</h1><p>Hello&nbsp;world</p><script>alert(1)</script><li>one</li></body></html>';
const parsed = fetchMod.htmlToText(html);
check('提取 title', parsed.title === 'T & A', parsed.title);
check('去掉 script/style/nav', !/alert|menu|x\{\}/.test(parsed.text), parsed.text);
check('段落换行与实体解码', parsed.text.includes('Hello world') && parsed.text.includes('Title'));

const addresses = [
	['8.8.8.8', false],
	['172.32.0.1', false],
	['172.16.0.1', true],
	['192.168.1.1', true],
	['100.64.0.1', true],
	['::ffff:127.0.0.1', true],
	['::ffff:7f00:1', true],
	['::ffff:a00:1', true],
	['0:0:0:0:0:0:0:1', true],
	['fec0::1', true],
	['2002:7f00:1::', true],
	['64:ff9b::7f00:1', true],
	['2001:0000::1', true],
	['100::1', true],
	['2001:db8::1', true],
	['::ffff:8.8.8.8', false],
	['2002:808:808::', false],
	['64:ff9b::808:808', false],
];
for (const [ip, shouldBlock] of addresses) {
	const reason = fetchMod.blockedAddressReason(ip);
	check(`${ip} ${shouldBlock ? '应拒绝' : '应放行'}`, Boolean(reason) === shouldBlock, reason ?? 'allowed');
}

process.stdout.write('\n[fetch policy]\n');
const deniedPolicy = { redirects: 'same-origin', allow: [], deny: ['example.com'] };
check(
	'deny 命中主域',
	Boolean(fetchMod.domainPolicyReason('example.com', deniedPolicy)),
);
check(
	'deny 命中子域',
	Boolean(fetchMod.domainPolicyReason('api.example.com', deniedPolicy)),
);
check(
	'deny 不误伤相似域',
	!fetchMod.domainPolicyReason('notexample.com', deniedPolicy),
);
const allowPolicy = { redirects: 'any', allow: ['docs.example.org'], deny: [] };
check('allow 命中子域', !fetchMod.domainPolicyReason('a.docs.example.org', allowPolicy));
check('allow 拒绝名单外', Boolean(fetchMod.domainPolicyReason('example.com', allowPolicy)));
check(
	'same-origin 同意',
	!fetchMod.redirectPolicyReason(new URL('https://a.com/x'), new URL('https://a.com/y'), 'same-origin'),
);
check(
	'same-origin 跨源拒绝',
	Boolean(fetchMod.redirectPolicyReason(new URL('https://a.com/x'), new URL('https://b.com/y'), 'same-origin')),
);
check(
	'same-origin 跨协议拒绝',
	Boolean(fetchMod.redirectPolicyReason(new URL('http://a.com/x'), new URL('https://a.com/x'), 'same-origin')),
);
check(
	'any 不限跳转',
	!fetchMod.redirectPolicyReason(new URL('https://a.com/x'), new URL('https://b.com/y'), 'any'),
);
let domainCode = '';
try {
	await fetchMod.fetchReadable('https://blocked.example.com/page', { policy: deniedPolicy });
} catch (error) {
	domainCode = error.code;
}
check('domain 策略在 DNS 之前生效', domainCode === 'domain', domainCode);
process.env.PI_FETCH_DENY_DOMAINS = 'example.com';
check(
	'env 中的 deny 名单被读到',
	Boolean(fetchMod.domainPolicyReason('example.com', fetchMod.loadFetchPolicy())),
);
delete process.env.PI_FETCH_DENY_DOMAINS;
process.env.PI_FETCH_REDIRECTS = 'same-origin';
check('env 中的 same-origin 被读到', fetchMod.loadFetchPolicy().redirects === 'same-origin');
delete process.env.PI_FETCH_REDIRECTS;

process.stdout.write('\n[content store]\n');
const store = await import(join(serverDir, 'content-store.ts'));
const body = `${'x'.repeat(500)}ALPHA marker one ${'y'.repeat(300)}BETA marker two ${'z'.repeat(3000)}`;
const saved = store.storeFetchedContent({
	sessionId: 'sess-A',
	url: 'https://example.com/doc',
	title: 'Doc',
	contentType: 'text/html',
	text: body,
	bytes: body.length,
});
check('保存返回 contentId', /^c_[0-9a-f]{10}$/.test(saved.id), saved.id);
check('保存记录了全文长度', saved.totalChars === body.length);

const page1 = store.pageFetchedContent(saved.id, 'sess-A', { offset: 0, limit: 400 });
check('分页长度受 limit 约束', page1.text.length === 400, `len=${page1.text.length}`);
check('分页给出 nextOffset', page1.nextOffset === 400, String(page1.nextOffset));
const page2 = store.pageFetchedContent(saved.id, 'sess-A', { offset: page1.nextOffset });
check('续读从 nextOffset 开始', page2.text.startsWith(body.slice(400, 410)), page2.text.slice(0, 20));
check('越界 offset 被夹住', store.pageFetchedContent(saved.id, 'sess-A', { offset: 10 ** 9 }).offset === body.length);

const found = store.findFetchedContent(saved.id, 'sess-A', ['ALPHA', 'beta']);
check('findText 两个关键词都命中', found.matches.length === 2, String(found.matches.length));
check('findText 大小写不敏感', found.matches.some((m) => m.context.includes('BETA marker two')));
check('findText 给出偏移量', found.matches[0].offset > 400 && found.matches[0].offset < 600, String(found.matches[0].offset));
check('findText 未命中返回空', store.findFetchedContent(saved.id, 'sess-A', ['zzz-not-there']).matches.length === 0);
check('findText 不做正则注入', store.findFetchedContent(saved.id, 'sess-A', ['A.*T']).matches.length === 0);

check('跨会话读不到', store.getFetchedContent(saved.id, 'sess-B') === undefined);
check('错误的 contentId 读不到', store.getFetchedContent('c_deadbeef00', 'sess-A') === undefined);
const pageText = store.renderContentPage(page1);
check('分页渲染带 contentId', pageText.includes(saved.id));
check('分页渲染带续读提示', pageText.includes('read_fetched'));
check('会话清理只删自己的', store.forgetSessionContent('sess-A') === 1 && store.getFetchedContent(saved.id, 'sess-A') === undefined);

process.stdout.write('\n[provider allowlist]\n');
process.env.PI_SEARCH_ALLOWED_PROVIDERS = 'tavily';
let providerCode = '';
try {
	await search.searchWeb({ query: 'escape hatch', provider: 'brave' });
} catch (error) {
	providerCode = error.code;
}
check('越权指定 provider 被拒', providerCode === 'provider', providerCode);
const allowedSearch = await search.searchWeb({ query: 'allowed provider', provider: 'tavily' });
check('白名单内的 provider 可用', allowedSearch.provider === 'tavily');
const statusWithAllow = await search.searchStatus();
check('状态里暴露 allowed', Array.isArray(statusWithAllow.allowed) && statusWithAllow.allowed.join(',') === 'tavily');
delete process.env.PI_SEARCH_ALLOWED_PROVIDERS;
check('去掉白名单后不限', (await search.searchStatus()).allowed === undefined);

process.stdout.write('\n[exa mcp]\n');
const sseBody = [
	'event: message',
	'data: {"result":{"content":[{"type":"text","text":"Title: A page\\nURL: https://example.com/a\\nPublished: 2025-01-02T00:00:00.000Z\\nAuthor: X\\nHighlights:\\nfirst hit body\\n\\n---\\n\\nTitle: B page\\nURL: https://example.org/b\\nPublished: N/A\\nHighlights:\\nsecond hit"}]}}',
].join('\n');
const parsedMcp = search.parseExaMcpResponse(sseBody);
check('SSE 解析出两条', parsedMcp.hits.length === 2, String(parsedMcp.hits.length));
check('Highlights 变成 snippet', parsedMcp.hits[0].snippet.includes('first hit body'));
check('N/A 发布时间被丢掉', parsedMcp.hits[1].publishedAt === undefined);
check('provider 标记为 exa-mcp', parsedMcp.hits[0].provider === 'exa-mcp');
check('错误响应被识别', Boolean(search.parseExaMcpResponse('data: {"error":{"message":"rate limited"}}').error));
const jsonOnly = JSON.stringify({
	result: { content: [{ type: 'text', text: 'Title: C\nURL: https://example.net/c\nHighlights:\nplain json' }] },
});
check('纯 JSON（非 SSE）也能解析', search.parseExaMcpResponse(jsonOnly).hits.length === 1);
check('没有 URL 的块被丢掉', search.parseExaResultBlocks('Title: no url\nHighlights: x').length === 0);
const naBlock = search.parseExaResultBlocks('Title: N/A\nURL: https://example.net/na\nPublished: N/A\nHighlights:\nbody');
check('Title 为 N/A 时回退成 URL', naBlock[0].title === 'https://example.net/na', naBlock[0].title);

process.env.PI_SEARCH_PROVIDERS = 'exa-mcp';
const fetchBefore = globalThis.fetch;
globalThis.fetch = async () =>
	new Response(sseBody, { status: 200, headers: { 'content-type': 'text/event-stream' } });
const mcpSearch = await search.searchWeb({ query: 'mcp probe ' + Date.now(), count: 2 });
check('exa-mcp 走通 searchWeb', mcpSearch.provider === 'exa-mcp' && mcpSearch.hits.length === 2, mcpSearch.provider);
globalThis.fetch = async () => new Response('data: {"error":{"message":"rate limited"}}', { status: 200 });
let mcpErr = '';
try {
	await search.searchWeb({ query: 'mcp rate ' + Date.now() });
} catch (error) {
	mcpErr = error.code;
}
check('exa-mcp 限流归类为 rate', mcpErr === 'rate', mcpErr);
globalThis.fetch = fetchBefore;
delete process.env.PI_SEARCH_PROVIDERS;

process.stdout.write('\n[readability]\n');
const para = (text, times) => `<p>${text.repeat(times)}</p>`;
const articleHtml =
	'<!doctype html><html><head><title>Guide to Widgets</title></head><body>' +
	'<nav><a href="/">Home</a><a href="/login">Sign in</a></nav>' +
	'<aside>Related reading: top ten</aside>' +
	'<div id="content"><article><h1>Guide to Widgets</h1>' +
	para('Widgets are small reusable components. ', 10) +
	para('Install them from the registry with the widgets package. ', 10) +
	'<pre><code>widgets --save</code></pre>' +
	'</article></div>' +
	'<footer>© 2026 Example Ltd</footer><script>alert(1)</script></body></html>';
const extracted = await fetchMod.extractReadable(articleHtml, 'https://example.com/docs/widgets');
check('Readability 被选中', extracted.source === 'readability', extracted.source);
check('保留正文', extracted.text.includes('Widgets are small reusable components'));
check('丢掉 nav', !extracted.text.includes('Sign in'));
check('丢掉 aside', !extracted.text.includes('Related reading'));
check('丢掉 footer', !extracted.text.includes('Example Ltd'));
check('丢掉 script', !extracted.text.includes('alert(1)'));
check('抽出标题', extracted.title === 'Guide to Widgets', String(extracted.title));
check('段落之间保留换行', extracted.text.includes('\n'), JSON.stringify(extracted.text.slice(0, 60)));
check('代码块文字保留', extracted.text.includes('widgets --save'));

const shortPage = await fetchMod.extractReadable('<html><body><p>hi</p><nav>menu</nav></body></html>');
check('短页面回退到正则', shortPage.source === 'fallback', shortPage.source);
check('回退仍然给出文本', shortPage.text.includes('hi'));
const brokenHtml = await fetchMod.extractReadable('<<<not really html>>>');
check('坏 HTML 不抛错', typeof brokenHtml.text === 'string');
check('坏 HTML 有 source', brokenHtml.source === 'fallback' || brokenHtml.source === 'readability');

// 审计是串行追加写，先让队列落地再删临时目录
await new Promise((r) => setTimeout(r, 100));
await rm(root, { recursive: true, force: true });
process.stdout.write(`\n${failed ? 'FAILED' : 'ok'}: ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
