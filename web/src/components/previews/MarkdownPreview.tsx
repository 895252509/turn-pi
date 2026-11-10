import { useMemo, type MouseEvent } from 'react';
import { rawFileUrl } from '@/lib/files';
import { fileRefRawUrl } from '@/lib/fileRef';
import { dirname, normalizeWorkspacePath, resolveRelativePath } from '@/lib/panel';
import { renderMarkdown } from '@/lib/markdown';
import { useStore } from '@/lib/store';

/** Markdown 预览：相对图片走 /api/files/raw，相对链接拦截后在本栏打开。 */
export function MarkdownPreview({
	text,
	root,
	path,
}: {
	text: string;
	root: string;
	path: string;
}) {
	const openFile = useStore((s) => s.openFile);
	const openAddress = useStore((s) => s.openAddress);
	const showToast = useStore((s) => s.showToast);
	const base = dirname(path);

	const html = useMemo(
		() =>
			renderMarkdown(text, {
				resolveImage: (src) => {
					if (/^(?:https?:|data:)/i.test(src)) return src;
					if (/^pi-resource:\/\/file\//i.test(src)) return fileRefRawUrl(src);
					const relative = resolveRelativePath(base, src);
					return relative == null ? null : rawFileUrl(root, relative);
				},
				resolveFile: (href) => resolveRelativePath(base, href),
			}),
		[text, base, root],
	);

	const onClick = (event: MouseEvent<HTMLDivElement>) => {
		const target = event.target as Element;
		const refAnchor = target.closest<HTMLElement>('[data-file-ref]');
		if (refAnchor) {
			event.preventDefault();
			void openAddress(refAnchor.dataset.fileRef ?? '');
			return;
		}
		const anchor = target.closest<HTMLElement>('[data-file-href]');
		if (anchor) {
			event.preventDefault();
			const href = anchor.dataset.fileHref ?? '';
			// data-file-href 已经是相对工作区根解析过的路径，不能再按当前 md 目录解析一次。
			const relative = normalizeWorkspacePath(href);
			if (relative == null || relative === '') showToast('文件不在工作区');
			else openFile(relative, { root });
			return;
		}
		const link = target.closest<HTMLAnchorElement>('a[href^="#"]');
		if (link) event.preventDefault();
	};

	return (
		<div
			className="markdown-body preview-markdown panel-scroll"
			onClick={onClick}
			dangerouslySetInnerHTML={{ __html: html }}
		/>
	);
}
