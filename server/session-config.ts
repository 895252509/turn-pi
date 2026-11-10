/**
 * 会话装载配置的**唯一**组装路径。
 *
 * 为什么单独一个文件：真实会话（`Chat.init`）和 agent 预览（dry-run 会话）
 * 必须拿到逐字节相同的系统提示词 / 工具声明。提示词一旦拼两遍，两遍一定会分叉 ——
 * 这个仓库已经踩过两次（`PI_TOOLS` vs 设置勾选；`mainAgent/CARD.md` 声明了
 * 根本不存在的 dispatch/send/status/remember）。新增装载项只改这里。
 */

import { createCodemodeExtension, createMcpExtension, DefaultResourceLoader } from '@earendil-works/pi-coding-agent';
import { loadPlatformMcpConfig } from './mcp.ts';
import { trustForSkillPath, type SkillCompositionItem } from './skills.ts';

/** 新会话的 codemode 策略：auto 默认 / on 强制走脚本 / off 本会话不给这个工具。 */
export type CodemodeMode = 'auto' | 'on' | 'off';

/** 强制开启时追加到系统提示词，把「能用」变成「必须用」。 */
export const CODEMODE_FORCE_PROMPT =
	'codemode is forced on for this session: perform tool work by writing a codemode script ' +
	'(tools.read / tools.bash / ... , Promise.allSettled for parallelism) instead of calling tools one by one. ' +
	'Only fall back to a direct tool call when a script would be strictly worse, such as a single interactive command.';

export interface SessionLoaderOptions {
	cwd: string;
	agentDir: string;
	/** 技能组合（原生 skill 通道）的审计条目，决定哪些能进 system prompt。 */
	skillEntries: SkillCompositionItem[];
	/** 技能组合给出的额外 SKILL.md 路径；预览时传空数组。 */
	skillPaths: string[];
	/** 追加到系统提示词末尾的片段，按顺序拼接。CARD 正文排在最前。 */
	appendSystemPrompt?: string[];
	codemode: CodemodeMode;
	/** 会话自己的扩展（工具拦截、before_agent_start 注入等）。 */
	extraFactories?: any[];
	/**
	 * MCP：只有真实会话开。工具清单（toolRegistry）、agent 预览都是 dry-run 会话，
	 * 开了就会为了看一眼工具而真的去起 stdio 子进程。
	 */
	mcp?: { enabled: boolean; configFile?: string };
}

/**
 * 组装 ResourceLoader。
 *
 * 注意 `skillsOverride` 不是可选的装饰：未审计 skill 必须 `disableModelInvocation`，
 * 否则它会绕过技能库的信任判定直接进提示词。
 */
/** 已经警告过的 append 来源：同一个源只吵一次（每次建会话都会走这里）。 */
const warnedAppendSources = new Set<string>();

export function createSessionLoader(options: SessionLoaderOptions): DefaultResourceLoader {
	// 空串不能进数组：SDK 用 "\n\n" join，空元素会 join 出多余空行。
	const append = (options.appendSystemPrompt ?? []).map((part) => part.trim()).filter(Boolean);
	if (options.codemode === 'on') append.push(CODEMODE_FORCE_PROMPT);
	return new DefaultResourceLoader({
		cwd: options.cwd,
		agentDir: options.agentDir,
		// 精确集合：noSkills 关掉所有自动发现，只保留组合输出的路径。
		noSkills: true,
		additionalSkillPaths: options.skillPaths,
		skillsOverride: (base) => ({
			skills: base.skills
				.filter((skill) => trustForSkillPath(options.skillEntries, skill.filePath) !== 'blocked')
				.map((skill) => {
					// 未审计 skill 不进 system prompt，但手动 /skill:name 仍可用。
					const trust = trustForSkillPath(options.skillEntries, skill.filePath);
					return trust === 'unreviewed' ? { ...skill, disableModelInvocation: true } : skill;
				}),
			diagnostics: base.diagnostics,
		}),
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		// 注意语义：这里**故意不合并** base（`<cwd>/.pi/APPEND_SYSTEM.md`、`<agentDir>/APPEND_SYSTEM.md`
		// 的发现结果）。spec 是系统提示词的唯一输入，否则同一份 CARD 在不同机器上会装出不同的 agent。
		// 但"故意不合并"不等于可以静默丢弃：放了文件却没生效，必须说一声。
		appendSystemPromptOverride: (base) => {
			const dropped = base.filter((part) => part.trim());
			if (dropped.length) {
				const key = dropped.join('\u0000');
				if (!warnedAppendSources.has(key)) {
					warnedAppendSources.add(key);
					process.stderr.write(
						`[session-config] 忽略外部 appendSystemPrompt（${dropped.length} 段，来自 APPEND_SYSTEM.md 等）：` +
							`本会话的系统提示词只由 CARD / 装载选项决定\n`,
					);
				}
			}
			return append;
		},
		// codemode 是 CLI 的内置扩展，SDK 会话不会自动带上（docs/sdk.md:116），得自己注册。
		// mode: 'on' 保留已有工具的声明，再把脚本调用方式追加到描述上；
		// 'only' 会把 read/bash 从模型视野里藏掉，和设置里的工具开关语义冲突。
		extensionFactories: [
			...(options.extraFactories ?? []),
			// MCP 是 CLI 的内置扩展，SDK 会话同样不会自动带（docs/sdk.md:116）。
			// loadConfig 换掉 SDK 的默认发现，配置来源只有平台这一份（见 server/mcp.ts）。
			...(options.mcp?.enabled
				? [createMcpExtension({ loadConfig: () => loadPlatformMcpConfig(options.mcp?.configFile) })]
				: []),
			createCodemodeExtension({ mode: 'on' }),
		],
	});
}
