import { useEffect, useRef, useState } from 'react';
import { Compartment, EditorState, StateEffect, StateField } from '@codemirror/state';
import {
	Decoration,
	EditorView,
	drawSelection,
	highlightActiveLine,
	highlightActiveLineGutter,
	highlightSpecialChars,
	keymap,
	lineNumbers,
	type DecorationSet,
} from '@codemirror/view';
import {
	HighlightStyle,
	LanguageDescription,
	bracketMatching,
	codeFolding,
	foldGutter,
	foldKeymap,
	syntaxHighlighting,
} from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { tags } from '@lezer/highlight';
import { useStore } from '@/lib/store';
import { resolveTheme } from '@/lib/theme';

const setHitLine = StateEffect.define<number | null>();

const hitLineField = StateField.define<DecorationSet>({
	create: () => Decoration.none,
	update(value, transaction) {
		let next = value.map(transaction.changes);
		for (const effect of transaction.effects) {
			if (!effect.is(setHitLine)) continue;
			if (effect.value == null) {
				next = Decoration.none;
				continue;
			}
			const lineNumber = Math.max(1, Math.min(transaction.state.doc.lines, effect.value));
			const line = transaction.state.doc.line(lineNumber);
			next = Decoration.set([Decoration.line({ class: 'cm-line-hit' }).range(line.from)]);
		}
		return next;
	},
	provide: (field) => EditorView.decorations.from(field),
});

const codeColors = {
	dark: {
		keyword: '#c099ff',
		name: '#c8d3f5',
		property: '#7dcfff',
		fn: '#82aaff',
		constant: '#ff966c',
		type: '#ffc777',
		operator: '#86e1fc',
		comment: '#636a7a',
		string: '#c3e88d',
		heading: '#82aaff',
		link: '#65bcff',
		invalid: '#ff5370',
	},
	light: {
		keyword: '#7c3aed',
		name: '#1f2937',
		property: '#0b7285',
		fn: '#1d4ed8',
		constant: '#b45309',
		type: '#8a5a00',
		operator: '#0e7490',
		comment: '#7b8495',
		string: '#2f7d32',
		heading: '#1d4ed8',
		link: '#0369a1',
		invalid: '#c43a4e',
	},
};

function codeHighlight(dark: boolean) {
	const c = dark ? codeColors.dark : codeColors.light;
	return HighlightStyle.define([
		{ tag: [tags.keyword, tags.operatorKeyword, tags.modifier], color: c.keyword },
		{ tag: [tags.name, tags.deleted, tags.character, tags.macroName], color: c.name },
		{ tag: [tags.propertyName, tags.attributeName], color: c.property },
		{ tag: [tags.function(tags.variableName), tags.labelName], color: c.fn },
		{ tag: [tags.color, tags.constant(tags.name), tags.standard(tags.name)], color: c.constant },
		{ tag: [tags.definition(tags.name), tags.separator], color: c.name },
		{ tag: [tags.typeName, tags.className, tags.number, tags.changed, tags.annotation, tags.self, tags.namespace], color: c.type },
		{ tag: [tags.operator, tags.url, tags.escape, tags.regexp, tags.link, tags.special(tags.string)], color: c.operator },
		{ tag: [tags.meta, tags.comment], color: c.comment, fontStyle: 'italic' },
		{ tag: [tags.string, tags.inserted, tags.processingInstruction], color: c.string },
		{ tag: [tags.atom, tags.bool, tags.special(tags.variableName)], color: c.constant },
		{ tag: tags.heading, color: c.heading, fontWeight: '600' },
		{ tag: tags.link, color: c.link, textDecoration: 'underline' },
		{ tag: tags.strong, fontWeight: '600' },
		{ tag: tags.emphasis, fontStyle: 'italic' },
		{ tag: tags.strikethrough, textDecoration: 'line-through' },
		{ tag: tags.invalid, color: c.invalid },
	]);
}

