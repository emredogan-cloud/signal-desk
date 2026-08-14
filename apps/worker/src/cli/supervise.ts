import { spawn, type ChildProcess } from 'node:child_process';

/**
 * Run the worker and the dashboard as one deployable unit.
 *
 * ## Why one process tree and not two services
 *
 * `ARCHITECTURE.md` §7: "exactly one writer (the worker) and one reader (the
 * dashboard)" against **one SQLite file**. That invariant is a filesystem fact, not a
 * configuration choice. Two Fly machines cannot share a volume, so splitting the two
 * across machines does not deploy this architecture — it silently replaces it with a
 * dashboard reading an empty database, which is exactly the failure that shipped
 * locally on 2026-08-14 and rendered a confident empty screen.
 *
 * So: one machine, one volume, one process tree. That costs one supervisor, which is
 * this file.
 *
 * ## Why not a supervisor package
 *
 * `THREAT-MODEL.md` §T-5 counts a dependency as a cost, and this project already
 * writes its own thirty-line dotenv parser on that reasoning. `s6-overlay` and
 * `supervisord` are both larger than the problem: two children, restart on exit,
 * forward signals, give up loudly rather than hot-loop.
 *
 * ## What it deliberately does not do
 *
 * It does not restart forever. `MAX_RESTARTS` crashes within `CRASH_WINDOW_MS` exits
 * the supervisor, which lets Fly's machine restart policy take over and — crucially —
 * makes the failure **visible** as a machine restart rather than invisible as a child
 * that respawns every two seconds for a week. A supervisor that hides a crash loop is
 * worse than no supervisor: the system looks up and detects nothing.
 */

type Managed = {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  child?: ChildProcess;
  crashes: number[];
};

/** Restarts allowed inside the window before the supervisor gives up. */
const MAX_RESTARTS = 5;
const CRASH_WINDOW_MS = 60_000;
const RESTART_DELAY_MS = 2_000;

const ROOT = process.env.SIGNAL_DESK_ROOT ?? '/app';

const MANAGED: Managed[] = [
  {
    name: 'worker',
    command: process.execPath,
    args: [`${ROOT}/apps/worker/dist/index.js`],
    cwd: ROOT,
    crashes: [],
  },
  {
    name: 'dashboard',
    command: process.execPath,
    args: [`${ROOT}/apps/web/node_modules/next/dist/bin/next`, 'start'],
    cwd: `${ROOT}/apps/web`,
    crashes: [],
  },
];

/**
 * The stages that turn ingested bytes into events, in order.
 *
 * ### The gap this closes — 2026-08-14
 *
 * The long-lived worker **only ingests.** `apps/worker/src/scheduler.ts` runs
 * `ingestOnce` on a cron and nothing else; clustering, scoring, and analysis have
 * always been `pnpm cluster`, `pnpm score`, `pnpm analyze` — commands a human runs.
 * That was invisible while the operator ran them by hand at his machine, and it is
 * fatal the moment the worker is supposed to be autonomous: the first hour on Fly
 * ingested **5,196 raw items and produced zero events**, and the dashboard reported
 * "Nothing has cleared the gate" — which is the correct rendering of a pipeline that
 * was never asked to run.
 *
 * They run here rather than inside the scheduler because the orchestration for each
 * stage lives in its CLI, not in a reusable function. Spawning the CLIs keeps **one**
 * implementation of each stage — the one the operator runs locally and the one the
 * tests cover. Re-implementing them inside the scheduler would create a second copy
 * that drifts, which is precisely the defect Phase 11 found (`strategyFromScore`
 * reimplemented in three callers, the third already wrong).
 *
 * Sequential and non-overlapping: `score` depends on `cluster` having run, `analyze`
 * on `score`. A failure stops the chain for that cycle and logs it; the next cycle
 * retries from the top, which is safe because every stage is idempotent over what it
 * has already processed.
 *
 * **Spend:** only `analyze` costs money, and it is bounded by `AI_DAILY_BUDGET_USD`
 * ($2/day) and the rule gate, which measured at a 98.7% kill rate. The one full pass
 * over 65 gate survivors cost $0.70. This is not an unmetered loop.
 */
const PIPELINE_STAGES = ['cluster', 'score', 'analyze'] as const;

