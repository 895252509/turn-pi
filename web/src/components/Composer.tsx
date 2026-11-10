import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { Brain, Check, ChevronsUpDown, ImagePlus, Plus, Search, SendHorizontal, TriangleAlert } from 'lucide-react';
import { newId } from '@/lib/api';
import { ComposerCardStack } from '@/components/ComposerCardStack';
import { InputTriggerMenu } from '@/components/InputTriggerMenu';
import { ImageLightbox } from '@/components/ImageLightbox';
import { useIsMobile, useTouchOnly } from '@/hooks/use-mobile';
import { StatusBar } from '@/components/StatusBar';
import { TurnVerse } from '@/components/TurnVerse';
import { useStore } from '@/lib/store';
import { BUILTIN_COMMANDS } from '@/lib/commands/builtins';
import { commandRegistry, executeCommand, type CommandContext } from '@/lib/commands/registry';
import { createSlashCommandSource } from '@/lib/commands/source';
import { inputTriggerRegistry } from '@/lib/input-trigger/registry';
import { useInputTriggers } from '@/lib/input-trigger/useInputTriggers';
import { createSessionReferenceSource } from '@/lib/references/sessionSource';
import type { ImageAttachment, SendMode } from '@/lib/types';

const MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const THINKING_LABELS: Record<string, string> = {
	off: '关闭',
	minimal: '极简',
	low: '低',
	medium: '中',
	high: '高',
	max: '最高',
};

const thinkingLabel = (level: string) => (level ? THINKING_LABELS[level] ?? level : '思考');

function autosize(el: HTMLTextAreaElement | null) {
	if (!el) return;
	const wrap = el.closest<HTMLElement>('.composer-wrap');
	const chat = el.closest<HTMLElement>('.chat');
	const head = chat?.querySelector<HTMLElement>('.chat-head');
	// 先量出文本区之外的固定高度（附件、状态栏、按钮区、内边距），
	// 这样输入框可以一直长到接近整个对话区，而不是被固定 max-height 截断。
	const wrapHeight = wrap?.getBoundingClientRect().height ?? 0;
	const fieldHeight = el.getBoundingClientRect().height;
	const nonField = Math.max(0, wrapHeight - fieldHeight);
	const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
	const headHeight = head?.getBoundingClientRect().height ?? 0;
	const max = Math.max(96, viewportHeight - headHeight - nonField - 24);

	// 先压到 0 并临时去掉 placeholder：Chrome 会把折行的 placeholder 算进 scrollHeight
	const placeholder = el.placeholder;
	el.placeholder = '';
	el.style.height = '0px';
	const content = Math.max(el.scrollHeight + 2, parseFloat(window.getComputedStyle(el).minHeight) || 0);
	el.style.height = `${Math.min(content, max)}px`;
	el.classList.toggle('overflow', content > max);
	el.placeholder = placeholder;
}

function readAsDataUrl(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result ?? ''));
		reader.onerror = () => reject(reader.error ?? new Error('read failed'));
		reader.readAsDataURL(file);
	});
}

function imageFiles(value: FileList | File[] | null | undefined): File[] {
	return Array.from(value ?? []).filter((file) => file.type.startsWith('image/'));
}

function hasDraggedFiles(event: DragEvent<HTMLElement>): boolean {
	const types = Array.from(event.dataTransfer?.types ?? []);
	return (
		types.includes('Files') ||
		types.includes('application/x-moz-file') ||
		types.some((type) => type.startsWith('image/')) ||
		(event.dataTransfer?.files?.length ?? 0) > 0
	);
}

