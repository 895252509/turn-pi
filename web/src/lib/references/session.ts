/**
 * @ 会话引用的纯文本 token。
 *
 * textarea 不能像富文本编辑器那样隐藏引用元数据，所以把稳定 ID 写进 token：
 *   @[标题](session:<id>)
 *   @[标题 · 第3轮](session:<id>#turn=3)
 *
 * 这样复制、粘贴、编辑后仍然可以解析；turn 是「引用会话中的某一轮」预留口。
 */
import type { SessionReference } from '@/lib/input-trigger/types';

export const MAX_SESSION_REFERENCES = 3;

const TOKEN = /@\[((?:\\.|[^\]])*)\]\(session:([A-Za-z0-9._-]+)(?:#turn=(\d+))?\)/gu;
const SESSION_ID = /^[A-Za-z0-9._-]+$/u;

function escapeTitle(title: string): string {
	return title.replace(/\s+/gu, ' ').replace(/\\/gu, '\\\\').replace(/\]/gu, '\\]');
}

function unescapeTitle(title: string): string {
	return title.replace(/\\([\\\]])/gu, '$1');
}

/** 生成可插入 textarea 的会话引用 token。 */
export function formatSessionReference(ref: SessionReference): string {
	const id = ref.id.trim();
	if (!SESSION_ID.test(id)) throw new Error(`invalid session id: ${ref.id}`);
	const title = escapeTitle(ref.title?.trim() || id);
	const turn = Number.isInteger(ref.turn) && (ref.turn ?? 0) > 0 ? `#turn=${ref.turn}` : '';
	return `@[${title}](session:${id}${turn})`;
}

/** 菜单里展示的标题；引用某一轮时带上轮次。 */
export function sessionReferenceLabel(title: string, turn?: number): string {
	return turn && turn > 0 ? `${title} · 第${turn}轮` : title;
}

/** 从草稿中解析全部会话引用；按 id + turn 去重，最多保留 3 个。 */
export function parseSessionReferences(text: string): SessionReference[] {
	const seen = new Set<string>();
	const refs: SessionReference[] = [];
	for (const match of text.matchAll(TOKEN)) {
		const id = match[2] ?? '';
		if (!SESSION_ID.test(id)) continue;
		const turnRaw = match[3] === undefined ? undefined : Number(match[3]);
		const turn = Number.isInteger(turnRaw) && (turnRaw ?? 0) > 0 ? turnRaw : undefined;
		const key = `${id}#${turn ?? 0}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const title = unescapeTitle(match[1] ?? '').trim();
		refs.push({
			kind: 'session',
			id,
			...(title ? { title } : {}),
			...(turn !== undefined ? { turn } : {}),
		});
		if (refs.length >= MAX_SESSION_REFERENCES) break;
	}
	return refs;
}
