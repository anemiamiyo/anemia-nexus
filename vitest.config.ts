import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      'anemia-core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['packages/*/test/**/*.test.ts'],
    passWithNoTests: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
