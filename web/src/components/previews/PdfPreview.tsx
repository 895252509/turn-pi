import { rawFileUrl } from '@/lib/files';
import { basename } from '@/lib/panel';

export function PdfPreview({
	root,
	path,
	version,
}: {
	root: string;
	path: string;
	version?: string;
}) {
	return (
		<iframe
			key={`${path}:${version ?? ''}`}
			className="pdf-frame"
			title={basename(path)}
			src={rawFileUrl(root, path, { version })}
		/>
	);
}
