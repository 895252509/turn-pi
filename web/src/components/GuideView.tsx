import { Folder, Globe } from 'lucide-react';
import { GUIDE_ENTRIES } from '@/lib/panel';

function EntryIcon({ icon }: { icon: 'files' | 'search' }) {
	if (icon === 'files') return <Folder aria-hidden="true" />;
	return <Globe aria-hidden="true" />;
}

export function GuideView({ onOpen }: { onOpen: (id: string) => void }) {
	const entries = [...GUIDE_ENTRIES].sort((a, b) => a.order - b.order);
	const showDescription = entries.length <= 4;

	return (
		<div className="guide panel-scroll">
			<h2 className="guide-title">功能</h2>
			<div className="guide-list">
				{entries.map((entry) => (
					<button
						key={entry.id}
						type="button"
						className={`guide-card${entry.badge ? ' has-badge' : ''}`}
						onClick={() => onOpen(entry.id)}
					>
						<span className={`guide-icon guide-icon-${entry.icon}`}>
							<EntryIcon icon={entry.icon} />
						</span>
						<span className="guide-text">
							<span className="guide-name">{entry.title}</span>
							{showDescription && entry.description ? (
								<span className="guide-desc">{entry.description}</span>
							) : null}
						</span>
						{entry.badge ? <span className="guide-badge">{entry.badge} 待确认</span> : null}
					</button>
				))}
			</div>
			{entries.length === 0 ? <p className="empty-note">暂无可用功能</p> : null}
		</div>
	);
}
