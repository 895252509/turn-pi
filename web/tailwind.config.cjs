const path = require('node:path');

/** shadcn/ui + Tailwind：preflight 关闭，现有 app.css 仍是唯一视觉来源。 */
module.exports = {
	darkMode: ['class'],
	// 旧站 class（.ring / .grow / .table …）会撞上 Tailwind 同名 utility，统一加前缀隔离
	prefix: 'tw-',
	content: [path.join(__dirname, 'index.html'), path.join(__dirname, 'src/**/*.{ts,tsx}')],
	corePlugins: {
		// 旧样式是手写 CSS，不能被 Tailwind 的全局重置改掉
		preflight: false,
	},
	theme: {
		extend: {
			borderRadius: {
				lg: 'var(--radius)',
				md: 'calc(var(--radius) - 2px)',
				sm: 'calc(var(--radius) - 4px)',
			},
			colors: {
				border: 'hsl(var(--border))',
				input: 'hsl(var(--input))',
				ring: 'hsl(var(--ring))',
				background: 'hsl(var(--background))',
				foreground: 'hsl(var(--foreground))',
				primary: { DEFAULT: 'hsl(var(--primary))', foreground: 'hsl(var(--primary-foreground))' },
				secondary: { DEFAULT: 'hsl(var(--secondary))', foreground: 'hsl(var(--secondary-foreground))' },
				destructive: { DEFAULT: 'hsl(var(--destructive))', foreground: 'hsl(var(--destructive-foreground))' },
				muted: { DEFAULT: 'hsl(var(--muted))', foreground: 'hsl(var(--muted-foreground))' },
				accent: { DEFAULT: 'hsl(var(--accent))', foreground: 'hsl(var(--accent-foreground))' },
				popover: { DEFAULT: 'hsl(var(--popover))', foreground: 'hsl(var(--popover-foreground))' },
				card: { DEFAULT: 'hsl(var(--card))', foreground: 'hsl(var(--card-foreground))' },
			},
		},
	},
	plugins: [require('tailwindcss-animate')],
};
