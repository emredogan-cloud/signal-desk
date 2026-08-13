import {
  openDatabase,
  runMigrations,
  seedAll,
  MIGRATIONS_FOLDER,
  eventsAwaitingAnalysis,
  envelopeItemsFor,
  eventForAnalysis,
  insertAnalyses,
  spendSince,
  spendBreakdown,
  countAnalyses,
  clearAnalyses,
  type AnalysisInsert,
} from '@signal-desk/db';
import {
  analyseEvent,
  createClient,
  budgetState,
  TRIAGE_PROMPT_VERSION,
  type EngineConfig,
  type EngineResult,
} from '@signal-desk/ai';
import { ConfigError } from '@signal-desk/shared';
import { bootstrap } from '../bootstrap.js';
import { renderTable } from '../table.js';

/**
 * `pnpm analyze` — run triage and analysis over gate survivors.
 *
 * Honest about mode. In MOCK it says so on every line; in LIVE it reports measured
 * cost and whether the prompt cache actually hit, because ROADMAP.md Phase 6 requires
 * `cache_read_input_tokens > 0` to be **verified**, not assumed.
 */

function startOfDay(now: Date): Date {
  const day = new Date(now);
  day.setUTCHours(0, 0, 0, 0);
  return day;
}

function toRows(result: EngineResult): AnalysisInsert[] {
  const rows: AnalysisInsert[] = [];
  const triage = result.triage;
  rows.push({
    eventId: result.eventId,
    stage: 'triage',
    status: triage.status,
    reason: triage.reason,
    skipCode: triage.skipCode ?? null,
    payload: triage.value ?? triage.rejectedRaw ?? null,
    confidence: null,
    recommendedAction: null,
    injectionObserved: triage.value?.injectionObserved ?? false,
    model: triage.model,
    promptVersion: triage.promptVersion,
    inputTokens: triage.usage.inputTokens,
    outputTokens: triage.usage.outputTokens,
    cacheReadTokens: triage.usage.cacheReadTokens,
    cacheWriteTokens: triage.usage.cacheWriteTokens,
    costUsd: triage.costUsd,
  });

  const analysis = result.analysis;
  rows.push({
    eventId: result.eventId,
    stage: 'analysis',
    status: analysis.status,
    reason: analysis.reason,
    skipCode: analysis.skipCode ?? null,
    payload: analysis.value ?? analysis.rejectedRaw ?? null,
    confidence: analysis.value?.confidence ?? null,
    recommendedAction: analysis.value?.recommendedAction ?? null,
    injectionObserved: analysis.value?.injectionObserved ?? false,
    model: analysis.model,
    promptVersion: analysis.promptVersion,
    inputTokens: analysis.usage.inputTokens,
    outputTokens: analysis.usage.outputTokens,
    cacheReadTokens: analysis.usage.cacheReadTokens,
    cacheWriteTokens: analysis.usage.cacheWriteTokens,
    costUsd: analysis.costUsd,
  });
  return rows;
}

