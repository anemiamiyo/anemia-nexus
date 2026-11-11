import { defineConfig } from 'tsup';

/**
 * anemia-core build: ESM only, syntax target node20. Node built-ins
 * (including `node:sqlite`) must stay external; the package must not bundle
 * any SQLite driver.
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
    'node:child_process',
    'node:crypto',
    'node:fs',
    'node:module',
    'node:path',
    'node:readline/promises',
    'node:sqlite',
    'node:url',
    'node:util',
    '@sourcegraph/scip-typescript',
    'proper-lockfile',
    'typescript',
    'zod',
  ],
});
