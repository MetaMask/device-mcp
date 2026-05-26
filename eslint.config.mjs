import base, { createConfig } from '@metamask/eslint-config';
import nodejs from '@metamask/eslint-config-nodejs';
import typescript from '@metamask/eslint-config-typescript';
import vitest from '@metamask/eslint-config-vitest';

const config = createConfig([
  {
    ignores: ['dist/', '.yarn/', 'yarn.config.cjs'],
  },

  {
    extends: base,

    languageOptions: {
      sourceType: 'module',
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
    },

    settings: {
      'import-x/extensions': ['.js', '.mjs'],
    },
  },

  {
    files: ['**/*.ts'],
    extends: typescript,
  },

  {
    files: ['**/*.js', '**/*.cjs'],
    extends: nodejs,

    languageOptions: {
      sourceType: 'script',
    },
  },

  {
    files: ['src/**/*.ts'],
    rules: {
      'import-x/no-nodejs-modules': 'off',
      'no-restricted-globals': 'off',
      'jsdoc/require-jsdoc': 'off',
      'id-length': 'off',
      '@typescript-eslint/prefer-nullish-coalescing': 'off',
      'import-x/no-useless-path-segments': 'off',
    },
  },

  {
    files: ['**/*.test.ts', '**/*.test.js'],
    extends: [vitest, nodejs],
    rules: {
      'vitest/no-conditional-expect': 'off',
      'jsdoc/require-jsdoc': 'off',
      'id-length': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-restricted-globals': 'off',
      'n/no-sync': 'off',
    },
  },
]);

export default config;
