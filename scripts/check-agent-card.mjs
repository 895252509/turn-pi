/**
 * 回归检查：每个 AgentTemplate（CARD.md）声明的工具必须真的存在。
 *
 *   node scripts/check-agent-card.mjs            # 检查 runtime/ 下的所有模板
 *   node scripts/check-agent-card.mjs --fix-tools # 顺手把未注册的工具从 CARD 里删掉
 *
 * 为什么需要它：CARD 是手写的，工具名是代码里注册的，两者能静默分叉 ——
 * `runtime/mainAgent/CARD.md` 就声明过 dispatch/send/status/remember 四个不存在的工具。
 * 那时候没有任何地方会报错：会话照旧用环境默认工具集跑，看起来一切正常。
 *
 * 退出码：有未注册工具 / 模板结构错误 → 1。
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const runtime = process.env.PI_RUNTIME_DIR ?? join(root, 'runtime');
const agentsDir = process.env.PI_AGENTS_DIR ?? join(runtime, 'agents');
const mainDir = process.env.PI_MAIN_AGENT_DIR ?? join(runtime, 'mainAgent');

const { parseFrontmatter } = await import('@earendil-works/pi-coding-agent');
// 只读注册表，不建会话：这里要能在没有模型/凭据的 CI 里跑。
const { TOOLS } = await import(join(root, 'server/chat.ts'));

const PINNED = ['cred_list', 'cred_use'];

async function cardFiles() {
	const files = [];
	const main = join(mainDir, 'CARD.md');
	try {
		await readFile(main, 'utf8');
		files.push(main);
	} catch {
		/* 没有 mainAgent 的部署也合法 */
	}
	let entries = [];
	try {
		entries = await readdir(agentsDir, { withFileTypes: true });
	} catch {
		/* 没有 agents 目录 = 没有模板 */
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		files.push(join(agentsDir, entry.name, 'CARD.md'));
	}
	return files;
}

const asList = (value) => {
	const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
	return raw.map((item) => String(item).trim()).filter(Boolean);
};

const problems = [];
const known = new Set(TOOLS);
for (const file of await cardFiles()) {
	let text;
	try {
		text = await readFile(file, 'utf8');
	} catch {
		problems.push({ file, message: '目录存在但没有 CARD.md' });
		continue;
	}
	const { frontmatter } = parseFrontmatter(text);
	const id = String(frontmatter.id ?? '').trim();
	if (!id) problems.push({ file, message: 'CARD 缺少 id' });

	// `dispatch: true`（YAML 里会被解析成 boolean）是最容易写错的一种：工具是字符串列表。
	const toolsValue = frontmatter.tools;
	const tools = asList(toolsValue);
	if (toolsValue != null && !Array.isArray(toolsValue) && typeof toolsValue !== 'string') {
		problems.push({ file, message: `tools 不是列表：${JSON.stringify(toolsValue)}` });
	}
	for (const name of tools) {
		if (known.has(name) || PINNED.includes(name)) continue;
		problems.push({ file, message: `工具 ${name} 未注册（PI_TOOLS 里没有，也不是内置工具）` });
	}

	if (!tools.length) problems.push({ file, message: 'tools 为空：这个模板建出来的会话没有工具' });
	const kind = String(frontmatter.kind ?? '');
	if (!['base', 'domain', 'variant', 'orchestrator'].includes(kind)) {
		problems.push({ file, message: `kind 不合法：${kind || '(空)'}` });
	}
	const model = String(frontmatter.model ?? '').trim();
	if (!model) problems.push({ file, message: 'model 为空：会静默回落到环境默认模型' });

	const label = id || file;
	if (tools.length) console.log(`${label.padEnd(24)} kind=${kind.padEnd(12)} tools=${tools.join(',')}`);
}

if (problems.length) {
	console.error(`\n${problems.length} 个问题：`);
	for (const problem of problems) console.error(`  ${problem.file}\n    ${problem.message}`);
	process.exit(1);
}
console.log('\nCARD 与工具注册表一致');
