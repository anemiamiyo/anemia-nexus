import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { mcpPackageInfo } from './package-info.js';
import {
  closeRuntime,
  createRuntime,
  startBootstrap,
  startWatch,
  type McpServerOptions,
  type RuntimeState,
} from './runtime.js';
import { registerTools } from './tools.js';

export type { McpServerOptions, RuntimeState } from './runtime.js';

export interface CreatedMcpServer {
  server: McpServer;
  runtime: RuntimeState;
}

export interface StartedMcpServer {
  runtime: RuntimeState;
  close(): Promise<void>;
}

export function createMcpServer(
  runtime: RuntimeState,
  options: { readOnly?: boolean } = {},
): CreatedMcpServer {
  const info = mcpPackageInfo();
  const server = new McpServer(
    { name: info.name, version: info.version },
    { capabilities: { tools: {} } },
  );
  registerTools(server, runtime, {
    readOnly: options.readOnly === true || runtime.options.readOnly === true,
  });
  return { server, runtime };
}

/**
 * Start the stdio MCP server. The transport is owned by serveStdio; the
 * process stays alive through stdin, so this returns once the server is
 * wired. stdout is reserved for JSON-RPC from this point on.
 */
export async function startMcpServer(options: McpServerOptions): Promise<StartedMcpServer> {
  const runtime = createRuntime(options);
  let handle: ReturnType<typeof serveStdio>;
  try {
    handle = serveStdio(() => createMcpServer(runtime).server, {
      onerror: (error) => {
        process.stderr.write(`[nex mcp] ${error.message}\n`);
      },
    });
  } catch (error) {
    await closeRuntime(runtime);
    throw error;
  }
  startBootstrap(runtime);
  startWatch(runtime);
  return {
    runtime,
    close: async () => {
      await handle.close();
      await closeRuntime(runtime);
    },
  };
}
