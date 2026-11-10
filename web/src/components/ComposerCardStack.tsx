import { useEffect, useState } from 'react';
import { Check, Clock, Layers, MessageSquare, ShieldAlert, X } from 'lucide-react';
import { ComposerCard, nextComposerCardState } from '@/components/ComposerCard';
import type { ComposerCardState } from '@/components/ComposerCard';
import { useStore } from '@/lib/store';
import type { CredentialRequest, CredentialTimeout, QueuePlacement } from '@/lib/types';

/**
 * 输入框后面的共通卡片栈：待发送消息和凭据审批都从这里向上堆。
 *
 * 卡片只有三档状态，右上角同一个箭头循环切换：
 *   peek    只露 2px 上边框，表示「还有东西」，点一下回到默认；
 *   default 图标 + 标题 + 摘要 + 功能自己的一行按钮；
 *   expanded 功能自己的完整内容（队列全文 / 审批目标、范围、原因）。
 *
 * 计数、全部收回、插话 / 撤回 / 审批按钮都属于功能内容，放在卡片体内，
 * 卡片外壳只提供头和箭头。
 */
export function ComposerCardStack() {
	const queue = useStore((s) => s.queue);
	const running = useStore((s) => s.busy);
	const queueAction = useStore((s) => s.queueAction);
	const clearQueue = useStore((s) => s.clearQueue);
	const requests = useStore((s) => s.credentialRequests);
	const timeouts = useStore((s) => s.credentialTimeouts);
	const decide = useStore((s) => s.decideCredential);
	const dismissTimeout = useStore((s) => s.dismissCredentialTimeout);
	const [states, setStates] = useState<Record<string, ComposerCardState>>({});
	const [queueBusy, setQueueBusy] = useState<string | null>(null);

	const queueItems = [
		...queue.steering.map((text, index) => ({ placement: 'steering' as const, index, text })),
		...queue.followUp.map((text, index) => ({ placement: 'followUp' as const, index, text })),
	];

	// 队列清空、审批处理完后把对应状态一起收走，下一次出现时从默认形态开始。
	useEffect(() => {
		setStates((current) => {
			const alive = new Set(requests.map((request) => request.requestId));
			for (const request of timeouts) alive.add(`timeout-${request.requestId}`);
			if (queueItems.length) alive.add('queue');
			let changed = false;
			const next: Record<string, ComposerCardState> = {};
			for (const [id, value] of Object.entries(current)) {
				if (alive.has(id)) next[id] = value;
				else changed = true;
			}
			return changed ? next : current;
		});
	}, [queueItems.length, requests, timeouts]);

	if (!queueItems.length && !requests.length && !timeouts.length) return null;

	const stateOf = (id: string, fallback: ComposerCardState = 'default'): ComposerCardState =>
		states[id] ?? fallback;

	const cycle = (id: string, fallback: ComposerCardState = 'default') => {
		setStates((current) => {
			const previous = current[id] ?? fallback;
			const next = { ...current };
			// 同一时间最多展开一张，其余展开中的卡片回到默认，避免堆得太高。
			if (previous === 'default') {
				for (const [key, value] of Object.entries(next)) {
					if (value === 'expanded') next[key] = 'default';
				}
			}
			next[id] = nextComposerCardState(previous);
			return next;
		});
	};

	const act = async (
		key: string,
		placement: QueuePlacement,
		index: number,
		text: string,
		kind: 'steer' | 'remove',
	) => {
		setQueueBusy(key);
		try {
			await queueAction(placement, index, text, kind);
		} finally {
			setQueueBusy(null);
		}
	};

	const queueState = stateOf('queue');
	const queueTone = queue.steering.length ? 'steering' : 'followUp';
	const visibleQueue = queueState === 'expanded' ? queueItems : queueItems.slice(0, 2);
	const hiddenQueue = queueItems.length - visibleQueue.length;
	const stackLabel = [
		queueItems.length ? `待发送消息 ${queueItems.length} 条` : '',
		requests.length ? '凭据使用审批' : '',
		timeouts.length ? '已超时的凭据审批' : '',
	]
		.filter(Boolean)
		.join('、');

	return (
		<section className="composer-card-stack" aria-label={stackLabel}>
			{queueItems.length ? (
				<ComposerCard
					tone={queueTone}
					icon={<Layers aria-hidden="true" />}
					title={`待发送 ${queueItems.length} 条`}
					summary={
						running ? 'Enter 插话 · Ctrl/Cmd+Enter 排队' : '本轮已停止，可收回后重新发送'
					}
					state={queueState}
					onCycle={() => cycle('queue')}
					className={`queue-card ${queueTone}`}
					summaryClassName="queue-card-summary"
				>
					<div className="queue-card-toolbar">
						<span className="queue-card-count">
							插话 {queue.steering.length} · 排队 {queue.followUp.length}
						</span>
						<button
							type="button"
							className="provider-card-btn queue-card-clear"
							disabled={queueBusy !== null}
							title="全部收回输入框"
							onClick={() => {
								setQueueBusy('clear');
								void clearQueue().finally(() => setQueueBusy(null));
							}}
						>
							全部收回
						</button>
					</div>

					{visibleQueue.map((item) => {
						const key = `${item.placement}-${item.index}-${item.text}`;
						const steering = item.placement === 'steering';
						return (
							<div
								key={key}
								className={`queue-row ${item.placement}`}
								data-tone={item.placement}
								data-queue-placement={item.placement}
								data-queue-index={item.index}
								aria-live="polite"
							>
								<span className="composer-card-icon queue-row-icon">
									{steering ? <MessageSquare aria-hidden="true" /> : <Clock aria-hidden="true" />}
								</span>
								<span className="composer-card-copy queue-row-copy">
									<strong>{steering ? '插话中' : '排队中'}</strong>
									<small title={item.text}>{item.text}</small>
								</span>
								<div className="composer-card-actions queue-row-actions">
									{!steering ? (
										<button
											type="button"
											className="provider-card-btn queue-action steer"
											disabled={!running || queueBusy !== null}
											title={running ? '强制插话到当前轮次' : '本轮已停止，插话不可用'}
											onClick={() => void act(key, item.placement, item.index, item.text, 'steer')}
										>
											<MessageSquare aria-hidden="true" />
											插话
										</button>
									) : null}
									<button
										type="button"
										className="provider-card-btn danger queue-action remove"
										disabled={queueBusy !== null}
										title={steering ? '撤回这条插话' : '从队列移除'}
										onClick={() => void act(key, item.placement, item.index, item.text, 'remove')}
									>
										<X aria-hidden="true" />
										{steering ? '撤回' : '移除'}
									</button>
								</div>
								{queueState === 'expanded' ? (
									<p className="composer-card-fulltext queue-row-fulltext">{item.text}</p>
								) : null}
							</div>
						);
					})}

					{hiddenQueue > 0 ? (
						<p className="queue-card-more">还有 {hiddenQueue} 条，点卡片头展开</p>
					) : null}
				</ComposerCard>
			) : null}

			{timeouts.map((request) => {
				const cardId = `timeout-${request.requestId}`;
				return (
					<TimedOutCredentialCard
						key={cardId}
						request={request}
						state={stateOf(cardId, 'peek')}
						onCycle={() => cycle(cardId, 'peek')}
						onDismiss={() => dismissTimeout(request.requestId)}
					/>
				);
			})}

			{requests.map((request) => (
				<CredentialRequestCard
					key={request.requestId}
					request={request}
					state={stateOf(request.requestId)}
					onCycle={() => cycle(request.requestId)}
					onDecide={(decision) => void decide(request.requestId, decision)}
				/>
			))}
		</section>
	);
}

