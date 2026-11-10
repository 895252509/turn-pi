import { useStore } from '@/lib/store';

/**
 * 全局浮动提示。
 *
 * - 纯文字：底部居中，2.6s 自己消失，不拦鼠标（pointer-events: none）。
 * - 带按钮（例如归档后的「撤销」）：顶部居中，默认停 10s，并放开 pointer-events，
 *   因为按钮要能点。位置和时长都由 store 里的 ToastState 决定，组件只负责渲染。
 */
export function Toast() {
	const toast = useStore((s) => s.toast);
	const dismissToast = useStore((s) => s.dismissToast);

	const runAction = () => {
		const action = toast?.action;
		// 先收起再执行：撤销本身会再发一条新提示，别让两条叠在一起
		dismissToast();
		action?.();
	};

	const classes = [
		'toast',
		toast ? 'show' : '',
		toast?.placement === 'top' ? 'top' : '',
		toast?.actionLabel ? 'has-action' : '',
	]
		.filter(Boolean)
		.join(' ');

	return (
		<div
			className={classes}
			role="status"
			aria-live="polite"
			data-placement={toast?.placement}
			data-timeout={toast ? String(toast.timeout) : undefined}
		>
			<span className="toast-text">{toast?.text ?? ''}</span>
			{toast?.actionLabel ? (
				<button type="button" className="toast-action" onClick={runAction}>
					{toast.actionLabel}
				</button>
			) : null}
		</div>
	);
}
