export type ThemeMode = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const THEME_KEY = 'turnpi-theme';

export function loadThemeMode(): ThemeMode {
	try {
		const value = localStorage.getItem(THEME_KEY);
		if (value === 'light' || value === 'dark' || value === 'system') return value;
	} catch {
		/* 隐私模式忽略 */
	}
	return 'system';
}

export function saveThemeMode(mode: ThemeMode) {
	try {
		localStorage.setItem(THEME_KEY, mode);
	} catch {
		/* 隐私模式忽略 */
	}
}

export function resolveTheme(mode: ThemeMode): ResolvedTheme {
	if (mode !== 'system') return mode;
	try {
		return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
	} catch {
		return 'dark';
	}
}

/** 把解析后的主题写到 <html>，同时保留用户选择，便于设置页回显。 */
export function applyTheme(mode: ThemeMode) {
	if (typeof document === 'undefined') return;
	const resolved = resolveTheme(mode);
	const root = document.documentElement;
	root.dataset.theme = resolved;
	root.dataset.themeMode = mode;
	root.style.colorScheme = resolved;
}
