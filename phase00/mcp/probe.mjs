import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const started = performance.now();
const serverPath = path.join(process.cwd(), 'phase00/mcp/echo-server.mjs');
const client = new Client({ name: 'phase00-probe', version: '0.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  cwd: process.cwd(),
  stderr: 'pipe',
});

let result;
try {
  await client.connect(transport);
  const listed = await client.listTools();
  const called = await client.callTool({ name: 'echo', arguments: { text: 'hello-phase00' } });
  result = {
    ok: true,
    node: process.version,
    protocolVersion: client.getNegotiatedProtocolVersion(),
    serverVersion: client.getServerVersion(),
    tools: listed.tools.map((tool) => tool.name),
    toolCount: listed.tools.length,
    content: called.content,
    structuredContent: called.structuredContent,
    elapsedMs: Math.round(performance.now() - started),
  };
} catch (error) {
  result = {
    ok: false,
    node: process.version,
    error: String(error),
    elapsedMs: Math.round(performance.now() - started),
  };
} finally {
  await client.close().catch(() => {});
}

console.log(JSON.stringify(result));
process.exit(result.ok ? 0 : 1);
