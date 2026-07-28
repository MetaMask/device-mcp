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
        branches: 56.06,
        functions: 58.26,
        lines: 55.48,
        statements: 55.33,
      },
    },

    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.test.json',
    },
  },
});