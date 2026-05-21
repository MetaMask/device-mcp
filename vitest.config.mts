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
        branches: 27.51,
        functions: 10.49,
        lines: 17.22,
        statements: 17.06,
      },
    },

    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.test.json',
    },
  },
});