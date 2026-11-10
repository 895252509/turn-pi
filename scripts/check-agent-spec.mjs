/**
 * 回归检查：AgentSpec 翻译出来的装载结果，必须与现有路径**逐字节相同**。
 *
 *   node scripts/check-agent-spec.mjs            # 纯映射 + 逐字节对比
 *   node scripts/check-agent-spec.mjs --offline  # 只跑纯映射（没有模型/凭据的 CI）
 *
 * 为什么需要它：`docs/agent-spec.md` 要做的第一件事不是"接进运行时"，而是证明新入口
 * 和旧入口产出同一份东西。没有这一步，接入口那天出现"预览变了、会话没变"，
 * 谁也说不清是哪边改坏的 —— 这个仓库已经因为"拼两遍提示词"分叉过两次。
 *
 * 三组断言：
 *   1. 映射：CARD → spec 字段逐一对照（含固定出口不可排除、excludeTools 生效）；
 *   2. 逐字节：同样输入下 spec 装配的 dry-run 会话 vs `previewAgent` → systemPrompt / 工具名全等；
 *   3. 报错：未注册的 section / extension / 自定义工具必须抛错，不许静默跳过。
 *
 * 退出码：任何一组失败 → 1。
 */
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const offline = process.argv.includes('--offline');

const {
	AgentSpecError,
	CUSTOM_TOOLS,
	DEFAULT_CUSTOM_TOOLS,
	PINNED_CUSTOM_TOOLS,
	SECTIONS,
	SECTION_NAME_RE,
	EXTENSIONS,
	assertSpec,
	resolveAgentSpec,
	specAppendPrompt,
	specLoaderOptions,
	specProblems,
	specSessionInputs,
	specSections,
	createSpecSectionsApplier,
} = await import(join(root, 'server/agent-spec.ts'));
const { TOOLS } = await import(join(root, 'server/chat.ts'));

const failures = [];
const checks = [];
function ok(name, condition, detail) {
	if (condition) checks.push(name);
	else failures.push(detail ? `${name} —— ${detail}` : name);
}

/** 一份最小的 CARD：形状与 `parseCard` 产出一致，不读盘。 */
function card(overrides = {}) {
	return {
		id: 'spec-fixture',
		description: '薪酬分摊与 HR 口径',
		kind: 'domain',
		domain: 'hr',
		appliesTo: [],
		tools: ['read', 'grep', 'bash', 'read'],
		skills: ['skill-bb9bb683@9f2c'],
		model: `${process.env.PI_PROVIDER ?? 'opencode-go'}/${process.env.PI_MODEL ?? 'deepseek-v4.1-flash'}`,
		thinking: 'high',
		parent: null,
		forkedAt: null,
		forkOffset: 0,
		expiresAt: null,
		external: false,
		maxActive: 1,
		status: 'active',
		prompt: '  你负责薪酬分摊域。  ',
		path: '/tmp/CARD.md',
		writable: true,
		warnings: [],
		...overrides,
	};
}

const knownTools = [...TOOLS, ...PINNED_CUSTOM_TOOLS];
const ctx = { cwd: process.cwd(), agentDir: join(root, 'runtime', 'agent'), knownTools };

// ── 1. 映射 ────────────────────────────────────────────────────────────────
const spec = resolveAgentSpec(card());
ok('id / description 直接映射', spec.id === 'spec-fixture' && spec.description === '薪酬分摊与 HR 口径');
ok('正文去掉首尾空白后进 prompt', spec.prompt === '你负责薪酬分摊域。', JSON.stringify(spec.prompt));
ok('tools 去重但保持顺序', JSON.stringify(spec.tools) === JSON.stringify(['read', 'grep', 'bash']), JSON.stringify(spec.tools));
ok('skills 去重', JSON.stringify(spec.skills) === JSON.stringify(['skill-bb9bb683@9f2c']));
ok('未实现的字段给默认值（不伪造）', spec.systemPrompt === null && spec.sections.length === 0 && spec.excludeTools.length === 0 && spec.customTools === null && spec.extensions.length === 0);
ok('model / thinking 原样带过', spec.model === card().model && spec.thinking === 'high');

const inputs = specSessionInputs(spec, ctx);
ok('固定出口总是被加回 allowlist', PINNED_CUSTOM_TOOLS.every((name) => inputs.tools.includes(name)), JSON.stringify(inputs.tools));
ok('CARD 没写 customTools 时四个可选工具全开（与旧路径一致）', JSON.stringify(inputs.customTools.slice(0, DEFAULT_CUSTOM_TOOLS.length)) === JSON.stringify(DEFAULT_CUSTOM_TOOLS), JSON.stringify(inputs.customTools));

