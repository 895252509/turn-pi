#!/usr/bin/env node
/**
 * 测试用的最小 MCP stdio 服务器（零依赖，只为 scripts/check-mcp.mjs 存在）。
 *
 * 实现 MCP 的 stdio 传输：每行一条 JSON-RPC 消息，只做 initialize / tools/list / tools/call。
 * 工具：echo(text) -> "echo:<text>"
 */

const TOOLS = [
	{
		name: 'echo',
		description: 'Echo the given text back, prefixed with "echo:".',
		inputSchema: {
			type: 'object',
			properties: { text: { type: 'string', description: 'Text to echo' } },
			required: ['text'],
		},
	},
];

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

const handle = (message) => {
	const { id, method, params } = message;
	// 通知（没有 id）不需要回复
	if (id === undefined || id === null) return;

	switch (method) {
		case 'initialize':
			send({
				jsonrpc: '2.0',
				id,
				result: {
					protocolVersion: params?.protocolVersion ?? '2025-06-18',
					capabilities: { tools: { listChanged: false } },
					serverInfo: { name: 'check-echo', version: '0.0.1' },
					instructions: 'Fixture server for pi-webchat MCP smoke checks. Call echo to verify wiring.',
				},
			});
			return;
		case 'ping':
			send({ jsonrpc: '2.0', id, result: {} });
			return;
		case 'tools/list':
			send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
			return;
		case 'resources/list':
			send({ jsonrpc: '2.0', id, result: { resources: [] } });
			return;
		case 'prompts/list':
			send({ jsonrpc: '2.0', id, result: { prompts: [] } });
			return;
		case 'tools/call': {
			const name = params?.name;
			if (name !== 'echo') {
				send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `unknown tool ${name}` }], isError: true } });
				return;
			}
			const text = String(params?.arguments?.text ?? '');
			send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `echo:${text}` }] } });
			return;
		}
		default:
			send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
	}
};

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
	buffer += chunk;
	for (let index = buffer.indexOf('\n'); index !== -1; index = buffer.indexOf('\n')) {
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		if (!line) continue;
		try {
			handle(JSON.parse(line));
		} catch (error) {
			process.stderr.write(`[mcp-fixture] 解析失败：${error instanceof Error ? error.message : String(error)}\n`);
		}
	}
});
process.stdin.on('end', () => process.exit(0));
