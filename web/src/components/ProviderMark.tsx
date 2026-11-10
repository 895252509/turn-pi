import anthropicSvg from '@/assets/providers/anthropic.svg?raw';
import cerebrasSvg from '@/assets/providers/cerebras.svg?raw';
import deepseekSvg from '@/assets/providers/deepseek.svg?raw';
import fireworksSvg from '@/assets/providers/fireworks.svg?raw';
import geminiSvg from '@/assets/providers/gemini.svg?raw';
import groqSvg from '@/assets/providers/groq.svg?raw';
import kimiSvg from '@/assets/providers/kimi.svg?raw';
import openaiSvg from '@/assets/providers/openai.svg?raw';
import opencodeSvg from '@/assets/providers/opencode.svg?raw';
import openrouterSvg from '@/assets/providers/openrouter.svg?raw';
import togetherSvg from '@/assets/providers/together.svg?raw';
import xaiSvg from '@/assets/providers/xai.svg?raw';
import zaiSvg from '@/assets/providers/zai.svg?raw';

interface BrandVisual {
	/** 品牌色 class，定义在 app.css 里。 */
	tone: string;
	/** 品牌 SVG（inline，currentColor 会跟随 --brand-fg）。 */
	svg?: string;
}

function svg(source: string): string {
	return source.replace(/<title>[\s\S]*?<\/title>/g, '');
}

const CUSTOM: BrandVisual = { tone: 'brand-custom' };

const BRANDS: Record<string, BrandVisual> = {
	openai: { tone: 'brand-openai', svg: svg(openaiSvg) },
	anthropic: { tone: 'brand-anthropic', svg: svg(anthropicSvg) },
	google: { tone: 'brand-google', svg: svg(geminiSvg) },
	openrouter: { tone: 'brand-openrouter', svg: svg(openrouterSvg) },
	deepseek: { tone: 'brand-deepseek', svg: svg(deepseekSvg) },
	moonshotai: { tone: 'brand-moonshot', svg: svg(kimiSvg) },
	'moonshotai-cn': { tone: 'brand-moonshot', svg: svg(kimiSvg) },
	'kimi-coding': { tone: 'brand-moonshot', svg: svg(kimiSvg) },
	zai: { tone: 'brand-zai', svg: svg(zaiSvg) },
	'zai-coding-cn': { tone: 'brand-zai', svg: svg(zaiSvg) },
	groq: { tone: 'brand-groq', svg: svg(groqSvg) },
	xai: { tone: 'brand-xai', svg: svg(xaiSvg) },
	together: { tone: 'brand-together', svg: svg(togetherSvg) },
	fireworks: { tone: 'brand-fireworks', svg: svg(fireworksSvg) },
	cerebras: { tone: 'brand-cerebras', svg: svg(cerebrasSvg) },
	opencode: { tone: 'brand-opencode', svg: svg(opencodeSvg) },
	'opencode-go': { tone: 'brand-opencode-go', svg: svg(opencodeSvg) },
};

function brandFor(providerId: string): BrandVisual {
	return BRANDS[providerId] ?? CUSTOM;
}

/** 卡片等高亮元素需要复用品牌色变量。 */
export function providerTone(providerId: string): string {
	return brandFor(providerId).tone;
}

/** 供应商品牌图标：内置用真实 logo，自定义回退到首字母。 */
export function ProviderMark({
	providerId,
	name,
	size = 'md',
}: {
	providerId: string;
	name?: string;
	size?: 'sm' | 'md';
}) {
	const brand = brandFor(providerId);
	const initial = (name?.trim() || providerId || '?').slice(0, 1).toUpperCase();

	return (
		<span
			className={`provider-mark ${brand.tone}${size === 'sm' ? ' sm' : ''}`}
			aria-hidden="true"
		>
			{brand.svg ? (
				<span className="provider-mark-art" dangerouslySetInnerHTML={{ __html: brand.svg }} />
			) : (
				<span className="provider-mark-initial">{initial}</span>
			)}
		</span>
	);
}
