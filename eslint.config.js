import js from '@eslint/js';
import n from 'eslint-plugin-n';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '.nexus/**',
      '.dsh/**',
      'docs/**',
      'fixtures/**',
      'phase00/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['tools/**/*.mjs'],
    languageOptions: { globals: { process: 'readonly' } },
  },
  {
    files: ['**/*.ts'],
    plugins: {
      n,
    },
    rules: {
      // Runtime floor is Node 22.16.0 (docs/02-technical-baseline.md 2.2).
      // Any new Node built-in API must also be registered in docs/runtime-api.md.
      // node:sqlite is required by the spec and remains flagged experimental in Node 22.16.
      'n/no-unsupported-features/node-builtins': [
        'error',
        { version: '22.16.0', ignores: ['sqlite'] },
      ],
    },
  },
);
