/**
 * 移动端 / 断点的浏览器验证（需要先启动 server，并有 chromium 或一个可连的 CDP 端点）。
 *
 *   npx playwright-core install chromium
 *   npm run build:web && npm start
 *   BASE_URL=http://127.0.0.1:44100 npm run smoke:mobile
 *
 * 如果本机没有 chromium，可以连一个已经开着的 Chrome：
 *   CDP_URL=http://bt-chrome:9222 npm run smoke:mobile
 * （连别人的浏览器时结束时只断开、不关闭它）
 *
 * 断言：390px 抽屉与抽屉内模块条；1024px 上下文列自动收起；
 * 1280 / 1440 的聊天区宽度与 rail 宽度；右栏抽屉与 Esc 关闭后的 inert 行为；
 * MCP 主操作按钮（组件库 primary）与旁边 ghost 按钮在 PC / 手机两套刻度下同高。
 */
import { chromium } from 'playwright-core';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:44100';
const CDP_URL = process.env.CDP_URL ?? '';
const failures = [];
const check = (condition, message) => {
	if (condition) console.log('ok  :', message);
	else {
		failures.push(message);
		console.error('FAIL:', message);
	}
};

let browser;
try {
	browser = CDP_URL ? await chromium.connectOverCDP(CDP_URL) : await chromium.launch();
} catch (error) {
	console.error(
		CDP_URL
			? `无法连接 CDP 端点 ${CDP_URL}，确认容器在跑且端口可达`
			: '无法启动 chromium，先执行：npx playwright-core install chromium',
	);
	console.error(String(error).split('\n')[0]);
	process.exit(1);
}

const isVisible = (rect, width) => Boolean(rect && rect.width > 0 && rect.left < width && rect.right > 0);
const panelRect = (page) =>
	page.evaluate(() => {
		const node = document.querySelector('#panel');
		if (!node) return null;
		const rect = node.getBoundingClientRect();
		return { left: rect.left, right: rect.right, width: rect.width, cls: node.className, inert: node.inert };
	});

// ---------- 移动端 ----------
{
	const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
	const errors = [];
	page.on('pageerror', (error) => errors.push(String(error)));
	await page.goto(BASE, { waitUntil: 'networkidle' });
	await page.waitForTimeout(400);

	check((await page.locator('#panel').count()) === 0, '移动端首屏不渲染右栏');
	check((await page.locator('#backdrop').isHidden()) === true, '移动端首屏没有遮罩');

	await page.click('#menu');
	await page.waitForSelector('.rail.open');
	await page.waitForTimeout(300);
	const rail = await page.evaluate(() => {
		const node = document.querySelector('.rail');
		const rect = node.getBoundingClientRect();
		return { left: rect.left, right: rect.right, width: rect.width, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth };
	});
	check(rail.left >= 0 && rail.right <= 390, `左侧抽屉不超出屏幕（${rail.width}px / 390px）`);
	check(rail.width <= 390 - 32, '左侧抽屉给遮罩留出可点击区域');
	check(rail.scrollWidth <= rail.clientWidth + 1, '左侧抽屉没有横向溢出');
	check((await page.locator('#rail-mods .rail-mods-btn').count()) === 4, '抽屉顶部有 4 个模块入口');
	check((await page.locator('.rail-nav').count()) === 0, '移动端不渲染常驻 icon rail');
	check((await page.locator('.rail-foot #rail-settings-toggle').count()) === 1, '设置入口只在抽屉底部出现一份');

	await page.click('#rail-mods .rail-mods-btn[data-module="skills"]');
	await page.waitForSelector('#module-placeholder');
	check((await page.locator('.rail.open').count()) === 0, '从模块条切模块后抽屉自动关上');
	check(page.url().endsWith('#/skills'), '模块条切换写回 hash');
	await page.click('#module-placeholder button');
	await page.waitForTimeout(300);
	check((await page.locator('.chat').count()) === 1, '占位页可以回到对话');
	await page.click('#menu');
	await page.waitForSelector('.rail.open');
	await page.waitForTimeout(250);
	await page.keyboard.press('Escape');
	await page.waitForTimeout(400);

	await page.click('#toggle-panel');
	await page.waitForSelector('#panel.open');
	await page.waitForTimeout(300);
	let rect = await panelRect(page);
	check(isVisible(rect, 390), '点击「右栏」后抽屉在视口内');
	check((await page.locator('.guide-card').count()) === 2, '抽屉打开时显示 Guide');
	await page.locator('.guide-card', { hasText: '沉淀' }).click();
	await page.waitForSelector('#sink-body');
	check((await page.locator('#sink-body .card').count()) > 0, 'Guide 可进入沉淀 tab');
	check(rect?.inert === false, '抽屉打开时不 inert');
	check((await page.locator('#backdrop').isVisible()) === true, '抽屉打开时显示遮罩');

	await page.keyboard.press('Escape');
	await page.waitForTimeout(400);
	rect = await panelRect(page);
	check(rect !== null, '关闭后抽屉实例保留（为了滑出动画）');
	check(!rect?.cls.includes('open'), '关闭后移除 open class');
	check(Boolean(rect?.inert), '关闭后 inert，焦点无法进入');
	check(!isVisible(rect, 390), '关闭后完全移出视口');

	await page.reload({ waitUntil: 'networkidle' });
	await page.waitForTimeout(400);
	check((await page.locator('#panel').count()) === 0, '刷新后重新回到默认关闭');
	check(errors.length === 0, `移动端无页面错误${errors.length ? `：${errors[0]}` : ''}`);
	await page.close();
}

