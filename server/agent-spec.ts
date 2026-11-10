/**
 * AgentSpec：把一份元数据翻译成装载入参的**唯一**纯函数入口。
 *
 * 为什么要有这个文件（而不是继续在 Chat.init / previewAgent 里各拼一遍）：
 *   - 现在「CARD 里写了什么」和「会话真的装了什么」是两条代码路径拼出来的，
 *     预览能对上只是因为两边抄了同样的三段（提示词 / 工具 / 技能）。抄第三遍就一定分叉，
 *     这个仓库已经踩过两次（PI_TOOLS vs 设置勾选、mainAgent/CARD.md 声明不存在的工具）。
 *   - 这里只做**翻译**：不读盘、不建会话、不碰模型。盘上的东西（技能路径、worktree 事实）
 *     由调用方通过 `SpecContext` 传进来，所以它能在 CI 里跑，也能被逐字节对比。
 *
 * 设计基线见 docs/agent-spec.md。**本文件尚未接进运行时**：`Chat.init` / `previewAgent`
 * 仍走原路径，等 `npm run check:agent-spec` 的逐字节对比全绿后才换入口（回滚 = 改回一行）。
 */

import type { CodemodeMode, SessionLoaderOptions } from './session-config.ts';
import type { AgentCard } from './agents.ts';

/** 产品固定出口：CARD 关不掉，spec 里也不能出现（出现了会被合并回去）。 */
export const PINNED_CUSTOM_TOOLS = ['cred_list', 'cred_use'] as const;

/**
 * 可选自定义工具：名字 → 说明。这些不在 SDK 的 tools allowlist 里，
 * 只能通过 `customTools` 传对象，所以 spec 存名字、代码里查表。
 */
export const CUSTOM_TOOLS: Record<string, string> = {
	report_files: '交付物文件卡',
	web_search: '公网搜索',
	web_fetch: '抓取单个公开 URL',
	read_fetched: '翻页已抓取的正文',
};

/** 现状：四个可选工具全开。CARD 没有 `customTools` 字段时按它走（保证与旧路径逐字节一致）。 */
export const DEFAULT_CUSTOM_TOOLS = Object.keys(CUSTOM_TOOLS);

/**
 * 扩展：名字 → 工厂。`codemode` 的 mode 是**会话事实**（设置里选、落进 session），
 * 不是 spec 字段：spec 只说装不装，mode 由调用方给。
 */
export const EXTENSIONS: Record<string, { note: string }> = {
	codemode: { note: '脚本化执行入口（mode 由会话决定）' },
};

/**
 * 提示词段：名字 → 渲染函数。文本**不放在 spec 里**，spec 只写名字。
 *
 * 为什么文本要留在代码里：段文本要能 diff、能 review、能按会话事实逐轮填，
 * 一旦抄进每份 CARD，10 个岗位就会有 10 份会各自漂移的副本。
 *
 * 现在这张表是**空**的：worktree 提示词走的是扩展（`server/worktree-guidance.ts`），不在这张表里。
 * 空表 + 未知名字直接报错，好过留一段谁都说不清是否生效的文本。
 */
export const SECTIONS: Record<string, (facts: SpecFacts) => string> = {};

/** 段名字规则：SDK 强制（`preamble` 保留，写了会抛错）。 */
export const SECTION_NAME_RE = /^[a-z][a-z0-9_-]*$/;

/** 逐会话事实，供 sections 渲染；不给就不填（段自己要处理 undefined）。 */
export interface SpecFacts {
	worktreePath?: string;
	worktreeBranch?: string;
	worktreeBaseRef?: string;
	cwd?: string;
}

export interface AgentSpec {
	id: string;
	description: string;
	/** → appendSystemPrompt[0] */
	prompt: string;
	/** → systemPrompt（整份替换，null = 用 pi 基线） */
	systemPrompt: string | null;
	/** → 名字，渲染进 appendSystemPrompt[1..] */
	sections: string[];
	/** → tools（allowlist） */
	tools: string[];
	/** → 从 allowlist 里减掉（环境/域限制，不是岗位选择） */
	excludeTools: string[];
	/** → customTools（名字）；null = 现状全开 */
	customTools: string[] | null;
	/** → `id` 或 `id@sha256` → additionalSkillPaths */
	skills: string[];
	/** → extensionFactories（名字） */
	extensions: string[];
	/** → model */
	model: string;
	/** → thinkingLevel（建会话时设一次） */
	thinking: string;
}

