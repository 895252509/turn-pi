/**
 * 极简 markdown → HTML（无依赖）。
 * 支持：标题、粗体/斜体/删除线、行内代码、围栏代码块、有序/无序列表、
 * 引用、表格、分隔线、http(s) 链接。
 * 流式渲染是安全的：未闭合的围栏会当作代码块渲染，直到收到收尾。
 */

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escape = (s: string) => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]);
const unescape = (s: string) =>
	String(s)
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'");

export interface MarkdownOptions {
	/** 把图片相对路径解析成可访问 URL；返回 null 表示不渲染为图片 */
	resolveImage?: (src: string) => string | null;
	/** 把相对链接解析成工作区相对路径；返回 null 表示普通链接 */
	resolveFile?: (href: string) => string | null;
	/** 把链接解析成全局文件资源地址（pi-resource://）；优先于 resolveFile */
	resolveFileRef?: (href: string) => string | null;
}

function inline(text: string, options?: MarkdownOptions): string {
	let out = escape(text);
	out = out.replace(/`([^`\n]+)`/g, '<code>$1</code>');
	out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
	out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
	out = out.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

	out = out.replace(/!\[([^\]\n]*)\]\(([^)\s]+)\)/g, (whole, alt: string, src: string) => {
		const clean = unescape(src);
		const resolved = options?.resolveImage ? options.resolveImage(clean) : clean;
		if (resolved == null) return whole;
		return `<img src="${escape(resolved)}" alt="${alt}" loading="lazy">`;
	});

	out = out.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (whole, label: string, href: string) => {
		const clean = unescape(href);
		if (/^https?:\/\//i.test(clean)) {
			return `<a href="${escape(clean)}" target="_blank" rel="noreferrer">${label}</a>`;
		}
		if (/^#/.test(clean)) return `<a href="${escape(clean)}">${label}</a>`;
		if (/^pi-resource:\/\/file\//i.test(clean)) {
			return `<a href="#" data-file-ref="${escape(clean)}" title="${escape(clean)}">${label}</a>`;
		}
		const ref = options?.resolveFileRef?.(clean);
		if (ref) {
			return `<a href="#" data-file-ref="${escape(ref)}" title="${escape(ref)}">${label}</a>`;
		}
		const file = options?.resolveFile?.(clean);
		if (file) {
			return `<a href="#" data-file-href="${escape(file)}" title="${escape(file)}">${label}</a>`;
		}
		return whole;
	});
	return out;
}

const isFence = (line: string) => /^\s*```/.test(line);
const isBlank = (line: string) => /^\s*$/.test(line);
const isQuote = (line: string) => /^\s*>\s?/.test(line);
const isUl = (line: string) => /^\s*[-*+]\s+/.test(line);
const isOl = (line: string) => /^\s*\d+[.)]\s+/.test(line);
const isHr = (line: string) => /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line);
const isTableRow = (line: string) => /^\s*\|.*\|\s*$/.test(line);
const isTableSeparator = (line: string) => /^\s*\|?[\s:|-]+\|[\s:|-]*\s*$/.test(line) && line.includes('-');

function splitCells(line: string): string[] {
	return line
		.trim()
		.replace(/^\|/, '')
		.replace(/\|$/, '')
		.split('|')
		.map((cell) => cell.trim());
}

export function renderMarkdown(source: string, options?: MarkdownOptions): string {
	const lines = String(source ?? '').replace(/\r\n/g, '\n').split('\n');
	const out: string[] = [];
	let paragraph: string[] = [];
	let i = 0;

	const flushParagraph = () => {
		if (!paragraph.length) return;
		out.push(`<p>${inline(paragraph.join('\n'), options).replace(/\n/g, '<br>')}</p>`);
		paragraph = [];
	};

	while (i < lines.length) {
		const line = lines[i];

		if (isFence(line)) {
			flushParagraph();
			const lang = /^\s*```(\S*)/.exec(line)?.[1] ?? '';
			const buffer: string[] = [];
			i += 1;
			while (i < lines.length && !isFence(lines[i])) {
				buffer.push(lines[i]);
				i += 1;
			}
			if (i < lines.length) i += 1;
			out.push(`<div class="code-block"${lang ? ` data-lang="${escape(lang)}"` : ''}><pre><code>${escape(buffer.join('\n'))}</code></pre></div>`);
			continue;
		}

		if (isBlank(line)) {
			flushParagraph();
			i += 1;
			continue;
		}

		const heading = /^(#{1,6})\s+(.*)$/.exec(line);
		if (heading) {
			flushParagraph();
			const level = heading[1].length;
			out.push(`<h${level}>${inline(heading[2].trim(), options)}</h${level}>`);
			i += 1;
			continue;
		}

		if (isHr(line)) {
			flushParagraph();
			out.push('<hr>');
			i += 1;
			continue;
		}

		if (isTableRow(line) && isTableSeparator(lines[i + 1] ?? '')) {
			flushParagraph();
			const head = splitCells(line);
			i += 2;
			const rows: string[][] = [];
			while (i < lines.length && isTableRow(lines[i])) {
				rows.push(splitCells(lines[i]));
				i += 1;
			}
			const cell = (tag: string, text: string) => `<${tag}>${inline(text, options)}</${tag}>`;
			out.push(
				`<table><thead><tr>${head.map((h) => cell('th', h)).join('')}</tr></thead>` +
					`<tbody>${rows.map((row) => `<tr>${row.map((c) => cell('td', c)).join('')}</tr>`).join('')}</tbody></table>`,
			);
			continue;
		}

		if (isQuote(line)) {
			flushParagraph();
			const buffer: string[] = [];
			while (i < lines.length && isQuote(lines[i])) {
				buffer.push(lines[i].replace(/^\s*>\s?/, ''));
				i += 1;
			}
			out.push(`<blockquote>${inline(buffer.join('\n'), options).replace(/\n/g, '<br>')}</blockquote>`);
			continue;
		}

		if (isUl(line) || isOl(line)) {
			flushParagraph();
			const ordered = isOl(line);
			const match = ordered ? isOl : isUl;
			const items: string[] = [];
			while (i < lines.length && match(lines[i])) {
				items.push(`<li>${inline(lines[i].replace(ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/, ''), options)}</li>`);
				i += 1;
			}
			out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
			continue;
		}

		paragraph.push(line);
		i += 1;
	}

	flushParagraph();
	return out.join('\n');
}
