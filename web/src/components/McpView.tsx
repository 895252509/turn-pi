import { useEffect, useMemo, useState } from 'react';
import {
	AlertTriangle,
	CheckCircle2,
	FileJson,
	FlaskConical,
	Globe,
	Loader2,
	Pencil,
	Plug,
	Plus,
	RefreshCw,
	Save,
	Terminal,
	Trash2,
	X,
	Zap,
} from 'lucide-react';
import { MobileModuleStrip } from '@/components/MobileModuleStrip';
import { Button } from '@/components/ui/button';
import { useIsMobile } from '@/hooks/use-mobile';
import {
	EXPOSURES,
	EXPOSURE_LABELS,
	useMcp,
	type McpExposure,
	type McpProbeEntry,
	type McpServerConfig,
	type McpServerView,
	type McpTransportKind,
} from '@/lib/mcp';
import { useStore } from '@/lib/store';

const NAME_RE = /^[A-Za-z0-9_-]+$/;

interface Draft {
	name: string;
	transport: McpTransportKind;
	command: string;
	args: string;
	env: string;
	cwd: string;
	url: string;
	headers: string;
	description: string;
	exposure: McpExposure;
	enabled: boolean;
	timeout: string;
}

function pairsToLines(map?: Record<string, string>): string {
	return Object.entries(map ?? {})
		.map(([key, value]) => `${key}=${value}`)
		.join('\n');
}

function linesToPairs(text: string, separators: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of text.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const indexes = [...separators].map((separator) => trimmed.indexOf(separator)).filter((index) => index > 0);
		if (!indexes.length) continue;
		const index = Math.min(...indexes);
		const key = trimmed.slice(0, index).trim();
		const value = trimmed.slice(index + 1).trim();
		if (key) out[key] = value;
	}
	return out;
}

function argsToLines(args?: string[]): string {
	return (args ?? []).join('\n');
}

function linesToArgs(text: string): string[] {
	return text
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean);
}

function toDraft(server?: McpServerView | null, name = ''): Draft {
	const config = server?.config ?? {};
	const transport: McpTransportKind = server?.transport ?? 'stdio';
	return {
		name: server?.name ?? name,
		transport,
		command: config.command ?? '',
		args: argsToLines(config.args),
		env: pairsToLines(config.env),
		cwd: config.cwd ?? '',
		url: config.url ?? '',
		headers: pairsToLines(config.headers),
		description: config.description ?? '',
		exposure: config.exposure ?? 'codemode',
		enabled: config.enabled !== false,
		timeout: config.timeout ? String(config.timeout) : '',
	};
}

/** 表单 → 配置对象。未知键（auth 等）从 raw 里带回来，避免一次保存把它们抹掉。 */
function fromDraft(draft: Draft, raw: Record<string, unknown> = {}): McpServerConfig {
	const config: Record<string, unknown> = { ...raw };
	for (const key of ['command', 'args', 'env', 'cwd', 'url', 'headers', 'type']) delete config[key];
	for (const key of ['description', 'timeout']) delete config[key];

	config.type = draft.transport;
	if (draft.transport === 'stdio') {
		config.command = draft.command.trim();
		const args = linesToArgs(draft.args);
		if (args.length) config.args = args;
		const env = linesToPairs(draft.env, '=');
		if (Object.keys(env).length) config.env = env;
		if (draft.cwd.trim()) config.cwd = draft.cwd.trim();
	} else {
		config.url = draft.url.trim();
		const headers = linesToPairs(draft.headers, ':=');
		if (Object.keys(headers).length) config.headers = headers;
	}
	if (draft.description.trim()) config.description = draft.description.trim();
	config.exposure = draft.exposure;
	config.enabled = draft.enabled;
	const timeout = Number(draft.timeout);
	if (Number.isFinite(timeout) && timeout > 0) config.timeout = timeout;

	return config as McpServerConfig;
}

