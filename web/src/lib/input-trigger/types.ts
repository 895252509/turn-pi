/**
 * 输入框触发器（/ 命令、@ 引用）的公共类型。
 *
 * 业务模块不直接操作 Composer DOM：只注册 source，返回候选和 pick 结果。
 * 这样 / 和 @ 共用同一套检测、菜单、键盘和光标恢复逻辑。
 */
import type { ChatStore } from '@/lib/store';

export type TriggerChar = '/' | '@';

/** token 在草稿里的位置：行首（命令）或行内（引用）。 */
export type TriggerPosition = 'leading' | 'inline';

export interface TriggerHit {
	trigger: TriggerChar;
	/** 触发符到光标之间的原文，不含触发符。 */
	query: string;
	/** 触发符在草稿里的起点。 */
	start: number;
	/** 光标位置。 */
	end: number;
	position: TriggerPosition;
}

export interface CandidateRequest {
	query: string;
	position: TriggerPosition;
	signal: AbortSignal;
}

/** 菜单里的一行；source 负责提供业务字段，菜单只负责展示。 */
export interface TriggerCandidate {
	/** 同一菜单内唯一。 */
	id: string;
	/** 给 onPick 路由回 source 用。 */
	source: string;
	title: string;
	description?: string;
	/** 右侧的短标记，例如「已归档」「busy」。 */
	badge?: string;
	/** 标题下的小字，例如工作区、轮次。 */
	meta?: string;
	/** 分组标题；相邻同组只渲染一次。 */
	section?: string;
	/** 参数提示，例如 `<level>`。 */
	hint?: string;
	/** source 自己解释的 pick 值。 */
	value: string;
	/** 排序权重，越小越靠前。 */
	order?: number;
	disabled?: boolean;
}

/** source 在选择/回车后返回给触发器的动作。 */
export type PickOutcome =
	| { kind: 'run'; command: string; args: string; line?: string }
	| { kind: 'insert'; text: string; caretOffset?: number }
	| { kind: 'replace'; start: number; end: number; text: string; caretOffset?: number }
	| { kind: 'error'; message: string }
	| { kind: 'handled' }
	| { kind: 'none' };

/** 一次选择携带的上下文。 */
export interface TriggerPick {
	candidate: TriggerCandidate;
	hit: TriggerHit;
	line: string;
}

/** Composer 提供给 source 的能力；source 不持有 React/DOM 引用。 */
export interface TriggerContext {
	getState(): ChatStore;
	runCommand(name: string, args: string, line: string): Promise<void>;
	toast(message: string): void;
	focusInput(): void;
}

/** 一个触发器来源；同一 trigger 下 name 唯一。 */
export interface InputTriggerSource {
	trigger: TriggerChar;
	name: string;
	order?: number;
	/** source 注册后、会话作用域建立时预热一次（可选）。 */
	warm?(ctx: TriggerContext): void;
	candidates(
		ctx: TriggerContext,
		req: CandidateRequest,
	): Promise<readonly TriggerCandidate[]> | readonly TriggerCandidate[];
	onPick(pick: TriggerPick, ctx: TriggerContext): PickOutcome | Promise<PickOutcome>;
	/**
	 * 菜单关闭时按 Enter 的兜底判断。返回 undefined 表示这条输入不属于本 source。
	 * 用于 / 命令：菜单没开时仍然要能执行 `/compact`。
	 */
	matchEnter?(
		line: string,
		ctx: TriggerContext,
		envelope: { attachments: number },
	): PickOutcome | undefined | Promise<PickOutcome | undefined>;
}

/** 一条引用在发送协议里的稳定形态；turn 是给「引用某一轮」预留的口。 */
export interface SessionReference {
	kind: 'session';
	id: string;
	title?: string;
	turn?: number;
}
