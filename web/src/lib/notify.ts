/**
 * 本轮完成提醒。
 *
 * 设计取舍：
 *   - 总开关关闭：完全不提醒（前台也不弹 toast）。
 *   - 页面在前台：弹一条完成 toast + 提示音。
 *   - 页面在后台 / 窗口失焦：系统通知（需授权）+ 提示音 + 标题未读标记。
 *   - 通知授权、提示音都不可用时，标题标记仍然生效，功能不会“看起来开了但什么也没发生”。
 *   - 所有状态都存 localStorage；音频上下文必须在用户手势里创建，未交互过的页面不会自动响。
 */

import { storage } from './api';

export type NotifyPermission = NotificationPermission | 'unsupported';

export interface NotifySettings {
	/** 总开关；关闭后所有完成提醒通道都停用 */
	enabled: boolean;
	/** 后台完成时播放提示音 */
	sound: boolean;
	/** 会话请求人工审批时播放审核铃声（独立于完成提醒总开关） */
	approvalSound: boolean;
}

export interface TurnDoneNotice {
	sessionId?: string | null;
	title: string;
	body: string;
}

const SETTINGS_KEY = 'turnpi-notify';
const BASE_TITLE = typeof document !== 'undefined' && document.title ? document.title : 'pi · webchat';
const NOTIFICATION_TAG = 'turnpi-turn-done';

const DEFAULT_SETTINGS: NotifySettings = { enabled: false, sound: true, approvalSound: true };

