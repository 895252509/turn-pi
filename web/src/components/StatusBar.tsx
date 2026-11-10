import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { api } from '@/lib/api';
import { buildQuotaRingLayers, quotaRingHeadline, quotaRingHot, useQuotaRingPrefs } from '@/lib/quotaRing';
import { useStore } from '@/lib/store';
import type { ProviderQuota, ProviderQuotaBalance } from '@/lib/types';

function formatK(value: number): string {
	const n = Number(value ?? 0);
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

/** 上下文明细统一按 k 显示；越小保留越多小数，避免全是 0.0k。 */
function formatKTokens(value: number): string {
	const n = Math.max(0, Number(value) || 0);
	if (!n) return '0k';
	const num = n / 1000;
	const digits = num < 1 ? 2 : num < 10 ? 1 : 0;
	let text = num.toFixed(digits);
	if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '');
	return `${text}k`;
}

function tokenParts(value: number): { value: string; unit: string } {
	const n = Number(value ?? 0);
	if (n < 1000) return { value: String(n), unit: '' };
	if (n < 1_000_000) return { value: (n / 1000).toFixed(n < 10_000 ? 1 : 0), unit: 'k' };
	return { value: (n / 1_000_000).toFixed(1), unit: 'M' };
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), Math.max(min, max));
}

type CtxPopoverPosition = {
	left: number;
	top: number;
	openBelow: boolean;
	arrowX: number;
};

type RingLayer = {
	key: string;
	className: string;
	radius: number;
	percent: number;
	limited?: boolean;
};

const CURRENCY_SYMBOLS: Record<string, string> = {
	USD: '$',
	CNY: '¥',
	EUR: '€',
	GBP: '£',
	JPY: '¥',
};

function formatQuotaAmount(value: number, currency: string): string {
	const symbol = CURRENCY_SYMBOLS[currency.toUpperCase()] ?? `${currency} `;
	return `${symbol}${value.toLocaleString('en-US', {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	})}`;
}

function quotaBalanceTitle(balance: ProviderQuotaBalance): string {
	const parts: string[] = [balance.label, formatQuotaAmount(balance.remaining, balance.currency)];
	if (balance.total !== undefined) parts.push(`总额 ${formatQuotaAmount(balance.total, balance.currency)}`);
	if (balance.used !== undefined) parts.push(`已用 ${formatQuotaAmount(balance.used, balance.currency)}`);
	for (const detail of balance.details ?? []) {
		parts.push(`${detail.label} ${formatQuotaAmount(detail.amount, balance.currency)}`);
	}
	return parts.join(' · ');
}

/** 订阅窗口剩余时间：5h 用 xhxm，7d / 30d 用 xdxh。 */
function formatQuotaRemaining(value: string | undefined, label: string): string {
	if (!value) return '';
	const resetAt = new Date(value).getTime();
	if (!Number.isFinite(resetAt)) return '';
	const ms = Math.max(0, resetAt - Date.now());
	if (label === '5h') {
		const totalMinutes = Math.floor(ms / 60_000);
		return `${Math.floor(totalMinutes / 60)}h${totalMinutes % 60}m`;
	}
	const totalHours = Math.floor(ms / 3_600_000);
	return `${Math.floor(totalHours / 24)}d${totalHours % 24}h`;
}

