export function formatK(value: number): string {
	const n = Number(value ?? 0);
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return '—';
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const seconds = ms / 1000;
	if (seconds < 10) return `${seconds.toFixed(1)}s`;
	if (seconds < 60) return `${Math.round(seconds)}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = Math.round(seconds % 60);
	return `${minutes}m${String(rest).padStart(2, '0')}s`;
}