function appTheme(dark: boolean) {
	const bg = dark ? '#0f1116' : '#f6f8fb';
	const fg = dark ? '#c8d3f5' : '#1f2937';
	const gutter = dark ? '#4f5766' : '#8a94a6';
	const gutterStrong = dark ? '#8792a8' : '#5e6a7d';
	return EditorView.theme(
		{
			'&': { height: '100%', backgroundColor: bg, color: fg },
			'&.cm-focused': { outline: 'none' },
			'.cm-scroller': {
				overflow: 'auto',
				fontFamily: 'var(--mono)',
				fontSize: '12.5px',
				lineHeight: '1.62',
			},
			'.cm-content': { padding: '10px 0 28px', caretColor: 'transparent' },
			'.cm-line': { padding: '0 14px 0 4px' },
			'.cm-gutters': {
				backgroundColor: bg,
				color: gutter,
				border: 'none',
				borderRight: dark ? '1px solid rgba(255, 255, 255, 0.045)' : '1px solid rgba(20, 28, 45, 0.07)',
			},
			'.cm-lineNumbers .cm-gutterElement': {
				padding: '0 10px 0 12px',
				minWidth: '42px',
				color: gutter,
			},
			'.cm-foldGutter .cm-gutterElement': {
				padding: '0 4px 0 2px',
				color: gutter,
				fontSize: '10px',
			},
			'.cm-foldGutter .cm-gutterElement:hover': { color: dark ? '#82aaff' : '#2f63cc' },
			'.cm-activeLine': { backgroundColor: dark ? 'rgba(255, 255, 255, 0.024)' : 'rgba(20, 28, 45, 0.035)' },
			'.cm-activeLineGutter': { backgroundColor: 'transparent', color: gutterStrong },
			'&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
				backgroundColor: dark ? 'rgba(122, 162, 247, 0.22)' : 'rgba(47, 99, 204, 0.18)',
			},
			'.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
				backgroundColor: dark ? 'rgba(122, 162, 247, 0.16)' : 'rgba(47, 99, 204, 0.14)',
				outline: dark ? '1px solid rgba(122, 162, 247, 0.35)' : '1px solid rgba(47, 99, 204, 0.4)',
			},
			'.cm-nonmatchingBracket': { color: dark ? '#ff5370' : '#c43a4e' },
			'.cm-line-hit': { backgroundColor: dark ? 'rgba(224, 175, 104, 0.15)' : 'rgba(154, 96, 0, 0.13)' },
			'.cm-foldPlaceholder': {
				background: dark ? 'rgba(122, 162, 247, 0.1)' : 'rgba(47, 99, 204, 0.08)',
				border: dark ? '1px solid rgba(122, 162, 247, 0.22)' : '1px solid rgba(47, 99, 204, 0.22)',
				borderRadius: '4px',
				color: gutterStrong,
				padding: '0 3px',
				margin: '0 3px',
			},
		},
		{ dark },
	);
}

function themeExtensions(dark: boolean) {
	return [syntaxHighlighting(codeHighlight(dark), { fallback: true }), appTheme(dark)];
}

