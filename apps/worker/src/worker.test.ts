import { describe, it, expect } from 'vitest';
import { runWorker } from './worker.js';
import { bootstrap } from './bootstrap.js';

/**
 * Phase 1 TESTS, per ROADMAP.md:
 *   "A smoke test asserting the worker starts and exits cleanly in MOCK mode."
 *
 * The environment is injected rather than read from the machine, so this test proves
 * the zero-credential path specifically — the one CI runs.
 */

function captureLogs() {
  const lines: string[] = [];
  return {
    destination: {
      write(chunk: string) {
        lines.push(chunk);
      },
    },
    text: () => lines.join(''),
    entries: () =>
      lines
        .map((line) => {
          try {
            return JSON.parse(line) as Record<string, unknown>;
          } catch {
            return {};
          }
        })
        .filter((entry) => Object.keys(entry).length > 0),
  };
}

describe('worker smoke test — MOCK mode, zero credentials', () => {
  it('starts, migrates, and shuts down cleanly with an empty environment', async () => {
    const logs = captureLogs();

    const result = await runWorker({
      env: {},
      skipDotenv: true,
      once: true,
      databaseUrl: ':memory:',
      destination: logs.destination,
    });

    expect(result.bootstrapped.modes.dataMode).toBe('MOCK');
    expect(result.bootstrapped.modes.aiMode).toBe('MOCK');
    expect(result.bootstrapped.modes.xMode).toBe('MOCK');

    await expect(result.shutdown()).resolves.toBeUndefined();
  });

  it('creates the sources table via migrations', async () => {
    const result = await runWorker({
      env: {},
      skipDotenv: true,
      once: true,
      databaseUrl: ':memory:',
      destination: captureLogs().destination,
    });

    const tables = result.database.raw
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name);

    expect(tables).toContain('sources');

    await result.shutdown();
  });

  it('is safe to shut down twice', async () => {
    const result = await runWorker({
      env: {},
      skipDotenv: true,
      once: true,
      databaseUrl: ':memory:',
      destination: captureLogs().destination,
    });

    await result.shutdown();
    await expect(result.shutdown()).resolves.toBeUndefined();
  });

  it('announces its effective modes on startup', async () => {
    const logs = captureLogs();

    const result = await runWorker({
      env: {},
      skipDotenv: true,
      once: true,
      databaseUrl: ':memory:',
      destination: logs.destination,
    });
    await result.shutdown();

    const startup = logs.entries().find((entry) => entry.msg === 'signal-desk starting');
    expect(startup).toBeDefined();
    expect(startup?.data_mode).toBe('MOCK');
    expect(startup?.ai_mode).toBe('MOCK');
  });

  it('logs every degradation as a warning rather than swallowing it', async () => {
    // §36 of the working brief: make the degradation visible. An operator who cannot
    // tell that AI fell back to MOCK will believe he is reading real analysis.
    const logs = captureLogs();

    const result = await runWorker({
      env: { AI_MODE: 'LIVE' }, // no key
      skipDotenv: true,
      once: true,
      databaseUrl: ':memory:',
      destination: logs.destination,
    });
    await result.shutdown();

    expect(result.bootstrapped.modes.aiMode).toBe('MOCK');

    const warnings = logs.entries().filter((entry) => entry.level === 'warn');
    const degraded = warnings.filter((entry) => String(entry.msg).startsWith('DEGRADED:'));
    expect(degraded.length).toBeGreaterThan(0);
    expect(degraded.some((entry) => entry.subsystem === 'ai')).toBe(true);
  });

  it('propagates a configuration error instead of starting in a wrong mode', async () => {
    await expect(
      runWorker({
        env: { DATA_MODE: 'live' },
        skipDotenv: true,
        once: true,
        databaseUrl: ':memory:',
      }),
    ).rejects.toThrow(/DATA_MODE/);
  });
});

describe('bootstrap', () => {
  it('registers credentials before the logger can write them', async () => {
    // The X access token has no distinctive shape; only registration catches it.
    // Assembled rather than written as a literal — see the note in redact.test.ts.
    // The other three values are deliberately short and obviously fake: they only
    // need to exist for X_MODE to resolve LIVE, and a realistic-looking literal here
    // trips the x-oauth rule in .gitleaks.toml for no testing benefit.
    const logs = captureLogs();
    const token = ['k7Hs92', 'LmQx4T', 'bV0nRz', 'YwPcEjA8'].join('');

    const { logger } = bootstrap({
      env: {
        X_MODE: 'LIVE',
        X_API_KEY: 'fixture',
        X_API_SECRET: 'fixture',
        X_ACCESS_TOKEN: token,
        X_ACCESS_TOKEN_SECRET: 'fixture',
      },
      skipDotenv: true,
      destination: logs.destination,
    });

    logger.info({ token }, 'about to call the x api');

    expect(logs.text()).not.toContain(token);
    await Promise.resolve();
  });
});
