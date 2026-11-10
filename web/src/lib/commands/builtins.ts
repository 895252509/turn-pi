/** 内置应用命令；第三方模块通过 registerCommand() 注册自己的 / 行为。 */
import type { CommandDefinition } from './registry';
import type { ThemeMode } from '@/lib/theme';

const THINKING_ALIASES: Record<string, string> = {
	关: 'off',
	关闭: 'off',
	off: 'off',
	极简: 'minimal',
	minimal: 'minimal',
	低: 'low',
	low: 'low',
	中: 'medium',
	medium: 'medium',
	高: 'high',
	high: 'high',
	最高: 'max',
	max: 'max',
};

const THEME_ALIASES: Record<string, ThemeMode> = {
	dark: 'dark',
	深色: 'dark',
	light: 'light',
	浅色: 'light',
	system: 'system',
	跟随系统: 'system',
};

function usage(text: string): { kind: 'error'; message: string } {
	return { kind: 'error', message: text };
}

export const BUILTIN_COMMANDS: readonly CommandDefinition[] = [
	{
		name: 'compact',
		label: '压缩上下文',
		description: '压缩较早的对话历史，可附带说明',
		group: '会话',
		order: 10,
		argumentHint: '[说明]',
		available: (state) => Boolean(state.sessionId) && !state.busy && !state.compacting,
		run: async (ctx, args) => {
			if (!ctx.getState().sessionId) return usage('先开始一个会话再压缩');
			await ctx.getState().compact(args || undefined);
			return { kind: 'none' };
		},
	},
	{
		name: 'new',
		label: '新对话',
		description: '开始一个新的会话',
		group: '会话',
		order: 20,
		run: (ctx) => {
			if (ctx.getState().busy) return usage('生成中不能新建对话，先 /stop');
			ctx.getState().newChat();
			return { kind: 'done', toast: '已开始新对话' };
		},
	},
	{
		name: 'fork',
		label: '创建分支',
		description: '从当前会话 fork 到新会话',
		group: '会话',
		order: 30,
		available: (state) => Boolean(state.sessionId) && !state.busy,
		run: async (ctx) => {
			if (!ctx.getState().sessionId) return usage('先打开一个会话再 fork');
			await ctx.getState().forkCurrent();
			return { kind: 'none' };
		},
	},
	{
		name: 'archive',
		label: '归档会话',
		description: '归档当前会话，可在「已归档」中恢复',
		group: '会话',
		order: 40,
		available: (state) => Boolean(state.sessionId) && !state.busy,
		run: async (ctx) => {
			const sessionId = ctx.getState().sessionId;
			if (!sessionId) return usage('当前没有可归档的会话');
			if (ctx.getState().busy) return usage('生成中不能归档，先 /stop');
			await ctx.getState().archiveSession(sessionId, true);
			return { kind: 'none' };
		},
	},
	{
		name: 'stop',
		label: '停止生成',
		description: '中止当前正在生成的回答',
		group: '会话',
		order: 50,
		available: (state) => state.busy,
		run: async (ctx) => {
			if (!ctx.getState().busy) return usage('当前没有正在生成的回答');
			await ctx.getState().abort();
			return { kind: 'none' };
		},
	},
	{
		name: 'rename',
		label: '重命名会话',
		description: '修改当前会话名称',
		group: '会话',
		order: 60,
		argumentHint: '<名称>',
		mode: 'insert',
		available: (state) => Boolean(state.sessionId),
		run: async (ctx, args) => {
			if (!ctx.getState().sessionId) return usage('先打开一个会话再重命名');
			const name = args.trim();
			if (!name) return usage('用法：/rename <名称>');
			await ctx.getState().renameSession(name);
			return { kind: 'none' };
		},
	},
	{
		name: 'model',
		label: '切换模型',
		description: '打开模型选择器，可带搜索词',
		group: '模型',
		order: 10,
		argumentHint: '[关键词]',
		available: (state) => state.models.length > 1,
		run: (ctx, args) => {
			if (ctx.getState().models.length < 2) return usage('当前只有一个可用模型');
			ctx.openModelMenu(args.trim());
			return { kind: 'none' };
		},
	},
	{
		name: 'thinking',
		label: '思考等级',
		description: '打开思考等级选择器，或直接指定 level',
		group: '模型',
		order: 20,
		argumentHint: '[level]',
		available: (state) => state.thinkingLevels.length > 1,
		run: async (ctx, args) => {
			const state = ctx.getState();
			if (state.thinkingLevels.length <= 1) return usage('当前模型只有一档思考等级');
			const raw = args.trim().toLowerCase();
			if (!raw) {
				ctx.openThinkingMenu();
				return { kind: 'none' };
			}
			const level = THINKING_ALIASES[raw] ?? raw;
			if (!state.thinkingLevels.includes(level)) {
				return usage(`未知思考等级：${args}；可选：${state.thinkingLevels.join(' / ')}`);
			}
			await state.setThinking(level);
			return { kind: 'done', toast: `思考等级：${level}` };
		},
	},
	{
		name: 'notify',
		label: '完成提醒',
		description: '开关完成提醒',
		group: '界面',
		order: 10,
		run: async (ctx) => {
			await ctx.getState().toggleNotify();
			return { kind: 'none' };
		},
	},
	{
		name: 'theme',
		label: '切换主题',
		description: '设置深色 / 浅色 / 跟随系统',
		group: '界面',
		order: 20,
		argumentHint: '<dark|light|system>',
		run: (ctx, args) => {
			const mode = THEME_ALIASES[args.trim().toLowerCase()];
			if (!mode) return usage('用法：/theme <dark|light|system>');
			ctx.getState().setTheme(mode);
			return { kind: 'done', toast: `主题：${mode}` };
		},
	},
	{
		name: 'files',
		label: '打开文件栏',
		description: '展开右侧文件/预览面板',
		group: '界面',
		order: 30,
		run: (ctx) => {
			ctx.getState().openPanel();
			return { kind: 'none' };
		},
	},
	{
		name: 'help',
		label: '命令帮助',
		description: '查看输入框快捷键和命令提示',
		group: '帮助',
		order: 10,
		run: (ctx) => {
			ctx.toast('输入 / 查看命令；↑↓ 选择，Enter/Tab 确认，Esc 关闭；输入 @ 引用会话');
			return { kind: 'none' };
		},
	},
];
