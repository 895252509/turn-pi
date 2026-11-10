/**
 * Input trigger 的 React 适配层：菜单状态、异步候选、键盘、光标恢复。
 * 业务规则都在 source 里；这里只做通用交互。
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type RefObject } from 'react';
import { detectTrigger, sameHit } from './detect';
import { inputTriggerRegistry } from './registry';
import type {
	PickOutcome,
	TriggerCandidate,
	TriggerContext,
	TriggerHit,
	TriggerPick,
} from './types';

interface MenuState {
	open: boolean;
	hit: TriggerHit | null;
	items: TriggerCandidate[];
	highlight: number;
	loading: boolean;
}

const CLOSED: MenuState = { open: false, hit: null, items: [], highlight: 0, loading: false };

interface Options {
	draft: string;
	setDraft(text: string): void;
	inputRef: RefObject<HTMLTextAreaElement | null>;
	context: TriggerContext;
}

export interface InputTriggerController {
	open: boolean;
	items: readonly TriggerCandidate[];
	highlight: number;
	loading: boolean;
	track(draft: string, caret: number): void;
	pick(index: number): Promise<void>;
	hover(index: number): void;
	refresh(): void;
	dismiss(): void;
	handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean;
	adjudicate(line: string, attachments: number): Promise<boolean>;
}

function clampHighlight(index: number, length: number): number {
	if (length <= 0) return 0;
	return Math.max(0, Math.min(index, length - 1));
}

export function useInputTriggers({ draft, setDraft, inputRef, context }: Options): InputTriggerController {
	const [state, setState] = useState<MenuState>(CLOSED);
	const stateRef = useRef(state);
	stateRef.current = state;
	const ctxRef = useRef(context);
	ctxRef.current = context;
	const draftRef = useRef(draft);
	draftRef.current = draft;
	const fetchRef = useRef<AbortController | null>(null);
	const generationRef = useRef(0);
	const dismissedRef = useRef<{ trigger: string; query: string; start: number; end: number } | null>(null);
	const pendingCaretRef = useRef<number | null>(null);
	const setDraftRef = useRef(setDraft);
	setDraftRef.current = setDraft;
	const version = useSyncExternalStore(
		inputTriggerRegistry.subscribe,
		inputTriggerRegistry.getVersion,
		inputTriggerRegistry.getVersion,
	);

	const close = useCallback(() => {
		fetchRef.current?.abort();
		fetchRef.current = null;
		generationRef.current += 1;
		setState((current) => (current.open || current.hit ? CLOSED : current));
	}, []);

	const dismiss = useCallback(() => {
		const hit = stateRef.current.hit;
		dismissedRef.current = hit
			? { trigger: hit.trigger, query: hit.query, start: hit.start, end: hit.end }
			: null;
		close();
	}, [close]);

	const applyOutcome = useCallback((outcome: PickOutcome, hit: TriggerHit) => {
		if (outcome.kind === 'error') {
			close();
			ctxRef.current.toast(outcome.message);
			return;
		}
		if (outcome.kind === 'run') {
			close();
			void ctxRef.current.runCommand(outcome.command, outcome.args, outcome.line ?? `/${outcome.command}`);
			return;
		}
		if (outcome.kind === 'insert' || outcome.kind === 'replace') {
			const current = inputRef.current?.value ?? draftRef.current;
			const start = outcome.kind === 'replace' ? outcome.start : hit.start;
			const end = outcome.kind === 'replace' ? outcome.end : hit.end;
			const text = outcome.text;
			const caret = start + (outcome.caretOffset ?? text.length);
			const next = current.slice(0, start) + text + current.slice(end);
			pendingCaretRef.current = caret;
			setDraftRef.current(next);
			close();
			return;
		}
		close();
	}, [close, inputRef]);

	const fetchCandidates = useCallback(async (hit: TriggerHit) => {
		const sources = inputTriggerRegistry.list(hit.trigger);
		if (!sources.length) {
			close();
			return;
		}
		fetchRef.current?.abort();
		const controller = new AbortController();
		fetchRef.current = controller;
		const generation = ++generationRef.current;
		setState((current) => ({
			open: true,
			hit,
			items: current.hit?.trigger === hit.trigger ? current.items : [],
			highlight: current.hit?.trigger === hit.trigger ? current.highlight : 0,
			loading: true,
		}));
		const results = await Promise.allSettled(
			sources.map(async (source) => {
				const items = await source.candidates(ctxRef.current, {
					query: hit.query,
					position: hit.position,
					signal: controller.signal,
				});
				return items.map((item) => ({ ...item, source: source.name }));
			}),
		);
		if (controller.signal.aborted || generation !== generationRef.current) return;
		for (const result of results) {
			if (result.status === 'rejected') console.error('[input-trigger] candidates failed:', result.reason);
		}
		const items = results.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
		if (controller.signal.aborted || generation !== generationRef.current) return;
		setState((current) => ({
			open: true,
			hit,
			items,
			highlight: clampHighlight(current.highlight, items.length),
			loading: false,
		}));
	}, [close]);

	const track = useCallback((nextDraft: string, caret: number) => {
		const hit = detectTrigger(nextDraft, caret);
		if (!hit) {
			close();
			return;
		}
		const dismissed = dismissedRef.current;
		if (dismissed && sameHit(dismissed, hit)) {
			close();
			return;
		}
		dismissedRef.current = null;
		const current = stateRef.current;
		if (
			current.open &&
			current.hit &&
			current.hit.trigger === hit.trigger &&
			current.hit.query === hit.query &&
			current.hit.start === hit.start &&
			current.hit.end === hit.end
		) {
			return;
		}
		void fetchCandidates(hit);
	}, [close, fetchCandidates]);

	const hover = useCallback((index: number) => {
		setState((prev) => ({ ...prev, highlight: clampHighlight(index, prev.items.length) }));
	}, []);

	const pick = useCallback(async (index: number) => {
		const current = stateRef.current;
		if (current.loading) return;
		const item = current.items[index];
		const hit = current.hit;
		if (!item || !hit) return;
		const source = inputTriggerRegistry.list(hit.trigger).find((candidate) => candidate.name === item.source);
		if (!source) return;
		const pickValue: TriggerPick = {
			candidate: item,
			hit,
			line: `${hit.trigger}${hit.query}`,
		};
		try {
			const outcome = await source.onPick(pickValue, ctxRef.current);
			applyOutcome(outcome, hit);
		} catch (error) {
			ctxRef.current.toast(error instanceof Error ? error.message : String(error));
			close();
		}
	}, [applyOutcome, close]);

	const refresh = useCallback(() => {
		const current = stateRef.current;
		if (current.open && current.hit) void fetchCandidates(current.hit);
	}, [fetchCandidates]);

	const handleKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
		if (event.nativeEvent.isComposing || event.keyCode === 229) return false;
		const current = stateRef.current;
		if (!current.open) return false;
		switch (event.key) {
			case 'ArrowDown':
				event.preventDefault();
				setState((prev) => ({
					...prev,
					highlight: prev.items.length ? (prev.highlight + 1) % prev.items.length : 0,
				}));
				return true;
			case 'ArrowUp':
				event.preventDefault();
				setState((prev) => ({
					...prev,
					highlight: prev.items.length ? (prev.highlight - 1 + prev.items.length) % prev.items.length : 0,
				}));
				return true;
			case 'Tab':
				if (event.shiftKey) {
					event.preventDefault();
					dismiss();
					return true;
				}
				if (!current.items.length) return false;
				event.preventDefault();
				if (current.loading) return true;
				void pick(current.highlight);
				return true;
			case 'Enter':
				if (!current.items.length) return false;
				if (current.loading) { event.preventDefault(); return true; }
				event.preventDefault();
				void pick(current.highlight);
				return true;
			case 'Escape':
				event.preventDefault();
				dismiss();
				return true;
			default:
				return false;
		}
	}, [dismiss, pick]);

	const adjudicate = useCallback(async (line: string, attachments: number): Promise<boolean> => {
		for (const source of inputTriggerRegistry.all()) {
			if (!source.matchEnter || !line.startsWith(source.trigger)) continue;
			let outcome: PickOutcome | undefined;
			try {
				outcome = await source.matchEnter(line, ctxRef.current, { attachments });
			} catch (error) {
				ctxRef.current.toast(error instanceof Error ? error.message : String(error));
				return true;
			}
			if (outcome === undefined) continue;
			close();
			if (outcome.kind === 'run') {
				await ctxRef.current.runCommand(outcome.command, outcome.args, outcome.line ?? line);
			} else if (outcome.kind === 'error') {
				ctxRef.current.toast(outcome.message);
			} else {
				applyOutcome(outcome, {
					trigger: source.trigger,
					query: '',
					start: 0,
					end: line.length,
					position: 'leading',
				});
			}
			return true;
		}
		return false;
	}, [applyOutcome, close]);

	// 注册表变化：预热新 source；菜单开着时重新取候选。
	useEffect(() => {
		for (const source of inputTriggerRegistry.all()) source.warm?.(ctxRef.current);
		const current = stateRef.current;
		if (current.open && current.hit) void fetchCandidates(current.hit);
	}, [version, fetchCandidates]);

	// 插入 token 后恢复光标；普通输入不会设置 pendingCaret。
	useEffect(() => {
		const caret = pendingCaretRef.current;
		if (caret === null) return;
		const el = inputRef.current;
		pendingCaretRef.current = null;
		if (!el) return;
		el.focus();
		el.setSelectionRange(caret, caret);
		track(el.value, caret);
	}, [draft, inputRef, track]);

	useEffect(() => () => fetchRef.current?.abort(), []);

	return {
		open: state.open,
		items: state.items,
		highlight: state.highlight,
		loading: state.loading,
		track,
		pick,
		hover,
		refresh,
		dismiss,
		handleKeyDown,
		adjudicate,
	};
}
