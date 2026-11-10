import { useEffect, useMemo, useState } from 'react';
import { useStore } from '@/lib/store';

/** 「12分34秒」；不足一分钟就只报秒，别写「0分07秒」。 */
export function formatTurnClock(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	const ss = String(seconds).padStart(2, '0');
	return minutes > 0 ? `${minutes}分${ss}秒` : `${ss}秒`;
}

/** 收起动画时长；和 CSS 里 .turn-verse 的 transition 保持一致 */
const LEAVE_MS = 240;

const TURN_VERSES = [
	'路漫漫其修远兮，吾将上下而求索。',
	'山重水复疑无路，柳暗花明又一村。',
	'长风破浪会有时，直挂云帆济沧海。',
	'天生我材必有用，千金散尽还复来。',
	'纸上得来终觉浅，绝知此事要躬行。',
	'海内存知己，天涯若比邻。',
	'会当凌绝顶，一览众山小。',
	'不积跬步，无以至千里。',
	'问渠那得清如许？为有源头活水来。',
	'凡是过往，皆为序章。',
	'我们都生活在阴沟里，但仍有人仰望星空。',
	'一个人可以被毁灭，但不能被打败。',
	'世上只有一种英雄主义：认清生活后依然热爱它。',
	// 游戏名句
	'断剑重铸之日，骑士归来之时。',
	'时间不在于你拥有多少，而在于你怎样使用。',
	'世界既不黑也不白，而是一道精致的灰。',
	'吾虽浪迹天涯，却未迷失本心。',
	'均衡，存乎万物之间。',
	'天动万象。',
	'俱收并蓄。',
	'只要不失去你的崇高，整个世界都会为你敞开。',
	'愿风神护佑你。',
	'旅途本身的意义，就是旅途。',
	'哇哦，抱歉。',
	'圣光会制裁你。',
	'我的魔法会把你撕成碎片。',
	'成长，生命，幸福，还有朋友。',
	'金色传说',
	'打得不错。',
	'为了部落！',
	'时间就是金钱，我的朋友。',
	'这个世界需要更多的英雄。',
	'犹豫就会败北。',
	'我以前和你一样是个冒险家，直到我的膝盖中了一箭。',
	'就决定是你了！',
	'赞美太阳！',
	'我的生命属于艾尔。',
	'注入灵魂',
	'梦开始的地方',
	'只要思想不滑坡，办法总比困难多。',
	'稳住，我们能赢。',
	'别问，问就是热爱。',
	'代码写得好，下班下得早。',
	'梦想还是要有的，万一实现了呢。',
	'鲸鱼娘正在深海里替你打捞答案。',
	'别怕，鲸鱼娘会把你托出水面。',
	'跟着鲸鱼娘，潜进知识的深海。',
	'深海有光，鲸鱼娘也有。',
	'鲸鱼娘说：慢慢来，答案会浮上来。',
];

/** 同一轮固定一句；换轮时用 startedAt + 随机盐重新洗一次。 */
function pickVerse(seed: number, salt: number): string {
	let hash = Math.imul((seed ^ Math.floor(salt * 0xffffffff)) >>> 0, 2654435761) >>> 0;
	hash ^= hash >>> 16;
	return TURN_VERSES[hash % TURN_VERSES.length] ?? TURN_VERSES[0];
}

/**
 * 输入框上方毛玻璃条里的一行：一句话 + 本轮总耗时 + 末尾三个点（纯展示，不可点）。
 *
 * 计时口径：从**发送**那一刻算起，到用户点中断或本轮回答完成；
 * 不是单步、也不是 token 速率那种瞬时值（那个在 #stats 里）。
 * 时间窗由 store 里 busy 的翻转维护（见 store.ts 末尾的 subscribe），
 * 这里只拿开始时间和本地 tick 做差——后台标签页被节流也不会把时间算歪。
 *
 * 名句、计时、三个点放在**同一个文本节点**里：扫光靠 background-clip: text，
 * 拆成多个元素会各扫各的（看着像几条光带），合成一段才是一道光从左扫到右。
 *
 * 本轮结束（完成或中断）后就**不再显示**：不保留最终时长，
 * 让毛玻璃条回落到原来的高度。收尾留 240ms 淡出，避免整条"啪"地抽走。
 */
export function TurnVerse() {
	const busy = useStore((s) => s.busy);
	/*
	 * 起点优先取"当前会话这一轮自己的 startedAt"（服务端 live 快照会带给它），
	 * 这样切换会话时计时跟着会话走，而不是沿用上一条会话的时间窗；
	 * store 里的 turnStartedAt 只在拿不到 startedAt 时兜底。
	 */
	const startedAt = useStore((s) => {
		if (!s.busy) return null;
		for (let i = s.items.length - 1; i >= 0; i -= 1) {
			const item = s.items[i];
			if (item.kind === 'turn' && typeof item.startedAt === 'number') return item.startedAt;
		}
		return s.turnStartedAt;
	});
	const [now, setNow] = useState(() => Date.now());
	/** 本轮展示哪句名句：startedAt 变化（新一轮）时重新随机 */
	const [verseSalt] = useState(() => Math.random());
	const verse = useMemo(() => pickVerse(startedAt ?? 0, verseSalt), [startedAt, verseSalt]);
	/** 收尾期间仍然留在 DOM 里（淡出 + 高度回落），之后卸载 */
	const [leaving, setLeaving] = useState(false);
	const [mounted, setMounted] = useState(false);

	useEffect(() => {
		if (!busy || !startedAt) return;
		setNow(Date.now());
		const id = setInterval(() => setNow(Date.now()), 500);
		return () => clearInterval(id);
	}, [busy, startedAt]);

	useEffect(() => {
		if (busy && startedAt) {
			setMounted(true);
			setLeaving(false);
			return;
		}
		if (!mounted) return;
		setLeaving(true);
		const id = setTimeout(() => {
			setMounted(false);
			setLeaving(false);
		}, LEAVE_MS);
		return () => clearTimeout(id);
	}, [busy, startedAt, mounted]);

	if (!mounted || !startedAt) return null;
	const elapsed = Math.max(0, (busy ? now : Date.now()) - startedAt);

	return (
		<div
			className={`turn-verse${busy ? ' running' : ''}${leaving ? ' leaving' : ''}`}
			role="timer"
			aria-live="off"
			data-elapsed={String(elapsed)}
		>
			{/* 一层小毛玻璃：滚动时后面的文字被模糊掉，不会和名句叠在一起 */}
			<span className="turn-verse-glass">
				<span className="turn-verse-line" data-verse={verse}>{`${verse} ${formatTurnClock(elapsed)} · · ·`}</span>
			</span>
		</div>
	);
}
