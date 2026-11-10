import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
	AlertTriangle,
	Code,
	Download,
	ExternalLink,
	Eye,
	Maximize2,
	Minimize2,
	RefreshCw,
} from 'lucide-react';
import { ImagePreview } from '@/components/previews/ImagePreview';
import { MarkdownPreview } from '@/components/previews/MarkdownPreview';
import { PdfPreview } from '@/components/previews/PdfPreview';
import { TextPreview } from '@/components/previews/TextPreview';
import { UnsupportedPreview } from '@/components/previews/UnsupportedPreview';
import { kindFromName, isTextLike } from '@/lib/fileKinds';
import { FilesError, describeFilesError, rawFileUrl, readFileText, statFile } from '@/lib/files';
import { basename, type PanelTab } from '@/lib/panel';
import { useStore } from '@/lib/store';
import type { FileStat, FileText } from '@/lib/types';

type FileTab = Extract<PanelTab, { kind: 'file' }>;
type Phase = 'loading' | 'ready' | 'error';

const POLL_MS = 3000;

export function PreviewView({
	tab,
	active,
	visible,
}: {
	tab: FileTab;
	active: boolean;
	visible: boolean;
}) {
	const refreshTick = useStore((s) => s.panelRefreshTick);
	const [stat, setStat] = useState<FileStat | null>(null);
	const [text, setText] = useState<FileText | null>(null);
	const [phase, setPhase] = useState<Phase>('loading');
	const [error, setError] = useState('');
	const [notFound, setNotFound] = useState(false);
	const [notText, setNotText] = useState(false);
	const [refreshing, setRefreshing] = useState(false);
	const [refreshError, setRefreshError] = useState<string | null>(null);
	const [updated, setUpdated] = useState(false);
	const [source, setSource] = useState(false);
	const [fit, setFit] = useState(true);
	const [wrap, setWrap] = useState(() => /\.(txt|log)$/i.test(tab.path));
	const [reload, setReload] = useState(0);

	const seq = useRef(0);
	const statRef = useRef<FileStat | null>(null);
	const lastTick = useRef(refreshTick);
	const updatedTimer = useRef<number | null>(null);

	const loadAll = useCallback(async () => {
		const current = ++seq.current;
		const previous = statRef.current;
		if (!previous) setPhase('loading');
		setRefreshing(Boolean(previous));
		setRefreshError(null);

		try {
			const nextStat = await statFile(tab.root, tab.path);
			if (seq.current !== current) return;
			if (previous && previous.version !== nextStat.version) {
				setUpdated(true);
				if (updatedTimer.current) window.clearTimeout(updatedTimer.current);
				updatedTimer.current = window.setTimeout(() => setUpdated(false), 2400);
			}
			statRef.current = nextStat;
			setStat(nextStat);
			setNotFound(false);

			let nextText: FileText | null = null;
			let unsupported = false;
			if (isTextLike(nextStat.kind)) {
				try {
					nextText = await readFileText(tab.root, tab.path);
				} catch (readError) {
					if (readError instanceof FilesError && readError.code === 'files/not-text') unsupported = true;
					else throw readError;
				}
			}
			if (seq.current !== current) return;
			setText(nextText);
			setNotText(unsupported);
			setPhase('ready');
		} catch (loadError) {
			if (seq.current !== current) return;
			const message = describeFilesError(loadError);
			const missing = loadError instanceof FilesError && loadError.code === 'files/not-found';
			if (missing || !statRef.current) {
				statRef.current = null;
				setStat(null);
				setText(null);
				setNotFound(missing);
				setPhase('error');
				setError(message);
			} else {
				// 轮询/刷新失败时保留旧内容，只提示
				setRefreshError(message);
				setPhase('ready');
			}
		} finally {
			if (seq.current === current) setRefreshing(false);
		}
	}, [tab.root, tab.path]);

	useEffect(() => {
		setSource(false);
		setNotText(false);
		setRefreshError(null);
	}, [tab.path]);

	useEffect(() => {
		loadAll();
	}, [loadAll, reload]);

	useEffect(() => {
		return () => {
			if (updatedTimer.current) window.clearTimeout(updatedTimer.current);
		};
	}, []);

	useEffect(() => {
		if (refreshTick === lastTick.current) return;
		lastTick.current = refreshTick;
		if (active && visible) loadAll();
	}, [refreshTick, active, visible, loadAll]);

	useEffect(() => {
		if (!active || !visible) return;
		const timer = window.setInterval(() => {
			if (document.visibilityState !== 'visible') return;
			statFile(tab.root, tab.path)
				.then((next) => {
					if (next.version !== statRef.current?.version) loadAll();
				})
				.catch(() => {
					if (statRef.current) loadAll();
				});
		}, POLL_MS);
		const onFocus = () => loadAll();
		window.addEventListener('focus', onFocus);
		return () => {
			window.clearInterval(timer);
			window.removeEventListener('focus', onFocus);
		};
	}, [active, visible, tab.root, tab.path, loadAll]);

	const kind = stat?.kind ?? kindFromName(tab.path);
	const canSource = kind === 'markdown' || kind === 'svg';
	const canWrap = isTextLike(kind) && !notText;
	const canFit = (kind === 'image' || kind === 'svg') && !(kind === 'svg' && source);
	const raw = rawFileUrl(tab.root, tab.path, { version: stat?.version });
	const download = rawFileUrl(tab.root, tab.path, { download: true, version: stat?.version });

	let content: ReactNode = null;
	if (phase === 'loading') {
		content = (
			<div className="preview-loading">
				<span className="spinner" aria-hidden="true" />
				加载中…
			</div>
		);
	} else if (phase === 'error') {
		content = (
			<div className="preview-error panel-scroll">
				<AlertTriangle aria-hidden="true" />
				<strong>{notFound ? '文件不存在或已被删除' : '无法打开文件'}</strong>
				<span>{error}</span>
				<div className="preview-error-actions">
					<button type="button" className="preview-action" onClick={() => setReload((value) => value + 1)}>
						重试
					</button>
					<a className="preview-action" href={download}>
						下载
					</a>
				</div>
			</div>
		);
	} else if (notText || kind === 'binary') {
		content = (
			<UnsupportedPreview
				root={tab.root}
				path={tab.path}
				size={stat?.size}
				reason={notText ? '不是 UTF-8 文本' : undefined}
			/>
		);
	} else if (kind === 'pdf') {
		content = <PdfPreview root={tab.root} path={tab.path} version={stat?.version} />;
	} else if (kind === 'image') {
		content = (
			<ImagePreview
				root={tab.root}
				path={tab.path}
				version={stat?.version}
				fit={fit}
				onToggleFit={() => setFit((value) => !value)}
			/>
		);
	} else if (kind === 'svg') {
		content = source ? (
			<TextPreview text={text?.text ?? ''} path={tab.path} line={tab.line} nav={tab.nav} wrap={wrap} />
		) : (
			<ImagePreview
				root={tab.root}
				path={tab.path}
				version={stat?.version}
				fit={fit}
				onToggleFit={() => setFit((value) => !value)}
			/>
		);
	} else if (kind === 'markdown') {
		content = source ? (
			<TextPreview text={text?.text ?? ''} path={tab.path} line={tab.line} nav={tab.nav} wrap={wrap} />
		) : (
			<MarkdownPreview text={text?.text ?? ''} root={tab.root} path={tab.path} />
		);
	} else if (kind === 'text' || kind === 'unknown') {
		content = text ? (
			<TextPreview text={text.text} path={tab.path} line={tab.line} nav={tab.nav} wrap={wrap} />
		) : (
			<UnsupportedPreview root={tab.root} path={tab.path} size={stat?.size} />
		);
	} else {
		content = <UnsupportedPreview root={tab.root} path={tab.path} size={stat?.size} />;
	}

	const truncated = text?.truncated || text?.eof === false;

	return (
		<div className="preview">
			<div className="preview-toolbar">
				<span className="preview-name" title={`${tab.root}:${tab.path}`}>
					{basename(tab.path)}
				</span>
				<span className="preview-path" title={tab.path}>
					{tab.path}
				</span>
				<div className="preview-actions">
					{canSource ? (
						<button
							type="button"
							className={`preview-btn${source ? ' active' : ''}`}
							title={source ? '预览' : '源码'}
							aria-label={source ? '预览' : '源码'}
							onClick={() => setSource((value) => !value)}
						>
							{source ? <Eye aria-hidden="true" /> : <Code aria-hidden="true" />}
							<span>{source ? '预览' : '源码'}</span>
						</button>
					) : null}
					{canWrap ? (
						<button
							type="button"
							className={`preview-btn${wrap ? ' active' : ''}`}
							title={wrap ? '不换行' : '自动换行'}
							aria-label={wrap ? '不换行' : '自动换行'}
							onClick={() => setWrap((value) => !value)}
						>
							<span>换行</span>
						</button>
					) : null}
					{canFit ? (
						<button
							type="button"
							className={`preview-btn${fit ? ' active' : ''}`}
							title={fit ? '原始大小' : '适应宽度'}
							aria-label={fit ? '原始大小' : '适应宽度'}
							onClick={() => setFit((value) => !value)}
						>
							{fit ? <Maximize2 aria-hidden="true" /> : <Minimize2 aria-hidden="true" />}
						</button>
					) : null}
					<button
						type="button"
						className={`preview-btn icon${refreshing ? ' spinning' : ''}`}
						title="刷新"
						aria-label="刷新"
						onClick={() => setReload((value) => value + 1)}
					>
						<RefreshCw aria-hidden="true" />
					</button>
					<a className="preview-btn icon" href={raw} target="_blank" rel="noreferrer" title="新窗口打开" aria-label="新窗口打开">
						<ExternalLink aria-hidden="true" />
					</a>
					<a className="preview-btn icon" href={download} title="下载" aria-label="下载">
						<Download aria-hidden="true" />
					</a>
				</div>
			</div>

			{refreshError ? <div className="preview-banner warn">{refreshError}</div> : null}
			{updated ? <div className="preview-banner">文件已更新</div> : null}
			{truncated ? <div className="preview-banner">内容过大，已截断显示</div> : null}
			<div className="preview-body">{content}</div>
		</div>
	);
}