async function main(): Promise<number> {
  const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
  const limit = limitArg === undefined ? 50 : Number(limitArg.slice('--limit='.length));
  const reset = process.argv.includes('--reset');

  let boot;
  try {
    boot = bootstrap({ loggerName: 'analyze' });
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`\n${error.message}\n`);
      return 1;
    }
    throw error;
  }

  const { config, modes } = boot;
  const handle = openDatabase({ url: config.DATABASE_URL });

  try {
    runMigrations(handle, MIGRATIONS_FOLDER);
    seedAll(handle.db);

    if (reset) {
      console.log('\n--reset: discarding stored analyses');
      clearAnalyses(handle.db);
    }

    const aiMode = modes.aiMode;
    const engineConfig: EngineConfig = {
      mode: aiMode,
      client:
        aiMode === 'LIVE' && config.ANTHROPIC_API_KEY !== undefined
          ? createClient(config.ANTHROPIC_API_KEY)
          : undefined,
      triageModel: config.AI_TRIAGE_MODEL,
      analysisModel: config.AI_ANALYSIS_MODEL,
      dailyBudgetUsd: config.AI_DAILY_BUDGET_USD,
      analysisThreshold: config.AI_ANALYSIS_THRESHOLD,
    };

    console.log(`\nAI_MODE=${aiMode}`);
    if (aiMode === 'MOCK') {
      console.log('  No model will be called. Output is a deterministic placeholder,');
      console.log('  marked [MOCK] in every field. It proves the pipeline runs, not that');
      console.log('  the analysis is any good — that needs ANTHROPIC_API_KEY.');
    } else {
      console.log(`  triage:   ${engineConfig.triageModel}`);
      console.log(
        `  analysis: ${engineConfig.analysisModel} (above score ${String(engineConfig.analysisThreshold)})`,
      );
      console.log(`  budget:   $${engineConfig.dailyBudgetUsd.toFixed(2)}/day`);
    }

    const now = new Date();
    const dayStart = startOfDay(now);
    let spent = spendSince(handle.db, dayStart);
    console.log(
      `  spent today: $${spent.toFixed(4)} — state ${budgetState(spent, engineConfig.dailyBudgetUsd)}\n`,
    );

    const queue = eventsAwaitingAnalysis(handle.db, TRIAGE_PROMPT_VERSION, limit);
    if (queue.length === 0) {
      console.log(
        'nothing to analyse: every gate survivor already has a verdict under this prompt version\n',
      );
      return 0;
    }
    console.log(`${String(queue.length)} event(s) awaiting analysis\n`);

    const rows: AnalysisInsert[] = [];
    let analysed = 0;
    let cacheHits = 0;
    let cacheEligible = 0;

    for (const entry of queue) {
      const event = eventForAnalysis(handle.db, entry.eventId);
      if (event === undefined) continue;
      const items = envelopeItemsFor(handle.db, entry.eventId);

      const result = await analyseEvent(
        engineConfig,
        {
          eventId: event.id,
          title: event.title,
          summary: event.summary,
          combinedScore: entry.combined,
          items: items.map(({ isOfficial: _ignored, ...rest }) => rest),
          hasOfficialSource: items.some((item) => item.isOfficial),
        },
        spent,
      );

      rows.push(...toRows(result));
      spent += result.totalCostUsd;
      analysed += 1;
      // Count EVERY stage that actually issued a request, not just successful deep
      // analyses. The first live run reported "0 successful calls — too few to
      // demonstrate a hit" while the ledger showed 8,764 cache-read tokens, because
      // this only looked at the analysis stage and every analysis had been skipped.
      //
      // MOCK runs are excluded: letting a credential-free CI run "prove" the cache
      // works would be exactly the fabricated-result failure the project forbids.
      if (aiMode === 'LIVE') {
        for (const stage of [result.triage, result.analysis]) {
          if (stage.status === 'skipped') continue;
          cacheEligible += 1;
          if (stage.usage.cacheReadTokens > 0) cacheHits += 1;
        }
      }
    }

    insertAnalyses(handle.db, rows, now);

    console.log(`analysed ${String(analysed)} event(s), ${String(rows.length)} row(s) stored\n`);

    // ─── Report WHY deep analysis did not happen, grouped.
    //
    // The first real run skipped 100% of deep analysis and each event said so in its
    // own reason — but nobody reads 65 reasons, and a tier that is unreachable by
    // construction looks exactly like a system correctly finding nothing worth
    // analysing. Grouping the reasons makes the difference visible in one line.
    const deepRows = rows.filter((row) => row.stage === 'analysis');
    const attempted = deepRows.filter((row) => row.status !== 'skipped').length;

    if (attempted === 0 && deepRows.length > 0) {
      const grouped = new Map<string, number>();
      for (const row of deepRows) {
        grouped.set(row.skipCode ?? 'unknown', (grouped.get(row.skipCode ?? 'unknown') ?? 0) + 1);
      }

      console.log('⚠️  NO event reached deep analysis in this run. Why:');
      for (const [rule, count] of [...grouped].sort((a, b) => b[1] - a[1])) {
        console.log(`      ${String(count).padStart(4)}  ${rule}`);
      }
      if ((grouped.get('below_threshold') ?? 0) > 0) {
        console.log('');
        console.log('    If the threshold keeps swallowing everything, it and the Phase 5 score');
        console.log('    scale are miscalibrated against each other — not a bug in either alone.');
      }
      console.log('');
    }

    const breakdown = spendBreakdown(handle.db, dayStart);
    if (breakdown.length > 0) {
      console.log('SPEND TODAY');
      console.log(
        renderTable(
          ['STAGE', 'MODEL', 'CALLS SENT', 'SKIPPED', 'COST USD', 'CACHE READ TOK'],
          breakdown.map((row) => [
            row.stage,
            row.model,
            String(row.calls),
            String(row.skipped),
            `$${row.costUsd.toFixed(4)}`,
            String(row.cacheReads),
          ]),
          ['left', 'left', 'right', 'right', 'right', 'right'],
        ),
      );
      console.log('');
    }

    if (aiMode === 'LIVE') {
      // ROADMAP.md Phase 6 acceptance: "Prompt cache demonstrably hits
      // (cache_read_input_tokens > 0 on the second call of a run)". Reported as a
      // measurement, never asserted.
      console.log('PROMPT CACHE');
      if (cacheEligible < 2) {
        console.log(
          `  ${String(cacheEligible)} successful call(s) — too few to demonstrate a hit; a cache read needs a second call.`,
        );
      } else {
        console.log(
          `  ${String(cacheHits)}/${String(cacheEligible)} successful call(s) read from cache`,
        );
        console.log(
          cacheHits > 0
            ? '  ✅ cache_read_input_tokens > 0 — the prefix is caching'
            : "  ⚠️  NO cache reads. Below the model's minimum prefix, or a silent invalidator in the prefix.",
        );
      }
      console.log('');
    } else {
      console.log('PROMPT CACHE: not measurable in MOCK mode — no model was called.\n');
    }

    console.log(`total stored analyses: ${String(countAnalyses(handle.db))}\n`);
    return 0;
  } finally {
    handle.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
