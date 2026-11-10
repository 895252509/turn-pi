const path = require('node:path');

module.exports = {
	plugins: {
		// Vite 的 cwd 是仓库根目录，这里显式指到 web/tailwind.config.cjs
		tailwindcss: { config: path.join(__dirname, 'tailwind.config.cjs') },
		autoprefixer: {},
	},
};
