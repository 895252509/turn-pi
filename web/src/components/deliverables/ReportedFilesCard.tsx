import { useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Download, FilePenLine, FilePlus2, FileText } from 'lucide-react';
import { fileRefRawUrl } from '@/lib/fileRef';
import { useStore } from '@/lib/store';
import type { FileImportance, ReportedFile, TurnFiles } from '@/lib/types';

const IMPORTANCE_RANK: Record<FileImportance, number> = { high: 0, normal: 1, low: 2 };
/** minImportance 对应的最大 rank：low 显示全部，normal 隐藏 low，high 只显示 high */
const MIN_RANK: Record<FileImportance, number> = { low: 2, normal: 1, high: 0 };
const COLLAPSED_ROWS = 4;

function basename(path: string): string {
	const clean = path.replace(/\/+$/, '');
	const index = clean.lastIndexOf('/');
	return index >= 0 ? clean.slice(index + 1) : clean;
}

function changeLabel(change: ReportedFile['change']): string {
	if (change === 'created') return '新建';
	if (change === 'modified') return '修改';
	return '';
}

function FileIcon({ file }: { file: ReportedFile }) {
	if (file.change === 'created') return <FilePlus2 aria-hidden="true" />;
	if (file.change === 'modified') return <FilePenLine aria-hidden="true" />;
	return <FileText aria-hidden="true" />;
}

/**
 * 一轮结束时 agent 主动汇报的文件卡片。
 *
 * - 按 importance 排序：high → normal → low；
 * - 多文件 2 列网格（≤980px 单列），超过 4 个折叠；
 * - `low` 默认折叠（可在设置里把最低重要度调到 low / high）；
 * - 点击行 → 右栏打开（pi-resource:// 地址）；右侧下载按钮走 /api/files/raw?download=1。
 */
export function ReportedFilesCard({ files }: { files: TurnFiles }) {
	const openAddress = useStore((s) => s.openAddress);
	const enabled = useStore((s) => s.fileCardsEnabled);
	const minImportance = useStore((s) => s.fileCardsMinImportance);
	const [showLow, setShowLow] = useState(false);
	const [expanded, setExpanded] = useState(false);

	const sorted = useMemo(
		() =>
			[...files.files].sort(
				(a, b) =>
					IMPORTANCE_RANK[a.importance] - IMPORTANCE_RANK[b.importance] ||
					a.display.localeCompare(b.display),
			),
		[files.files],
	);

	if (!enabled || !sorted.length) return null;

	const threshold = MIN_RANK[minImportance];
	const primary = sorted.filter((file) => IMPORTANCE_RANK[file.importance] <= threshold);
	const hidden = sorted.filter((file) => IMPORTANCE_RANK[file.importance] > threshold);
	const canRevealHidden = minImportance !== 'high' && hidden.length > 0;
	if (!primary.length && !canRevealHidden) return null;

	const revealed = canRevealHidden && showLow;
	const shown = revealed ? [...primary, ...hidden] : primary;
	const rows = expanded ? shown : shown.slice(0, COLLAPSED_ROWS);
	const foldable = shown.length > COLLAPSED_ROWS;
	const single = sorted.length === 1 && shown.length === 1 && !hidden.length ? sorted[0] : undefined;
	const firstFile = single ?? primary[0] ?? sorted[0];
	const highCount = sorted.filter((file) => file.importance === 'high').length;
	const title = single
		? `${basename(single.path)}${changeLabel(single.change) ? ` · ${changeLabel(single.change)}` : ''}`
		: `汇报了 ${sorted.length} 个文件`;
	const subtitle = single
		? single.description
		: [highCount ? `${highCount} 个主要` : '', canRevealHidden && !revealed ? `${hidden.length} 个次要` : '']
				.filter(Boolean)
				.join(' · ');

	const fullPath = (file: ReportedFile) => (files.cwd ? `${files.cwd.replace(/\/+$/, '')}/${file.path}` : file.path);

	const head = (
		<>
			<span className="report-files-icon">
				<FileText aria-hidden="true" />
			</span>
			<span className="report-files-titles">
				<strong>{title}</strong>
				{subtitle ? <small>{subtitle}</small> : null}
			</span>
		</>
	);

	return (
		<div className="report-files" data-report-files>
			{single ? (
				<div className="report-files-head-wrap">
					<button
						type="button"
						className="report-files-head report-files-head-button"
						title={fullPath(single)}
						aria-label={`打开 ${single.display}`}
						onClick={() => {
							void openAddress(single.address);
						}}
					>
						{head}
					</button>
					<a
						className="report-files-download"
						href={fileRefRawUrl(single.address, { download: true })}
						download={basename(single.path)}
						title={`下载 ${single.display}`}
						aria-label={`下载 ${single.display}`}
					>
						<Download aria-hidden="true" />
					</a>
				</div>
			) : firstFile ? (
				<button
					type="button"
					className="report-files-head report-files-head-button"
					title={fullPath(firstFile)}
					aria-label={`打开 ${firstFile.display}`}
					onClick={() => {
						void openAddress(firstFile.address);
					}}
				>
					{head}
				</button>
			) : (
				<div className="report-files-head">{head}</div>
			)}

			{!single ? (
				<ul className="report-files-list">
					{rows.map((file) => (
						<li key={file.path} className="report-files-item">
							<button
								type="button"
								className={`report-files-row report-files-${file.importance}`}
								title={fullPath(file)}
								aria-label={`打开 ${file.display}`}
								onClick={() => {
									void openAddress(file.address);
								}}
							>
								<span className="report-files-row-icon">
									<FileIcon file={file} />
								</span>
								<span className="report-files-path">{file.display}</span>
								<span className="report-files-meta">
									{file.importance === 'high' ? <span className="report-files-badge">主要</span> : null}
									{changeLabel(file.change) ? <span>{changeLabel(file.change)}</span> : null}
									{file.line ? <span className="report-files-line">L{file.line}</span> : null}
								</span>
							</button>
							<a
								className="report-files-download"
								href={fileRefRawUrl(file.address, { download: true })}
								download={basename(file.path)}
								title={`下载 ${file.display}`}
								aria-label={`下载 ${file.display}`}
							>
								<Download aria-hidden="true" />
							</a>
						</li>
					))}
				</ul>
			) : null}

			{foldable || canRevealHidden ? (
				<div className="report-files-foot">
					{foldable ? (
						<button
							type="button"
							className="report-files-toggle"
							aria-expanded={expanded}
							onClick={() => setExpanded((value) => !value)}
						>
							{expanded ? '收起' : `显示全部 ${shown.length} 个`}
							{expanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
						</button>
					) : null}
					{canRevealHidden ? (
						<button
							type="button"
							className="report-files-toggle report-files-toggle-low"
							aria-expanded={revealed}
							onClick={() => setShowLow((value) => !value)}
						>
							{revealed ? '收起次要文件' : `还有 ${hidden.length} 个次要文件`}
						</button>
					) : null}
				</div>
			) : null}
		</div>
	);
}
