/**
 * GitHub 技能市场的浏览状态。
 *
 * 与已安装技能（useSkills）分开：市场目录来自 GitHub，已安装状态来自本地 store。
 * 安装后两边都刷新一次，卡片上的「已装」和详情里的 trust 才不会滞后。
 */

import { create } from 'zustand';
import { api } from './api';
import { useSkills, type SkillTrust } from './skills';

export interface MarketSource {
	id: string;
	repo: string;
	url: string;
	label: string;
	license: string;
	category: string;
	ref: string;
	stars: number;
	forks: number;
	openIssues: number;
	description?: string;
	updatedAt?: string;
	skillCount: number;
	installed: number;
	deprecated?: boolean;
	note?: string;
	error?: string;
}

export interface MarketSkill {
	key: string;
	sourceId: string;
	sourceLabel: string;
	repo: string;
	path: string;
	name: string;
	description: string;
	category: string;
	tags: string[];
	license?: string;
	ref: string;
	/** tree sha：ref 是分支名，用它才能在 UI 上看出“固定到哪一版” */
	tree?: string;
	stars: number;
	forks: number;
	deprecated?: boolean;
	installs: number;
	installed: boolean;
	trust?: SkillTrust;
}

export interface MarketCatalog {
	updatedAt: number;
	cached: boolean;
	refreshing: boolean;
	sources: MarketSource[];
	skills: MarketSkill[];
	categories: Array<{ id: string; label: string; count: number }>;
	diagnostics: string[];
}

export interface MarketItem {
	skill: MarketSkill;
	content: string;
}

interface MarketState {
	catalog: MarketCatalog | null;
	loading: boolean;
	refreshing: boolean;
	error: string | null;
	query: string;
	category: string;
	sourceId: string;
	onlyInstalled: boolean;
	selectedKey: string | null;
	load: (force?: boolean) => Promise<void>;
	install: (skill: MarketSkill) => Promise<void>;
	setQuery: (query: string) => void;
	setCategory: (category: string) => void;
	setSource: (sourceId: string) => void;
	setOnlyInstalled: (value: boolean) => void;
	select: (key: string | null) => void;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export const useSkillMarket = create<MarketState>((set, get) => ({
	catalog: null,
	loading: false,
	refreshing: false,
	error: null,
	query: '',
	category: 'all',
	sourceId: 'all',
	onlyInstalled: false,
	selectedKey: null,

	load: async (force = false) => {
		const first = !get().catalog;
		set({ loading: first, refreshing: Boolean(force), error: null });
		try {
			const catalog = await api<MarketCatalog>(`/api/skills/market${force ? '?refresh=1' : ''}`);
			set({ catalog, loading: false, refreshing: false });
		} catch (error) {
			set({ loading: false, refreshing: false, error: messageOf(error) });
		}
	},

	install: async (skill) => {
		set({ error: null });
		try {
			await api('/api/skills/install', {
				source: {
					kind: 'market',
					id: `https://github.com/${skill.repo}.git`,
					url: `https://github.com/${skill.repo}.git`,
					ref: skill.ref,
					subdir: skill.path,
				},
				activate: true,
			});
			await Promise.all([get().load(), useSkills.getState().load()]);
		} catch (error) {
			set({ error: messageOf(error) });
			throw error;
		}
	},

	setQuery: (query) => set({ query }),
	setCategory: (category) => set({ category }),
	setSource: (sourceId) => set({ sourceId }),
	setOnlyInstalled: (onlyInstalled) => set({ onlyInstalled }),
	select: (selectedKey) => set({ selectedKey }),
}));

export function marketItemUrl(skill: MarketSkill): string {
	return `/api/skills/market/item?source=${encodeURIComponent(skill.sourceId)}&path=${encodeURIComponent(skill.path)}`;
}
