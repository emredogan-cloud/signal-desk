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
    include: ['packages/**/*.test.ts', 'apps/worker/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['packages/*/src/**/*.ts', 'apps/worker/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts', '**/types.ts'],
    },
  },
});