/** 装配需要的会话事实（不进 spec：换台机器、换目录不该改变 agent 是什么）。 */
export interface SpecContext {
	cwd: string;
	agentDir: string;
	/** 已注册的一手工具名（`TOOLS` + 设置里勾选的），用于校验 `tools` / `excludeTools`。 */
	knownTools: string[];
	/** 技能库解析出的 SKILL.md 路径；spec 不做 I/O，由调用方给。 */
	skillPaths?: string[];
	skillEntries?: SessionLoaderOptions['skillEntries'];
	facts?: SpecFacts;
	/** 会话级扩展（工具拦截、before_agent_start 注入）不来自 spec。 */
	extraFactories?: any[];
}

export class AgentSpecError extends Error {
	// 不用参数属性（`constructor(readonly x)`）：node 的 strip-only 模式不支持，
	// 而 scripts/check-agent-spec.mjs 要能直接 import 这个文件。
	field: keyof AgentSpec | 'tools';

	constructor(message: string, field: keyof AgentSpec | 'tools') {
		super(message);
		this.name = 'AgentSpecError';
		this.field = field;
	}
}

function dedupe(list: string[] | undefined): string[] {
	return [...new Set((list ?? []).map((item) => String(item).trim()).filter(Boolean))];
}

/**
 * CARD → spec。纯函数：同样的 CARD 永远得到同样的 spec。
 *
 * 现在只映射已经存在的字段；`systemPrompt / sections / excludeTools / customTools / extensions`
 * 在 CARD 里还没有对应 key（见 docs/agent-spec.md §4 的"未实现"列），所以给默认值，
 * 默认值必须与旧路径等价 —— 逐字节对比（check:agent-spec）就是用来钉死这句话的。
 */
export function resolveAgentSpec(card: AgentCard): AgentSpec {
	return {
		id: card.id,
		description: card.description ?? '',
		prompt: (card.prompt ?? '').trim(),
		systemPrompt: null,
		sections: [],
		tools: dedupe(card.tools),
		excludeTools: [],
		customTools: null,
		skills: dedupe(card.skills),
		extensions: [],
		model: card.model,
		thinking: card.thinking,
	};
}

/**
 * 名字查表。**不抛错**：预览要能把"写了但没注册"的名字当告警显示，
 * 而不是让整个页面挂掉；需要硬失败的地方（建会话）再调 `assertSpec`。
 */
export function specProblems(spec: AgentSpec, ctx: Pick<SpecContext, 'knownTools'>): string[] {
	const problems: string[] = [];
	const known = new Set(ctx.knownTools);
	for (const name of spec.tools) {
		if (!known.has(name)) problems.push(`工具 ${name} 未注册（tools）`);
	}
	for (const name of spec.excludeTools) {
		if (!known.has(name)) problems.push(`工具 ${name} 未注册（excludeTools）`);
		if (PINNED_CUSTOM_TOOLS.includes(name as any)) problems.push(`固定出口 ${name} 不能排除`);
	}
	for (const name of spec.sections) {
		if (!SECTION_NAME_RE.test(name) || name === 'preamble') problems.push(`段名 ${name} 不合法（小写字母开头，preamble 保留）`);
		else if (!SECTIONS[name]) problems.push(`提示词段 ${name} 未注册（sections）`);
	}
	for (const name of spec.extensions) if (!EXTENSIONS[name]) problems.push(`扩展 ${name} 未注册（extensions）`);
	for (const name of spec.customTools ?? []) {
		if (!CUSTOM_TOOLS[name]) problems.push(`自定义工具 ${name} 未注册（customTools）`);
	}
	if (spec.systemPrompt !== null && !spec.systemPrompt.trim()) problems.push('systemPrompt 是空串：要整份替换就写正文，否则用 null');
	return problems;
}

export function assertSpec(spec: AgentSpec, ctx: Pick<SpecContext, 'knownTools'>): void {
	const problems = specProblems(spec, ctx);
	if (problems.length) throw new AgentSpecError(`AgentSpec ${spec.id} 不合法：${problems.join('；')}`, 'tools');
}

/**
 * 追加提示词 = CARD 正文（→ `addendum`）。
 *
 * **段不在这里**：段是系统提示词里独立的 `<name>` 块，只能由扩展在 `before_agent_start`
 * 里写进 `event.systemPromptOptions.sections`（loader 没有这个选项）。
 *
 * 段的收益是**变更边界**，不是缓存：`diffSystemPromptSections` 保证段没变就不产生 patch，
 * 所以稳定段零代价、失效只落在真正变的那一块。但段一旦变化，代价取决于 transport ——
 * 默认 `supportsMidConvoSystemMessages: false` 时补丁会被折叠进头部，前缀缓存从 token 0 起全失效。
 * **每个 run 都变的内容不该进系统提示词**（用尾部 custom message），见 docs/agent-spec.md §3。
 *
 * 术语：`before_agent_start` 是**每个 run**（一次用户提示提交）一次，不是每个模型请求
 * —— run 内部有 N 个 turn（`turn_start`），这 N 个 turn 共享同一份系统提示词。
 */
