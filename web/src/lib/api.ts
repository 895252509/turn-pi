/** 服务端 API 封装，语义与旧 web/app.js 完全一致。 */
export async function api<T = any>(path: string, payload?: unknown, options: { method?: string } = {}): Promise<T> {
	const method = options.method ?? (payload ? 'POST' : 'GET');
	const res = await fetch(path, {
		method,
		...(payload
			? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }
			: {}),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(data?.error || data?.message || res.statusText);
	return data as T;
}

/** `crypto.randomUUID` 只在安全上下文可用；局域网 http 下要退化。 */
export function newId(): string {
	const c = globalThis.crypto;
	if (c && typeof c.randomUUID === 'function') return c.randomUUID();
	const bytes = new Uint8Array(16);
	if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
	else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const storage = {
	get(key: string): string | null {
		try {
			return localStorage.getItem(key);
		} catch {
			return null;
		}
	},
	set(key: string, value: string) {
		try {
			localStorage.setItem(key, value);
		} catch {
			/* 隐私模式忽略 */
		}
	},
	remove(key: string) {
		try {
			localStorage.removeItem(key);
		} catch {
			/* 忽略 */
		}
	},
};

export const sessionStore = {
	get(key: string): string | null {
		try {
			return sessionStorage.getItem(key);
		} catch {
			return null;
		}
	},
	set(key: string, value: string) {
		try {
			sessionStorage.setItem(key, value);
		} catch {
			/* 忽略 */
		}
	},
};
