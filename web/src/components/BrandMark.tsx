import { useId } from 'react';

/**
 * Turn Pi 的标记：红色 T，上面盖一层半透明 Pi。
 *
 * 直接内联 SVG，不走 <img>：
 *   - 幽灵层用 currentColor，深色主题下自动变成"白幽灵"，浅色主题下是"黑幽灵"，
 *     不需要为两套主题各准备一个文件；
 *   - 尺寸由 CSS 决定，不会因为加载慢闪一下。
 *
 * 几何见 docs/brand/README.md：120 × 120 画布，模块 24，左红 T + 黑 Pi 28%。
 * 这里的坐标和 docs/brand/turnpi-icon.svg 逐格一致，改一处就得改另一处。
 *
 * viewBox 收成 120 × 96，只裁掉上下各 12px 的空白，不动任何矩形：内联时盒子按
 * 5:4 给（CSS 里 .brand-mark 的 width/height），标记才能填满。用正方形盒子的话
 * 浏览器会按宽度缩放、上下各留 10%，5 列模块每格只有盒宽的 1/5，比官方 Pi 的
 * 4 列细 20%，看上去就小一圈。favicon 的 icon.svg 仍保持 120 × 120 正方形画布。
 *
 * 红 T 带一层小尺寸专用的光：同一个 feDropShadow 链，但用户单位按 22–24px 的
 * 盒子调过（8 / 14，65% / 35%）；大尺寸仍用 splash / turnpi-about.svg 的 2.5 / 7 / 14。
 * 滤镜 id 用 useId 区分，避免同一页多个 BrandMark 撞 id。
 */
export function BrandMark({ className = 'brand-mark' }: { className?: string }) {
	const glowId = `brand-mark-glow-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
	return (
		<svg
			className={className}
			viewBox="0 12 120 96"
			aria-hidden="true"
			focusable="false"
			shapeRendering="crispEdges"
		>
			<defs>
				<filter
					id={glowId}
					x="-50%"
					y="-50%"
					width="200%"
					height="200%"
					filterUnits="objectBoundingBox"
					colorInterpolationFilters="sRGB"
				>
					<feDropShadow
						dx="0"
						dy="0"
						stdDeviation="8"
						floodColor="#E8432B"
						floodOpacity="0.65"
						result="core"
					/>
					<feDropShadow
						in="core"
						dx="0"
						dy="0"
						stdDeviation="14"
						floodColor="#E8432B"
						floodOpacity="0.35"
					/>
				</filter>
			</defs>
			{/* 第 1 层：红 T + 小尺寸的光 */}
			<g fill="#E8432B" filter={`url(#${glowId})`}>
				<rect x="0" y="12" width="72" height="24" />
				<rect x="24" y="36" width="24" height="72" />
			</g>
			{/* 第 2 层：Pi，currentColor + 低透明度 */}
			<g className="brand-mark-ghost">
				<rect x="24" y="12" width="72" height="24" />
				<rect x="72" y="36" width="24" height="24" />
				<rect x="24" y="36" width="24" height="72" />
				<rect x="48" y="60" width="24" height="24" />
				<rect x="96" y="60" width="24" height="48" />
			</g>
		</svg>
	);
}