function CredentialRequestCard({
	request,
	state,
	onCycle,
	onDecide,
}: {
	request: CredentialRequest;
	state: ComposerCardState;
	onCycle: () => void;
	onDecide: (decision: 'once' | 'session' | 'deny') => void;
}) {
	return (
		<ComposerCard
			tone="approval"
			icon={<ShieldAlert aria-hidden="true" />}
			title={`凭据 ${request.credential.label}`}
			summary={
				<>
					{request.scopes.join(' · ')}
					{request.reason ? <span className="credential-request-reason"> · {request.reason}</span> : null}
				</>
			}
			state={state}
			onCycle={onCycle}
			className="credential-request"
			summaryClassName="credential-request-summary"
		>
			<div className="composer-card-actions credential-request-actions">
				<button
					type="button"
					className="provider-card-btn"
					title="仅允许这一次使用"
					onClick={() => onDecide('once')}
				>
					<Check aria-hidden="true" />
					仅本次
				</button>
				<button
					type="button"
					className="provider-card-btn"
					title="本会话一直允许，直到会话结束"
					onClick={() => onDecide('session')}
				>
					<Layers aria-hidden="true" />
					本会话
				</button>
				<button
					type="button"
					className="provider-card-btn danger"
					title="拒绝这次请求"
					onClick={() => onDecide('deny')}
				>
					<X aria-hidden="true" />
					拒绝
				</button>
			</div>

			{state === 'expanded' ? <CredentialRequestDetail request={request} /> : null}
		</ComposerCard>
	);
}

function TimedOutCredentialCard({
	request,
	state,
	onCycle,
	onDismiss,
}: {
	request: CredentialTimeout;
	state: ComposerCardState;
	onCycle: () => void;
	onDismiss: () => void;
}) {
	return (
		<ComposerCard
			tone="approval"
			icon={<ShieldAlert aria-hidden="true" />}
			title={`凭据 ${request.credential.label} · 审批已超时`}
			summary={
				<>
					{request.scopes.join(' · ')}
					{request.reason ? <span className="credential-request-reason"> · {request.reason}</span> : null}
				</>
			}
			state={state}
			onCycle={onCycle}
			className="credential-request credential-request-timeout"
			summaryClassName="credential-request-summary"
		>
			<div className="composer-card-actions credential-request-actions credential-request-timeout-actions">
				<span className="credential-request-timeout-label">
					<Clock aria-hidden="true" />
					已超时，自动拒绝
				</span>
				<button
					type="button"
					className="provider-card-btn"
					title="收起这条超时记录"
					onClick={onDismiss}
				>
					<X aria-hidden="true" />
					知道了
				</button>
			</div>
			{state === 'expanded' ? <CredentialRequestDetail request={request} timedOut /> : null}
		</ComposerCard>
	);
}

function CredentialRequestDetail({ request, timedOut }: { request: CredentialRequest; timedOut?: boolean }) {
	return (
		<div className="composer-card-detail credential-request-detail">
			<dl>
				<div>
					<dt>目标</dt>
					<dd>{request.credential.hosts.join('、') || '—'}</dd>
				</div>
				<div>
					<dt>范围</dt>
					<dd>{request.scopes.join('、')}</dd>
				</div>
				<div>
					<dt>原因</dt>
					<dd>{request.reason || '—'}</dd>
				</div>
			</dl>
			<p>
				{timedOut
					? '这条审批在 120 秒内没有操作，已自动拒绝；真实密钥没有下发。点右上角箭头可以重新收起成细条。'
					: '真实密钥由服务端注入，agent 只拿到租约。选「本会话」后该租约持续到会话结束或手动撤销；120 秒未操作自动拒绝。'}
			</p>
		</div>
	);
}
