import { Cron } from 'croner';
import type { Logger } from '@signal-desk/shared';
import { ingestOnce, type IngestOptions, type IngestRunSummary } from './ingest.js';

/**
 * The in-process scheduler. ARCHITECTURE.md §2:
 *
 *   "The worker is already a long-lived process. An external scheduler would be a
 *    service to operate for no gain."
 *
 * **One tick, not one cron per source.** The tick runs every 60 seconds and asks
 * each source whether it is due, rather than registering 60 separate cron jobs. Two
 * reasons, and the second is the load-bearing one:
 *
 *  1. Per-source intervals are data. A source whose interval changes must not need a
 *     job to be unregistered and re-registered.
 *  2. Due-ness is computed from `lastCheckedAt`, which is **persisted**. A worker
 *     that restarts therefore resumes where it left off instead of re-fetching
 *     everything — which is what sixty in-memory cron jobs would do on every deploy,
 *     turning a restart into a burst against every publisher at once.
 *
 * The jitter that keeps sources from firing in lockstep lives in `isDue`, applied
 * per source per tick (`resilience.ts`).
 */

/**
 * How often to check what is due.
 *
 * Not the poll interval — that is per source, from the registry. This is the
 * granularity at which "is anything due?" is asked. Sixty seconds is well under the
 * shortest interval in the registry (Priority 1, five minutes), so it costs nothing
 * in latency, and it means an idle tick is a single indexed read.
 */
export const TICK_SECONDS = 60;

export type SchedulerOptions = IngestOptions & {
  readonly logger: Logger;
  /** Overridden in tests. */
  readonly tickSeconds?: number;
  /** Called after every tick that fetched something. */
  readonly onRun?: (summary: IngestRunSummary) => void;
};

export type Scheduler = {
  start(): void;
  stop(): Promise<void>;
  /** Run one tick immediately, awaiting completion. For tests and `ingest:once`. */
  tick(): Promise<IngestRunSummary>;
  readonly running: boolean;
};

export function createScheduler(options: SchedulerOptions): Scheduler {
  const tickSeconds = options.tickSeconds ?? TICK_SECONDS;
  let job: Cron | undefined;
  let inFlight: Promise<IngestRunSummary> | undefined;
  let stopped = false;

  /**
   * Ticks never overlap.
   *
   * A slow tick — sixty sources, several of them timing out at 20s — can outlast the
   * next scheduled one. Letting those overlap would double the request rate against
   * exactly the hosts that are already struggling, which is how a polite client gets
   * itself blocked (§T-8).
   */
  const runTick = async (): Promise<IngestRunSummary> => {
    if (inFlight !== undefined) {
      options.logger.warn('previous ingest tick is still running; skipping this one');
      return inFlight;
    }

    inFlight = ingestOnce(options)
      .then((summary) => {
        if (summary.fetched > 0) {
          options.logger.info(
            {
              considered: summary.considered,
              fetched: summary.fetched,
              not_modified: summary.notModified,
              items_found: summary.itemsFound,
              items_new: summary.itemsNew,
              failures: summary.failures,
              skipped_circuit_open: summary.skippedCircuitOpen,
              duration_ms: summary.durationMs,
            },
            'ingest tick complete',
          );
          options.onRun?.(summary);
        }
        return summary;
      })
      .finally(() => {
        inFlight = undefined;
      });

    return inFlight;
  };

  return {
    get running() {
      return job !== undefined && !stopped;
    },

    start() {
      if (job !== undefined) return;
      stopped = false;

      job = new Cron(`*/${String(tickSeconds)} * * * * *`, { protect: true }, () => {
        void runTick().catch((error: unknown) => {
          // A thrown tick must never kill the scheduler. The next one may succeed,
          // and a worker that silently stopped polling is the T-9 failure.
          options.logger.error(
            { err: error instanceof Error ? error : new Error(String(error)) },
            'ingest tick threw',
          );
        });
      });

      options.logger.info(
        { tick_seconds: tickSeconds, mode: options.registry.mode },
        'scheduler started',
      );
    },

    async stop() {
      stopped = true;
      job?.stop();
      job = undefined;
      // Let an in-flight tick finish rather than tearing the database out from under
      // it mid-transaction.
      if (inFlight !== undefined) await inFlight.catch(() => undefined);
      options.logger.info('scheduler stopped');
    },

    tick: runTick,
  };
}