export function loadNotifySettings(): NotifySettings {
	try {
		const raw = storage.get(SETTINGS_KEY);
		if (!raw) return { ...DEFAULT_SETTINGS };
		const parsed = JSON.parse(raw) as Partial<NotifySettings>;
		return {
			enabled: parsed.enabled === true,
			sound: parsed.sound !== false,
			approvalSound: parsed.approvalSound !== false,
		};
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

export function saveNotifySettings(settings: NotifySettings) {
	storage.set(SETTINGS_KEY, JSON.stringify(settings));
}

export function currentNotifyPermission(): NotifyPermission {
	if (typeof window === 'undefined') return 'unsupported';
	const api = window.Notification;
	if (!api) return 'unsupported';
	return api.permission;
}

/** 只能在用户手势（点击 / 按键）里调用；浏览器会忽略其他时机的授权请求。 */
export async function requestNotifyPermission(): Promise<NotifyPermission> {
	if (typeof window === 'undefined') return 'unsupported';
	const api = window.Notification;
	if (!api) return 'unsupported';
	if (api.permission !== 'default') return api.permission;
	try {
		const result = await api.requestPermission();
		return result;
	} catch {
		return api.permission;
	}
}

export function isPageBackground(): boolean {
	if (typeof document === 'undefined') return false;
	return document.visibilityState === 'hidden' || !document.hasFocus();
}

// ---------- 标题未读标记 ----------
let unreadTurns = 0;

export function markDoneTitle() {
	if (typeof document === 'undefined') return;
	unreadTurns += 1;
	document.title = `(${unreadTurns}) ✓ 本轮完成 · ${BASE_TITLE}`;
}

export function clearDoneTitle() {
	if (typeof document === 'undefined') return;
	if (unreadTurns === 0 && document.title === BASE_TITLE) return;
	unreadTurns = 0;
	document.title = BASE_TITLE;
}

// ---------- 提示音（不依赖音频文件） ----------
type AudioContextCtor = typeof AudioContext;

let audio: AudioContext | null = null;
let audioUnavailable = false;

function audioCtor(): AudioContextCtor | null {
	if (typeof window === 'undefined') return null;
	const w = window as Window & {
		AudioContext?: AudioContextCtor;
		webkitAudioContext?: AudioContextCtor;
	};
	return (w.AudioContext ?? w.webkitAudioContext) ?? null;
}

function audioContext(): AudioContext | null {
	if (audio || audioUnavailable) return audio;
	const Ctor = audioCtor();
	if (!Ctor) {
		audioUnavailable = true;
		return null;
	}
	try {
		audio = new Ctor();
	} catch {
		audioUnavailable = true;
		audio = null;
	}
	return audio;
}

/** 在 pointerdown / keydown / send 时调用，把 AudioContext 从 suspended 状态解锁。 */
export function primeAudio() {
	const ctx = audioContext();
	if (!ctx) return;
	if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
}

function chime(ctx: AudioContext) {
	const start = ctx.currentTime + 0.02;
	const notes = [
		{ freq: 784, offset: 0, duration: 0.14 },
		{ freq: 1046.5, offset: 0.1, duration: 0.22 },
	];
	for (const note of notes) {
		const osc = ctx.createOscillator();
		const gain = ctx.createGain();
		osc.type = 'sine';
		osc.frequency.setValueAtTime(note.freq, start + note.offset);
		gain.gain.setValueAtTime(0.0001, start + note.offset);
		gain.gain.exponentialRampToValueAtTime(0.65, start + note.offset + 0.015);
		gain.gain.exponentialRampToValueAtTime(0.0001, start + note.offset + note.duration);
		osc.connect(gain);
		gain.connect(ctx.destination);
		osc.start(start + note.offset);
		osc.stop(start + note.offset + note.duration + 0.02);
	}
}

export function playDoneSound() {
	const ctx = audioContext();
	if (!ctx) return;
	if (ctx.state === 'suspended') {
		ctx.resume()
			.then(() => {
				if (ctx.state === 'running') chime(ctx);
			})
			.catch(() => {});
		return;
	}
	if (ctx.state === 'running') chime(ctx);
}

/**
 * 审核铃声：急促的三连音，和完成提示的柔和双音明显区分。
 * 同时左边会话列表会闪动，声音只是把人叫回页面。
 */
function approvalRing(ctx: AudioContext) {
	const start = ctx.currentTime + 0.02;
	const notes = [
		{ freq: 880, offset: 0, duration: 0.1 },
		{ freq: 660, offset: 0.13, duration: 0.1 },
		{ freq: 880, offset: 0.26, duration: 0.18 },
	];
	for (const note of notes) {
		const osc = ctx.createOscillator();
		const gain = ctx.createGain();
		osc.type = 'triangle';
		osc.frequency.setValueAtTime(note.freq, start + note.offset);
		gain.gain.setValueAtTime(0.0001, start + note.offset);
		gain.gain.exponentialRampToValueAtTime(0.32, start + note.offset + 0.012);
		gain.gain.exponentialRampToValueAtTime(0.0001, start + note.offset + note.duration);
		osc.connect(gain);
		gain.connect(ctx.destination);
		osc.start(start + note.offset);
		osc.stop(start + note.offset + note.duration + 0.02);
	}
}

export function playApprovalSound() {
	const ctx = audioContext();
	if (!ctx) return;
	if (ctx.state === 'suspended') {
		ctx.resume()
			.then(() => {
				if (ctx.state === 'running') approvalRing(ctx);
			})
			.catch(() => {});
		return;
	}
	if (ctx.state === 'running') approvalRing(ctx);
}

// ---------- 系统通知 ----------
function showSystemNotification(notice: TurnDoneNotice): boolean {
	if (typeof window === 'undefined') return false;
	const api = window.Notification;
	if (!api || api.permission !== 'granted') return false;
	try {
		const notification = new api(notice.title, {
			body: notice.body,
			tag: NOTIFICATION_TAG,
			renotify: true,
			// 声音由页面自己播，避免系统通知音和提示音叠在一起
			silent: true,
			data: { sessionId: notice.sessionId ?? null },
		} as NotificationOptions);
		notification.onclick = () => {
			try {
				window.focus();
			} catch {
				/* 部分浏览器不允许脚本聚焦窗口 */
			}
			clearDoneTitle();
			notification.close();
		};
		return true;
	} catch {
		return false;
	}
}

/**
 * 投递一次“本轮完成”提醒。
 * - 'off'：总开关关闭，调用方什么也不做。
 * - 'background'：已走后台通道（通知/声音/标题），调用方不必再弹 toast。
 * - 'foreground'：页面在前台，调用方弹一条 toast。
 */
export function deliverTurnDone(
	settings: NotifySettings,
	notice: TurnDoneNotice,
): 'off' | 'background' | 'foreground' {
	if (!settings.enabled) return 'off';

	const background = isPageBackground();
	if (background) {
		markDoneTitle();
		showSystemNotification(notice);
	}
	// 前台也响：用户开提醒通常就是为了不用一直盯着页面
	if (settings.sound) playDoneSound();
	return background ? 'background' : 'foreground';
}
