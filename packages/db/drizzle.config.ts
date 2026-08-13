import { defineConfig } from 'drizzle-kit';

// Paths are relative to the repository root, which is where `pnpm db:generate` runs.
export default defineConfig({
  dialect: 'sqlite',
  schema: './packages/db/src/schema.ts',
  out: './packages/db/migrations',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? 'file:./data/signal-desk.db',
  },
  strict: true,
  verbose: true,
});