// ---------- 桌面端回归 ----------
const chatWidth = (page) => page.evaluate(() => document.querySelector('.chat')?.getBoundingClientRect().width ?? 0);
const railWidth = (page) => page.evaluate(() => document.querySelector('.rail-nav')?.getBoundingClientRect().width ?? 0);

{
	const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
	await page.goto(BASE, { waitUntil: 'networkidle' });
	await page.waitForTimeout(400);
	const rect = await panelRect(page);
	check(isVisible(rect, 1280), '桌面端右栏仍然常驻');
	check((await railWidth(page)) >= 48 && (await railWidth(page)) <= 64, `模块 rail 宽 56px（实测 ${await railWidth(page)}px）`);
	check((await page.locator('.rail').count()) === 1, '1280px 默认展开会话列表');
	const wide = await chatWidth(page);
	check(wide >= 560, `1280px 聊天区不被打穿（实测 ${Math.round(wide)}px）`);
	await page.click('#toggle-panel');
	await page.waitForTimeout(300);
	check((await page.locator('.app.no-panel').count()) === 1, '桌面端点「右栏」折叠右栏');
	await page.close();
}

// ---------- 窄屏桌面（<1180）：上下文列自动收起 ----------
{
	const page = await browser.newPage({ viewport: { width: 1024, height: 800 } });
	await page.goto(BASE, { waitUntil: 'networkidle' });
	await page.waitForTimeout(400);
	check((await page.locator('.app.ctx-collapsed').count()) === 1, '1024px 默认收起会话列表');
	check((await page.locator('.rail').count()) === 0, '收起时上下文列不渲染');
	const narrow = await chatWidth(page);
	check(narrow >= 520, `1024px 聊天区保持可用（实测 ${Math.round(narrow)}px）`);
	await page.click('.rail-nav-btn[data-module="chat"]');
	await page.waitForSelector('.rail');
	await page.waitForTimeout(250);
	check((await page.locator('.app.ctx-collapsed').count()) === 0, '点对话图标可以手动展开');
	await page.close();
}

// ---------- 宽屏（≥1440）：四列全开 ----------
{
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	await page.goto(BASE, { waitUntil: 'networkidle' });
	await page.waitForTimeout(400);
	check((await page.locator('.rail').count()) === 1, '1440px 上下文列常驻');
	const ctx = await page.evaluate(() => document.querySelector('.rail')?.getBoundingClientRect().width ?? 0);
	check(ctx >= 200 && ctx <= 260, `上下文列约 248px（实测 ${Math.round(ctx)}px）`);
	const wide = await chatWidth(page);
	check(wide >= 600, `1440px 聊天区足够宽（实测 ${Math.round(wide)}px）`);
	await page.close();
}

// ---------- MCP 主按钮不能比旁边的 ghost 按钮大一圈 ----------
// 组件库的 primary 按钮一度用的是 shadcn 默认刻度（14px 字 / px-4 / py-2），
// PC 上比 app.css 的 .ghost 高 7px；≤980px 时 .ghost 会加大，比例才勉强对上。
for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
	const page = await browser.newPage({ viewport });
	await page.goto(`${BASE}/#/mcp`, { waitUntil: 'networkidle' });
	await page.waitForSelector('.mcp-head-actions button');
	const sizes = await page.evaluate(() =>
		[...document.querySelectorAll('.mcp-head-actions button')].map((el) => ({
			text: el.textContent.trim(),
			height: Math.round(el.getBoundingClientRect().height),
			primary: el.className.includes('tw-bg-primary'),
		})),
	);
	const heights = sizes.map((item) => item.height);
	const detail = sizes.map((item) => `${item.text}=${item.height}px`).join(' / ');
	check(sizes.some((item) => item.primary), `${viewport.width}px：MCP 顶部有组件库主按钮`);
	check(Math.max(...heights) - Math.min(...heights) <= 1, `${viewport.width}px：主按钮与 ghost 按钮同高（${detail}）`);
	await page.close();
}

// 连外部浏览器时只断开，不要把人家的 Chrome 关掉
if (!CDP_URL) await browser.close();
console.log(failures.length ? `\n${failures.length} failure(s)` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
