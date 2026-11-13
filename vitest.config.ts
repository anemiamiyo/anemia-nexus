import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      'anemia-core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
      'anemia-mcp': fileURLToPath(new URL('./packages/mcp/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['packages/*/test/**/*.test.ts'],
    passWithNoTests: false,
    // Phase 07 D2: time is not a gate. Serialize test files so concurrent
    // SCIP/MCP child processes cannot starve one another in CI containers.
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
