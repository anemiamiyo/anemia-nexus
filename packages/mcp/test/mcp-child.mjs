// Test double for the `doctor --mcp` probe only. It speaks the two messages
// the probe needs; the production server is packages/mcp/src/server.ts.
import process from 'node:process';
import readline from 'node:readline';

const write = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === 'initialize') {
    write({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'anemia-mcp-test-double', version: '0.0.0' },
      },
    });
  } else if (message.method === 'tools/list') {
    write({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: [
          'status',
          'search',
          'symbol',
          'references',
          'deps',
          'impact',
          'context',
          'refresh',
        ].map((name) => ({ name, inputSchema: { type: 'object' } })),
      },
    });
  }
});
