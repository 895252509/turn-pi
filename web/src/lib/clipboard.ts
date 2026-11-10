/**
 * 复制到剪贴板。
 *
 * navigator.clipboard 只在安全上下文（https / localhost）里有，而且可能被权限策略拒掉；
 * Turn Pi 经常跑在内网 http 上，所以这里带一个 execCommand 兜底，
 * 返回值表示"是否真的复制成功"，调用方据此给反馈，不要默认成功。
 */
export async function copyText(text: string): Promise<boolean> {
	try {
		if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch {
		/* 落到下面的兜底 */
	}
	if (typeof document === 'undefined') return false;
	try {
		const area = document.createElement('textarea');
		area.value = text;
		area.setAttribute('readonly', '');
		area.style.position = 'fixed';
		area.style.top = '-1000px';
		area.style.opacity = '0';
		document.body.appendChild(area);
		area.select();
		const ok = typeof document.execCommand === 'function' ? document.execCommand('copy') : false;
		document.body.removeChild(area);
		return ok;
	} catch {
		return false;
	}
}
