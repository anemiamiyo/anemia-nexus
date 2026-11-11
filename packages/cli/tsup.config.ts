import { defineConfig } from 'tsup';

/**
 * anemia-cli build: single executable entry with a shebang. The core library
 * stays external so the CLI and any future MCP server share one implementation.
 */
export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  dts: true,
  clean: true,
  sourcemap: false,
  splitting: false,
  treeshake: true,
  banner: { js: '#!/usr/bin/env node' },
  removeNodeProtocol: false,
  external: [
    'node:child_process',
    'node:crypto',
    'node:fs',
    'node:module',
    'node:path',
    'node:readline/promises',
    'node:sqlite',
    'node:url',
    'node:util',
    'anemia-core',
    'commander',
  ],
});
