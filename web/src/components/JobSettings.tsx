import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock, Play, RefreshCw, XCircle } from 'lucide-react';
import { api } from '@/lib/api';
import type { JobInfo, JobRunRecord, JobsSnapshot } from '@/lib/types';

interface Draft {
	enabled: boolean;
	dryRun: boolean;
	intervalHours: string;
	config: Record<string, string | boolean>;
}

function makeDraft(job: JobInfo): Draft {
	return {
		enabled: job.enabled,
		dryRun: job.dryRun,
		intervalHours: String(Math.round((job.intervalMs / 3_600_000) * 10) / 10),
		config: Object.fromEntries(
			job.fields.map((field) => [
				field.key,
				field.type === 'boolean' ? Boolean(job.config[field.key] ?? field.default) : String(job.config[field.key] ?? field.default),
			]),
		),
	};
}

function formatTime(value?: string): string {
	if (!value) return '—';
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return '—';
	return date.toLocaleString('zh-CN', { hour12: false });
}

function formatDuration(run: JobRunRecord): string {
	const start = new Date(run.startedAt).getTime();
	const end = new Date(run.finishedAt).getTime();
	if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '—';
	const ms = end - start;
	if (ms < 1_000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
	return `${Math.round(ms / 60_000)}min`;
}

function statusText(status?: string): string {
	if (status === 'ok') return '成功';
	if (status === 'error') return '失败';
	return '未执行';
}

function RunRow({ run, name }: { run: JobRunRecord; name: string }) {
	return (
		<article className={`job-run ${run.status}`}>
			<div className="job-run-head">
				<span className={`job-run-status ${run.status}`}>
					{run.status === 'ok' ? <CheckCircle2 aria-hidden="true" /> : <XCircle aria-hidden="true" />}
					{statusText(run.status)}
				</span>
				<strong>{name}</strong>
				<span className="job-run-meta">
					{run.trigger === 'manual' ? '手动' : '定时'}
					{run.dryRun ? ' · 干跑' : ' · 真实执行'} · {formatTime(run.finishedAt)} · {formatDuration(run)}
				</span>
			</div>
			<p className="job-run-summary">{run.summary}</p>
			{run.error ? <pre className="job-error">{run.error}</pre> : null}
			{run.detail ? (
				<details className="job-run-detail">
					<summary>查看详情</summary>
					<pre>{JSON.stringify(run.detail, null, 2)}</pre>
				</details>
			) : null}
		</article>
	);
}

export function JobSettings() {
	const [snapshot, setSnapshot] = useState<JobsSnapshot | null>(null);
	const [drafts, setDrafts] = useState<Record<string, Draft>>({});
	const [loading, setLoading] = useState(true);
	const [pending, setPending] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async (keepDrafts = false) => {
		setLoading(true);
		setError(null);
		try {
			const data = await api<JobsSnapshot>('/api/jobs');
			setSnapshot(data);
			setDrafts((previous) =>
				keepDrafts
					? { ...Object.fromEntries(data.jobs.map((job) => [job.id, makeDraft(job)])), ...previous }
					: Object.fromEntries(data.jobs.map((job) => [job.id, makeDraft(job)])),
			);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const patchDraft = (jobId: string, patch: Partial<Draft>) => {
		setDrafts((previous) => ({ ...previous, [jobId]: { ...previous[jobId], ...patch } }));
	};

	const patchConfig = (jobId: string, key: string, value: string | boolean) => {
		setDrafts((previous) => ({
			...previous,
			[jobId]: { ...previous[jobId], config: { ...previous[jobId].config, [key]: value } },
		}));
	};

	async function save(job: JobInfo) {
		const draft = drafts[job.id];
		if (!draft) return;
		const config: Record<string, number | boolean> = {};
		for (const field of job.fields) {
			const value = draft.config[field.key];
			if (field.type === 'boolean') {
				config[field.key] = Boolean(value);
			} else {
				const parsed = Number(value);
				config[field.key] = String(value ?? '').trim() !== '' && Number.isFinite(parsed) ? parsed : Number(job.config[field.key] ?? field.default);
			}
		}
		const intervalHours = Number(draft.intervalHours);
		const intervalMs = Number.isFinite(intervalHours) && intervalHours > 0 ? Math.round(intervalHours * 3_600_000) : job.intervalMs;
		setPending(`save:${job.id}`);
		setError(null);
		try {
			await api('/api/jobs/update', {
				id: job.id,
				enabled: draft.enabled,
				dryRun: draft.dryRun,
				intervalMs,
				config,
			});
			await load();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setPending(null);
		}
	}

	async function run(job: JobInfo, forceDryRun: boolean) {
		// 用已保存的 dryRun，不用未保存的草稿：避免“改了开关但没保存”时误触发真实删除。
		const dryRun = forceDryRun || job.dryRun;
		if (!dryRun && !window.confirm(`将真实删除符合条件的 worktree，确定执行「${job.name}」？`)) return;
		setPending(`run:${job.id}`);
		setError(null);
		try {
			const result = await api<{ ok: boolean; run?: JobRunRecord; error?: string }>('/api/jobs/run', {
				id: job.id,
				dryRun,
			});
			if (!result.ok) {
				const message = result.error ?? '执行失败';
				await load(true);
				setError(message);
				return;
			}
			await load();
		} catch (reason) {
			const message = reason instanceof Error ? reason.message : String(reason);
			await load(true);
			setError(message);
		} finally {
			setPending(null);
		}
	}

	const jobs = snapshot?.jobs ?? [];
	const runs = snapshot?.runs ?? [];
	const running = jobs.some((job) => job.running);
	const names = new Map(jobs.map((job) => [job.id, job.name]));

	return (
		<div id="jobs-settings" className="jobs-body">
			<div className="settings-section">
				<div className="jobs-head">
					<div>
						<h3>进程内定时任务</h3>
						<p className="jobs-head-note">
							随 server 启动，状态落盘到 runtime/jobs；进程重启后按上次执行时间补跑。{running ? ' 当前有任务在执行。' : ''}
						</p>
					</div>
					<button type="button" className="ghost small" onClick={() => void load()} disabled={loading || pending !== null}>
						<RefreshCw aria-hidden="true" className={loading ? 'spin' : undefined} />
						刷新
					</button>
				</div>

				{error ? (
					<div className="jobs-error" role="alert">
						<AlertTriangle aria-hidden="true" />
						<span>{error}</span>
					</div>
				) : null}

				{loading && !snapshot ? <p className="settings-note">正在读取任务状态…</p> : null}
				{!loading && jobs.length === 0 ? <p className="settings-note">没有已注册的定时任务。</p> : null}

				{jobs.map((job) => {
					const draft = drafts[job.id] ?? makeDraft(job);
					const busy = job.running || pending === `save:${job.id}` || pending === `run:${job.id}`;
					return (
						<article className="job-card" key={job.id}>
							<div className="job-card-head">
								<div className="job-card-title">
									<Clock aria-hidden="true" />
									<div>
										<strong>{job.name}</strong>
										<small>{job.description}</small>
									</div>
								</div>
								<div className="job-badges">
									<span className={`job-badge ${draft.enabled ? 'on' : 'off'}`}>{draft.enabled ? '已启用' : '已暂停'}</span>
									<span className={`job-badge ${draft.dryRun ? 'dry' : 'live'}`}>{draft.dryRun ? '干跑' : '真实删除'}</span>
									{job.running ? <span className="job-badge running">执行中</span> : null}
								</div>
							</div>

							<div className="job-meta">
								<div>
									<span>上次执行</span>
									<strong>{formatTime(job.state.lastRunAt)}</strong>
								</div>
								<div>
									<span>上次结果</span>
									<strong className={job.state.lastStatus === 'error' ? 'bad' : ''}>{statusText(job.state.lastStatus)}</strong>
								</div>
								<div>
									<span>下次计划</span>
									<strong>{draft.enabled ? formatTime(job.state.nextRunAt) : '—'}</strong>
								</div>
								<div>
									<span>累计执行</span>
									<strong>{job.state.totalRuns}</strong>
								</div>
							</div>

							{job.state.lastSummary ? (
								<p className={`job-last-summary ${job.state.lastStatus === 'error' ? 'bad' : ''}`}>{job.state.lastSummary}</p>
							) : null}
							{job.state.lastError ? <pre className="job-error">{job.state.lastError}</pre> : null}

							<div className="job-config">
								<div className="job-field">
									<span>执行间隔</span>
									<div className="job-input-wrap">
										<input
											type="number"
											min={1}
											step={0.5}
											aria-label="执行间隔（小时）"
											value={draft.intervalHours}
											onChange={(event) => patchDraft(job.id, { intervalHours: event.target.value })}
										/>
										<small>小时</small>
									</div>
								</div>
								{job.fields.map((field) => (
									<div className="job-field" key={field.key} title={field.hint}>
										<span>{field.label}</span>
										{field.type === 'boolean' ? (
											<span className="settings-switch">
												<input
													type="checkbox"
													aria-label={field.label}
													checked={Boolean(draft.config[field.key])}
													onChange={(event) => patchConfig(job.id, field.key, event.target.checked)}
												/>
												<span aria-hidden="true" />
											</span>
										) : (
											<div className="job-input-wrap">
												<input
													type="number"
													min={field.min}
													max={field.max}
													step={field.step}
													aria-label={field.label}
													value={String(draft.config[field.key] ?? '')}
													onChange={(event) => patchConfig(job.id, field.key, event.target.value)}
												/>
												{field.unit ? <small>{field.unit}</small> : null}
											</div>
										)}
									</div>
								))}
							</div>

							<div className="job-switches">
								<label className="settings-row">
									<span className="settings-row-copy">
										<strong>启用定时执行</strong>
										<small>关闭后仍可手动运行</small>
									</span>
									<span className="settings-switch">
										<input
											type="checkbox"
											checked={draft.enabled}
											onChange={(event) => patchDraft(job.id, { enabled: event.target.checked })}
										/>
										<span aria-hidden="true" />
									</span>
								</label>
								<label className="settings-row">
									<span className="settings-row-copy">
										<strong>干跑模式</strong>
										<small>只扫描和报告，不实际删除；手动执行也遵循这个模式</small>
									</span>
									<span className="settings-switch">
										<input
											type="checkbox"
											checked={draft.dryRun}
											onChange={(event) => patchDraft(job.id, { dryRun: event.target.checked })}
										/>
										<span aria-hidden="true" />
									</span>
								</label>
							</div>

							<div className="job-actions">
								<button type="button" className="ghost small" onClick={() => void save(job)} disabled={busy}>
									保存设置
								</button>
								<button type="button" className="ghost small" onClick={() => void run(job, false)} disabled={busy}>
									<Play aria-hidden="true" />
									{job.dryRun ? '按干跑执行' : '立即执行'}
								</button>
								<button type="button" className="ghost small" onClick={() => void run(job, true)} disabled={busy}>
									干跑一次
								</button>
								<span className="job-actions-note">
									真实执行不会 force；脏树、打开中的会话、未归档 fork 都会跳过。
								</span>
							</div>
						</article>
					);
				})}
			</div>

			<div className="settings-section">
				<div className="jobs-head">
					<div>
						<h3>执行记录</h3>
						<p className="jobs-head-note">最近 200 次，包含定时和手动执行；点开详情可看候选与跳过原因。</p>
					</div>
				</div>
				<div className="job-runs">
					{runs.length === 0 ? <p className="settings-note">还没有执行记录。</p> : null}
					{runs.map((run) => (
						<RunRow key={run.id} run={run} name={names.get(run.jobId) ?? run.jobId} />
					))}
				</div>
			</div>
		</div>
	);
}
