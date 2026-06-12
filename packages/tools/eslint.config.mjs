// @zaivim/tools ESLint config
// Enforces ISecurityProvider contact-point constraint (AC8):
// Tools MUST NOT import directly from @zaivim/engine.
// All security interaction goes through ISecurityProvider from @zaivim/core.
//
// Story 2.4, Task 5.1 & 5.2: ESLint enforcement of bidirectional contact-point

import rootConfig from '../../eslint.config.mjs';
import importX from 'eslint-plugin-import-x';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';

export default [
  ...rootConfig,
  {
    plugins: {
      'import-x': importX,
    },
    settings: {
      'import-x/resolver-next': [
        createTypeScriptImportResolver({
          alwaysTryTypes: true,
          project: [
            './tsconfig.json',
            '../../tsconfig.json',
          ],
        }),
      ],
    },
    rules: {
      // AC8 L1: Prevent tools from importing engine by package name
      // Catches `import { X } from '@zaivim/engine'`
      'no-restricted-imports': ['error', {
        patterns: [
          {
            group: ['@zaivim/engine', '@zaivim/engine/**'],
            message: '@zaivim/tools MUST NOT import from @zaivim/engine. '
              + 'Use ISecurityProvider from @zaivim/core instead. '
              + 'See: architecture-nodejs-migration.md#双向接触点定界',
          },
        ],
      }],

      // AC8 L2: Prevent tools from importing engine by file path
      // Catches relative-path workarounds like `import ... from '../../engine/src/...'`
      'import-x/no-restricted-paths': ['error', {
        zones: [
          {
            target: './src/',
            from: '../../engine/src/',
            message: '@zaivim/tools MUST NOT import from @zaivim/engine. '
              + 'Use ISecurityProvider from @zaivim/core instead.',
          },
          {
            target: './src/',
            from: '../../engine/dist/',
            message: '@zaivim/tools MUST NOT import from @zaivim/engine. '
              + 'Use ISecurityProvider from @zaivim/core instead.',
          },
        ],
      }],
    },
  },
];
