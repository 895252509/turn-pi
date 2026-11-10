/**
 * MCP 模块的前端状态。
 *
 * 和技能模块一样单独一个 zustand store：MCP 面板的读取 / 保存 / 探测不该吵到对话 store，
 * 也不能因为面板刷新去碰会话。真正连服务器的还是每个会话自己的 MCP 扩展（见 docs/mcp.md），
 * 这里只做三件事：读配置、改配置、点一下 "测试" 连一次看看。
 */

import { create } from 'zustand';
import { api } from './api';

export type McpExposure = 'codemode' | 'deferred' | 'direct' | 'hidden';
export type McpTransportKind = 'stdio' | 'http';

/** 与 SDK 的 `McpServerConfig` 同形；UI 只编辑其中一部分。 */
export interface McpServerConfig {
	type?: McpTransportKind | 'streamable-http';
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	url?: string;
	headers?: Record<string, string>;
	description?: string;
	exposure?: McpExposure;
	enabled?: boolean;
	timeout?: number;
	toolExposure?: Record<string, string>;
}

export interface McpServerView {
	name: string;
	transport: McpTransportKind;
	config: McpServerConfig;
	/** 文件里的原始条目：保存时合并，保住 auth 等前端不认识的键。 */
	raw: Record<string, unknown>;
}

export interface McpSnapshot {
	ok: true;
	/** `false` = 服务端 `PI_MCP=0`，配置能改但会话不会连。 */
	enabled: boolean;
	file: string;
	exists: boolean;
	autoEnableCodemode?: boolean;
	servers: McpServerView[];
	/** 坏条目 / 坏 JSON 的说明；单独展示，不影响其他服务器。 */
	errors: string[];
}

export interface McpToolInfo {
	name: string;
	title?: string;
	description?: string;
}

export interface McpProbeResult {
	ok: boolean;
	name: string;
	transport: McpTransportKind;
	ms: number;
	serverInfo?: { name: string; version: string };
	protocolVersion?: string;
	instructions?: string;
	tools: McpToolInfo[];
	error?: string;
	stderr?: string;
}

export interface McpProbeEntry {
	at: number;
	/** 草稿探测还是已保存配置探测：草稿结果不能当成"这台服务器是好的"。 */
	draft: boolean;
	result: McpProbeResult;
}

export interface McpApplyResult {
	ok: true;
	applied: string[];
	skipped: Array<{ id: string; reason: string }>;
	failed: Array<{ id: string; error: string }>;
}

export const EXPOSURE_LABELS: Record<McpExposure, string> = {
	codemode: 'codemode（脚本里调）',
	deferred: 'deferred（按需声明）',
	direct: 'direct（直接声明，暂不支持）',
	hidden: 'hidden（隐藏）',
};

export const EXPOSURES: McpExposure[] = ['codemode', 'deferred', 'direct', 'hidden'];

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

interface McpState {
	snapshot: McpSnapshot | null;
	loading: boolean;
	error: string | null;
	/** 进行中的动作：`load` / `save` / `remove:<name>` / `enable:<name>` / `test:<name>` / `apply` */
	pending: string | null;
	probes: Record<string, McpProbeEntry>;
	load: () => Promise<void>;
	save: (name: string, config: McpServerConfig) => Promise<void>;
	remove: (name: string) => Promise<void>;
	setEnabled: (name: string, enabled: boolean) => Promise<void>;
	test: (name: string, config?: McpServerConfig) => Promise<McpProbeResult>;
	apply: () => Promise<McpApplyResult>;
	clearProbe: (name: string) => void;
}

export const useMcp = create<McpState>((set, get) => ({
	snapshot: null,
	loading: false,
	error: null,
	pending: null,
	probes: {},

	load: async () => {
		set({ loading: true, error: null });
		try {
			set({ snapshot: await api<McpSnapshot>('/api/mcp'), loading: false });
		} catch (error) {
			set({ loading: false, error: messageOf(error) });
		}
	},

	save: async (name, config) => {
		set({ pending: 'save', error: null });
		try {
			set({ snapshot: await api<McpSnapshot>('/api/mcp/save', { name, config }), pending: null });
			// 改了配置后旧的探测结果不再代表当前条目
			get().clearProbe(name);
		} catch (error) {
			set({ pending: null, error: messageOf(error) });
			throw error;
		}
	},

	remove: async (name) => {
		set({ pending: `remove:${name}`, error: null });
		try {
			set({ snapshot: await api<McpSnapshot>('/api/mcp/remove', { name }), pending: null });
			get().clearProbe(name);
		} catch (error) {
			set({ pending: null, error: messageOf(error) });
			throw error;
		}
	},

	setEnabled: async (name, enabled) => {
		set({ pending: `enable:${name}`, error: null });
		try {
			set({ snapshot: await api<McpSnapshot>('/api/mcp/enable', { name, enabled }), pending: null });
		} catch (error) {
			set({ pending: null, error: messageOf(error) });
			throw error;
		}
	},

	test: async (name, config) => {
		set({ pending: `test:${name}`, error: null });
		try {
			const body = await api<{ ok: boolean; enabled: boolean; probe: McpProbeResult }>('/api/mcp/test', {
				name,
				...(config ? { config } : {}),
			});
			set((state) => ({
				pending: null,
				probes: { ...state.probes, [name]: { at: Date.now(), draft: Boolean(config), result: body.probe } },
			}));
			return body.probe;
		} catch (error) {
			set({ pending: null, error: messageOf(error) });
			throw error;
		}
	},

	apply: async () => {
		set({ pending: 'apply', error: null });
		try {
			const result = await api<McpApplyResult>('/api/mcp/apply', {});
			set({ pending: null });
			return result;
		} catch (error) {
			set({ pending: null, error: messageOf(error) });
			throw error;
		}
	},

	clearProbe: (name) =>
		set((state) => {
			if (!(name in state.probes)) return state;
			const probes = { ...state.probes };
			delete probes[name];
			return { probes };
		}),
}));
