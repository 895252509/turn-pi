import type { ReactNode } from 'react';
import { ChevronRight, Folder, FolderOpen, Link2, Loader2 } from 'lucide-react';
import { FileTypeIcon } from '@/components/files/fileIcons';
import type { FileEntry } from '@/lib/types';

export interface DirState {
	status: 'idle' | 'loading' | 'ready' | 'error';
	entries: FileEntry[];
	error?: string;
	truncated?: boolean;
	expanded?: boolean;
	refreshing?: boolean;
	/** 首次懒加载进行中：拿到结果后自动展开。 */
	pending?: boolean;
}

export const IGNORED_NAMES = new Set(['node_modules', '.git', 'dist', '.next', '.turbo', 'coverage', '.cache']);

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function childPath(parent: string, name: string): string {
	return parent ? `${parent}/${name}` : name;
}

function RowIcon({ entry }: { entry: FileEntry }) {
	if (entry.type === 'directory') return null;
	return <FileTypeIcon name={entry.name} />;
}

function sortEntries(entries: FileEntry[], showIgnored: boolean): FileEntry[] {
	return entries
		.filter((entry) => showIgnored || !IGNORED_NAMES.has(entry.name))
		.sort((a, b) => {
			const aDir = a.type === 'directory' ? 0 : 1;
			const bDir = b.type === 'directory' ? 0 : 1;
			if (aDir !== bDir) return aDir - bDir;
			return collator.compare(a.name, b.name);
		});
}

function HelpRow({ children }: { children: ReactNode }) {
	return <div className="file-help">{children}</div>;
}

export function FileTree({
	root,
	dirs,
	path = '',
	depth = 0,
	showIgnored,
	onToggle,
	onOpen,
	onRetry,
}: {
	root: string;
	dirs: Record<string, DirState>;
	path?: string;
	depth?: number;
	showIgnored: boolean;
	onToggle: (path: string) => void;
	onOpen: (root: string, path: string) => void;
	onRetry: (path: string) => void;
}) {
	const dir = dirs[path];
	const pad = 10 + depth * 14;

	if (!dir || dir.status === 'idle') {
		return null;
	}

	// 懒加载未返回时不占位：只让目录行的文件夹图标转圈，拿到结果再展开。
	if (dir.status === 'loading' && !dir.entries.length) {
		return null;
	}

	if (dir.status === 'error' && !dir.entries.length) {
		return (
			<div className="file-error" style={{ paddingLeft: pad }}>
				<span>{dir.error || '目录加载失败'}</span>
				<button type="button" onClick={() => onRetry(path)}>
					重试
				</button>
			</div>
		);
	}

	const entries = sortEntries(dir.entries, showIgnored);
	if (!entries.length) {
		return <HelpRow>{dir.status === 'error' ? '加载失败' : '空目录'}</HelpRow>;
	}

	return (
		<>
			{entries.map((entry) => {
				const full = childPath(path, entry.name);
				const isDir = entry.type === 'directory' && !entry.blocked;
				const expanded = Boolean(isDir && dirs[full]?.expanded);
				const loading = Boolean(
					isDir && !expanded && dirs[full]?.status === 'loading' && !dirs[full]?.entries.length,
				);
				const disabled = entry.blocked || entry.type === 'other';
				const title = entry.blocked
					? '指向工作区外'
					: entry.type === 'other'
						? '不支持的类型'
						: entry.symlink
							? `符号链接 · ${full}`
							: full;

				return (
					<div key={full} className="file-node">
						<button
							type="button"
							className={`file-row${disabled ? ' disabled' : ''}${isDir ? ' directory' : ' file'}`}
							style={{ paddingLeft: pad }}
							title={title}
							aria-expanded={isDir ? expanded : undefined}
							aria-busy={loading || undefined}
							disabled={disabled}
							onClick={() => {
								if (disabled) return;
								if (isDir) onToggle(full);
								else onOpen(root, full);
							}}
						>
							<span className="file-chevron" aria-hidden="true">
								{isDir ? <ChevronRight className={expanded ? 'open' : ''} /> : null}
							</span>
							<span className={`file-icon${isDir ? ' folder' : ''}`}>
								{isDir ? (
									loading ? (
										<Loader2 className="file-spin" aria-hidden="true" />
									) : expanded ? (
										<FolderOpen aria-hidden="true" />
									) : (
										<Folder aria-hidden="true" />
									)
								) : (
									<RowIcon entry={entry} />
								)}
							</span>
							<span className={`file-name${entry.name.startsWith('.') ? ' dotfile' : ''}`}>{entry.name}</span>
							{entry.symlink ? <Link2 className="file-link" aria-hidden="true" /> : null}
						</button>
						{expanded ? (
							<FileTree
								root={root}
								dirs={dirs}
								path={full}
								depth={depth + 1}
								showIgnored={showIgnored}
								onToggle={onToggle}
								onOpen={onOpen}
								onRetry={onRetry}
							/>
						) : null}
					</div>
				);
			})}
			{dir.truncated ? <HelpRow>仅显示前 2000 项</HelpRow> : null}
			{dir.status === 'error' ? <HelpRow>刷新失败，显示的是缓存内容</HelpRow> : null}
		</>
	);
}
