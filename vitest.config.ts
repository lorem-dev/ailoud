import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const fromRoot = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@laud/core/testing': fromRoot('./packages/core/src/testing/index.ts'),
      '@laud/core': fromRoot('./packages/core/src/index.ts'),
    },
  },
  test: {
    // e2e/src holds the wordErrorRate pure function and its unit test
    // (e2e/src/wer.test.ts) -- Vitest's usual home for a *.test.ts file.
    // Jest's e2e config only ever matches e2e/tests/**/*.spec.ts, a
    // different directory and suffix, so the two runners never collect
    // each other's files.
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts', 'e2e/src/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      // The gate covers the domain core. Providers are thin adapters over
      // foreign processes and are covered by the end-to-end suite instead.
      include: ['packages/core/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/testing/**', '**/index.ts'],
      thresholds: { lines: 90, branches: 90, functions: 90, statements: 90 },
    },
  },
});
