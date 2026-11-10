import {
	Binary,
	Braces,
	Container,
	Database,
	FileArchive,
	FileAudio,
	FileCode2,
	FileCog,
	FileImage,
	FileJson,
	FileKey,
	FileQuestion,
	FileSpreadsheet,
	FileText,
	FileVideo,
	GitBranch,
	Lock,
	Scale,
	Terminal,
	Type,
	Wrench,
	type LucideIcon,
} from 'lucide-react';

interface IconSpec {
	Icon: LucideIcon;
	color: string;
}

const C = {
	blue: '#7aa2f7',
	cyan: '#7dcfff',
	green: '#9ece6a',
	yellow: '#e0af68',
	orange: '#ff966c',
	red: '#f7768e',
	purple: '#bb9af7',
	teal: '#73daca',
	pink: '#ff9eb5',
	muted: '#8b93a1',
};

function spec(Icon: LucideIcon, color: string): IconSpec {
	return { Icon, color };
}

const EXACT: Record<string, IconSpec> = {
	dockerfile: spec(Container, C.blue),
	containerfile: spec(Container, C.blue),
	makefile: spec(Wrench, C.yellow),
	license: spec(Scale, C.muted),
	licence: spec(Scale, C.muted),
	copying: spec(Scale, C.muted),
	'.gitignore': spec(GitBranch, C.orange),
	'.gitattributes': spec(GitBranch, C.orange),
	'.gitmodules': spec(GitBranch, C.orange),
	'.env': spec(FileKey, C.green),
	'.bashrc': spec(Terminal, C.green),
	'.zshrc': spec(Terminal, C.green),
	'.profile': spec(Terminal, C.green),
	'.npmrc': spec(FileCog, C.muted),
	'.editorconfig': spec(FileCog, C.muted),
};

const BY_EXT: Record<string, IconSpec> = {
	ts: spec(FileCode2, C.blue),
	tsx: spec(FileCode2, C.cyan),
	mts: spec(FileCode2, C.blue),
	cts: spec(FileCode2, C.blue),
	js: spec(FileCode2, C.yellow),
	jsx: spec(FileCode2, C.cyan),
	mjs: spec(FileCode2, C.yellow),
	cjs: spec(FileCode2, C.yellow),
	vue: spec(FileCode2, C.green),
	svelte: spec(FileCode2, C.orange),
	html: spec(FileCode2, C.orange),
	htm: spec(FileCode2, C.orange),
	xml: spec(FileCode2, C.orange),
	css: spec(Braces, C.purple),
	scss: spec(Braces, C.pink),
	sass: spec(Braces, C.pink),
	less: spec(Braces, C.blue),
	json: spec(FileJson, C.yellow),
	jsonl: spec(FileJson, C.yellow),
	yaml: spec(FileCog, C.yellow),
	yml: spec(FileCog, C.yellow),
	toml: spec(FileCog, C.yellow),
	ini: spec(FileCog, C.muted),
	conf: spec(FileCog, C.muted),
	env: spec(FileKey, C.green),
	md: spec(FileText, C.blue),
	markdown: spec(FileText, C.blue),
	txt: spec(FileText, C.muted),
	log: spec(FileText, C.muted),
	py: spec(FileCode2, C.teal),
	go: spec(FileCode2, C.cyan),
	rs: spec(FileCode2, C.orange),
	java: spec(FileCode2, C.purple),
	kt: spec(FileCode2, C.purple),
	kts: spec(FileCode2, C.purple),
	c: spec(FileCode2, C.blue),
	h: spec(FileCode2, C.blue),
	cc: spec(FileCode2, C.blue),
	cpp: spec(FileCode2, C.blue),
	hpp: spec(FileCode2, C.blue),
	cs: spec(FileCode2, C.purple),
	php: spec(FileCode2, C.purple),
	rb: spec(FileCode2, C.red),
	lua: spec(FileCode2, C.blue),
	swift: spec(FileCode2, C.orange),
	sh: spec(Terminal, C.green),
	bash: spec(Terminal, C.green),
	zsh: spec(Terminal, C.green),
	fish: spec(Terminal, C.green),
	sql: spec(Database, C.cyan),
	csv: spec(FileSpreadsheet, C.green),
	tsv: spec(FileSpreadsheet, C.green),
	xls: spec(FileSpreadsheet, C.green),
	xlsx: spec(FileSpreadsheet, C.green),
	png: spec(FileImage, C.green),
	jpg: spec(FileImage, C.green),
	jpeg: spec(FileImage, C.green),
	gif: spec(FileImage, C.pink),
	webp: spec(FileImage, C.green),
	bmp: spec(FileImage, C.green),
	ico: spec(FileImage, C.blue),
	avif: spec(FileImage, C.green),
	svg: spec(FileImage, C.orange),
	pdf: spec(FileText, C.red),
	zip: spec(FileArchive, C.yellow),
	tar: spec(FileArchive, C.yellow),
	gz: spec(FileArchive, C.yellow),
	tgz: spec(FileArchive, C.yellow),
	bz2: spec(FileArchive, C.yellow),
	xz: spec(FileArchive, C.yellow),
	'7z': spec(FileArchive, C.yellow),
	rar: spec(FileArchive, C.yellow),
	mp4: spec(FileVideo, C.pink),
	mov: spec(FileVideo, C.pink),
	avi: spec(FileVideo, C.pink),
	mkv: spec(FileVideo, C.pink),
	webm: spec(FileVideo, C.pink),
	mp3: spec(FileAudio, C.purple),
	wav: spec(FileAudio, C.purple),
	flac: spec(FileAudio, C.purple),
	ogg: spec(FileAudio, C.purple),
	ttf: spec(Type, C.purple),
	otf: spec(Type, C.purple),
	woff: spec(Type, C.purple),
	woff2: spec(Type, C.purple),
	lock: spec(Lock, C.red),
	wasm: spec(Binary, C.orange),
	bin: spec(Binary, C.orange),
	exe: spec(Binary, C.orange),
	dll: spec(Binary, C.orange),
	so: spec(Binary, C.orange),
	dylib: spec(Binary, C.orange),
};

const FALLBACK = spec(FileText, C.muted);
const UNKNOWN = spec(FileQuestion, C.muted);

export function iconForFile(name: string): IconSpec {
	const lower = name.toLowerCase();
	if (EXACT[lower]) return EXACT[lower];
	if (lower.startsWith('.env.')) return EXACT['.env'];
	if (/^dockerfile(?:\..+)?$/i.test(name)) return EXACT.dockerfile;

	const index = name.lastIndexOf('.');
	if (index < 0) return FALLBACK;
	return BY_EXT[name.slice(index + 1).toLowerCase()] ?? UNKNOWN;
}

export function FileTypeIcon({ name }: { name: string }) {
	const { Icon, color } = iconForFile(name);
	return <Icon aria-hidden="true" style={{ color }} />;
}