function draftProblem(draft: Draft): string | null {
	if (!draft.name.trim()) return '服务器名不能为空';
	if (!NAME_RE.test(draft.name.trim())) return '服务器名只允许字母、数字、_ 和 -（工具名是 mcp__<server>__<tool>）';
	if (draft.transport === 'stdio') {
		if (!draft.command.trim()) return 'stdio 服务器需要 command';
		if (draft.command.includes(' ')) return 'command 是可执行文件，不是 shell 命令串；参数写进 args';
	} else if (!/^https?:\/\//.test(draft.url.trim())) {
		return 'HTTP 服务器需要 http(s) 地址';
	}
	return null;
}

function summarize(server: McpServerView): string {
	const config = server.config;
	if (server.transport === 'http') return config.url ?? '';
	return [config.command, ...(config.args ?? [])].filter(Boolean).join(' ');
}

function ProbeCard({ entry }: { entry: McpProbeEntry }) {
	const { result } = entry;
	return (
		<div className={`mcp-probe${result.ok ? ' ok' : ' err'}`}>
			<div className="mcp-probe-head">
				{result.ok ? <CheckCircle2 aria-hidden="true" /> : <AlertTriangle aria-hidden="true" />}
				<strong>
					{result.ok ? `连接成功 · ${result.tools.length} 个工具 · ${result.ms}ms` : `连接失败 · ${result.ms}ms`}
				</strong>
				{entry.draft ? <span className="badge draft">草稿</span> : null}
				{result.serverInfo ? (
					<span className="mcp-probe-server">
						{result.serverInfo.name} {result.serverInfo.version}
					</span>
				) : null}
			</div>
			{result.error ? <p className="mcp-probe-error">{result.error}</p> : null}
			{result.ok && result.tools.length ? (
				<ul className="mcp-tools">
					{result.tools.map((tool) => (
						<li key={tool.name} title={tool.description ?? tool.title ?? tool.name}>
							<code>{tool.name}</code>
							{tool.description ? <span>{tool.description}</span> : null}
						</li>
					))}
				</ul>
			) : null}
			{result.ok && !result.tools.length ? <p className="hint">连上了，但这台服务器没有声明任何工具。</p> : null}
			{result.stderr ? <pre className="mcp-stderr">{result.stderr}</pre> : null}
		</div>
	);
}