/** 浮动层挂在 body 上并用 fixed 定位，避免被 .chat 的 overflow 裁掉。 */
function useAnchorPopover(open: boolean) {
	const anchorRef = useRef<HTMLDivElement | null>(null);
	const popRef = useRef<HTMLDivElement | null>(null);
	const [pos, setPos] = useState<CtxPopoverPosition | null>(null);

	useLayoutEffect(() => {
		if (!open) {
			setPos(null);
			return;
		}

		const update = () => {
			const anchor = anchorRef.current?.getBoundingClientRect();
			const pop = popRef.current?.getBoundingClientRect();
			if (!anchor || !pop) return;

			const viewport = window.visualViewport;
			const viewLeft = viewport?.offsetLeft ?? 0;
			const viewTop = viewport?.offsetTop ?? 0;
			const viewWidth = viewport?.width ?? window.innerWidth;
			const viewHeight = viewport?.height ?? window.innerHeight;
			const margin = 8;
			const gap = 10;
			const width = pop.width || 260;
			const height = pop.height || 0;

			// 默认向上（输入区在底部），上方实在放不下且下方更宽裕时才向下。
			const spaceAbove = anchor.top - viewTop;
			const spaceBelow = viewTop + viewHeight - anchor.bottom;
			const openBelow = spaceAbove < height + gap + margin && spaceBelow > spaceAbove;
			const rawTop = openBelow ? anchor.bottom + gap : anchor.top - gap - height;
			const top = clamp(rawTop, viewTop + margin, viewTop + viewHeight - margin - height);

			// 环在左半边就向右展开，在右半边就向左展开；首选一侧放不下时再选空间更大的一侧，
			// 最后夹进视口，保证窄屏第二行（环可能贴左或贴右）也不会被裁掉。
			const anchorCenter = (anchor.left + anchor.right) / 2;
			const spaceLeft = anchor.left - viewLeft;
			const spaceRight = viewLeft + viewWidth - anchor.right;
			let extendRight = anchorCenter <= viewLeft + viewWidth / 2;
			if (extendRight && spaceRight < width + margin && spaceLeft > spaceRight) extendRight = false;
			else if (!extendRight && spaceLeft < width + margin && spaceRight > spaceLeft) extendRight = true;
			const rawLeft = extendRight ? anchor.left : anchor.right - width;
			const left = clamp(rawLeft, viewLeft + margin, viewLeft + viewWidth - margin - width);

			const arrowX = clamp(anchorCenter - left - 4, 8, width - 16);
			setPos((prev) =>
				prev && prev.left === left && prev.top === top && prev.openBelow === openBelow && prev.arrowX === arrowX
					? prev
					: { left, top, openBelow, arrowX },
			);
		};

		update();
		const Observer = typeof ResizeObserver === 'function' ? ResizeObserver : null;
		const observer = Observer ? new Observer(update) : null;
		if (popRef.current) observer?.observe(popRef.current);
		if (anchorRef.current) observer?.observe(anchorRef.current);
		window.addEventListener('resize', update);
		window.addEventListener('scroll', update, true);
		window.visualViewport?.addEventListener('resize', update);
		window.visualViewport?.addEventListener('scroll', update);
		return () => {
			observer?.disconnect();
			window.removeEventListener('resize', update);
			window.removeEventListener('scroll', update, true);
			window.visualViewport?.removeEventListener('resize', update);
			window.visualViewport?.removeEventListener('scroll', update);
		};
	}, [open]);

	return { anchorRef, popRef, pos };
}

function Ring({
	id,
	variant,
	percent,
	hot,
	compacting,
	title,
	onClick,
	expanded,
	controls,
	layers,
}: {
	id: string;
	variant: 'cache' | 'ctx' | 'quota';
	percent: number;
	hot?: boolean;
	compacting?: boolean;
	title: string;
	onClick?: () => void;
	expanded?: boolean;
	controls?: string;
	layers?: RingLayer[];
}) {
	const pct = Math.max(0, Math.min(100, Math.round(percent)));
	const className = `ring ${variant}${hot ? ' hot' : ''}${compacting ? ' compacting' : ''}`;
	const content = (
		<>
			<svg viewBox="0 0 36 36" aria-hidden="true">
				{layers?.length ? (
					layers.map((layer) => {
						const layerPct = Math.max(0, Math.min(100, Math.round(layer.percent)));
						return (
							<g key={layer.key}>
								<circle className="ring-track" cx="18" cy="18" r={layer.radius} />
								<circle
									className={`ring-fill ${layer.className}${layer.limited ? ' limited' : ''}`}
									cx="18"
									cy="18"
									r={layer.radius}
									pathLength={100}
									strokeDasharray="100"
									strokeDashoffset={100 - layerPct}
								/>
							</g>
						);
					})
				) : (
					<>
						<circle className="ring-track" cx="18" cy="18" r="15.9155" />
						<circle
							className="ring-fill"
							cx="18"
							cy="18"
							r="15.9155"
							strokeDasharray="100"
							strokeDashoffset={100 - pct}
						/>
					</>
				)}
			</svg>
			<span className="ring-val">{pct}</span>
		</>
	);
	if (onClick) {
		return (
			<button
				id={id}
				type="button"
				className={className}
				aria-busy={compacting || undefined}
				aria-expanded={expanded}
				aria-controls={controls}
				aria-label={title}
				title={compacting ? `${title} · 压缩中…` : title}
				onClick={onClick}
			>
				{content}
			</button>
		);
	}
	return (
		<div
			id={id}
			className={className}
			aria-busy={compacting || undefined}
			title={compacting ? `${title} · 压缩中…` : title}
		>
			{content}
		</div>
	);
}

