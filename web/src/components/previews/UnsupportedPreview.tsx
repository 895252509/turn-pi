import { Download, FileQuestion } from 'lucide-react';
import { formatBytes } from '@/lib/fileKinds';
import { rawFileUrl } from '@/lib/files';
import { basename } from '@/lib/panel';

export function UnsupportedPreview({
	root,
	path,
	size,
	reason,
}: {
	root: string;
	path: string;
	size?: number;
	reason?: string;
}) {
	return (
		<div className="preview-unsupported panel-scroll">
			<div className="preview-unsupported-card">
				<FileQuestion aria-hidden="true" />
				<div className="preview-unsupported-title">{basename(path)}</div>
				<div className="preview-unsupported-meta">
					{size != null ? formatBytes(size) : '未知大小'}
					{reason ? ` · ${reason}` : ''}
				</div>
				<p>该类型暂不支持预览</p>
				<a className="preview-action primary" href={rawFileUrl(root, path, { download: true })}>
					<Download aria-hidden="true" />
					下载
				</a>
			</div>
		</div>
	);
}
