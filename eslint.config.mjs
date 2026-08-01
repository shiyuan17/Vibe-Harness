// ESLint flat config for Vibe-Harness.
//
// Conservative thresholds: this config introduces lint discipline for new code
// without forcing a large-scale refactor of existing code. Rules that would
// flag existing violations are set to 'warn' (non-blocking). Thresholds can be
// tightened incrementally as debt is paid down.

import eslint from '@eslint/js';
import globals from 'globals';

export default [
  eslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Warn-level (non-blocking) to surface debt without breaking CI.
      complexity: ['warn', 30],
      'max-lines-per-function': ['warn', { max: 400, skipComments: true }],
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'consistent-return': 'warn',

      // CLI tooling legitimately uses console for user-facing output.
      'no-console': 'off',

      // Downgrade recommended rules that flag existing code to non-blocking
      // warnings. These can be promoted back to 'error' once the debt is fixed.
      'no-useless-escape': 'warn',
      'no-empty': 'warn',
      'no-control-regex': 'warn',
      'no-useless-assignment': 'warn',
      'no-ex-assign': 'warn',
      'no-undef': 'warn',
      'preserve-caught-error': 'warn',
    },
  },
  {
    ignores: [
      'node_modules/**',
      '.vibe-harness/**',
      'output/**',
      'tmp/**',
    ],
  },
];
