import {
  credentialShapeProblems,
  verifyCredentials,
  XApiError,
  XBudgetExceeded,
  X_REQUEST_PRICE_USD,
  type XCredentials,
  type XSpendAccount,
} from '@signal-desk/adapters';
import {
  openDatabase,
  spendSince,
  recordVendorSpend,
  MIGRATIONS_FOLDER,
  runMigrations,
} from '@signal-desk/db';
import { bootstrap, logStartupState } from '../bootstrap.js';
import { findRepoRoot } from '../repo-root.js';

/**
 * `pnpm x:verify` — one live, read-only X request, to prove the credentials work.
 *
 * ENV-HANDBOOK.md §10 names this as the rotation runbook's verification step:
 * "restart → verify with a single owned read → confirm the old tokens fail." It is
 * also the honest answer to "are the X keys correct?", which cannot be answered by
 * looking at `.env`: four present variables prove four present variables.
 *
 * **This command cannot post.** It imports nothing that can. `X_ENABLE_POSTING` is not
 * consulted because there is no branch here it could enable.
 *
 * Cost: **one `user_read`, $0.010**, charged against `X_DAILY_BUDGET_USD` and written
 * to the spend ledger like any other metered call. Run it when something changed, not
 * on a schedule.
 */

function main(): Promise<number> {
  const { config, modes, logger } = bootstrap({ loggerName: 'x-verify' });
  logStartupState({ config, modes, logger });

  if (modes.xMode !== 'LIVE') {
    console.error(
      `\nX is not in effective LIVE mode (X_MODE=${config.X_MODE}). Nothing was sent.\n` +
        `Run \`pnpm check:env\` — the degradation table says which credential is missing.\n`,
    );
    return Promise.resolve(1);
  }

  const credentials: XCredentials = {
    apiKey: config.X_API_KEY ?? '',
    apiSecret: config.X_API_SECRET ?? '',
    accessToken: config.X_ACCESS_TOKEN ?? '',
    accessTokenSecret: config.X_ACCESS_TOKEN_SECRET ?? '',
  };

  // Free checks before the metered one. A truncated paste is indistinguishable from a
  // revoked key once X has answered 401, and answering costs $0.010 either way.
  const shapeProblems = credentialShapeProblems(credentials);
  if (shapeProblems.length > 0) {
    console.error('\nREFUSED BEFORE SENDING — the credentials cannot be valid as written:\n');
    for (const problem of shapeProblems) console.error(`  - ${problem}`);
    console.error('\nNothing was sent and nothing was billed.\n');
    return Promise.resolve(2);
  }

  const handle = openDatabase({ url: config.DATABASE_URL });
  // This CLI may be the first thing run on a fresh host, before the worker has
  // migrated. The dashboard must never migrate (it is a reader); a worker-side CLI
  // that writes to the ledger is on the writing side of that line.
  runMigrations(handle, MIGRATIONS_FOLDER);

  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);

  const spend: XSpendAccount = {
    spentTodayUsd: () => spendSince(handle.db, dayStart, 'x'),
    budgetUsd: () => config.X_DAILY_BUDGET_USD,
    record: (kind, priceUsd, endpoint, status) => {
      recordVendorSpend(handle.db, {
        provider: 'x',
        stage: kind,
        endpoint: `${endpoint} ${status}`,
        costUsd: priceUsd,
        spentAt: new Date(),
      });
    },
  };

  const before = spendSince(handle.db, dayStart, 'x');
  console.log(
    `\nX spend today before this call: $${before.toFixed(4)} of ` +
      `$${config.X_DAILY_BUDGET_USD.toFixed(2)} ceiling`,
  );
  console.log(`Sending: GET /2/users/me  (priced as user_read, $${X_REQUEST_PRICE_USD.user_read})`);

  return verifyCredentials(credentials, spend)
    .then((response) => {
      const after = spendSince(handle.db, dayStart, 'x');
      console.log('\nAUTHENTICATED');
      console.log(`  account      @${response.data.username}`);
      console.log(`  display name ${response.data.name}`);
      console.log(`  user id      ${response.data.id}`);
      console.log('\nRATE LIMIT');
      console.log(`  limit        ${response.rateLimit.limit ?? '(not sent)'}`);
      console.log(`  remaining    ${response.rateLimit.remaining ?? '(not sent)'}`);
      console.log(`  resets at    ${response.rateLimit.resetAt?.toISOString() ?? '(not sent)'}`);
      console.log('\nSPEND');
      console.log(`  this call    $${response.priceUsd.toFixed(4)}`);
      console.log(
        `  today        $${after.toFixed(4)} of $${config.X_DAILY_BUDGET_USD.toFixed(2)}`,
      );
      console.log(`  posting      ${modes.postingEnabled ? 'ENABLED' : 'disabled'}`);
      console.log(`  ledger       ${findRepoRoot()} → spend_ledger (provider='x')\n`);
      return 0;
    })
    .catch((error: unknown) => {
      if (error instanceof XBudgetExceeded) {
        console.error(`\nREFUSED BEFORE SENDING — ${error.message}`);
        console.error('Nothing was sent and nothing was billed.\n');
        return 2;
      }
      if (error instanceof XApiError) {
        console.error(`\nX REJECTED THE REQUEST — HTTP ${error.status}`);
        console.error(error.body);
        console.error(
          '\n401 means the four credentials do not form a valid OAuth 1.0a user context.\n' +
            '403 usually means the app lacks the permission the endpoint needs.\n' +
            'The call was still billed — X charges attempts.\n',
        );
        return 1;
      }
      throw error;
    })
    .finally(() => {
      handle.close();
    });
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
