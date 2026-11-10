#!/usr/bin/env node
// 语法自检：node --watch 只在启动时才发现 server/*.ts 坏掉，而进程一崩线上就 502。
// 改完 server/ 后先跑这个（make check），比等健康检查变红快得多。
//
// 注意：`node --check xxx.ts` 对 TS 不生效（它按 JS 词法跳过），
// 这里用 Node 自己的 strip 实现解析，和运行时用的是同一套 TS 解析器，
// 所以能原样复现 "ERR_INVALID_TYPESCRIPT_SYNTAX" 这类错误，
// 包括误粘贴进代码的 diff 行（行首多余的 + / -）。

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';

const roots = process.argv.slice(2);
const targets = roots.length ? roots : ['server'];
const exts = new Set(['.ts', '.mts', '.cts', '.tsx']);
let failed = 0;
let checked = 0;

function walk(dir) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
			walk(full);
		} else if (exts.has(full.slice(full.lastIndexOf('.')))) {
			check(full);
		}
	}
}

function check(file) {
	checked += 1;
	const source = readFileSync(file, 'utf8');
	try {
		stripTypeScriptTypes(source, { mode: 'strip' });
	} catch (error) {
		failed += 1;
		const line = error?.stack?.match(/:(\d+):(\d+)/) ?? error?.stack?.match(/\b(\d+):(\d+)\b/);
		const where = line ? `:${line[1]}:${line[2]}` : '';
		console.error(`FAIL ${relative(process.cwd(), file)}${where}`);
		console.error('     ' + String(error.message).split('\n')[0]);
	}
}

for (const root of targets) {
	try {
		walk(root);
	} catch {
		console.error(`skip: cannot read ${root}`);
	}
}

if (failed) {
	console.error(`\n${failed}/${checked} 个文件有语法错误。容器里是 node --watch，改坏了会直接崩掉不重启。`);
	process.exit(1);
}
console.log(`ok: ${checked} 个 TypeScript 文件通过语法检查`);
