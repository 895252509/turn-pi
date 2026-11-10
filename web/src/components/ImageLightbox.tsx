import { useEffect } from 'react';
import { X } from 'lucide-react';
import { createPortal } from 'react-dom';

/** 全屏图片预览：点击遮罩 / Esc 关闭，图片本身不触发关闭。 */
export function ImageLightbox({
	src,
	alt,
	onClose,
}: {
	src: string;
	alt?: string;
	onClose: () => void;
}) {
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') onClose();
		};
		const previousOverflow = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
		document.addEventListener('keydown', onKeyDown);
		return () => {
			document.body.style.overflow = previousOverflow;
			document.removeEventListener('keydown', onKeyDown);
		};
	}, [onClose]);

	return createPortal(
		<div
			className="image-lightbox"
			role="dialog"
			aria-modal="true"
			aria-label={alt ? `预览 ${alt}` : '图片预览'}
			onClick={onClose}
		>
			<img src={src} alt={alt ?? ''} onClick={(event) => event.stopPropagation()} />
			<button type="button" className="image-lightbox-close" aria-label="关闭图片预览" onClick={onClose}>
				<X aria-hidden="true" />
			</button>
		</div>,
		document.body,
	);
}