export function StatusBar() {
	const turns = useStore((s) => s.turns);
	const steps = useStore((s) => s.steps);
	const toolCalls = useStore((s) => s.toolCalls);
	const tps = useStore((s) => s.tps);
	const avgTps = useStore((s) => s.avgTps);
	const busy = useStore((s) => s.busy);
	const usage = useStore((s) => s.usage);
	const contextTokens = useStore((s) => s.contextTokens);
	const contextWindow = useStore((s) => s.contextWindow);
	const contextBreakdown = useStore((s) => s.contextBreakdown);
	const contextEstimated = useStore((s) => s.contextEstimated);
	const compacting = useStore((s) => s.compacting);
	const compact = useStore((s) => s.compact);

	const model = useStore((s) => s.model);
	const providerId = model.includes('/') ? model.split('/')[0] : '';
	const ringPrefs = useQuotaRingPrefs();

	const [cacheOpen, setCacheOpen] = useState(false);
	const cachePopover = useAnchorPopover(cacheOpen);
	const [ctxOpen, setCtxOpen] = useState(false);
	const ctxPopover = useAnchorPopover(ctxOpen);
	const [quotaOpen, setQuotaOpen] = useState(false);
	const quotaPopover = useAnchorPopover(quotaOpen);

	useEffect(() => {
		if (!cacheOpen) return;
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target as Node;
			if (!cachePopover.anchorRef.current?.contains(target) && !cachePopover.popRef.current?.contains(target)) {
				setCacheOpen(false);
			}
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') setCacheOpen(false);
		};
		document.addEventListener('pointerdown', onPointerDown);
		document.addEventListener('keydown', onKeyDown);
		return () => {
			document.removeEventListener('pointerdown', onPointerDown);
			document.removeEventListener('keydown', onKeyDown);
		};
	}, [cacheOpen, cachePopover.anchorRef, cachePopover.popRef]);

	useEffect(() => {
		if (!ctxOpen) return;
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target as Node;
			if (!ctxPopover.anchorRef.current?.contains(target) && !ctxPopover.popRef.current?.contains(target)) {
				setCtxOpen(false);
			}
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') setCtxOpen(false);
		};
		document.addEventListener('pointerdown', onPointerDown);
		document.addEventListener('keydown', onKeyDown);
		return () => {
			document.removeEventListener('pointerdown', onPointerDown);
			document.removeEventListener('keydown', onKeyDown);
		};
	}, [ctxOpen, ctxPopover.anchorRef, ctxPopover.popRef]);

	useEffect(() => {
		if (!quotaOpen) return;
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target as Node;
			if (!quotaPopover.anchorRef.current?.contains(target) && !quotaPopover.popRef.current?.contains(target)) {
				setQuotaOpen(false);
			}
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') setQuotaOpen(false);
		};
		document.addEventListener('pointerdown', onPointerDown);
		document.addEventListener('keydown', onKeyDown);
		return () => {
			document.removeEventListener('pointerdown', onPointerDown);
			document.removeEventListener('keydown', onKeyDown);
		};
	}, [quotaOpen, quotaPopover.anchorRef, quotaPopover.popRef]);

	const [quotaData, setQuotaData] = useState<ProviderQuota | null>(null);
	const [quotaLoading, setQuotaLoading] = useState(false);
	const providerRef = useRef(providerId);
	providerRef.current = providerId;

	const loadQuota = useCallback(async (force = false) => {
		const id = providerRef.current;
		if (!id) {
			setQuotaData(null);
			return;
		}
		setQuotaLoading(true);
		try {
			const data = await api<ProviderQuota>(
				`/api/providers/quota?id=${encodeURIComponent(id)}${force ? '&refresh=1' : ''}`,
			);
			if (providerRef.current === id) setQuotaData(data);
		} catch {
			if (providerRef.current === id) setQuotaData(null);
		} finally {
			if (providerRef.current === id) setQuotaLoading(false);
		}
	}, []);

	useEffect(() => {
		if (!providerId) {
			setQuotaData(null);
			setQuotaOpen(false);
			return;
		}
		setQuotaData(null);
		setQuotaOpen(false);
		void loadQuota();
		const timer = setInterval(() => void loadQuota(), 60_000);
		return () => clearInterval(timer);
	}, [providerId, loadQuota]);

	// 每轮结束后补一次，避免刚消耗的额度要等一分钟才更新。
	const wasBusy = useRef(false);
	useEffect(() => {
		if (wasBusy.current && !busy) void loadQuota();
		wasBusy.current = busy;
	}, [busy, loadQuota]);

	const ctxPct = contextWindow ? Math.min(100, Math.round((contextTokens / contextWindow) * 100)) : 0;
	const quotaWindows = quotaData?.status === 'ok' ? quotaData.windows : [];
	const quotaLayers = buildQuotaRingLayers(quotaWindows, ringPrefs);
	const primaryBalance = quotaData?.status === 'ok' ? quotaData.balances[0] : undefined;
	const quotaPct = quotaRingHeadline(quotaLayers, ringPrefs.metric);
	const quotaMetricLabel = ringPrefs.metric === 'remaining' ? '余量' : '已用';
	const quotaTitle = quotaLayers.length
		? `订阅额度 · ${quotaLayers.map((layer) => `${layer.label} ${quotaMetricLabel} ${layer.percent}%`).join(' · ')} · 点击查看明细`
		: '';
	const cacheDenominator = usage.input + usage.cacheRead + usage.cacheWrite;
	const cachePct = cacheDenominator ? Math.round((usage.cacheRead / cacheDenominator) * 100) : 0;
	const cacheRows = cacheDenominator
		? [
				{ key: 'hit', label: '缓存命中', value: usage.cacheRead, pct: (usage.cacheRead / cacheDenominator) * 100 },
				{ key: 'miss', label: '未命中', value: usage.input, pct: (usage.input / cacheDenominator) * 100 },
				...(usage.cacheWrite
					? [{ key: 'write', label: '缓存写入', value: usage.cacheWrite, pct: (usage.cacheWrite / cacheDenominator) * 100 }]
					: []),
			]
		: [];

	const breakdownRows = contextBreakdown
		? [
				{ key: 'system', label: '系统提示词', value: contextBreakdown.system, meta: '' },
				{
					key: 'tools',
					label: '工具定义',
					value: contextBreakdown.tools,
					meta: contextBreakdown.toolCount != null ? `${contextBreakdown.toolCount} 个` : '',
				},
				{
					key: 'messages',
					label: '对话消息',
					value: contextBreakdown.messages,
					meta: contextBreakdown.messageCount != null ? `${contextBreakdown.messageCount} 条` : '',
				},
				{ key: 'other', label: '估算差异', value: contextBreakdown.other, meta: 'tokenizer 与字符÷4' },
			].filter((row) => row.key !== 'other' || row.value > 0)
		: [];
	const breakdownTotal = breakdownRows.reduce((sum, row) => sum + row.value, 0);
	const ctxTotal = contextTokens || breakdownTotal;
	const barTotal = breakdownTotal || 1;

	const miss = tokenParts(usage.input);
	const hit = tokenParts(usage.cacheRead);
	const out = tokenParts(usage.output);
	// 实时值在工具等待时保留；没有实时值就回落到本轮/历史平均；
	// 新会话刚开始、还没出 token 时显示 0，执行中不显示 —
	const shownTps = tps ?? avgTps ?? (busy ? 0 : null);

	return (
		<div className="statusbar">
			<div className="stats">
				<span
					className="stat"
					id="stat-turn"
					title={`轮：你发了几条消息（一问一答算一轮）\n步：模型执行的循环步数，一次模型调用算一步\n工具调用：${toolCalls} 次`}
				>
					<svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
						<path d="M4 7h16M4 12h10M4 17h13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
					</svg>
					<b id="turn-n">{turns}</b>
					<em>轮</em>
					<span className="sep">/</span>
					<b id="step-n">{steps}</b>
					<em>步</em>
				</span>

				<span
					className={`stat tps${shownTps == null ? ' idle' : ''}`}
					id="stat-tps"
					title={
						tps != null
							? '实时输出速度（tok/s，按流式文本实时估算）'
							: avgTps != null
								? '最近一轮平均输出速度（tok/s，按历史 usage / 生成耗时计算）'
								: busy
									? '等待模型输出…'
									: '输出速度（tok/s）'
					}
				>
					<svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
						<path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" fill="currentColor" />
					</svg>
					<span className="lbl">TPS</span>
					<b id="tps-value">{shownTps ?? '—'}</b>
					<em>tok/s</em>
				</span>

				<span className="stat" id="stat-in" title={`输入 tokens：↑ 未命中 ${formatK(usage.input)} / 命中 ${formatK(usage.cacheRead)}${usage.cacheWrite ? ` / 写入 ${formatK(usage.cacheWrite)}` : ''}`}>
					<span className="arrow up">↑</span>
					<b id="in-miss">{miss.value}</b>
					<em id="u-miss">{miss.unit}</em>
					<span className="sep">/</span>
					<b id="in-hit">{hit.value}</b>
					<em id="u-hit">{hit.unit}</em>
				</span>

				<span className="stat" id="stat-out" title="输出 tokens">
					<span className="arrow down">↓</span>
					<b id="out-k">{out.value}</b>
					<em id="u-out">{out.unit}</em>
				</span>
			</div>

			<div className="rings">
				{quotaLayers.length > 0 ? (
					<div className="ctx-anchor" ref={quotaPopover.anchorRef}>
						<Ring
							id="ring-quota"
							variant="quota"
							percent={quotaPct}
							hot={quotaRingHot(quotaPct, ringPrefs.metric)}
							layers={quotaLayers}
							expanded={quotaOpen}
							controls="quota-pop"
							title={`${quotaTitle}${quotaLoading ? ' · 刷新中…' : ''}`}
							onClick={() => {
								setQuotaOpen((open) => !open);
								setCtxOpen(false);
								setCacheOpen(false);
							}}
						/>
						{quotaOpen &&
							createPortal(
								<div
									id="quota-pop"
									ref={quotaPopover.popRef}
									className={`ctx-pop quota-pop ${quotaPopover.pos?.openBelow ? 'pop-below' : 'pop-above'}`}
									role="dialog"
									aria-label="订阅额度明细"
									aria-busy={quotaLoading || undefined}
									style={
										quotaPopover.pos
											? ({
													left: quotaPopover.pos.left,
													top: quotaPopover.pos.top,
													'--ctx-arrow-x': `${quotaPopover.pos.arrowX}px`,
												} as CSSProperties)
											: { left: 0, top: 0, visibility: 'hidden' }
									}
								>
									<div className="ctx-pop-scroll">
										<div className="ctx-pop-head">
											<span>订阅额度</span>
											<button
												type="button"
												className="ctx-pop-close"
												aria-label="关闭订阅额度明细"
												onClick={() => setQuotaOpen(false)}
											>
												×
											</button>
										</div>
										<div className="ctx-total">
											<b>{quotaPct}%</b>
											<span>{quotaMetricLabel === '余量' ? '最低余量' : '最高已用'}</span>
											<em>{providerId === 'opencode-go' ? 'OpenCode Go' : providerId}</em>
										</div>
										<div className="quota-rows">
											{quotaLayers.map((layer) => (
												<div
													className={`quota-row ${layer.className}${layer.limited ? ' limited' : ''}`}
													key={layer.key}
												>
													<span className="quota-dot" />
													<div className="quota-row-body">
														<div className="quota-row-head">
															<span>{layer.name}</span>
															<b>{layer.percent}%</b>
															{layer.limited ? <em>已限流</em> : null}
														</div>
														<div className="quota-bar" aria-hidden="true">
															<span style={{ width: `${Math.max(0, Math.min(100, layer.percent))}%` }} />
														</div>
														<div className="quota-reset">
															{layer.reset ? `剩余 ${formatQuotaRemaining(layer.reset, layer.label)}` : '剩余时间未知'}
														</div>
													</div>
												</div>
											))}
										</div>
										<div className="ctx-note">
											订阅接口只读探测，不会发起对话或消耗 token；每分钟自动刷新。
										</div>
									</div>
								</div>,
								document.body,
							)}
					</div>
				) : primaryBalance ? (
					<span
						id="balance-chip"
						className={`balance-chip${primaryBalance.remaining <= 0 ? ' empty' : ''}`}
						title={quotaBalanceTitle(primaryBalance)}
					>
						{formatQuotaAmount(primaryBalance.remaining, primaryBalance.currency)}
					</span>
				) : null}
				<div className="ctx-anchor" ref={cachePopover.anchorRef}>
					<Ring
						id="ring-cache"
						variant="cache"
						percent={cachePct}
						expanded={cacheOpen}
						controls="cache-pop"
						title={`缓存命中率 ${cachePct}% · 命中 ${formatK(usage.cacheRead)} / 未命中 ${formatK(usage.input)}${usage.cacheWrite ? ` / 写入 ${formatK(usage.cacheWrite)}` : ''} · 点击查看明细`}
						onClick={() => {
							setCacheOpen((open) => !open);
							setCtxOpen(false);
							setQuotaOpen(false);
						}}
					/>
					{cacheOpen &&
						createPortal(
							<div
								id="cache-pop"
								ref={cachePopover.popRef}
								className={`ctx-pop cache-pop ${cachePopover.pos?.openBelow ? 'pop-below' : 'pop-above'}`}
								role="dialog"
								aria-label="缓存命中明细"
								style={
									cachePopover.pos
										? ({
												left: cachePopover.pos.left,
												top: cachePopover.pos.top,
												'--ctx-arrow-x': `${cachePopover.pos.arrowX}px`,
											} as CSSProperties)
										: { left: 0, top: 0, visibility: 'hidden' }
								}
							>
								<div className="ctx-pop-scroll">
									<div className="ctx-pop-head">
										<span>缓存命中</span>
										<button
											type="button"
											className="ctx-pop-close"
											aria-label="关闭缓存命中明细"
											onClick={() => setCacheOpen(false)}
										>
											×
										</button>
									</div>
									<div className="ctx-total">
										<b>{cachePct}%</b>
										<span>命中率</span>
										<em>{formatK(usage.cacheRead)} 命中</em>
									</div>
									{cacheRows.length > 0 ? (
										<>
											<div className="ctx-bar" aria-hidden="true">
												{cacheRows.map((row) =>
													row.value > 0 ? (
														<span
															key={row.key}
															className={`ctx-seg cache-${row.key}`}
															style={{ width: `${row.pct}%` }}
														/>
													) : null,
												)}
											</div>
											<div className="ctx-rows">
												{cacheRows.map((row) => (
													<div className={`ctx-row cache-${row.key}`} key={row.key}>
														<span className="ctx-dot" />
														<span className="ctx-name">{row.label}</span>
														<span className="ctx-meta">{Math.round(row.pct)}%</span>
														<b>{formatK(row.value)}</b>
													</div>
												))}
											</div>
										</>
									) : (
										<div className="ctx-empty">暂无缓存用量</div>
									)}
									<div className="ctx-note">
										{cacheDenominator
											? `命中率 = 命中 ÷（命中 + 未命中${usage.cacheWrite ? ' + 写入' : ''}）；缓存写入也占用输入 token`
											: '等待模型返回缓存用量'}
									</div>
								</div>
							</div>,
							document.body,
						)}
				</div>
				<div className="ctx-anchor" ref={ctxPopover.anchorRef}>
					<Ring
						id="ring-ctx"
						variant="ctx"
						percent={ctxPct}
						hot={ctxPct > 85}
						compacting={compacting}
						expanded={ctxOpen}
						controls="ctx-pop"
						title={`上下文用量 ${ctxPct}% · ${formatK(contextTokens)} / ${formatK(contextWindow)}${contextEstimated ? ' · 压缩后估算' : ''} · 点击查看明细`}
						onClick={() => {
							setCtxOpen((open) => !open);
							setQuotaOpen(false);
							setCacheOpen(false);
						}}
					/>
					{ctxOpen &&
						createPortal(
							<div
								id="ctx-pop"
								ref={ctxPopover.popRef}
								className={`ctx-pop ${ctxPopover.pos?.openBelow ? 'pop-below' : 'pop-above'}`}
								role="dialog"
								aria-label="上下文明细"
								style={
									ctxPopover.pos
										? ({
												left: ctxPopover.pos.left,
												top: ctxPopover.pos.top,
												'--ctx-arrow-x': `${ctxPopover.pos.arrowX}px`,
											} as CSSProperties)
										: { left: 0, top: 0, visibility: 'hidden' }
								}
							>
								<div className="ctx-pop-scroll">
									<div className="ctx-pop-head">
									<span>上下文明细</span>
									<button
										type="button"
										className="ctx-pop-close"
										aria-label="关闭上下文明细"
										onClick={() => setCtxOpen(false)}
									>
										×
									</button>
								</div>
								<div className="ctx-total">
									<b>{formatKTokens(ctxTotal)}</b>
									{contextWindow > 0 && <span>/ {formatKTokens(contextWindow)}</span>}
									<em>{ctxPct}%</em>
								</div>
								{breakdownRows.length > 0 ? (
									<>
										<div className="ctx-bar" aria-hidden="true">
											{breakdownRows.map((row) =>
												row.value > 0 ? (
													<span
														key={row.key}
														className={`ctx-seg ctx-${row.key}`}
														style={{ width: `${(row.value / barTotal) * 100}%` }}
													/>
												) : null,
											)}
										</div>
										<div className="ctx-rows">
											{breakdownRows.map((row) => (
												<div className={`ctx-row ctx-${row.key}`} data-key={row.key} key={row.key}>
													<span className="ctx-dot" />
													<span className="ctx-name">{row.label}</span>
													{row.meta && <span className="ctx-meta">{row.meta}</span>}
													<b>{formatKTokens(row.value)}</b>
												</div>
											))}
										</div>
									</>
								) : (
									<div className="ctx-empty">暂无可拆分的明细</div>
								)}
								<div className="ctx-note">
									{contextEstimated
										? '压缩后的估算值；下一轮模型返回 usage 后会自动校准'
										: contextTokens
											? '按字符数 ÷ 4 估算；差异来自 tokenizer，不是漏算内容'
											: '等待模型返回用量；以上为估算值'}
								</div>
								</div>
							</div>,
							document.body,
						)}
				</div>
				<button
					id="compact"
					className={`ring-btn${compacting ? ' compacting' : ''}`}
					type="button"
					title={busy ? '生成中不能压缩上下文' : compacting ? '正在压缩上下文…' : '压缩上下文'}
					aria-label={busy ? '生成中不能压缩上下文' : compacting ? '正在压缩上下文' : '压缩上下文'}
					aria-busy={compacting || undefined}
					disabled={compacting || busy}
					onClick={() => {
						compact().catch(() => {});
					}}
				>
					<svg viewBox="0 0 24 24" aria-hidden="true">
						<path
							d="M4 9h16M4 15h16M9 4v4M15 16v4"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.8"
							strokeLinecap="round"
						/>
					</svg>
				</button>
			</div>
		</div>
	);
}
