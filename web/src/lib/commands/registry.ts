/**
 * 命令注册表：其他模块通过 registerCommand() 主动注册 / 行为。
 *
 * 定义只包含元数据、可用性判断和执行函数；不依赖 React、DOM 或 Composer。
 * 注册返回 disposer，方便组件卸载/热更新时撤销。
 */
import type { ChatStore } from '@/lib/store';

export type CommandGroup = '会话' | '模型' | '界面' | '帮助' | (string & {});

export type CommandResult =
	| { kind: 'done'; toast?: string }
	| { kind: 'insert'; text: string; caretOffset?: number }
	| { kind: 'submit'; text: string }
	| { kind: 'error'; message: string }
	| { kind: 'none' };

export interface CommandContext {
	/** 执行时再取最新快照，避免菜单渲染时的旧状态。 */
	getState(): ChatStore;
	toast(message: string): void;
	send(text: string): Promise<boolean>;
	openModelMenu(query?: string): void;
	openThinkingMenu(): void;
	focusInput(): void;
}

export interface CommandDefinition {
	name: string;
	description: string;
	label?: string;
	group?: CommandGroup;
	order?: number;
	aliases?: string[];
	/** 参数提示，例如 `[说明]`；没有参数时省略。 */
	argumentHint?: string;
	/** 菜单选中后的默认动作；insert 留给需要继续输入的命令。 */
	mode?: 'action' | 'insert';
	available?: (state: ChatStore) => boolean;
	run(ctx: CommandContext, args: string): CommandResult | Promise<CommandResult>;
}

interface RegisteredCommand {
	definition: CommandDefinition;
}

class CommandRegistry {
	private readonly commands = new Map<string, RegisteredCommand>();
	private readonly listeners = new Set<() => void>();
	private version = 0;

	register(definition: CommandDefinition, options: { replace?: boolean } = {}): () => void {
		const name = definition.name.trim().toLowerCase();
		if (!/^[a-z][a-z0-9_-]*$/u.test(name)) {
			throw new Error(`command name "${definition.name}" must match /^[a-z][a-z0-9_-]*$/`);
		}
		if (!definition.description.trim()) {
			throw new Error(`command "${name}" description must not be empty`);
		}
		if (this.commands.has(name) && !options.replace) {
			throw new Error(`command "${name}" is already registered`);
		}
		const stored = {
			definition: {
				...definition,
				name,
				...(definition.aliases ? { aliases: definition.aliases.map((alias) => alias.toLowerCase()) } : {}),
			},
		};
		this.commands.set(name, stored);
		this.bump();
		return () => {
			if (this.commands.get(name) !== stored) return;
			this.commands.delete(name);
			this.bump();
		};
	}

	find(name: string): CommandDefinition | undefined {
		const key = name.trim().toLowerCase();
		const exact = this.commands.get(key)?.definition;
		if (exact) return exact;
		return this.list().find((definition) => definition.aliases?.includes(key));
	}

	list(): readonly CommandDefinition[] {
		return [...this.commands.values()]
			.map((entry) => entry.definition)
			.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));
	}

	getVersion = (): number => this.version;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	private bump(): void {
		this.version += 1;
		for (const listener of this.listeners) {
			try {
				listener();
			} catch {
				/* 一个订阅者失败不能阻止其它订阅者刷新 */
			}
		}
	}
}

export const commandRegistry = new CommandRegistry();

/** 执行一条已解析的命令；未知命令和不可用状态都返回 error。 */
export async function executeCommand(
	name: string,
	args: string,
	ctx: CommandContext,
): Promise<CommandResult> {
	const command = commandRegistry.find(name);
	if (!command) return { kind: 'error', message: `未知命令：/${name}` };
	try {
		if (command.available && !command.available(ctx.getState())) {
			return { kind: 'error', message: `/${name} 当前不可用` };
		}
		return await command.run(ctx, args);
	} catch (error) {
		return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
	}
}
