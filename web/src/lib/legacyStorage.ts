/**
 * 一次性迁移：旧 localStorage 前缀 `pi-webchat` → `turnpi`。
 *
 * 只在没有新键时写入，绝不覆盖用户已经在新版本里做过的选择。
 * 旧键保留不删——万一要回滚，设置还在。
 *
 * 前缀式键（`turnpi:context-width:<id>`）也要跟着走，所以这里扫全量 key，
 * 而不是维护一张固定表：表会漏，扫描不会。
 */

export const STORAGE_PREFIX = 'turnpi';

const LEGACY_PREFIX = 'pi-webchat';

let migrated = false;

/** 幂等：重复调用只做一次。启动时在渲染前调用。 */
export function migrateLegacyStorageKeys(): void {
	if (migrated) return;
	migrated = true;
	try {
		const carry: [string, string][] = [];
		for (let i = 0; i < localStorage.length; i += 1) {
			const key = localStorage.key(i);
			if (!key || !key.startsWith(LEGACY_PREFIX)) continue;
			carry.push([key, STORAGE_PREFIX + key.slice(LEGACY_PREFIX.length)]);
		}
		for (const [from, to] of carry) {
			if (localStorage.getItem(to) !== null) continue;
			const value = localStorage.getItem(from);
			if (value !== null) localStorage.setItem(to, value);
		}
	} catch {
		/* 隐私模式 / 存储被禁用：什么都不做 */
	}
}
