import { useState } from 'react';
import type { FormEvent } from 'react';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { useStore } from '@/lib/store';

/**
 * Git tab 末端的「＋」：手动登记子目录仓库，并管理已登记的条目。
 * 只维护索引（运行态 JSON），不改仓库、不改目录。
 */
export function GitAddView({ onAdded }: { onAdded: (key: string) => void }) {
	const panel = useStore((s) => s.gitPanel);
	const status = useStore((s) => s.gitPanelStatus);
	const panelError = useStore((s) => s.gitPanelError);
	const addGitRepo = useStore((s) => s.addGitRepo);
	const removeGitRepo = useStore((s) => s.removeGitRepo);
	const [draft, setDraft] = useState('');
	const [saving, setSaving] = useState(false);

	const manual = (panel?.repos ?? []).filter((repo) => repo.source === 'manual');

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		const path = draft.trim();
		if (!path || saving) return;
		setSaving(true);
		try {
			const key = await addGitRepo(path);
			if (!key) return;
			setDraft('');
			onAdded(key);
		} finally {
			setSaving(false);
		}
	};

	return (
		<section className="git-view" aria-label="添加子仓库">
			<div className="git-inner">
				<div className="git-toolbar">
					<div className="git-summary">
						<b>添加子仓库</b>
						<span>手动登记工作区内的仓库</span>
					</div>
				</div>
				<form className="git-add" onSubmit={submit}>
					<input
						value={draft}
						onChange={(event) => setDraft(event.target.value)}
						placeholder="子目录路径，如 packages/api（也可粘贴工作区内的绝对路径）"
						aria-label="仓库路径"
						spellCheck={false}
					/>
					<button type="submit" className="git-btn primary" disabled={saving || !draft.trim()}>
						{saving ? <Loader2 className="spin" aria-hidden="true" /> : <Plus aria-hidden="true" />}
						{saving ? '添加中…' : '添加'}
					</button>
					<p className="git-hint">
						只登记工作区内的仓库；填仓库内部子目录会自动归一到仓库根。登记结果存在运行态，不写仓库。
						自动扫描只覆盖两层目录，更深的仓库用这里补。
					</p>
				</form>

				{status === 'error' ? <p className="git-error">{panelError}</p> : null}

				<div className="git-manual">
					<div className="git-manual-head">
						<span className="label">手动登记 · {manual.length}</span>
					</div>
					{manual.length ? (
						<ul className="git-manual-list">
							{manual.map((repo) => (
								<li key={repo.key}>
									<span className="git-manual-name" title={repo.path}>
										{repo.rel || repo.path}
									</span>
									<span className="git-manual-branch">{repo.branch ?? '—'}</span>
									<button
										type="button"
										className="git-remove"
										title="移除这条手动登记（不会删除目录）"
										aria-label={`移除 ${repo.rel || repo.path}`}
										onClick={() => {
											if (!repo.rel) return;
											if (!window.confirm(`移除手动登记的仓库 ${repo.rel}？（只删索引，不动目录）`)) return;
											void removeGitRepo(repo.rel);
										}}
									>
										<Trash2 aria-hidden="true" />
									</button>
								</li>
							))}
						</ul>
					) : (
						<p className="git-empty">还没有手动登记的仓库。</p>
					)}
				</div>
			</div>
		</section>
	);
}
