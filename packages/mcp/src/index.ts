/**
 * anemia-mcp — MCP server for Anemia Nexus (docs/14-agent-integration.md).
 * The eight tools share anemia-core query logic with the CLI; this package
 * owns only protocol registration, format fallback and the refresh guard.
 */
export { createMcpServer, startMcpServer } from './server.js';
export type { CreatedMcpServer, StartedMcpServer } from './server.js';
export type { McpServerOptions, RuntimeState } from './runtime.js';
export {
  createRuntime,
  closeRuntime,
  currentStatus,
  startBootstrap,
  startWatch,
  scheduleWatchRefresh,
} from './runtime.js';
export { refreshIndex } from './refresh.js';
export { resolveFormat, renderCompact, renderErrorText } from './format.js';
export type { FormatDecision, McpFormat } from './format.js';
export { TOOL_NAMES } from './tool-names.js';
