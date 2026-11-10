/**
 * 技能正文的解析层：AgentTemplate（CARD）钉住的 skill → 真正注入 prompt 的文本块。
 *
 * 会话装配（server/chat.ts）和模板预览（server/agents.ts）都走这里：预览要能显示
 * "模型会收到的原文"，就不能在页面里再拼一遍。
 *
 * 真相在技能库里（runtime/skillstore，见 server/skills.ts）：CARD 只钉引用
 * （`name` 或 `name@sha256:<前缀>`），注入时现读现算 hash，内容对不上就不注入。
 *
 * 技能注入的唯一来源就是技能库：CARD 钉住什么，本轮就注入什么。
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { listSkills } from './skills.ts';

export type SkillBlock = { id: string; sha256: string; text: string };

/** 模板页的技能勾选项（/api/agents 用）。 */
export async function availableSkills(): Promise<
	{ id: string; state: string; version: string; main: string; injected: boolean }[]
> {
	const snapshot = await listSkills();
	const inPrompt = new Set(
		snapshot.composition.skills.filter((skill) => skill.inPrompt).map((skill) => skill.name),
	);
	return snapshot.entries.map((entry) => ({
		id: entry.name,
		// trust 直接当状态展示：audited / unreviewed / blocked
		state: entry.trust,
		version: entry.treeHash.slice(0, 12),
		main: entry.specFields.description || entry.name,
		injected: inPrompt.has(entry.name),
	}));
}

/**
 * 按 CARD 钉住的引用取 SKILL.md 原文。
 *
 * `@sha256` 里的 hash 是防盗校验，不是选择器：内容被悄悄替换时不注入并告警，
 * 而不是把替换后的内容当成本来那份钉进去。
 */
export async function blocksForPinned(refs: string[]): Promise<SkillBlock[]> {
	if (!refs.length) return [];
	const { entries } = await listSkills();
	const byName = new Map(entries.map((entry) => [entry.name, entry]));
	const blocks: SkillBlock[] = [];
	for (const raw of refs) {
		const [name, pinned] = String(raw).split('@');
		const entry = byName.get(name);
		if (!entry) {
			process.stderr.write(`[skills] 模板钉住的 skill 不存在：${name}\n`);
			continue;
		}
		try {
			const text = await readFile(join(entry.dir, 'SKILL.md'), 'utf8');
			const sha256 = createHash('sha256').update(text).digest('hex');
			const expected = (pinned ?? '').replace(/^sha256:/, '');
			if (expected && !sha256.startsWith(expected)) {
				process.stderr.write(`[skills] ${name} 的内容与模板钉住的 hash 不符，跳过注入\n`);
				continue;
			}
			blocks.push({ id: name, sha256, text });
		} catch {
			process.stderr.write(`[skills] ${name} 的 SKILL.md 读不到，跳过注入\n`);
		}
	}
	return blocks;
}