/** 只读代码预览：CodeMirror 6 高亮 + 折叠 + 行号 + 行跳转。 */
export function TextPreview({
	text,
	path,
	line,
	nav,
	wrap,
}: {
	text: string;
	path: string;
	line?: number;
	nav: number;
	wrap: boolean;
}) {
	const themeMode = useStore((s) => s.theme);
	const [darkTheme, setDarkTheme] = useState(() => resolveTheme(themeMode) === 'dark');
	const host = useRef<HTMLDivElement>(null);
	const viewRef = useRef<EditorView | null>(null);
	const themeCompartment = useRef(new Compartment()).current;
	const languageCompartment = useRef(new Compartment()).current;
	const wrapCompartment = useRef(new Compartment()).current;
	const lineCount = text.split('\n').length;
	const outOfRange = line != null && line > lineCount;

	useEffect(() => {
		setDarkTheme(resolveTheme(themeMode) === 'dark');
		if (themeMode !== 'system') return;
		const media = window.matchMedia('(prefers-color-scheme: dark)');
		const onChange = () => setDarkTheme(resolveTheme('system') === 'dark');
		media.addEventListener?.('change', onChange);
		return () => media.removeEventListener?.('change', onChange);
	}, [themeMode]);

	// 每个 tab 一个只读 EditorView；切 tab 时组件不卸载，滚动/折叠状态会保留。
	useEffect(() => {
		const parent = host.current;
		if (!parent) return;
		const view = new EditorView({
			parent,
			state: EditorState.create({
				doc: text,
				extensions: [
					lineNumbers(),
					codeFolding(),
					foldGutter({ openText: '▾', closedText: '▸' }),
					keymap.of(foldKeymap),
					themeCompartment.of(themeExtensions(darkTheme)),
					bracketMatching(),
					highlightSpecialChars(),
					highlightActiveLine(),
					highlightActiveLineGutter(),
					drawSelection(),
					EditorState.readOnly.of(true),
					EditorView.editable.of(false),
					EditorView.contentAttributes.of({ spellcheck: 'false', autocapitalize: 'off' }),
					wrapCompartment.of(wrap ? EditorView.lineWrapping : []),
					languageCompartment.of([]),
					hitLineField,
				],
			}),
		});
		viewRef.current = view;
		return () => {
			view.destroy();
			viewRef.current = null;
		};
		// 只在挂载时创建；正文变化走下面的 doc 更新 effect。
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	useEffect(() => {
		viewRef.current?.dispatch({
			effects: themeCompartment.reconfigure(themeExtensions(darkTheme)),
		});
	}, [darkTheme, themeCompartment]);

	// 按文件扩展名懒加载 CodeMirror 语言包；不认识的扩展名保持纯文本。
	useEffect(() => {
		let cancelled = false;
		const filename = path.split('/').pop() || path;
		let description: LanguageDescription | null = LanguageDescription.matchFilename(languages, filename);
		if (!description && /^Dockerfile(?:\..+)?$/i.test(filename)) {
			description = languages.find((item) => item.name === 'Dockerfile') ?? null;
		}
		if (!description && /^\.env(?:\.|$)/i.test(filename)) {
			description = languages.find((item) => item.name === 'Shell') ?? null;
		}
		if (!description) {
			viewRef.current?.dispatch({ effects: languageCompartment.reconfigure([]) });
			return;
		}
		description
			.load()
			.then((support) => {
				if (cancelled) return;
				viewRef.current?.dispatch({ effects: languageCompartment.reconfigure(support) });
			})
			.catch(() => {
				/* 语言包加载失败时保持纯文本 */
			});
		return () => {
			cancelled = true;
		};
	}, [path, languageCompartment]);

	useEffect(() => {
		const view = viewRef.current;
		if (!view) return;
		if (view.state.doc.toString() === text) return;
		view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
	}, [text]);

	useEffect(() => {
		viewRef.current?.dispatch({
			effects: wrapCompartment.reconfigure(wrap ? EditorView.lineWrapping : []),
		});
	}, [wrap, wrapCompartment]);

	useEffect(() => {
		const view = viewRef.current;
		if (!view || line == null) return;
		if (line < 1 || line > view.state.doc.lines) return;
		const target = view.state.doc.line(line);
		view.dispatch({
			effects: [EditorView.scrollIntoView(target.from, { y: 'center' }), setHitLine.of(line)],
		});
		const timer = window.setTimeout(() => {
			viewRef.current?.dispatch({ effects: setHitLine.of(null) });
		}, 1500);
		return () => window.clearTimeout(timer);
	}, [line, nav, text]);

	return (
		<div className={`code-preview${wrap ? ' wrap' : ''}`}>
			{outOfRange ? <div className="preview-banner">第 {line} 行在截断范围之外</div> : null}
			<div ref={host} className="cm-host" />
		</div>
	);
}
