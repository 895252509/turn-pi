import { rawFileUrl } from '@/lib/files';
import { basename } from '@/lib/panel';

export function ImagePreview({
	root,
	path,
	version,
	fit,
	onToggleFit,
}: {
	root: string;
	path: string;
	version?: string;
	fit: boolean;
	onToggleFit: () => void;
}) {
	return (
		<div className={`image-preview panel-scroll${fit ? ' fit' : ''}`}>
			<img
				src={rawFileUrl(root, path, { version })}
				alt={basename(path)}
				loading="lazy"
				onClick={onToggleFit}
			/>
		</div>
	);
}
