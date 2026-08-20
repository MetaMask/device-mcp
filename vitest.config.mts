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
        branches: 60.11,
        functions: 63.01,
        lines: 63.58,
        statements: 63.44,
      },
    },

    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.test.json',
    },
  },
});