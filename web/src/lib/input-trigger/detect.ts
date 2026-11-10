/**
 * 触发检测：从光标向前找最近的 / 或 @ token。
 *
 * 规则参考 dsh：
 * - / 只在行首触发（v1 不做行内命令），避免和 `/workspace/...` 这类绝对路径冲突；
 * - @ 可以行内触发；
 * - token 内不能有空白；
 * - URL 里的 /（`https://`、`//`）不触发；
 * - 已经成形的 @[标题](session:...) 不再打开菜单。
 */
import type { TriggerChar, TriggerHit } from './types';

const WHITESPACE = /\s/u;
const WORD_CHAR = /[\p{L}\p{N}_]/u;

/** 触发符是否处在词边界。 */
function boundaryOk(draft: string, index: number, char: TriggerChar): boolean {
	if (index === 0) return true;
	const prev = draft.charAt(index - 1);
	if (WHITESPACE.test(prev)) return true;
	if (WORD_CHAR.test(prev)) return false;
	if (char === '/') {
		if (prev === '/') return false;
		if (prev === ':' && index >= 2 && !WHITESPACE.test(draft.charAt(index - 2))) return false;
	}
	return true;
}

/** 已经插入的会话 token 内部不再触发 @ 菜单。 */
function insideReferenceToken(query: string): boolean {
	if (query.startsWith('[')) return true;
	return query.includes('](') || query.includes('#turn=');
}

/** 找光标所在的 trigger token；没有则 null。 */
export function detectTrigger(draft: string, caret: number): TriggerHit | null {
	const end = Math.max(0, Math.min(caret, draft.length));
	for (let index = end - 1; index >= 0; index--) {
		const char = draft.charAt(index);
		if (WHITESPACE.test(char)) return null;
		if (char !== '/' && char !== '@') continue;
		if (!boundaryOk(draft, index, char)) continue;
		const query = draft.slice(index + 1, end);
		const position = draft.slice(0, index).trim().length === 0 ? 'leading' : 'inline';
		if (char === '/') {
			// v1 命令只认行首，且查询里出现 / 视为路径，不弹命令菜单。
			if (position !== 'leading' || query.includes('/')) return null;
		} else if (insideReferenceToken(query)) {
			continue;
		}
		return { trigger: char, query, start: index, end, position };
	}
	return null;
}

/** dsh 同款命令语法：/name + 空白/结尾；rawInput 保留分隔空白。 */
const COMMAND_LINE = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])([\s\S]*)$/u;

export interface ParsedCommandLine {
	name: string;
	rawInput: string;
	args: string;
}

/** 解析一整行命令；不是合法命令语法时返回 undefined。 */
export function parseCommandLine(line: string): ParsedCommandLine | undefined {
	const match = COMMAND_LINE.exec(line);
	if (match === null) return undefined;
	const name = match[1];
	if (name === undefined) return undefined;
	const rawInput = match[2] ?? '';
	return { name, rawInput, args: rawInput.trim() };
}

/** 与 dsh 的 dismissed 语义一致：同一个 token/查询不因光标移动重新弹开。 */
export function sameHit(
	a: { trigger: string; query: string; start: number; end: number } | null,
	b: TriggerHit | null,
): boolean {
	return Boolean(a && b && a.trigger === b.trigger && a.query === b.query && a.start === b.start && a.end === b.end);
}
