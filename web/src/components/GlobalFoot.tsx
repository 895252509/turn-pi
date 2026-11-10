import { useState } from 'react';
import { Settings } from 'lucide-react';
import { SettingsDialog } from '@/components/SettingsDialog';
import { useStore } from '@/lib/store';

/**
 * 全局底栏：设置入口 + 连接状态。
 *
 * 桌面端挂在最左的 icon rail 底部，移动端挂在抽屉底部（同一时刻只渲染一处，
 * 避免 #conn / #rail-settings-toggle 出现重复 id）。
 */
export function GlobalFoot() {
	const connection = useStore((s) => s.connection);
	const [settingsOpen, setSettingsOpen] = useState(false);

	const badgeClass = connection === 'on' ? 'badge on' : connection === 'off' ? 'badge off' : 'badge';
	const badgeText = connection === 'on' ? '已连接' : connection === 'off' ? '重连中…' : '连接中…';

	return (
		<div className="rail-foot">
			<button
				type="button"
				id="rail-settings-toggle"
				className={`rail-settings-btn${settingsOpen ? ' active' : ''}`}
				aria-expanded={settingsOpen}
				aria-haspopup="dialog"
				aria-controls="settings-dialog"
				title={settingsOpen ? '关闭设置' : '打开设置'}
				onClick={() => setSettingsOpen((open) => !open)}
			>
				<Settings aria-hidden="true" />
				<span>设置</span>
			</button>
			<span id="conn" className={badgeClass}>
				{badgeText}
			</span>
			<SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
		</div>
	);
}
