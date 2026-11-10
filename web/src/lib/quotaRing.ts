import { useEffect, useState } from 'react';
import type { ProviderQuotaWindow } from '@/lib/types';

export type QuotaRingOrder = '30d-outer' | '5h-outer';
export type QuotaRingMetric = 'used' | 'remaining';

export interface QuotaRingPrefs {
	/** 外圈的时间窗口：30d 在外，或 5h 在外。 */
	order: QuotaRingOrder;
	/** 环和数字表示已用百分比，还是剩余百分比。 */
	metric: QuotaRingMetric;
}

export interface QuotaRingLayer {
	key: string;
	label: string;
	name: string;
	className: string;
	radius: number;
	/** 当前设置下用于画环和显示的数字。 */
	percent: number;
	/** 接口返回的已用百分比。 */
	usedPercent: number;
	limited?: boolean;
	reset?: string;
}

export const QUOTA_RING_STORAGE_KEY = 'turnpi-quota-ring';
export const QUOTA_RING_EVENT = 'turnpi:quota-ring';

export const DEFAULT_QUOTA_RING_PREFS: QuotaRingPrefs = {
	order: '30d-outer',
	metric: 'used',
};

const LAYER_META: Record<'30d' | '7d' | '5h', { name: string; className: string }> = {
	'30d': { name: '30 天', className: 'q30' },
	'7d': { name: '7 天', className: 'q7' },
	'5h': { name: '5 小时', className: 'q5' },
};

let memoryPrefs = DEFAULT_QUOTA_RING_PREFS;

function normalize(raw: unknown): QuotaRingPrefs {
	const data = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
	return {
		order: data.order === '5h-outer' ? '5h-outer' : '30d-outer',
		metric: data.metric === 'remaining' ? 'remaining' : 'used',
	};
}

export function readQuotaRingPrefs(): QuotaRingPrefs {
	try {
		const raw = window.localStorage.getItem(QUOTA_RING_STORAGE_KEY);
		if (raw) {
			memoryPrefs = normalize(JSON.parse(raw));
			return memoryPrefs;
		}
	} catch {
		/* private mode / 无 localStorage */
	}
	return memoryPrefs;
}

export function updateQuotaRingPrefs(patch: Partial<QuotaRingPrefs>): QuotaRingPrefs {
	return writeQuotaRingPrefs({ ...readQuotaRingPrefs(), ...patch });
}

export function writeQuotaRingPrefs(prefs: QuotaRingPrefs): QuotaRingPrefs {
	const next = normalize(prefs);
	memoryPrefs = next;
	try {
		window.localStorage.setItem(QUOTA_RING_STORAGE_KEY, JSON.stringify(next));
	} catch {
		/* 只保留当前内存状态 */
	}
	window.dispatchEvent(new Event(QUOTA_RING_EVENT));
	return next;
}

export function useQuotaRingPrefs(): QuotaRingPrefs {
	const [prefs, setPrefs] = useState<QuotaRingPrefs>(readQuotaRingPrefs);

	useEffect(() => {
		const update = () => setPrefs(readQuotaRingPrefs());
		const onStorage = (event: StorageEvent) => {
			if (event.key === QUOTA_RING_STORAGE_KEY) update();
		};
		window.addEventListener('storage', onStorage);
		window.addEventListener(QUOTA_RING_EVENT, update);
		return () => {
			window.removeEventListener('storage', onStorage);
			window.removeEventListener(QUOTA_RING_EVENT, update);
		};
	}, []);

	return prefs;
}

/** 把接口窗口按设置排序，并映射成外→内三层的半径。 */
export function buildQuotaRingLayers(
	windows: ProviderQuotaWindow[],
	prefs: QuotaRingPrefs,
): QuotaRingLayer[] {
	const order: Array<'30d' | '7d' | '5h'> =
		prefs.order === '5h-outer' ? ['5h', '7d', '30d'] : ['30d', '7d', '5h'];
	const byLabel = new Map<string, ProviderQuotaWindow>();
	for (const win of windows) {
		if (typeof win.percent === 'number') byLabel.set(win.label, win);
	}

	const layers: QuotaRingLayer[] = [];
	for (const label of order) {
		const win = byLabel.get(label);
		if (!win || typeof win.percent !== 'number') continue;
		const usedPercent = Math.max(0, Math.min(100, win.percent));
		layers.push({
			key: label,
			label,
			name: LAYER_META[label].name,
			className: LAYER_META[label].className,
			radius: 0,
			percent: prefs.metric === 'remaining' ? 100 - usedPercent : usedPercent,
			usedPercent,
			limited: win.limited,
			reset: win.reset,
		});
	}

	// 半径差 = 线宽，三层紧贴；略留 0.1 重叠避免抗锯齿缝隙。
	return layers.map((layer, index) => ({
		...layer,
		radius: Math.round((15.7 - index * 2.9) * 100) / 100,
	}));
}

export function quotaRingHeadline(layers: QuotaRingLayer[], metric: QuotaRingMetric): number {
	if (!layers.length) return 0;
	return metric === 'remaining'
		? Math.min(...layers.map((layer) => layer.percent))
		: Math.max(...layers.map((layer) => layer.percent));
}

export function quotaRingHot(value: number, metric: QuotaRingMetric): boolean {
	return metric === 'remaining' ? value <= 15 : value >= 85;
}