export function Composer() {
	const draft = useStore((s) => s.draft);
	const setDraft = useStore((s) => s.setDraft);
	const busy = useStore((s) => s.busy);
	const compacting = useStore((s) => s.compacting);
	const sessionOpening = useStore((s) => s.sessionOpening);
	const historyLoading = useStore((s) => s.historyLoading);
	const historyLoadingInitial = useStore((s) => s.historyLoadingInitial);
	const sessionArchived = useStore((s) =>
		Boolean(s.sessionId && s.sessions.some((item) => item.id === s.sessionId && item.archived)),
	);
	const send = useStore((s) => s.send);
	const abort = useStore((s) => s.abort);
	const focusSeq = useStore((s) => s.focusSeq);
	const requestPin = useStore((s) => s.requestPin);
	const showToast = useStore((s) => s.showToast);
	const credentialRequests = useStore((s) => s.credentialRequests);
	const credentialTimeouts = useStore((s) => s.credentialTimeouts);
	const sessionId = useStore((s) => s.sessionId);
	const models = useStore((s) => s.models);
	const model = useStore((s) => s.model);
	const modelName = useStore((s) => s.modelName);
	const setModel = useStore((s) => s.setModel);
	const thinking = useStore((s) => s.thinking);
	const thinkingLevels = useStore((s) => s.thinkingLevels);
	const setThinking = useStore((s) => s.setThinking);
	const isMobile = useIsMobile();
	// 触屏设备展开模型菜单时不要把焦点塞进搜索框：会直接弹软键盘挡住列表
	const touchOnly = useTouchOnly();
	const historyBusy = historyLoading || historyLoadingInitial;
	const lockedReason = sessionArchived
		? '已归档会话，恢复后才能发送'
		: sessionOpening || historyBusy
			? '正在加载历史消息…'
			: null;
	const locked = Boolean(lockedReason);

	const inputRef = useRef<HTMLTextAreaElement | null>(null);
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const addButtonRef = useRef<HTMLButtonElement | null>(null);
	const menuRef = useRef<HTMLDivElement | null>(null);
	const modelButtonRef = useRef<HTMLButtonElement | null>(null);
	const modelMenuRef = useRef<HTMLDivElement | null>(null);
	const thinkingButtonRef = useRef<HTMLButtonElement | null>(null);
	const thinkingMenuRef = useRef<HTMLDivElement | null>(null);
	const [images, setImages] = useState<ImageAttachment[]>([]);
	const [menuOpen, setMenuOpen] = useState(false);
	const [modelMenuOpen, setModelMenuOpen] = useState(false);
	const [thinkingMenuOpen, setThinkingMenuOpen] = useState(false);
	const [modelQuery, setModelQuery] = useState('');
	const [dragging, setDragging] = useState(false);
	const [previewImage, setPreviewImage] = useState<ImageAttachment | null>(null);

	const openModelMenu = useCallback((query = '') => {
		setMenuOpen(false);
		setThinkingMenuOpen(false);
		setModelQuery(query);
		setModelMenuOpen(true);
	}, []);

	const openThinkingMenu = useCallback(() => {
		setMenuOpen(false);
		setModelMenuOpen(false);
		setThinkingMenuOpen(true);
	}, []);

	const focusInput = useCallback(() => {
		inputRef.current?.focus();
	}, []);

	const commandContext = useMemo<CommandContext>(() => ({
		getState: () => useStore.getState(),
		toast: showToast,
		send: (text) => useStore.getState().send(text),
		openModelMenu,
		openThinkingMenu,
		focusInput,
	}), [showToast, openModelMenu, openThinkingMenu, focusInput]);

	const runCommand = useCallback(async (name: string, args: string, line: string) => {
		const previous = useStore.getState().draft;
		setMenuOpen(false);
		setModelMenuOpen(false);
		setThinkingMenuOpen(false);
		if (previous.trim().startsWith('/')) useStore.getState().setDraft('');
		const result = await executeCommand(name, args, commandContext);
		if (result.kind === 'error') {
			useStore.getState().setDraft(previous);
			showToast(result.message);
			focusInput();
			return;
		}
		if (result.kind === 'done' && result.toast) showToast(result.toast);
		if (result.kind === 'insert') {
			useStore.getState().setDraft(result.text);
			window.requestAnimationFrame(() => {
				const el = inputRef.current;
				if (!el) return;
				el.focus();
				const caret = result.caretOffset ?? result.text.length;
				el.setSelectionRange(caret, caret);
			});
		}
		if (result.kind === 'submit') await useStore.getState().send(result.text);
		void line;
	}, [commandContext, focusInput, showToast]);

	const triggerContext = useMemo(() => ({
		getState: () => useStore.getState(),
		runCommand,
		toast: showToast,
		focusInput,
	}), [runCommand, showToast, focusInput]);

	const triggers = useInputTriggers({ draft, setDraft, inputRef, context: triggerContext });
	const dismissTriggers = triggers.dismiss;
	const refreshTriggers = triggers.refresh;

	useEffect(() => commandRegistry.subscribe(refreshTriggers), [refreshTriggers]);

	useEffect(() => {
		const disposers = [
			...BUILTIN_COMMANDS.map((definition) => commandRegistry.register(definition, { replace: true })),
			inputTriggerRegistry.register(createSlashCommandSource()),
			inputTriggerRegistry.register(createSessionReferenceSource()),
		];
		return () => {
			for (const dispose of disposers) dispose();
		};
	}, []);

	useEffect(() => {
		autosize(inputRef.current);
	}, [draft, images.length]);

	useEffect(() => {
		const onResize = () => autosize(inputRef.current);
		window.addEventListener('resize', onResize);
		window.visualViewport?.addEventListener('resize', onResize);
		return () => {
			window.removeEventListener('resize', onResize);
			window.visualViewport?.removeEventListener('resize', onResize);
		};
	}, []);

	useEffect(() => {
		if (!focusSeq) return;
		inputRef.current?.focus();
	}, [focusSeq]);

	// 切换 / 新建会话时，上一段还没发出去的图片不应跟着漂过去。
	useEffect(() => {
		setImages([]);
		setMenuOpen(false);
		setModelMenuOpen(false);
		setThinkingMenuOpen(false);
		dismissTriggers();
	}, [sessionId, dismissTriggers]);

	// 历史加载中 / 归档会话：收起已经打开的弹层，不让半截操作留在禁用态里。
	useEffect(() => {
		if (!locked) return;
		setMenuOpen(false);
		setModelMenuOpen(false);
		setThinkingMenuOpen(false);
		dismissTriggers();
	}, [locked, dismissTriggers]);

	useEffect(() => {
		if (!modelMenuOpen) setModelQuery('');
	}, [modelMenuOpen]);

	useEffect(() => {
		if (!menuOpen && !modelMenuOpen && !thinkingMenuOpen) return;
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target as Node;
			if (menuOpen && !menuRef.current?.contains(target) && !addButtonRef.current?.contains(target)) {
				setMenuOpen(false);
			}
			if (
				modelMenuOpen &&
				!modelMenuRef.current?.contains(target) &&
				!modelButtonRef.current?.contains(target)
			) {
				setModelMenuOpen(false);
			}
			if (
				thinkingMenuOpen &&
				!thinkingMenuRef.current?.contains(target) &&
				!thinkingButtonRef.current?.contains(target)
			) {
				setThinkingMenuOpen(false);
			}
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				setMenuOpen(false);
				setModelMenuOpen(false);
				setThinkingMenuOpen(false);
			}
		};
		document.addEventListener('pointerdown', onPointerDown);
		document.addEventListener('keydown', onKeyDown);
		return () => {
			document.removeEventListener('pointerdown', onPointerDown);
			document.removeEventListener('keydown', onKeyDown);
		};
	}, [menuOpen, modelMenuOpen, thinkingMenuOpen]);

	useEffect(() => {
		if (!triggers.open) return;
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target as Node | null;
			if (!(target instanceof Node)) return;
			if (inputRef.current?.closest('.composer-input-box')?.contains(target)) return;
			if (document.getElementById('input-trigger-menu')?.contains(target)) return;
			dismissTriggers();
		};
		document.addEventListener('pointerdown', onPointerDown, true);
		return () => document.removeEventListener('pointerdown', onPointerDown, true);
	}, [triggers.open, dismissTriggers]);

	const addFiles = async (files: FileList | File[] | null | undefined) => {
		if (locked) return;
		const picked = imageFiles(files);
		if (!picked.length) return;
		const accepted: ImageAttachment[] = [];
		for (const file of picked.slice(0, MAX_IMAGES)) {
			if (file.size > MAX_IMAGE_BYTES) {
				showToast(`图片太大：${file.name || '剪贴板图片'}`);
				continue;
			}
			try {
				const dataUrl = await readAsDataUrl(file);
				const comma = dataUrl.indexOf(',');
				const data = comma >= 0 ? dataUrl.slice(comma + 1) : '';
				if (!data) continue;
				accepted.push({
					id: newId(),
					name: file.name || `图片 ${accepted.length + 1}`,
					mimeType: file.type || 'image/png',
					data,
					size: file.size,
				});
			} catch {
				showToast('读取图片失败');
			}
		}
		if (!accepted.length) return;
		if (images.length + accepted.length > MAX_IMAGES) showToast(`最多添加 ${MAX_IMAGES} 张图片`);
		setImages((current) => [...current, ...accepted].slice(0, MAX_IMAGES));
	};

	const submit = async (requested?: SendMode) => {
		if (locked || compacting) return;
		const text = draft.trim();
		if (!text && !images.length) {
			if (busy) abort().catch(() => {});
			return;
		}
		// / 命令优先于普通发送；未知但语法合法的 /foo 会被拦住，不降级成 prompt。
		if (text.startsWith('/')) {
			const handled = await triggers.adjudicate(text, images.length);
			if (handled) return;
		}
		triggers.dismiss();
		const pending = images;
		setImages([]);
		setMenuOpen(false);
		setModelMenuOpen(false);
		setThinkingMenuOpen(false);
		const mode = requested ?? (busy ? 'steer' : 'prompt');
		send(text, mode, pending)
			.then((ok) => {
				if (!ok) setImages((current) => (current.length ? current : pending));
			})
			.catch(() => {
				setImages((current) => (current.length ? current : pending));
			});
	};

	const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
		const files = Array.from(event.clipboardData?.items ?? [])
			.filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
			.map((item) => item.getAsFile())
			.filter((file): file is File => Boolean(file));
		if (!files.length) return;
		event.preventDefault();
		addFiles(files).catch(() => {});
	};

	useEffect(() => {
		// 审批卡出现/消失/展开/收成超时细条会改变输入区高度，重新计算可用的文本区上限。
		autosize(inputRef.current);
	}, [credentialRequests, credentialTimeouts]);

	const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
		if (!hasDraggedFiles(event)) return;
		event.preventDefault();
		if (locked) {
			event.dataTransfer.dropEffect = 'none';
			return;
		}
		event.dataTransfer.dropEffect = 'copy';
		setDragging(true);
	};

	const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
		if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
		setDragging(false);
	};

	const handleDrop = (event: DragEvent<HTMLDivElement>) => {
		event.preventDefault();
		setDragging(false);
		if (locked) return;
		addFiles(event.dataTransfer?.files).catch(() => {});
	};

	const modelQueryValue = modelQuery.trim().toLowerCase();
	const visibleModels = modelQueryValue
		? models.filter((item) =>
				[item.provider, item.name, item.id, item.key].some((value) =>
					value.toLowerCase().includes(modelQueryValue),
				),
			)
		: models;
	const modelGroups = new Map<string, typeof models>();
	for (const item of visibleModels) {
		if (!modelGroups.has(item.provider)) modelGroups.set(item.provider, []);
		modelGroups.get(item.provider)!.push(item);
	}
	const modelLabel = modelName || models.find((item) => item.key === model)?.name || '模型';
	const providerLabel =
		models.find((item) => item.key === model)?.provider ||
		(model.includes('/') ? model.split('/')[0] : '');
	const thinkingText = thinkingLabel(thinking);
	const thinkingDisabled = thinkingLevels.length <= 1;
	const supportsImages = models.find((item) => item.key === model)?.supportsImages !== false;
	const canSend = draft.trim().length > 0 || images.length > 0;
	const stopButton = busy && !canSend;
	const sendTitle = lockedReason
		? lockedReason
		: compacting
			? '正在压缩上下文…'
			: stopButton
				? '停止生成'
				: busy
					? '插话发送（Ctrl/Cmd+Enter 排队）'
					: '发送';

	return (
		<div className="composer-wrap">
			<TurnVerse />
			<ComposerCardStack />
			<form
				id="composer"
				className={`composer${locked ? ' locked' : ''}`}
				aria-busy={historyBusy || sessionOpening || undefined}
				onSubmit={(event) => {
					event.preventDefault();
					void submit();
				}}
			>
				<div
					className={`composer-field${dragging ? ' dragging' : ''}`}
					onDragEnter={handleDragOver}
					onDragOver={handleDragOver}
					onDragLeave={handleDragLeave}
					onDrop={handleDrop}
				>
					<div className="composer-input-box">
						{images.length ? (
							<div className="composer-attachments">
								{images.map((image, index) => (
									<div className="composer-attachment" key={image.id ?? index}>
										<button
											type="button"
											className="composer-attachment-open"
											aria-label={`查看图片 ${image.name ?? index + 1}`}
											title="点击放大"
											onClick={() => setPreviewImage(image)}
										>
											<img
												src={`data:${image.mimeType};base64,${image.data}`}
												alt={image.name ?? `图片 ${index + 1}`}
												title={image.name}
											/>
										</button>
										<button
											type="button"
											className="composer-attachment-remove"
											aria-label={`移除图片 ${image.name ?? index + 1}`}
											title="移除图片"
											onClick={() => setImages((current) => current.filter((_, i) => i !== index))}
										>
											×
										</button>
									</div>
								))}
							</div>
						) : null}
						{images.length && !supportsImages ? (
							<div className="composer-model-warning" role="status">
								<TriangleAlert aria-hidden="true" />
								<span>当前模型不支持读图；消息仍可发送，但图片内容不会被模型读取。</span>
							</div>
						) : null}
					<textarea
						id="input"
						ref={inputRef}
						rows={3}
						role="combobox"
						aria-autocomplete="list"
						aria-haspopup="listbox"
						aria-expanded={triggers.open}
						aria-controls={triggers.open ? 'input-trigger-menu' : undefined}
						aria-activedescendant={
							triggers.open && triggers.items[triggers.highlight]
								? `input-trigger-option-${triggers.highlight}`
								: undefined
						}
						disabled={locked}
						placeholder={
							lockedReason ??
							(busy
								? isMobile
									? '生成中：Enter 插话…'
									: '生成中：Enter 插话，Ctrl/Cmd+Enter 排队…'
								: isMobile
									? '说点什么，或拖入图片…'
									: '说点什么，或拖入 / 粘贴图片…')
						}
						title={lockedReason ?? 'Enter 发送/插话，Shift+Enter 换行；生成中 Ctrl/Cmd+Enter 排队；支持拖拽 / 粘贴图片'}
						value={draft}
						onChange={(event) => {
							setDraft(event.target.value);
							triggers.track(event.target.value, event.target.selectionStart ?? event.target.value.length);
						}}
						onPaste={handlePaste}
						onSelect={(event) => {
							triggers.track(event.currentTarget.value, event.currentTarget.selectionStart ?? event.currentTarget.value.length);
						}}
						onClick={(event) => {
							triggers.track(event.currentTarget.value, event.currentTarget.selectionStart ?? event.currentTarget.value.length);
						}}
						onKeyDown={(event) => {
							if (triggers.handleKeyDown(event)) return;
							if (event.key === 'Enter' && !event.shiftKey) {
								event.preventDefault();
								if (event.repeat || (!draft.trim() && !images.length)) return;
								const queued = busy && (event.ctrlKey || event.metaKey || event.altKey);
								void submit(queued ? 'followUp' : undefined);
							}
						}}
						onFocus={(event) => {
							window.setTimeout(requestPin, 250);
							triggers.track(event.currentTarget.value, event.currentTarget.selectionStart ?? event.currentTarget.value.length);
						}}
					/>
					<InputTriggerMenu
						open={triggers.open}
						items={triggers.items}
						highlight={triggers.highlight}
						loading={triggers.loading}
						onHover={triggers.hover}
						onPick={(index) => { void triggers.pick(index); }}
					/>
					<button
						ref={addButtonRef}
						type="button"
						className="composer-add"
						aria-label="添加附件"
						aria-haspopup="menu"
						aria-expanded={menuOpen}
						title={lockedReason ?? '添加附件'}
						disabled={locked}
						onClick={() => {
							dismissTriggers();
							setModelMenuOpen(false);
							setThinkingMenuOpen(false);
							setMenuOpen((value) => !value);
						}}
					>
						<Plus aria-hidden="true" />
					</button>
					<div className="composer-switches">
						<button
							ref={thinkingButtonRef}
							id="thinking-switch"
							type="button"
							className="composer-thinking-switch"
							aria-label={`思考等级，当前 ${thinkingText}`}
							aria-haspopup="listbox"
							aria-expanded={thinkingMenuOpen}
							aria-controls="thinking-switch-menu"
							title={lockedReason ?? (thinkingDisabled ? '当前模型只有一档思考等级' : `思考等级 · 当前：${thinkingText}`)}
							disabled={thinkingDisabled || locked}
							onClick={() => {
								dismissTriggers();
								setMenuOpen(false);
								setModelMenuOpen(false);
								setThinkingMenuOpen((value) => !value);
							}}
						>
							<Brain aria-hidden="true" />
							<span>{thinkingText}</span>
						</button>
						<button
							ref={modelButtonRef}
							id="model-switch"
							type="button"
							className="composer-model-switch"
							aria-label={`切换模型，当前 ${modelLabel}${providerLabel ? `（${providerLabel}）` : ''}`}
							aria-haspopup="listbox"
							aria-expanded={modelMenuOpen}
							aria-controls="model-switch-menu"
							title={lockedReason ?? `切换模型 · 当前：${modelLabel}${providerLabel ? `（${providerLabel}）` : ''}`}
							disabled={models.length < 2 || locked}
							onClick={() => {
								dismissTriggers();
								setMenuOpen(false);
								setThinkingMenuOpen(false);
								setModelMenuOpen((value) => !value);
							}}
						>
							<span className="composer-model-switch-stack">
								{providerLabel ? (
									<span className="composer-model-switch-provider">{providerLabel}</span>
								) : null}
								<span className="composer-model-switch-name">{modelLabel}</span>
							</span>
							<ChevronsUpDown aria-hidden="true" />
						</button>
					</div>
					<button
						id="send"
						type="submit"
						title={sendTitle}
						aria-label={lockedReason ?? (compacting ? '正在压缩上下文' : stopButton ? '停止生成' : busy ? '插话发送' : '发送')}
						className={stopButton ? 'stop' : undefined}
						disabled={compacting || locked}
					>
						{stopButton ? (
							<svg viewBox="0 0 24 24" aria-hidden="true">
								<rect x="6" y="6" width="12" height="12" rx="2.2" fill="currentColor" />
							</svg>
						) : (
							<SendHorizontal aria-hidden="true" />
						)}
					</button>
					<input
						ref={fileInputRef}
						type="file"
						accept="image/*"
						multiple
						hidden
						onChange={(event) => {
							addFiles(event.target.files).catch(() => {});
							event.target.value = '';
						}}
					/>
					{thinkingMenuOpen ? (
						<div
							ref={thinkingMenuRef}
							id="thinking-switch-menu"
							className="composer-thinking-menu"
							role="listbox"
							aria-label="选择思考等级"
						>
							<div className="composer-model-group-label">思考等级</div>
							{thinkingLevels.map((level) => {
								const selected = level === thinking;
								return (
									<button
										key={level}
										type="button"
										role="option"
										aria-selected={selected}
										className={`composer-model-option${selected ? ' selected' : ''}`}
										onClick={() => {
											setThinkingMenuOpen(false);
											if (!selected) setThinking(level).catch(() => {});
										}}
									>
										<span className="composer-model-option-name">{thinkingLabel(level)}</span>
										<span className="composer-model-option-tag">{level}</span>
										{selected ? <Check aria-hidden="true" /> : null}
									</button>
								);
							})}
						</div>
					) : null}
					{modelMenuOpen ? (
						<div
							ref={modelMenuRef}
							id="model-switch-menu"
							className="composer-model-menu"
							role="listbox"
							aria-label="选择模型"
						>
							<div className="composer-model-search">
								<Search aria-hidden="true" />
								<input
									id="model-switch-search"
									value={modelQuery}
									placeholder="搜索模型或供应商"
									autoComplete="off"
									spellCheck={false}
									autoFocus={!touchOnly}
									onChange={(event) => setModelQuery(event.target.value)}
									onKeyDown={(event) => event.stopPropagation()}
								/>
							</div>
							<div className="composer-model-list">
								{[...modelGroups.entries()].map(([provider, list]) => (
									<div className="composer-model-group" key={provider} role="group" aria-label={provider}>
										<div className="composer-model-group-label">{provider}</div>
										{list.map((item) => {
											const selected = item.key === model;
											return (
												<button
													key={item.key}
													type="button"
													role="option"
													aria-selected={selected}
													className={`composer-model-option${selected ? ' selected' : ''}`}
													title={`${item.provider}/${item.id}`}
													onClick={() => {
														setModelMenuOpen(false);
														if (!selected) setModel(item.key).catch(() => {});
													}}
												>
													<span className="composer-model-option-name">{item.name}</span>
													{item.reasoning ? (
														<span className="composer-model-option-tag">reasoning</span>
													) : null}
													<span
														className={`composer-model-option-tag${item.supportsImages ? ' vision' : ''}`}
													>
														{item.supportsImages ? '视觉' : '纯文本'}
													</span>
													{selected ? <Check aria-hidden="true" /> : null}
												</button>
											);
										})}
									</div>
								))}
								{!visibleModels.length ? (
									<div className="composer-model-empty">没有匹配的模型</div>
								) : null}
							</div>
						</div>
					) : null}
					{menuOpen ? (
						<div ref={menuRef} className="composer-menu" role="menu" aria-label="添加附件">
							<button
								type="button"
								role="menuitem"
								onClick={() => {
									setMenuOpen(false);
									fileInputRef.current?.click();
								}}
							>
								<ImagePlus aria-hidden="true" />
								<span>上传图片</span>
							</button>
						</div>
					) : null}
					{dragging ? (
						<div className="composer-drop-hint">
							<ImagePlus aria-hidden="true" />
							<span>松开以添加图片</span>
						</div>
					) : null}
					</div>
				</div>
			</form>

			<StatusBar />
			{previewImage ? (
				<ImageLightbox
					src={`data:${previewImage.mimeType};base64,${previewImage.data}`}
					alt={previewImage.name}
					onClose={() => setPreviewImage(null)}
				/>
			) : null}
		</div>
	);
}
