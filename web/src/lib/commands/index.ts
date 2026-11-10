/**
 * 对外入口：其他模块从这里注册 / 行为。
 *
 *   import { registerCommand } from '@/lib/commands';
 *   const dispose = registerCommand({ ... });
 *
 * 组件里通常在 useEffect 中注册并返回 dispose；重复名称默认抛错。
 */
import { commandRegistry, type CommandDefinition } from './registry';

export { commandRegistry, executeCommand } from './registry';
export type {
	CommandContext,
	CommandDefinition,
	CommandGroup,
	CommandResult,
} from './registry';

export function registerCommand(
	definition: CommandDefinition,
	options: { replace?: boolean } = {},
): () => void {
	return commandRegistry.register(definition, options);
}
