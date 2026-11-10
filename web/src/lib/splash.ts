/**
 * 启动画面的收尾。
 *
 * 画面本体、样式、看门狗全部内联在 `web/index.html` 里，因为它的唯一职责是
 * 「在打包产物还没到之前就先画出来」——放进 app.css 或 React 组件里就失去意义了。
 *
 * 这里只负责在应用真正挂载之后通知它退场。函数由 index.html 末尾的内联脚本挂到
 * window 上；没挂上（老缓存、被 CSP 拦掉、或者单测里没有 index.html）就静默跳过。
 */

declare global {
	interface Window {
		__turnpiDismissSplash?: () => void;
	}
}

export function dismissSplash(): void {
	try {
		window.__turnpiDismissSplash?.();
	} catch {
		/* 启动画面不是关键路径，出错不影响应用 */
	}
}