export function specAppendPrompt(spec: AgentSpec): string[] {
	// 整份替换时正文和段都不进：那是 systemPrompt 的语义，混进来就成了两套提示词。
	if (spec.systemPrompt !== null) return [spec.systemPrompt];
	return spec.prompt ? [spec.prompt] : [];
}

/**
 * spec.sections → 交给扩展填 `systemPromptOptions.sections` 的对象。
 *
 * 空文本不入表（SDK 的 `if (content)` 同样跳过），所以"关掉某段"= 不放进结果里。
 *
 * 调用时机是**创建会话时**，结果喂给 `createSpecSectionsApplier`；不要每轮重新渲染。
 */
export function specSections(spec: AgentSpec, facts: SpecFacts = {}): Record<string, string> {
	const out: Record<string, string> = {};
	for (const name of spec.sections) {
		const render = SECTIONS[name];
		if (!render) continue;
		const text = render(facts).trim();
		if (text) out[name] = text;
	}
	return out;
}

/**
 * spec 的段 → **冻结表 + 一个只负责写回的扩展**。
 *
 * 为什么必须有这个 applier，而不是让每个扩展自己往 `event.systemPromptOptions.sections` 里塞：
 *   1. loader 和 createAgentSession 都没有 sections 选项，扩展是唯一落点；
 *   2. `emitBeforeAgentStart` 每次 run 都从 base 复制一份 options（runner.js:1122），
 *      所以**这一轮没写 = 这个段不存在** → diff 会生成 `patch[name] = null`，把文本从提示词里删掉。
 *      静态文本的正确性不能依赖"每轮都执行成功"；
 *   3. 第三方扩展各自塞会因为加载顺序不同而产生不同提示词，而 spec 要求同一份配置产出同一个 agent。
 *
 * 冻结表在**创建会话时**渲染一次（此时 cwd / worktree / 技能都已确定），之后每轮写回同一份内容：
 * diff 为 no-op，零缓存代价。
 */
export function createSpecSectionsApplier(sections: Record<string, string>): (pi: any) => void {
	const frozen = Object.freeze({ ...sections });
	return (pi: any) => {
		if (!Object.keys(frozen).length) return; // 没有段就不注册钩子
		pi.on('before_agent_start', async (event: any) => {
			const target = event?.systemPromptOptions?.sections;
			if (!target) return;
			for (const [name, text] of Object.entries(frozen)) target[name] = text;
		});
	};
}

/**
 * spec → `createSessionLoader` 入参。与 `Chat.init` / `previewAgent` 里的拼装逐字节对齐：
 * 同样的 spec + 同样的会话事实，必须得到同样的 systemPrompt。
 */
export function specLoaderOptions(
	spec: AgentSpec,
	ctx: SpecContext,
	session: { codemode: CodemodeMode },
): SessionLoaderOptions {
	// codemode 的强制段由 createSessionLoader 统一追加，这里不重复拼：
	// 两处各拼一次就多一段，而提示词重复是那种"看起来也能跑"的 bug。
	// 注意：`systemPrompt`（整份替换）要落到 loader 的 `systemPromptOverride`，
	// 而 `SessionLoaderOptions` 目前没透传它 —— 接运行时的时候补一行，别在这里假装支持。
	return {
		cwd: ctx.cwd,
		agentDir: ctx.agentDir,
		skillEntries: ctx.skillEntries ?? [],
		skillPaths: ctx.skillPaths ?? [],
		appendSystemPrompt: specAppendPrompt(spec),
		codemode: session.codemode,
		extraFactories: ctx.extraFactories,
	};
}

/**
 * spec → `createAgentSession` 入参里与 agent 身份有关的那几项。
 *
 * 注意工具的两层过滤，顺序不能反：
 *   1. `excludeTools` 减掉环境不允许的；
 *   2. 加回固定出口（CARD 关不掉）；
 *   readonly 工作区的过滤不在这里 —— 那是会随工作区状态变的事实，运行时再算。
 */
export function specSessionInputs(spec: AgentSpec, ctx: Pick<SpecContext, 'knownTools'>): {
	tools: string[];
	customTools: string[];
	model: string;
	thinking: string;
} {
	const known = new Set(ctx.knownTools);
	const excluded = new Set(spec.excludeTools);
	const tools = spec.tools.filter((name) => known.has(name) && !excluded.has(name));
	const customTools = spec.customTools ?? DEFAULT_CUSTOM_TOOLS;
	return {
		tools: [...new Set([...tools, ...PINNED_CUSTOM_TOOLS])],
		customTools: [...new Set([...customTools, ...PINNED_CUSTOM_TOOLS])],
		model: spec.model,
		thinking: spec.thinking,
	};
}
