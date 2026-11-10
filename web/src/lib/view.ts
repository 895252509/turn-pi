/**
 * 全局视图（模块）路由。
 *
 * 只用一个 hash 承载"当前模块"，不引路由库：
 *   - 刷新、前进/后退、分享链接都能落回同一个视图
 *   - 会话 id 仍然只由 localStorage(SESSION_KEY) 记忆，避免 hash 和本地状态两处真相打架
 *
 * 视图列表故意不收 'settings'：设置是深度配置的弹窗，不是平级模块。
 */

export type AppView = 'chat' | 'skills' | 'agents' | 'mcp' | 'jobs';

export const APP_VIEWS = ['chat', 'skills', 'agents', 'mcp', 'jobs'] as const satisfies readonly AppView[];

export const DEFAULT_VIEW: AppView = 'chat';

export const VIEW_LABELS: Record<AppView, string> = {
	chat: '对话',
	skills: '技能',
	agents: 'Agent',
	mcp: 'MCP',
	jobs: '定时任务',
};

export function isAppView(value: string): value is AppView {
	return (APP_VIEWS as readonly string[]).includes(value);
}

/** `#/skills` → 'skills'；空 hash / 未知值一律回落到对话视图 */
export function parseViewHash(hash: string): AppView {
	const [head = ''] = hash.replace(/^#\/?/, '').split('/');
	return isAppView(head) ? head : DEFAULT_VIEW;
}

export function viewHash(view: AppView): string {
	return `#/${view}`;
}

/** happy-dom / 服务端渲染下没有 window 时返回空串 */
export function currentHash(): string {
	return typeof window === 'undefined' ? '' : window.location.hash;
}

/** 只在与当前 hash 不同才写入，避免"写 hash → 触发 hashchange → 再写"的空转 */
export function writeViewHash(view: AppView): void {
	if (typeof window === 'undefined') return;
	const next = viewHash(view);
	if (window.location.hash === next) return;
	window.location.hash = next;
}
