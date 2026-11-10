/**
 * 会话 cwd 查询：给文件引用解析用。
 *
 * 活着的 Chat 在 init 时登记 cwd；会话被回收/进程重启后，退回读会话 JSONL header。
 * 这样 `/api/files/resolve` 不依赖 ChatRegistry，也不会和 chat.ts 形成循环依赖。
 */

import { SessionManager } from '@earendil-works/pi-coding-agent';

const SESSION_DIR = process.env.PI_SESSION_DIR ?? '/sessions';
const liveCwds = new Map<string, string>();

export function registerLiveCwd(sessionId: string, cwd: string): void {
	if (!sessionId || !cwd) return;
	liveCwds.set(sessionId, cwd);
}

export function unregisterLiveCwd(sessionId: string): void {
	liveCwds.delete(sessionId);
}

/** 按 pi sessionId（或会话文件路径）取 cwd；找不到返回 undefined。 */
export async function sessionCwd(sessionId: string): Promise<string | undefined> {
	const live = liveCwds.get(sessionId);
	if (live) return live;
	try {
		const entries = await SessionManager.listAll(SESSION_DIR);
		const entry = entries.find((item) => item.id === sessionId || item.path === sessionId);
		return entry?.cwd || undefined;
	} catch {
		return undefined;
	}
}