const excluded = specSessionInputs({ ...spec, excludeTools: ['bash'] }, ctx);
ok('excludeTools 生效', !excluded.tools.includes('bash'), JSON.stringify(excluded.tools));
const notAllowed = specSessionInputs({ ...spec, tools: ['read', 'nope'] }, ctx);
ok('未注册工具不会进 allowlist', !notAllowed.tools.includes('nope'), JSON.stringify(notAllowed.tools));

ok('固定出口出现在 spec.excludeTools 里会被判为问题', specProblems({ ...spec, excludeTools: ['cred_use'] }, ctx).some((problem) => problem.includes('不能排除')));
ok('systemPrompt 空串被判为问题（要替换就写正文）', specProblems({ ...spec, systemPrompt: '   ' }, ctx).some((problem) => problem.includes('systemPrompt')));

// 段不是 addendum 的一部分（loader 没有 sections 选项，段只能由扩展填）。
ok('prompt 进 appendSystemPrompt', JSON.stringify(specAppendPrompt(spec)) === JSON.stringify(['你负责薪酬分摊域。']), JSON.stringify(specAppendPrompt(spec)));
ok('systemPrompt 非 null 时正文不进（整份替换）', JSON.stringify(specAppendPrompt({ ...spec, systemPrompt: '整份' })) === JSON.stringify(['整份']));

SECTIONS['fixture-section'] = () => '  【段文本】  ';
ok(
	'段渲染进 specSections，不进 appendSystemPrompt',
	JSON.stringify(specSections({ ...spec, sections: ['fixture-section'] })) === JSON.stringify({ 'fixture-section': '【段文本】' }) &&
		JSON.stringify(specAppendPrompt({ ...spec, sections: ['fixture-section'] })) === JSON.stringify(['你负责薪酬分摊域。']),
	JSON.stringify([specSections({ ...spec, sections: ['fixture-section'] }), specAppendPrompt({ ...spec, sections: ['fixture-section'] })]),
);
SECTIONS['empty-section'] = () => '   ';
ok('空段不入表（关掉某段 = 不放进结果，不是写空串）', JSON.stringify(specSections({ ...spec, sections: ['empty-section'] })) === '{}');
ok('未注册的段不会渲染成空块', JSON.stringify(specSections({ ...spec, sections: ['no-such-section'] })) === '{}');
delete SECTIONS['fixture-section'];
delete SECTIONS['empty-section'];

// 段名规则来自 SDK：`^[a-z][a-z0-9_-]*$`，`preamble` 保留。
ok('SECTION_NAME_RE 与 SDK 一致', SECTION_NAME_RE.source === '^[a-z][a-z0-9_-]*$', SECTION_NAME_RE.source);
ok('大写段名被判非法', specProblems({ ...spec, sections: ['Worktree'] }, ctx).some((problem) => problem.includes('不合法')));
ok('preamble 被判非法（SDK 保留名）', specProblems({ ...spec, sections: ['preamble'] }, ctx).some((problem) => problem.includes('preamble')));

// ── 1b. 段：冻结表 + applier（控制面归 spec，不归扩展） ──────────────────────
const { buildSystemPromptSections, diffSystemPromptSections } = await import(
	join(root, 'node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js')
);

/** 假装是 pi：收集 before_agent_start 的 handler，用来跑 applier。 */
function fakePi() {
	const handlers = [];
	return { handlers, on: (name, handler) => name === 'before_agent_start' && handlers.push(handler) };
}
/** 每次 run 都从 base 复制一份 options（和 runner.js:1122 的行为一致）。 */
function freshOptions() {
	return { cwd: '/tmp/demo', selectedTools: [], sections: {}, appendSystemPrompt: '' };
}
const runHandlers = async (handlers, options) => {
	for (const handler of handlers) await handler({ systemPromptOptions: options });
	return options;
};

SECTIONS['frozen-section'] = () => '冻结文本';
const frozenTable = specSections({ ...spec, sections: ['frozen-section'] });
const pi = fakePi();
createSpecSectionsApplier(frozenTable)(pi);
ok('applier 注册了一个 before_agent_start', pi.handlers.length === 1, String(pi.handlers.length));

const run1 = await runHandlers(pi.handlers, freshOptions());
const run2 = await runHandlers(pi.handlers, freshOptions());
ok('冻结表写回内容正确', run1.sections['frozen-section'] === '冻结文本', JSON.stringify(run1.sections));
ok('两次 run 的 options 完全相同（diff 为 undefined = 无缓存代价）', JSON.stringify(run1) === JSON.stringify(run2));
ok(
	'diff 无变化时不产生补丁',
	diffSystemPromptSections(buildSystemPromptSections(run1), buildSystemPromptSections(run2)) === undefined,
);

