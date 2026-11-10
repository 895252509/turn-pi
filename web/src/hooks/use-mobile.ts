import { useEffect, useState } from 'react';

/** 与旧版一致：980px 以下左右两栏变成抽屉。 */
/**
 * 触屏优先设备（手机/平板，包括横屏 >980px 的平板）：没有 hover、主指针是 coarse。
 *
 * 用能力判断而不是宽度：平板横屏是 1024/1280，但仍会弹软键盘。
 * 典型用途：菜单里带搜索框时不要 autoFocus（否则一展开就弹键盘、挡住列表）。
 */
export function useTouchOnly(): boolean {
	const query = '(hover: none) and (pointer: coarse)';
	const [touch, setTouch] = useState(() =>
		typeof window === 'undefined' ? false : window.matchMedia(query).matches,
	);

	useEffect(() => {
		const mql = window.matchMedia(query);
		const onChange = () => setTouch(mql.matches);
		onChange();
		mql.addEventListener('change', onChange);
		return () => mql.removeEventListener('change', onChange);
	}, []);

	return touch;
}

export function useIsMobile(): boolean {
	const query = '(max-width: 980px)';
	const [mobile, setMobile] = useState(() =>
		typeof window === 'undefined' ? false : window.matchMedia(query).matches,
	);

	useEffect(() => {
		const mql = window.matchMedia(query);
		const onChange = () => setMobile(mql.matches);
		onChange();
		mql.addEventListener('change', onChange);
		return () => mql.removeEventListener('change', onChange);
	}, []);

	return mobile;
}
