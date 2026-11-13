import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export interface McpPackageInfo {
  name: string;
  version: string;
}

/**
 * Read the MCP package identity from its own package.json so `status.self`
 * can expose the real binary identity (docs/22-onboarding.md 22.2 #4).
 */
export function mcpPackageInfo(): McpPackageInfo {
  try {
    const value = require('../package.json') as unknown;
    if (typeof value === 'object' && value !== null) {
      const record = value as Record<string, unknown>;
      if (typeof record.name === 'string' && typeof record.version === 'string') {
        return { name: record.name, version: record.version };
      }
    }
  } catch {
    // fall through to defaults
  }
  return { name: 'anemia-mcp', version: '0.0.0' };
}
