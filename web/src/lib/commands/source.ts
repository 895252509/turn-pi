/** / 命令 source：把 CommandRegistry 适配成 InputTriggerSource。 */
import type {
	InputTriggerSource,
	TriggerCandidate,
} from '@/lib/input-trigger/types';
import { parseCommandLine } from '@/lib/input-trigger/detect';
import { rankByMatch } from '@/lib/input-trigger/rank';
import { commandRegistry } from './registry';

const GROUP_ORDER: Record<string, number> = { '会话': 0, '模型': 1, '界面': 2, '帮助': 3 };

function commandOrder(definition: ReturnType<typeof commandRegistry.list>[number]): number {
	return (GROUP_ORDER[definition.group ?? ''] ?? 9) * 1000 + (definition.order ?? 0);
}

function candidateOf(definition: ReturnType<typeof commandRegistry.list>[number]): TriggerCandidate {
	return {
		id: `command:${definition.name}`,
		source: 'command',
		title: `/${definition.name}`,
		description: definition.description,
		meta: definition.label,
		section: definition.group ?? '命令',
		hint: definition.argumentHint,
		order: commandOrder(definition),
		value: definition.name,
	};
}

export function createSlashCommandSource(): InputTriggerSource {
	return {
		trigger: '/',
		name: 'command',
		order: 0,
		warm() {
			/* 命令是同步注册表，不需要预热 */
		},
		candidates(ctx, req) {
			const state = ctx.getState();
			const rows = commandRegistry.list();
			const ranked = rankByMatch(
				rows,
				req.query,
				(definition) => [
					definition.name,
					definition.label,
					definition.description,
					...(definition.aliases ?? []),
				],
				(definition) => commandOrder(definition),
			);
			return ranked.map((definition) => {
				const available = !definition.available || definition.available(state);
				return {
					...candidateOf(definition),
					...(available ? {} : { badge: '不可用', disabled: true }),
				};
			});
		},
		onPick(pick) {
			const definition = commandRegistry.find(pick.candidate.value);
			if (!definition) return { kind: 'none' };
			if (definition.mode === 'insert') {
				return { kind: 'insert', text: `/${definition.name} `, caretOffset: definition.name.length + 2 };
			}
			return {
				kind: 'run',
				command: definition.name,
				args: '',
				line: `/${definition.name}`,
			};
		},
		async matchEnter(line, ctx, envelope) {
			const parsed = parseCommandLine(line);
			if (!parsed) return undefined;
			const definition = commandRegistry.find(parsed.name);
			if (!definition) {
				return { kind: 'error', message: `未知命令：/${parsed.name}` };
			}
			if (envelope.attachments > 0) {
				return { kind: 'error', message: `/${parsed.name} 不支持图片附件` };
			}
			if (definition.available && !definition.available(ctx.getState())) {
				return { kind: 'error', message: `/${parsed.name} 当前不可用` };
			}
			return {
				kind: 'run',
				command: parsed.name,
				args: parsed.args,
				line,
			};
		},
	};
}
