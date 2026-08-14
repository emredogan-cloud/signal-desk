import { bootstrap } from '../bootstrap.js';

/**
 * `pnpm healthcheck` — is the deployed system alive, and is it *doing anything*.
 *
 * ## The distinction this exists to make
 *
 * "The process is up" and "the system is working" are different claims, and only the
 * first is easy. A worker whose every source has gone stale, whose budget guard has
 * suspended analysis, or whose scheduler stopped ticking, answers HTTP 200 the whole
 * time. `docs/VALIDATION.md` names silent feed death as the most likely real-world
 * failure of this system; a health check that cannot see it is decoration.
 *
 * So each check below is a *behavioural* one, run against the live deployment over
 * its public URL, and each prints the number it judged on rather than a bare OK.
 *
 * Exits non-zero if any check fails, so it can be a cron or a CI gate.
 */

type Check = {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
};

const APP_URL = process.env.SIGNAL_DESK_URL ?? 'https://signal-desk.fly.dev';

/** A source silent this long is dead until proven otherwise (ARCHITECTURE §9). */
const STALE_HOURS = 48;

async function checkPublicHealth(): Promise<Check[]> {
  const checks: Check[] = [];
  try {
    const response = await fetch(`${APP_URL}/healthz`, {
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await response.json()) as { ok?: boolean; database?: string };
    checks.push({
      name: 'dashboard reachable',
      ok: response.status === 200,
      detail: `${APP_URL}/healthz → HTTP ${response.status}`,
    });
    checks.push({
      name: 'database readable from the dashboard',
      ok: body.database === 'readable',
      detail: `database: ${body.database ?? 'no answer'}`,
    });
  } catch (error) {
    checks.push({
      name: 'dashboard reachable',
      ok: false,
      detail: `${APP_URL}/healthz → ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  // The console itself must NOT be readable without credentials. A health check that
  // only tests "does it respond" would rate an accidentally-public dashboard healthy.
  try {
    const response = await fetch(APP_URL, {
      signal: AbortSignal.timeout(15_000),
      redirect: 'manual',
    });
    checks.push({
      name: 'console refuses anonymous access',
      ok: response.status === 401,
      detail: `GET / → HTTP ${response.status} (401 expected)`,
    });
  } catch (error) {
    checks.push({
      name: 'console refuses anonymous access',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  return checks;
}

async function main(): Promise<number> {
  const { config } = bootstrap({ loggerName: 'healthcheck' });

  const checks: Check[] = [...(await checkPublicHealth())];

  // Local-side checks: only meaningful when run where the database is.
  const { openDatabase, sourceHealthRows, spendSince, latestScores } =
    await import('@signal-desk/db');

  try {
    const handle = openDatabase({ url: config.DATABASE_URL });
    try {
      const now = Date.now();
      const sources = sourceHealthRows(handle.db);
      const fresh = sources.filter(
        (row) =>
          row.lastSuccessAt !== null &&
          (now - row.lastSuccessAt.getTime()) / 3_600_000 < STALE_HOURS,
      );
      checks.push({
        name: 'sources are being polled',
        ok: sources.length > 0 && fresh.length > sources.length / 2,
        detail: `${fresh.length}/${sources.length} succeeded within ${STALE_HOURS}h`,
      });

      const dayStart = new Date();
      dayStart.setUTCHours(0, 0, 0, 0);
      const aiSpend = spendSince(handle.db, dayStart, 'anthropic');
      const xSpend = spendSince(handle.db, dayStart, 'x');
      checks.push({
        name: 'AI spend within budget',
        ok: aiSpend <= config.AI_DAILY_BUDGET_USD,
        detail: `$${aiSpend.toFixed(4)} of $${config.AI_DAILY_BUDGET_USD.toFixed(2)}`,
      });
      checks.push({
        name: 'X spend within budget',
        ok: xSpend <= config.X_DAILY_BUDGET_USD,
        detail: `$${xSpend.toFixed(4)} of $${config.X_DAILY_BUDGET_USD.toFixed(2)}`,
      });

      const scored = latestScores(handle.db, 1, false);
      checks.push({
        name: 'events have been scored',
        ok: scored.length > 0,
        detail: scored.length > 0 ? 'at least one scored event present' : 'no scored events',
      });
    } finally {
      handle.close();
    }
  } catch (error) {
    checks.push({
      name: 'local database checks',
      ok: false,
      detail: `skipped: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  const width = Math.max(...checks.map((check) => check.name.length));
  console.log('');
  for (const check of checks) {
    console.log(`  ${check.ok ? 'OK  ' : 'FAIL'}  ${check.name.padEnd(width)}  ${check.detail}`);
  }

  const failed = checks.filter((check) => !check.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
  return failed.length === 0 ? 0 : 1;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
