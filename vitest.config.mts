import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    watch: false,
    include: ['src/**/*.test.ts'],

    coverage: {
      enabled: true,
      provider: 'istanbul',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.test-d.ts'],
      thresholds: {
        autoUpdate: !process.env.CI,
        branches: 39.47,
        functions: 42.59,
        lines: 36.3,
        statements: 36.48,
      },
    },

    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.test.json',
    },
  },
});