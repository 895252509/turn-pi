import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
	root: fileURLToPath(new URL('.', import.meta.url)),
	plugins: [react()],
	resolve: {
		alias: {
			'@': fileURLToPath(new URL('./src', import.meta.url)),
		},
	},
	server: {
		port: 44101,
		// 本地开发：前端跑 Vite，/api 与 SSE 反代到 node server
		proxy: {
			'/api': { target: 'http://127.0.0.1:44100', changeOrigin: true },
		},
	},
	build: {
		outDir: 'dist',
		emptyOutDir: true,
	},
});
