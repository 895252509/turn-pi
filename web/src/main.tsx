import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { migrateLegacyStorageKeys } from './lib/legacyStorage';
import { dismissSplash } from './lib/splash';

// 改名前的老键（pi-webchat-*）迁到 turnpi-*，必须在任何读取本地设置的模块跑之前。
migrateLegacyStorageKeys();

// Tailwind/shadcn 在前；app.css 是旧站样式，保持原样（不加 layer，优先级最高）。
import './styles/tailwind.css';
import './styles/app.css';
import './styles/chat.css';
import './styles/splitter.css';
import './styles/skills.css';
import './styles/agents.css';
import './styles/mcp.css';
import './styles/theme.css';

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<App />
	</StrictMode>,
);

// 等这一帧真正提交（首屏 DOM 已经在屏幕上）再收启动画面，避免出现白屏的中间态。
// 双重 rAF：第一次是提交后、第二次是下一次绘制前。
requestAnimationFrame(() => {
	requestAnimationFrame(() => dismissSplash());
});
