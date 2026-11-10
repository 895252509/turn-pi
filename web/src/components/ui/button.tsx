import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * shadcn/ui Button。
 *
 * base 只放「关掉 preflight 后 <button> 自带的浏览器样式」兜底：UA 默认给按钮
 * 2px outset 边框、系统字体和 default 光标，不清掉的话 `variant="default"`
 * 会在主色底上留一圈浅色斜面。间距/高度一律不放 base，全在 variant 里，
 * 所以 `variant="unstyled"` 不会偷偷带进 padding/height；app.css 里的
 * `button.ghost`、`.card .actions button` 等旧规则继续说了算（app.css 没有 layer，
 * 天然盖过 @layer utilities）。
 *
 * 刻度：这里不再用 shadcn 默认的 `h-9/px-4/text-sm`（14px 字 + 16px 行高），
 * 那套比旧站控件大一圈，主按钮和旁边的 ghost 按钮并排时一眼就能看出来。
 * 旧站只有一套控件刻度（app.css 的 `button.ghost`）：12px 字、行高 normal、
 * 上下 7px + 1px 边框、左右 10px + 1px 边框。组件库按钮没有边框，所以内边距补成
 * 8px / 11px，外框才和 ghost 严丝合缝；`≤980px` 时 app.css 会把 ghost 加大到
 * 9px + 1px / 11px + 1px，这里同步跟到 10px / 12px。
 * （行高必须写死 normal：`tw-text-xs` 自带 16px 行高，比 ghost 高 2px，
 * 那 2px 正是 PC 上主按钮"大一圈"的来源之一。）
 */
const controlLayout =
	'tw-inline-flex tw-items-center tw-justify-center tw-gap-1.5 tw-whitespace-nowrap tw-rounded-md tw-font-medium tw-transition-colors focus-visible:tw-outline-none focus-visible:tw-ring-2 focus-visible:tw-ring-ring disabled:tw-pointer-events-none disabled:tw-opacity-50';

/** 盒子刻度，对齐 app.css 的 `button.ghost`（含 ≤980px 的加大版本）。 */
const controlBox =
	'tw-px-[11px] tw-py-[8px] tw-text-[12px] tw-leading-[normal] max-[980px]:tw-px-[12px] max-[980px]:tw-py-[10px]';

const buttonVariants = cva('tw-border-0 tw-font-[inherit] tw-cursor-pointer', {
	variants: {
		variant: {
			// 旧站按钮：盒子与颜色全部由 app.css 的 class（ghost / icon-btn / …）决定
			unstyled: '',
			default: `${controlLayout} ${controlBox} tw-bg-primary tw-text-primary-foreground tw-shadow hover:tw-bg-primary/90`,
			destructive: `${controlLayout} ${controlBox} tw-bg-destructive tw-text-destructive-foreground tw-shadow-sm hover:tw-bg-destructive/90`,
			outline: `${controlLayout} ${controlBox} tw-border tw-border-input tw-bg-background tw-shadow-sm hover:tw-bg-accent hover:tw-text-accent-foreground`,
			secondary: `${controlLayout} ${controlBox} tw-bg-secondary tw-text-secondary-foreground tw-shadow-sm hover:tw-bg-secondary/80`,
			ghost: `${controlLayout} ${controlBox} hover:tw-bg-accent hover:tw-text-accent-foreground`,
			link: 'tw-inline-flex tw-items-center tw-gap-1.5 tw-text-[12px] tw-font-medium tw-text-primary tw-underline-offset-4 hover:tw-underline',
		},
		// 不设 size：旧站只有一套控件刻度，多一层 size 只会让「到底谁决定高度」变成谜。
		// 以后真要加，照 controlBox 写出真实数值，别再留空字符串占位。
	},
	defaultVariants: {
		variant: 'default',
	},
});

export interface ButtonProps
	extends React.ButtonHTMLAttributes<HTMLButtonElement>,
		VariantProps<typeof buttonVariants> {
	asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
	({ className, variant, asChild = false, ...props }, ref) => {
		const Comp = asChild ? Slot : 'button';
		return <Comp className={cn(buttonVariants({ variant, className }))} ref={ref} {...props} />;
	},
);
Button.displayName = 'Button';

export { Button, buttonVariants };
