/** Stable MCP tool-name contract (docs/14-agent-integration.md 14.1). */
export const TOOL_NAMES = [
  'status',
  'search',
  'symbol',
  'references',
  'deps',
  'impact',
  'context',
  'refresh',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];
