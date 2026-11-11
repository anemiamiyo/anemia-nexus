import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const server = new McpServer({ name: 'phase00-echo', version: '0.0.0' });

server.registerTool(
  'echo',
  {
    title: 'Echo',
    description: 'Echo the provided text',
    inputSchema: z.object({ text: z.string() }),
    outputSchema: z.object({ text: z.string() }),
  },
  async ({ text }) => ({
    content: [{ type: 'text', text }],
    structuredContent: { text },
  }),
);

await server.connect(new StdioServerTransport());
