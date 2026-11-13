import { defineConfig } from 'tsup';

/**
 * anemia-mcp build: self-contained ESM package (docs/03-tech-stack-and-build.md 3.3).
 * anemia-core, the MCP SDK, zod and Node built-ins stay external.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  dts: true,
  clean: true,
  sourcemap: false,
  splitting: false,
  treeshake: true,
  removeNodeProtocol: false,
  external: [
    'node:fs',
    'node:module',
    'node:path',
    'node:sqlite',
    'anemia-core',
    '@modelcontextprotocol/server',
    '@modelcontextprotocol/server/stdio',
    'zod',
  ],
});
