import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    watch: false,
    include: ['src/**/*.test.ts'],

    coverage: {
      enabled: true,
      provider: 'istanbul',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.test-d.ts',
        // signer.ts is the pure-JS APK signature verifier. Its end-to-end path
        // can only be exercised against a real signed APK, which requires the
        // Android SDK + signing keystore — present locally and in the release
        // build, but not in the unit-test CI job (where those tests skip). It is
        // covered by the SDK-gated integration tests and the on-device check.
        // Excluding it here keeps the global thresholds meaningful for every
        // other file instead of being dragged down by an untestable-in-CI unit.
        'src/backends/android-instrumentation/signer.ts',
      ],
      thresholds: {
        // autoUpdate is disabled so the thresholds never silently ratchet up on
        // a machine where the SDK-dependent tests run. Keep them in sync manually.
        autoUpdate: false,
        branches: 60,
        functions: 60.11,
        lines: 60.41,
        statements: 60.22,
      },
    },

    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.test.json',
    },
  },
});