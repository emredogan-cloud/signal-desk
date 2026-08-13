import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against TypeScript source, not build output. This keeps the test
    // loop fast and, more importantly, means a green test run never depends on a
    // stale dist/ directory.
    alias: {
      '@signal-desk/shared': r('./packages/shared/src/index.ts'),
      '@signal-desk/db': r('./packages/db/src/index.ts'),
      '@signal-desk/core': r('./packages/core/src/index.ts'),
      '@signal-desk/adapters': r('./packages/adapters/src/index.ts'),
      '@signal-desk/ai': r('./packages/ai/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    // The pipeline tests cluster ~960 fixture items against a real in-memory SQLite.
    // 5s is vitest's default and it is comfortable locally and marginal on a CI
    // runner — which is a bad place for the margin to be, because the failure looks
    // like flakiness rather than the timing signal it is.
    testTimeout: 20_000,
    // .tsx included from Phase 10: the dashboard's XSS test renders hostile corpus
    // content through the real components, which needs JSX.
    include: ['packages/**/*.test.ts', 'apps/worker/**/*.test.ts', 'apps/web/**/*.test.tsx'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['packages/*/src/**/*.ts', 'apps/worker/src/**/*.ts', 'apps/web/src/**/*.tsx'],
      exclude: ['**/*.test.ts', '**/index.ts', '**/types.ts'],
    },
  },
});
