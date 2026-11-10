/** 命令/引用候选的简单排序：前缀优先，其次包含，最后子序列。 */

function normalize(value: string): string {
	return value.toLocaleLowerCase();
}

function subsequence(haystack: string, needle: string): boolean {
	let at = 0;
	for (const char of needle) {
		at = haystack.indexOf(char, at);
		if (at < 0) return false;
		at += 1;
	}
	return true;
}

/**
 * 返回越小越靠前的匹配分；null 表示不匹配。
 * 空查询返回 0，保留 source 给出的顺序。
 */
export function matchScore(query: string, fields: readonly (string | undefined)[]): number | null {
	const needle = normalize(query.trim());
	if (!needle) return 0;
	let best: number | null = null;
	for (const field of fields) {
		if (!field) continue;
		const value = normalize(field);
		let score: number | null = null;
		if (value === needle) score = 0;
		else if (value.startsWith(needle)) score = 1;
		else if (value.includes(needle)) score = 3;
		else if (subsequence(value, needle)) score = 5;
		if (score !== null && (best === null || score < best)) best = score;
	}
	return best;
}

/** 按 score、order、原 index 稳定排序。 */
export function rankByMatch<T>(
	items: readonly T[],
	query: string,
	fields: (item: T) => readonly (string | undefined)[],
	order: (item: T) => number = () => 0,
): T[] {
	const ranked = items
		.map((item, index) => ({ item, index, score: matchScore(query, fields(item)) }))
		.filter((row): row is { item: T; index: number; score: number } => row.score !== null)
		.sort((a, b) => a.score - b.score || order(a.item) - order(b.item) || a.index - b.index);
	return ranked.map((row) => row.item);
}
