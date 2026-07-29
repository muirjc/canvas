// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/*.config.js',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // ignoreRestSiblings covers the standard idiom for omitting a property immutably:
      // `const { containerId: _dropped, ...rest } = node`. The binding is deliberately unused —
      // it exists so the rest object excludes that key.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
  {
    // Standalone Node tooling scripts (e.g. apps/web/scripts/check-contrast.mjs) run under Node,
    // not in the browser, so they legitimately use process/console/URL.
    files: ['**/scripts/**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', URL: 'readonly' },
    },
  },
);
