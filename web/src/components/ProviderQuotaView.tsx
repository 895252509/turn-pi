import { Loader2, RefreshCw } from 'lucide-react';
import type { ProviderQuota, ProviderQuotaBalance, ProviderQuotaWindow } from '@/lib/types';

const CURRENCY_SYMBOLS: Record<string, string> = {
	USD: '$',
	CNY: '¥',
	EUR: '€',
	GBP: '£',
	JPY: '¥',
};

function compactNumber(value: number): string {
	if (!Number.isFinite(value)) return '—';
	const abs = Math.abs(value);
	if (abs >= 1_000_000) {
		const n = value / 1_000_000;
		return `${n >= 10 ? Math.round(n) : Number(n.toFixed(1))}M`;
	}
	if (abs >= 1_000) {
		const n = value / 1_000;
		return `${n >= 10 ? Math.round(n) : Number(n.toFixed(1))}k`;
	}
	return String(Math.round(value));
}

function formatAmount(value: number, currency: string): string {
	const symbol = CURRENCY_SYMBOLS[currency.toUpperCase()] ?? `${currency} `;
	return `${symbol}${value.toLocaleString('en-US', {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	})}`;
}

function balanceTitle(balance: ProviderQuotaBalance): string {
	const parts: string[] = [];
	if (balance.total !== undefined) parts.push(`总额 ${formatAmount(balance.total, balance.currency)}`);
	if (balance.used !== undefined) parts.push(`已用 ${formatAmount(balance.used, balance.currency)}`);
	for (const detail of balance.details ?? []) {
		parts.push(`${detail.label} ${formatAmount(detail.amount, balance.currency)}`);
	}
	return parts.join(' · ') || `${balance.label} ${formatAmount(balance.remaining, balance.currency)}`;
}

function formatReset(value?: string): string {
	if (!value) return '';
	const date = new Date(value);
	if (!Number.isNaN(date.getTime())) {
		return date.toLocaleString('zh-CN', {
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
		});
	}
	return value;
}

function windowTitle(window: ProviderQuotaWindow): string {
	const parts: string[] = [];
	if (window.percent !== undefined) parts.push(`已用 ${window.percent}%`);
	if (window.limited) parts.push('已限流');
	if (window.limit !== undefined) parts.push(`上限 ${compactNumber(window.limit)}`);
	if (window.reset) parts.push(`重置 ${formatReset(window.reset)}`);
	return parts.join(' · ') || window.label;
}

function windowValue(window: ProviderQuotaWindow): string {
	if (window.percent !== undefined) return `${window.percent}%`;
	if (window.remaining !== undefined && window.limit !== undefined) {
		return `${compactNumber(window.remaining)}/${compactNumber(window.limit)}`;
	}
	if (window.remaining !== undefined) return `剩余 ${compactNumber(window.remaining)}`;
	if (window.limit !== undefined) return `上限 ${compactNumber(window.limit)}`;
	return '—';
}

function connectivityState(
	quota: ProviderQuota | undefined,
	loading: boolean,
	configured: boolean,
	enabled: boolean,
): { tone: string; text: string; title: string } {
	if (!enabled) return { tone: 'muted', text: '已停用', title: '该供应商已停用，不会参与模型请求' };
	if (!configured) return { tone: 'warn', text: '未配置', title: '缺少 API Key 环境变量' };
	if (loading) return { tone: 'busy', text: '探测中', title: '正在探测连接与额度' };
	if (!quota) return { tone: 'muted', text: '待探测', title: '还没有探测结果' };
	if (quota.reachable) {
		return {
			tone: 'ok',
			text: quota.latencyMs !== undefined ? `在线 ${quota.latencyMs}ms` : '在线',
			title: quota.sources.length ? `探测地址：${quota.sources.join(' · ')}` : '连接正常',
		};
	}
	return {
		tone: 'error',
		text: '连接失败',
		title: quota.error || quota.warnings.join('；') || '无法连接供应商',
	};
}

export function ProviderConnectivity({
	quota,
	loading,
	configured,
	enabled,
}: {
	quota?: ProviderQuota;
	loading: boolean;
	configured: boolean;
	enabled: boolean;
}) {
	const state = connectivityState(quota, loading, configured, enabled);
	return (
		<span className={`provider-connectivity ${state.tone}`} title={state.title}>
			<span className="provider-connectivity-dot" aria-hidden="true" />
			{state.text}
		</span>
	);
}

function QuotaContents({ quota }: { quota: ProviderQuota }) {
	if (quota.status === 'ok') {
		return (
			<span className="provider-quota-values">
				{quota.plan ? <span className="provider-quota-plan">{quota.plan}</span> : null}
				{quota.balances.map((balance, index) => (
					<span
						key={`${balance.label}-${balance.currency}-${index}`}
						className="provider-quota-chip balance"
						title={balanceTitle(balance)}
					>
						<span className="provider-quota-chip-label">{balance.label}</span>
						{formatAmount(balance.remaining, balance.currency)}
					</span>
				))}
				{quota.windows.map((window, index) => (
					<span
						key={`${window.label}-${index}`}
						className={`provider-quota-chip window${window.percent !== undefined ? ' percent' : ''}${
							window.limited ? ' limited' : ''
						}`}
						title={windowTitle(window)}
					>
						<span className="provider-quota-chip-label">{window.label}</span>
						{window.percent !== undefined ? (
							<span className="provider-quota-meter" aria-hidden="true">
								<span
									className="provider-quota-meter-fill"
									style={{ width: `${Math.max(0, Math.min(100, window.percent))}%` }}
								/>
							</span>
						) : null}
						{windowValue(window)}
					</span>
				))}
			</span>
		);
	}
	if (quota.status === 'unsupported') {
		return (
			<span className="provider-quota-note" title={quota.error || '该接口没有返回余额或速率额度'}>
				无公开额度信息
			</span>
		);
	}
	if (quota.status === 'unconfigured') {
		return <span className="provider-quota-note">配置凭据后可探测</span>;
	}
	return (
		<span className="provider-quota-error" title={quota.error || quota.warnings.join('；')}>
			探测失败
		</span>
	);
}

export function ProviderQuotaView({
	quota,
	loading,
	configured,
	enabled,
	onRefresh,
}: {
	quota?: ProviderQuota;
	loading: boolean;
	configured: boolean;
	enabled: boolean;
	onRefresh: () => void;
}) {
	return (
		<div className="provider-quota-line">
			<span className="provider-quota-label">额度</span>
			<div className="provider-quota-content">
				{loading && configured && enabled ? (
					<span className="provider-quota-loading">
						<Loader2 className="spin" aria-hidden="true" />
						探测中…
					</span>
				) : !enabled ? (
					<span className="provider-quota-note">供应商已停用</span>
				) : !configured ? (
					<span className="provider-quota-note">配置凭据后可探测</span>
				) : quota ? (
					<QuotaContents quota={quota} />
				) : (
					<span className="provider-quota-note">待探测</span>
				)}
			</div>
			<button
				type="button"
				className="provider-quota-refresh"
				aria-label="刷新额度"
				title={quota?.checkedAt ? `刷新额度 · 上次 ${new Date(quota.checkedAt).toLocaleTimeString()}` : '刷新额度'}
				disabled={loading || !configured || !enabled}
				onClick={onRefresh}
			>
				<RefreshCw className={loading ? 'spin' : undefined} aria-hidden="true" />
			</button>
		</div>
	);
}