function ServerCard({ server, onEdit, confirmRemove, onAskRemove, onCancelRemove }: {
	server: McpServerView;
	onEdit: () => void;
	confirmRemove: boolean;
	onAskRemove: () => void;
	onCancelRemove: () => void;
}) {
	const probe = useMcp((s) => s.probes[server.name]);
	const pending = useMcp((s) => s.pending);
	const test = useMcp((s) => s.test);
	const remove = useMcp((s) => s.remove);
	const setEnabled = useMcp((s) => s.setEnabled);
	const showToast = useStore((s) => s.showToast);
	const enabled = server.config.enabled !== false;
	const testing = pending === `test:${server.name}`;
	const removing = pending === `remove:${server.name}`;
	const toggling = pending === `enable:${server.name}`;

	async function runTest() {
		try {
			const result = await test(server.name);
			showToast(result.ok ? `${server.name}: 连上了，${result.tools.length} 个工具` : `${server.name}: 连接失败`);
		} catch (error) {
			showToast(`测试失败：${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async function toggle() {
		try {
			await setEnabled(server.name, !enabled);
		} catch (error) {
			showToast(`切换失败：${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async function doRemove() {
		try {
			await remove(server.name);
			showToast(`已删除 ${server.name}`);
		} catch (error) {
			showToast(`删除失败：${error instanceof Error ? error.message : String(error)}`);
		}
	}

	return (
		<article className={`mcp-server${enabled ? '' : ' off'}`} data-server={server.name}>
			<header className="mcp-server-head">
				<span className="mcp-server-icon" aria-hidden="true">
					{server.transport === 'http' ? <Globe /> : <Terminal />}
				</span>
				<div className="mcp-server-title">
					<strong>{server.name}</strong>
					<small>{server.config.description || '（没有写 description）'}</small>
				</div>
				<div className="mcp-badges">
					<span className="badge">{server.transport}</span>
					<span className="badge">{server.config.exposure ?? 'codemode'}</span>
					<span className={`badge${enabled ? ' on' : ''}`}>{enabled ? '启用' : '停用'}</span>
				</div>
			</header>

			<code className="mcp-command">{summarize(server) || '（没有 command / url）'}</code>
			<p className="mcp-prefix">
				工具前缀 <code>mcp__{server.name}__*</code>
				{server.config.timeout ? ` · 超时 ${server.config.timeout}s` : ''}
			</p>

			{probe ? <ProbeCard entry={probe} /> : null}

			<footer className="mcp-server-actions">
				<Button variant="unstyled" type="button" className="ghost mcp-action" disabled={testing} onClick={runTest}>
					{testing ? <Loader2 className="mcp-spin" aria-hidden="true" /> : <Zap aria-hidden="true" />}
					{testing ? '测试中…' : '测试连接'}
				</Button>
				<Button variant="unstyled" type="button" className="ghost mcp-action" onClick={onEdit}>
					<Pencil aria-hidden="true" />
					编辑
				</Button>
				<Button variant="unstyled" type="button" className="ghost mcp-action" disabled={toggling} onClick={toggle}>
					{enabled ? <X aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />}
					{enabled ? '停用' : '启用'}
				</Button>
				{confirmRemove ? (
					<span className="mcp-confirm">
						<span>删除 {server.name}？</span>
						<Button variant="unstyled" type="button" className="ghost mcp-action danger" disabled={removing} onClick={doRemove}>
							{removing ? <Loader2 className="mcp-spin" aria-hidden="true" /> : <Trash2 aria-hidden="true" />}
							确认删除
						</Button>
						<Button variant="unstyled" type="button" className="ghost mcp-action" onClick={onCancelRemove}>
							取消
						</Button>
					</span>
				) : (
					<Button variant="unstyled" type="button" className="ghost mcp-action" onClick={onAskRemove}>
						<Trash2 aria-hidden="true" />
						删除
					</Button>
				)}
			</footer>
		</article>
	);
}

function Editor({ server, raw, onDone }: {
	server?: McpServerView | null;
	raw?: Record<string, unknown>;
	onDone: () => void;
}) {
	const save = useMcp((s) => s.save);
	const test = useMcp((s) => s.test);
	const pending = useMcp((s) => s.pending);
	const showToast = useStore((s) => s.showToast);
	const [draft, setDraft] = useState<Draft>(() => toDraft(server));
	const [error, setError] = useState<string | null>(null);
	const [testing, setTesting] = useState(false);
	// 草稿的探测结果按服务器名存，和已保存条目共用一个槽位；`draft` 标签区分是谁的结果。
	const probe = useMcp((s) => s.probes[draft.name.trim()] ?? (server ? s.probes[server.name] : undefined));
	const isNew = !server;
	const problem = useMemo(() => draftProblem(draft), [draft]);
	const saving = pending === 'save';
	const rawEntry = raw ?? server?.raw ?? {};

	function patch(next: Partial<Draft>) {
		setDraft((current) => ({ ...current, ...next }));
	}

	async function submit() {
		const issue = draftProblem(draft);
		if (issue) {
			setError(issue);
			return;
		}
		setError(null);
		try {
			await save(draft.name.trim(), fromDraft(draft, rawEntry));
			showToast(`${draft.name.trim()} 已保存；在跑的会话点「应用到会话」才重连`);
			onDone();
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		}
	}

	async function testDraft() {
		const issue = draftProblem(draft);
		if (issue) {
			setError(issue);
			return;
		}
		setError(null);
		setTesting(true);
		try {
			const result = await test(draft.name.trim(), fromDraft(draft, rawEntry));
			showToast(result.ok ? `草稿可连：${result.tools.length} 个工具` : `草稿连不上：${result.error ?? '未知错误'}`);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setTesting(false);
		}
	}

	return (
		<aside className="mcp-editor" aria-label={isNew ? '新建 MCP 服务器' : `编辑 ${server?.name}`}>
			<header className="mcp-editor-head">
				<div>
					<h2>{isNew ? '新建服务器' : `编辑 ${server?.name}`}</h2>
					<p>保存写回平台托管的 mcp.json；不认识的键（auth 等）会原样保留。</p>
				</div>
				<Button variant="unstyled" type="button" className="icon-btn" aria-label="关闭编辑器" onClick={onDone}>
					<X aria-hidden="true" />
				</Button>
			</header>

			<div className="mcp-form">
				<label className="mcp-field">
					<span>服务器名</span>
					<input
						className="field-input"
						value={draft.name}
						disabled={!isNew}
						placeholder="filesystem"
						onChange={(event) => patch({ name: event.target.value })}
					/>
					<small>工具名会变成 mcp__{draft.name || '<server>'}__&lt;tool&gt;</small>
				</label>

				<label className="mcp-field">
					<span>传输</span>
					<select
						className="select"
						value={draft.transport}
						onChange={(event) => patch({ transport: event.target.value as McpTransportKind })}
					>
						<option value="stdio">stdio（本地子进程）</option>
						<option value="http">http（streamable HTTP）</option>
					</select>
				</label>

				{draft.transport === 'stdio' ? (
					<>
						<label className="mcp-field">
							<span>command</span>
							<input
								className="field-input mono"
								value={draft.command}
								placeholder="npx"
								onChange={(event) => patch({ command: event.target.value })}
							/>
							<small>可执行文件，不是 shell 命令串</small>
						</label>
						<label className="mcp-field">
							<span>args（一行一个）</span>
							<textarea
								className="field-textarea mono"
								rows={3}
								value={draft.args}
								placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/workspace'}
								onChange={(event) => patch({ args: event.target.value })}
							/>
						</label>
						<label className="mcp-field">
							<span>env（一行一个 KEY=VALUE）</span>
							<textarea
								className="field-textarea mono"
								rows={2}
								value={draft.env}
								placeholder="DOCS_TOKEN=${DOCS_TOKEN}"
								onChange={(event) => patch({ env: event.target.value })}
							/>
							<small>支持 ${'{NAME}'} 与 !命令；容器里没有的变量要先用凭据写进环境</small>
						</label>
						<label className="mcp-field">
							<span>cwd（相对会话工作目录）</span>
							<input
								className="field-input mono"
								value={draft.cwd}
								placeholder="."
								onChange={(event) => patch({ cwd: event.target.value })}
							/>
						</label>
					</>
				) : (
					<>
						<label className="mcp-field">
							<span>url</span>
							<input
								className="field-input mono"
								value={draft.url}
								placeholder="https://example.com/mcp"
								onChange={(event) => patch({ url: event.target.value })}
							/>
							<small>streamable HTTP；不支持 SSE</small>
						</label>
						<label className="mcp-field">
							<span>headers（一行一个，KEY: VALUE）</span>
							<textarea
								className="field-textarea mono"
								rows={2}
								value={draft.headers}
								placeholder="Authorization: Bearer ${DOCS_TOKEN}"
								onChange={(event) => patch({ headers: event.target.value })}
							/>
							<small>OAuth 登录在容器里没有回调地址，需要令牌就得写 header</small>
						</label>
					</>
				)}

				<label className="mcp-field">
					<span>description（给模型看的一句话）</span>
					<input
						className="field-input"
						value={draft.description}
						placeholder="读写工作区文件"
						onChange={(event) => patch({ description: event.target.value })}
					/>
				</label>

				<label className="mcp-field">
					<span>exposure</span>
					<select
						className="select"
						value={draft.exposure}
						onChange={(event) => patch({ exposure: event.target.value as McpExposure })}
					>
						{EXPOSURES.map((exposure) => (
							<option key={exposure} value={exposure}>
								{EXPOSURE_LABELS[exposure]}
							</option>
						))}
					</select>
				</label>

				<div className="mcp-form-row">
					<label className="mcp-field">
						<span>timeout（秒，留空用默认）</span>
						<input
							className="field-input"
							value={draft.timeout}
							inputMode="numeric"
							placeholder="60"
							onChange={(event) => patch({ timeout: event.target.value })}
						/>
					</label>
					<label className="mcp-check">
						<input
							type="checkbox"
							checked={draft.enabled}
							onChange={(event) => patch({ enabled: event.target.checked })}
						/>
						<span>启用（新会话就连接）</span>
					</label>
				</div>

				{draft.exposure === 'direct' ? (
					<p className="mcp-form-hint">direct 目前会被工具白名单过滤，配了也不生效；需要直连工具得先改白名单（见 docs/mcp.md）。</p>
				) : null}
				{problem ? <p className="mcp-form-hint">{problem}</p> : null}
				{error ? <p className="mcp-form-error">{error}</p> : null}
				{probe ? <ProbeCard entry={probe} /> : null}

				<footer className="mcp-form-actions">
					<Button type="button" variant="default" disabled={saving || Boolean(problem)} onClick={submit}>
						{saving ? <Loader2 className="mcp-spin" aria-hidden="true" /> : <Save aria-hidden="true" />}
						{saving ? '保存中…' : '保存'}
					</Button>
					<Button
						variant="unstyled"
						type="button"
						className="ghost"
						disabled={testing || Boolean(problem)}
						onClick={testDraft}
					>
						{testing ? <Loader2 className="mcp-spin" aria-hidden="true" /> : <FlaskConical aria-hidden="true" />}
						测试草稿
					</Button>
					<Button variant="unstyled" type="button" className="ghost" onClick={onDone}>
						取消
					</Button>
				</footer>
			</div>
		</aside>
	);
}

/**
 * MCP 模块视图（rail 的「MCP」入口）。
 *
 * 三件事：看平台托管的 mcp.json、改服务器条目、点一下测试（连一次、列工具）。
 * 会话里的连接归 SDK 的 mcp 扩展管，改完配置要「应用到会话」才会重连（session.reload）。
 */
export function McpView() {
	const isMobile = useIsMobile();
	const snapshot = useMcp((s) => s.snapshot);
	const loading = useMcp((s) => s.loading);
	const error = useMcp((s) => s.error);
	const pending = useMcp((s) => s.pending);
	const load = useMcp((s) => s.load);
	const apply = useMcp((s) => s.apply);
	const showToast = useStore((s) => s.showToast);

	const [editing, setEditing] = useState<{ name: string | null } | null>(null);
	const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

	useEffect(() => {
		if (!snapshot) void load();
	}, [snapshot, load]);

	const servers = snapshot?.servers ?? [];
	const applying = pending === 'apply';
	const editingServer = editing?.name ? servers.find((server) => server.name === editing.name) ?? null : null;

	async function applyToSessions() {
		try {
			const result = await apply();
			const parts = [`已重连 ${result.applied.length} 个会话`];
			if (result.skipped.length) parts.push(`${result.skipped.length} 个在生成中跳过`);
			if (result.failed.length) parts.push(`${result.failed.length} 个失败`);
			showToast(parts.join(' · '));
		} catch (caught) {
			showToast(`应用失败：${caught instanceof Error ? caught.message : String(caught)}`);
		}
	}

	return (
		<main className="module-view mcp-view" id="module-mcp">
			{isMobile ? <MobileModuleStrip /> : null}
			<div className="module-view-scroll">
				<header className="module-view-head mcp-head">
					<div>
						<h1>MCP</h1>
						<p>
							平台托管一份 <code>mcp.json</code>，会话启动时连接。默认 exposure=codemode：工具不占模型的工具声明，
							由 codemode 脚本里的 <code>searchTools()</code> 找到再调用（<code>mcp__&lt;server&gt;__&lt;tool&gt;</code>）。
						</p>
					</div>
					<div className="mcp-head-actions">
						<Button variant="unstyled" type="button" className="ghost" disabled={loading} onClick={() => void load()}>
							<RefreshCw className={loading ? 'mcp-spin' : undefined} aria-hidden="true" />
							重新载入
						</Button>
						<Button variant="unstyled" type="button" className="ghost" disabled={applying} onClick={applyToSessions}>
							{applying ? <Loader2 className="mcp-spin" aria-hidden="true" /> : <Zap aria-hidden="true" />}
							应用到会话
						</Button>
						<Button type="button" variant="default" onClick={() => setEditing({ name: null })}>
							<Plus aria-hidden="true" />
							新建服务器
						</Button>
					</div>
				</header>

				<div className="module-view-body mcp-body">
					{snapshot && !snapshot.enabled ? (
						<div className="mcp-banner warn">
							<AlertTriangle aria-hidden="true" />
							<div>
								<strong>这个进程没接 MCP（PI_MCP=0）</strong>
								<p>配置可以照常编辑，但新会话也不会连接。去掉 PI_MCP=0 重启服务后回来。</p>
							</div>
						</div>
					) : null}

					{snapshot?.errors.length ? (
						<div className="mcp-banner err">
							<AlertTriangle aria-hidden="true" />
							<div>
								<strong>配置文件里有问题（坏条目已跳过，其余照常加载）</strong>
								<ul>
									{snapshot.errors.map((message) => (
										<li key={message}>{message}</li>
									))}
								</ul>
							</div>
						</div>
					) : null}

					{error ? <div className="mcp-banner err"><AlertTriangle aria-hidden="true" /><div><strong>{error}</strong></div></div> : null}

					<p className="mcp-meta">
						<FileJson aria-hidden="true" />
						<code>{snapshot?.file ?? '读取中…'}</code>
						{snapshot ? <span>{snapshot.exists ? `${servers.length} 个服务器` : '文件还不存在，保存第一条就会创建'}</span> : null}
					</p>

					<div className="mcp-grid">
						<section className="mcp-list" aria-label="MCP 服务器">
							{loading && !snapshot ? <p className="hint">正在读取配置…</p> : null}
							{!loading && snapshot && !servers.length ? (
								<div className="mcp-empty">
									<Plug aria-hidden="true" />
									<strong>还没有 MCP 服务器</strong>
									<p>从「新建服务器」加一条，或者把 Claude Desktop / Cursor 的 mcpServers 条目贴过来。</p>
									<Button type="button" variant="default" onClick={() => setEditing({ name: null })}>
										<Plus aria-hidden="true" />
										新建服务器
									</Button>
								</div>
							) : null}

							{servers.map((server) => (
								<ServerCard
									key={server.name}
									server={server}
									onEdit={() => setEditing({ name: server.name })}
									confirmRemove={confirmRemove === server.name}
									onAskRemove={() => setConfirmRemove(server.name)}
									onCancelRemove={() => setConfirmRemove(null)}
								/>
							))}
						</section>

						{editing ? (
							<Editor
								key={editingServer?.name ?? '__new'}
								server={editingServer}
								raw={editingServer?.raw}
								onDone={() => setEditing(null)}
							/>
						) : (
							<aside className="mcp-help" aria-label="MCP 说明">
								<h2>怎么用</h2>
								<ol>
									<li>在这里添加服务器，先点「测试连接」确认连得上、工具列得出来。</li>
									<li>新会话自动连接；已经在跑的会话点「应用到会话」（生成中会被跳过）。</li>
									<li>
										默认 codemode：模型用 <code>searchTools(&quot;mcp__&quot;)</code> 找工具，<code>describeNamespace()</code> 读服务器说明。
									</li>
									<li>测试连接用的是服务进程的工作目录（stdio 的相对 cwd 以它为准）；会话里以各自工作目录为准。</li>
								</ol>
								<h2>边界</h2>
								<ul>
									<li>只读工作区不接 MCP（否则 mcp__* 会绕过只读过滤）。</li>
									<li>不支持 SSE，用 streamable HTTP（一般是 /mcp 端点）。</li>
									<li>容器里没有 python/uv，uvx 起的服务器跑不起来；OAuth 回调也落不进来，用 header 带令牌。</li>
									<li><code>direct</code> 暂不支持：工具白名单只认精确名。</li>
								</ul>
								<p className="hint">细节见仓库里的 docs/mcp.md；本页改动只写配置，不碰源码。</p>
							</aside>
						)}
					</div>
				</div>
			</div>
		</main>
	);
}