/** How often the pipeline runs. Ingestion polls far more often; events are slower. */
const PIPELINE_INTERVAL_MS =
  Number(process.env.PIPELINE_INTERVAL_MINUTES ?? '20') * 60_000 || 20 * 60_000;

/** Delay before the first run, so ingestion has something for it to work on. */
const PIPELINE_FIRST_RUN_MS = 3 * 60_000;

let pipelineRunning = false;

function runPipelineStage(stage: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [`${ROOT}/apps/worker/dist/cli/${stage}.js`], {
      cwd: ROOT,
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
    });
    child.on('exit', (code) => {
      resolve(code ?? 1);
    });
    child.on('error', () => {
      resolve(1);
    });
  });
}

async function runPipeline(): Promise<void> {
  if (pipelineRunning || shuttingDown) return;
  pipelineRunning = true;
  const started = Date.now();

  try {
    for (const stage of PIPELINE_STAGES) {
      const code = await runPipelineStage(stage);
      if (code !== 0) {
        log(`pipeline stage "${stage}" exited ${code} — stopping this cycle, will retry next`);
        return;
      }
      if (shuttingDown) return;
    }
    log(`pipeline complete in ${Math.round((Date.now() - started) / 1000)}s`);
  } finally {
    pipelineRunning = false;
  }
}

let shuttingDown = false;

function log(message: string): void {
  // Plain stdout, not pino: this process owns no config and must be able to say
  // "the worker will not start" even when the reason is that config failed to parse.
  process.stdout.write(
    `${JSON.stringify({ supervisor: message, at: new Date().toISOString() })}\n`,
  );
}

function start(managed: Managed): void {
  if (shuttingDown) return;

  const child = spawn(managed.command, [...managed.args], {
    cwd: managed.cwd,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: process.env,
  });
  managed.child = child;
  log(`${managed.name} started, pid ${child.pid ?? -1}`);

  child.on('exit', (code, signal) => {
    if (shuttingDown) return;

    log(`${managed.name} exited code=${String(code)} signal=${String(signal)}`);

    const now = Date.now();
    managed.crashes = managed.crashes.filter((at) => now - at < CRASH_WINDOW_MS);
    managed.crashes.push(now);

    if (managed.crashes.length > MAX_RESTARTS) {
      log(
        `${managed.name} crashed ${managed.crashes.length} times in ${CRASH_WINDOW_MS / 1000}s — ` +
          `giving up so the platform restarts the machine and the failure is visible`,
      );
      shutdown('crash-loop', 1);
      return;
    }

    setTimeout(() => {
      start(managed);
    }, RESTART_DELAY_MS);
  });

  child.on('error', (error) => {
    log(`${managed.name} failed to spawn: ${error.message}`);
  });
}

function shutdown(reason: string, exitCode: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`shutting down: ${reason}`);

  for (const managed of MANAGED) {
    managed.child?.kill('SIGTERM');
  }

  // The worker's own SIGTERM handler checkpoints WAL and closes the database. Give it
  // room to finish; a SIGKILL mid-write is how a -wal file outlives its database.
  const deadline = setTimeout(() => {
    log('children did not exit within 15s — sending SIGKILL');
    for (const managed of MANAGED) managed.child?.kill('SIGKILL');
    process.exit(exitCode);
  }, 15_000);
  deadline.unref();

  const poll = setInterval(() => {
    if (MANAGED.every((managed) => managed.child?.exitCode !== null)) {
      clearInterval(poll);
      log('all children exited');
      process.exit(exitCode);
    }
  }, 250);
}

process.on('SIGTERM', () => {
  shutdown('SIGTERM', 0);
});
process.on('SIGINT', () => {
  shutdown('SIGINT', 0);
});

for (const managed of MANAGED) start(managed);

// Ingestion is already running by the time the first pipeline cycle fires.
setTimeout(() => {
  void runPipeline();
  setInterval(() => {
    void runPipeline();
  }, PIPELINE_INTERVAL_MS).unref();
}, PIPELINE_FIRST_RUN_MS).unref();

log(
  `pipeline scheduled: ${PIPELINE_STAGES.join(' → ')} every ` +
    `${Math.round(PIPELINE_INTERVAL_MS / 60_000)} minutes, first run in ` +
    `${Math.round(PIPELINE_FIRST_RUN_MS / 60_000)} minutes`,
);
