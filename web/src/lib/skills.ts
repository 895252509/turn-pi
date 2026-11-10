/**
 * 技能模块的前端状态。
 *
 * 单独一个 zustand store，避免把技能库的 loading / pending 塞进全局聊天 store：
 * 技能面板可以在不接收 SSE、不影响会话状态的情况下独立刷新。
 */

import { create } from 'zustand';
import { api } from './api';

export type SkillTrust = 'audited' | 'unreviewed' | 'blocked';

export type SkillSource =
	| { kind: 'market'; id: string; url?: string; package?: string; ref?: string; subdir?: string; subdirs?: string[] }
	| { kind: 'local'; path: string }
	| { kind: 'package'; package: string };

export interface SkillSpecFields {
	description?: string;
	license?: string;
	compatibility?: string;
	allowedTools?: string[];
	disableModelInvocation?: boolean;
}

export interface SkillAudit {
	by: string;
	at: number;
	treeHash: string;
	note?: string;
}

export interface SkillEntry {
	name: string;
	source: SkillSource;
	treeHash: string;
	dir: string;
	trust: SkillTrust;
	hasScripts: boolean;
	specFields: SkillSpecFields;
	installedAt: number;
	installedBy: string;
	bytes: number;
	available?: boolean;
	audits?: SkillAudit[];
	warnings?: string[];
}

export interface SkillSelection {
	mode: 'only' | 'add';
	refs: string[];
	policy: {
		onConflict: 'template-order' | 'error' | 'last-wins';
		maxSkills: number;
		unreviewed: 'manual-only' | 'prompt';
	};
	updatedAt: number;
	updatedBy: string;
}

export interface SkillCompositionItem {
	ref: string;
	name: string;
	treeHash: string;
	source: SkillSource;
	trust: SkillTrust;
	dir: string;
	hasScripts: boolean;
	inPrompt: boolean;
	specFields: SkillSpecFields;
}

export interface SkillConflict {
	name: string;
	kept: string;
	dropped: string;
	reason: 'duplicate-name' | 'missing' | 'blocked' | 'over-cap';
}

export interface SkillSnapshot {
	store: string;
	indexFile: string;
	updatedAt: number;
	entries: SkillEntry[];
	selection: SkillSelection;
	composition: {
		skills: SkillCompositionItem[];
		conflicts: SkillConflict[];
		warnings: string[];
		tokens: number;
		maxSkills: number;
		mode: 'only' | 'add';
	};
	diagnostics: string[];
}

export type InstallSource =
	| { kind: 'local'; path: string }
	| { kind: 'market'; url?: string; package?: string; ref?: string; subdir?: string; subdirs?: string[] };

interface SkillsState {
	snapshot: SkillSnapshot | null;
	/** 当前选中的技能（`name@sha256:...`），侧栏和主面板共用。 */
	selected: string | null;
	loading: boolean;
	pending: string | null;
	error: string | null;
	setSelected: (key: string | null) => void;
	load: () => Promise<void>;
	install: (source: InstallSource) => Promise<SkillEntry[]>;
	audit: (name: string, treeHash: string, trust: SkillTrust, note?: string) => Promise<void>;
	remove: (name: string, treeHash: string) => Promise<void>;
	select: (refs: string[]) => Promise<void>;
	refresh: (name?: string) => Promise<void>;
	apply: (sessionId: string) => Promise<{ paths: string[]; skills: SkillCompositionItem[]; diagnostics: string[] }>;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function skillRef(entry: Pick<SkillEntry, 'name' | 'treeHash'>): string {
	return `${entry.name}@sha256:${entry.treeHash}`;
}

export function sourceKindLabel(source: SkillSource): string {
	if (source.kind === 'market') return source.package ? 'npm' : '市场';
	if (source.kind === 'local') return '本地';
	return '插件';
}

export function sourceDetail(source: SkillSource): string {
	if (source.kind === 'market') return source.package ?? source.url ?? source.id;
	if (source.kind === 'local') return source.path;
	return source.package;
}

export function trustLabel(trust: SkillTrust): string {
	if (trust === 'audited') return '已审计';
	if (trust === 'blocked') return '已拉黑';
	return '未审计';
}

export function shortHash(hash: string): string {
	return hash.slice(0, 12);
}

export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export const useSkills = create<SkillsState>((set, get) => ({
	snapshot: null,
	selected: null,
	setSelected: (selected) => set({ selected }),
	loading: false,
	pending: null,
	error: null,

	load: async () => {
		set({ loading: true, error: null });
		try {
			const snapshot = await api<SkillSnapshot>('/api/skills');
			set({ snapshot, loading: false });
		} catch (error) {
			set({ loading: false, error: messageOf(error) });
		}
	},

	install: async (source) => {
		set({ pending: 'install', error: null });
		try {
			const result = await api<{ installed: SkillEntry[]; entries: SkillEntry[]; selection: SkillSelection }>('/api/skills/install', { source });
			const snapshot = await api<SkillSnapshot>('/api/skills');
			set({ snapshot, pending: null });
			return result.installed ?? [];
		} catch (error) {
			set({ pending: null, error: messageOf(error) });
			throw error;
		}
	},

	audit: async (name, treeHash, trust, note) => {
		set({ pending: `audit:${name}`, error: null });
		try {
			await api('/api/skills/audit', { name, treeHash, trust, note });
			set({ snapshot: await api<SkillSnapshot>('/api/skills'), pending: null });
		} catch (error) {
			set({ pending: null, error: messageOf(error) });
			throw error;
		}
	},

	remove: async (name, treeHash) => {
		set({ pending: `remove:${name}`, error: null });
		try {
			await api('/api/skills/remove', { name, treeHash });
			set({ snapshot: await api<SkillSnapshot>('/api/skills'), pending: null });
		} catch (error) {
			set({ pending: null, error: messageOf(error) });
			throw error;
		}
	},

	select: async (refs) => {
		const current = get().snapshot;
		set({ pending: 'select', error: null });
		try {
			await api('/api/skills/select', {
				refs,
				mode: current?.selection.mode ?? 'only',
				policy: current?.selection.policy,
			});
			set({ snapshot: await api<SkillSnapshot>('/api/skills'), pending: null });
		} catch (error) {
			set({ pending: null, error: messageOf(error) });
			throw error;
		}
	},

	refresh: async (name) => {
		set({ pending: 'refresh', error: null });
		try {
			await api('/api/skills/refresh', name ? { name } : {});
			set({ snapshot: await api<SkillSnapshot>('/api/skills'), pending: null });
		} catch (error) {
			set({ pending: null, error: messageOf(error) });
			throw error;
		}
	},

	apply: async (sessionId) => {
		set({ pending: 'apply', error: null });
		try {
			const result = await api<{ paths: string[]; skills: SkillCompositionItem[]; diagnostics: string[] }>(
				`/api/session/${encodeURIComponent(sessionId)}/skills/apply`,
				{},
			);
			set({ pending: null });
			return result;
		} catch (error) {
			set({ pending: null, error: messageOf(error) });
			throw error;
		}
	},
}));
