import { ExternalLink, Trash2 } from 'lucide-react';
import { useStore } from '@/lib/store';
import type { SearchSourceGroup } from '@/lib/types';

function hostOf(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, '');
	} catch {
		return url;
	}
}

function clock(at: number): string {
	const date = new Date(at);
	return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** 右栏「检索」：把 agent 每次 web_search 的命中按时间倒序铺开，链接可点。 */
export function SearchSourcesView() {
	const groups = useStore((s) => s.searchSources);
	const clear = useStore((s) => s.clearSearchSources);
	const total = groups.reduce((sum, group) => sum + group.hits.length, 0);

	return (
		<div className="search-body panel-scroll">
			{groups.length ? (
				<div className="panel-summary search-summary">
					<span>
						{groups.length} 次搜索 · {total} 条来源
					</span>
					<button type="button" className="search-clear" onClick={clear} title="清空来源列表（只清本地，不影响会话）">
						<Trash2 aria-hidden="true" />
						清空
					</button>
				</div>
			) : null}

			{!groups.length ? (
				<p className="empty-note">
					还没有联网搜索。
					<br />
					模型需要最新事实时会调用 <code>web_search</code>；命中的标题 / 链接 / 摘要会出现在这里，方便你核对它引用的来源。
					<br />
					<br />
					没配置搜索 provider？设 <code>PI_SEARXNG_URL</code>（自建，无 key）或 <code>TAVILY_API_KEY</code> 后重启服务。
				</p>
			) : null}

			{groups.map((group) => (
				<SearchGroup key={`${group.at}-${group.query}`} group={group} />
			))}
		</div>
	);
}

function SearchGroup({ group }: { group: SearchSourceGroup }) {
	return (
		<section className="search-group">
			<header className="search-group-head">
				<span className="search-query">{group.query}</span>
				<span className="search-meta">
					{group.provider || 'search'} · {clock(group.at)} · {group.hits.length} 条
					{group.cached ? ' · 缓存' : ''}
				</span>
			</header>
			{group.degraded ? <p className="search-note">{group.degraded}</p> : null}
			{group.hits.length ? (
				<ul className="search-hits">
					{group.hits.map((hit, index) => (
						<li key={`${hit.url}-${index}`} className="search-hit">
							<a
								className="search-hit-title"
								href={hit.url}
								target="_blank"
								rel="noreferrer noopener"
								title={hit.url}
							>
								<span className="search-hit-index">{index + 1}</span>
								<span className="search-hit-name">{hit.title || hit.url}</span>
								<ExternalLink aria-hidden="true" />
							</a>
							<div className="search-hit-meta">
								<span>{hostOf(hit.url)}</span>
								{hit.publishedAt ? <span>{hit.publishedAt}</span> : null}
							</div>
							{hit.snippet ? <p className="search-hit-snippet">{hit.snippet}</p> : null}
						</li>
					))}
				</ul>
			) : (
				<p className="search-note">这次没有结果：换更短的关键词或去掉站点限制再试。</p>
			)}
		</section>
	);
}