// 对照组：手写扩展"这一轮没写"→ 段被 patch 成 null 删掉（这就是不允许各扩展自己塞的原因）
const prev = buildSystemPromptSections(run1);
const skipped = await runHandlers([], freshOptions());
const patch = diffSystemPromptSections(prev, buildSystemPromptSections(skipped));
ok(
	'某轮没写该段 → patch 该段为 null（静默删除提示词）',
	patch?.['frozen-section'] === null,
	JSON.stringify(patch),
);

const emptyPi = fakePi();
createSpecSectionsApplier({})(emptyPi);
ok('空表不注册钩子', emptyPi.handlers.length === 0);
delete SECTIONS['frozen-section'];

// ── 2. 报错（不许静默跳过） ────────────────────────────────────────────────
for (const [field, patch] of [
	['sections', { sections: ['no-such-section'] }],
	['extensions', { extensions: ['no-such-extension'] }],
	['customTools', { customTools: ['no-such-tool'] }],
	['tools', { tools: ['no-such-agent-tool'] }],
]) {
	let thrown = null;
	try {
		assertSpec({ ...spec, ...patch }, ctx);
	} catch (error) {
		thrown = error;
	}
	ok(`未注册的 ${field} 抛 AgentSpecError`, thrown instanceof AgentSpecError, thrown ? String(thrown.message) : '没有抛错');
}
ok('注册表本身有内容可查（extensions / customTools 非空）', Object.keys(EXTENSIONS).length > 0 && Object.keys(CUSTOM_TOOLS).length > 0);

// ── 3. 逐字节：spec 装配 vs 现有 previewAgent ──────────────────────────────
if (offline) {
	console.log('跳过逐字节对比（--offline）');
} else {
	try {
		const { previewAgent } = await import(join(root, 'server/agents.ts'));
		const { createSessionLoader } = await import(join(root, 'server/session-config.ts'));
		const { createAgentSession, SessionManager } = await import('@earendil-works/pi-coding-agent');

		// previewAgent 的 dry-run 只读提示词和工具声明，不调模型，所以不需要凭据。
		const reference = await previewAgent({ ...card(), skills: [] });
		const modelKey = reference.model;

		// spec 侧：完全按 specLoaderOptions / specSessionInputs 给的东西建会话。
		const { getRuntime } = await import(join(root, 'server/chat.ts'));
		const runtime = await getRuntime();
		const [provider, ...rest] = modelKey.split('/');
		const model = runtime.getModel(provider, rest.join('/'));
		if (!model) throw new Error(`模型不可用：${modelKey}`);

		const loader = createSessionLoader(specLoaderOptions(spec, { ...ctx, skillPaths: [] }, { codemode: 'auto' }));
		await loader.reload();
		const created = await createAgentSession({
			cwd: process.cwd(),
			agentDir: ctx.agentDir,
			modelRuntime: runtime,
			model,
			tools: [...new Set([...spec.tools, ...TOOLS, ...PINNED_CUSTOM_TOOLS])],
			customTools: [],
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(),
		});
		const session = created.session;
		try {
			session.setActiveToolsByName(specSessionInputs(spec, ctx).tools);
			const system = String(session.systemPrompt ?? '');
			ok(
				'逐字节：spec 的 systemPrompt 与 previewAgent 完全一致',
				system === reference.system,
				`长度 ${system.length} vs ${reference.system.length}`,
			);
			const active = [...(session.getActiveToolNames?.() ?? [])].sort();
			const expected = [...reference.activeTools].sort();
			ok('逐字节：生效工具集一致', JSON.stringify(active) === JSON.stringify(expected), `${JSON.stringify(active)} vs ${JSON.stringify(expected)}`);
			// 记一笔坑：allowlist 里有名字 ≠ 会话里真的生效。固定出口是 customTools，
			// 不传对象就只是字符串，`getActiveToolNames()` 不会报它 —— 建会话时两处都得给。
			ok(
				'没注册对象时固定出口不会出现在生效工具集（allowlist ≠ 注册表）',
				PINNED_CUSTOM_TOOLS.every((name) => !active.includes(name)),
				JSON.stringify(active),
			);
		} finally {
			session.dispose?.();
		}
	} catch (error) {
		// 没有模型运行时不算失败，但要明确说出来：跳过 ≠ 通过。
		const message = error instanceof Error ? error.message : String(error);
		if (/Model not available|credential|runtime/i.test(message)) console.log(`跳过逐字节对比（模型运行时不可用：${message}）`);
		else failures.push(`逐字节对比执行失败 —— ${message}`);
	}
}

// ── 汇总 ──────────────────────────────────────────────────────────────────
for (const name of checks) console.log(`ok  : ${name}`);
for (const name of failures) console.log(`FAIL: ${name}`);
console.log(`\n${checks.length} 项通过，${failures.length} 项失败`);
process.exit(failures.length ? 1 : 0);
