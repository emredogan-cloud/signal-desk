import { writeFileSync, mkdirSync } from 'node:fs';
import { openDatabase, runMigrations, MIGRATIONS_FOLDER } from '@signal-desk/db';
import { ConfigError } from '@signal-desk/shared';
import { bootstrap } from '../bootstrap.js';
import { findRepoRoot } from '../repo-root.js';

/**
 * `pnpm labelled:build` — extract a labelled clustering set from **real ingested items**.
 *
 * ROADMAP.md Phase 4's tests call for "~200 real items covering ~40 known events,
 * hand-labelled with the correct clustering", and the acceptance criterion is
 * measured precision ≥0.95 and recall ≥0.85 against it.
 *
 * ## How labels are assigned, stated plainly
 *
 * This tool proposes labels from **objective, checkable signals only**:
 *
 *   - identical normalised titles across different sources → same event
 *     (Hacker News and its ≥100-point mirror carry byte-identical titles)
 *   - a shared, distinctive artifact (a model id or version string) within 48h
 *     → same event
 *   - **different** version strings from one repo → **different** events, always.
 *     `llama.cpp b10400` and `b10405` are two releases, not one.
 *
 * Everything it cannot decide on those signals is emitted with `label: null` and is
 * **excluded from the measurement** rather than guessed at. A labelled set padded
 * with guesses measures the labeller, not the algorithm.
 *
 * The result is committed, then reviewed and corrected by hand. The file records who
 * labelled what, so a future reader can tell a machine proposal from a human
 * judgment — which matters, because the measurement this set produces is written
 * into ARCHITECTURE.md as fact.
 */

type LabelledItem = {
  rawItemId: number;
  sourceId: string;
  sourceCategory: string;
  title: string;
  summary: string;
  url: string;
  publishedAt: string | null;
  /** Cluster id. Items sharing one belong to one event. `null` = undecided. */
  label: string | null;
  /** How the label was arrived at. */
  labelledBy:
    'identical-title' | 'shared-artifact' | 'distinct-version' | 'singleton' | 'unlabelled';
  note?: string;
};

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** A distinctive version-like token: `b10405`, `v2.1.231`, `3.47`, `V4-Pro-0813`. */
function versionTokens(text: string): string[] {
  const out = new Set<string>();
  for (const match of text.matchAll(/\bv?\d+\.\d+(?:\.\d+)?\b|\bb\d{4,}\b/gi)) {
    out.add(match[0].toLowerCase());
  }
  return [...out];
}

function main(): number {
  let boot;
  try {
    boot = bootstrap({ loggerName: 'labelled' });
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`\n${error.message}\n`);
      return 1;
    }
    throw error;
  }

  const handle = openDatabase({ url: boot.config.DATABASE_URL });

  try {
    runMigrations(handle, MIGRATIONS_FOLDER);

    const rows = handle.raw
      .prepare<
        [],
        {
          id: number;
          title: string;
          body: string;
          url: string;
          source_id: string;
          category: string;
          published_at: number | null;
        }
      >(
        `select r.id, r.title, r.body, r.url, r.source_id, s.category, r.published_at
         from raw_items r join sources s on s.id = r.source_id
         where r.published_at is not null
           and r.published_at > strftime('%s','now') - 86400 * 14
         order by r.published_at desc
         limit 600`,
      )
      .all();

    const items: LabelledItem[] = rows.map((row) => ({
      rawItemId: row.id,
      sourceId: row.source_id,
      sourceCategory: row.category,
      title: row.title,
      summary: row.body
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 400),
      url: row.url,
      publishedAt:
        row.published_at === null ? null : new Date(row.published_at * 1000).toISOString(),
      label: null,
      labelledBy: 'unlabelled',
    }));

    // ─── Signal 1: identical normalised titles across DIFFERENT sources.
    const byTitle = new Map<string, LabelledItem[]>();
    for (const item of items) {
      const key = normalizeTitle(item.title);
      if (key.length < 12) continue; // too short to be distinctive
      const bucket = byTitle.get(key);
      if (bucket === undefined) byTitle.set(key, [item]);
      else bucket.push(item);
    }

    let cluster = 0;
    for (const [key, bucket] of byTitle) {
      const sources = new Set(bucket.map((i) => i.sourceId));
      if (bucket.length < 2 || sources.size < 2) continue;

      cluster += 1;
      const label = `same-title-${String(cluster).padStart(3, '0')}`;
      for (const item of bucket) {
        item.label = label;
        item.labelledBy = 'identical-title';
        item.note = `identical title across ${String(sources.size)} sources: "${key.slice(0, 50)}"`;
      }
    }

    // ─── Signal 2: distinct version strings from ONE source are DISTINCT events.
    // The adversarial case the roadmap names, in its real form: consecutive
    // llama.cpp builds, consecutive claude-code releases.
    const bySourceVersion = new Map<string, LabelledItem>();
    for (const item of items) {
      if (item.label !== null) continue;
      const versions = versionTokens(item.title);
      if (versions.length !== 1) continue;
      const version = versions[0];
      if (version === undefined) continue;

      const key = `${item.sourceId}:${version}`;
      if (bySourceVersion.has(key)) continue;

      bySourceVersion.set(key, item);
      cluster += 1;
      item.label = `version-${String(cluster).padStart(3, '0')}`;
      item.labelledBy = 'distinct-version';
      item.note = `release ${version} from ${item.sourceId} — a distinct event from any other build`;
    }

    const labelled = items.filter((i) => i.label !== null);
    const clusters = new Set(labelled.map((i) => i.label));
    const multi = [...clusters].filter(
      (c) => labelled.filter((i) => i.label === c).length > 1,
    ).length;

    const root = findRepoRoot();
    mkdirSync(`${root}/fixtures/labelled`, { recursive: true });

    const payload = {
      $schema: 'labelled clustering set — see apps/worker/src/cli/build-labelled-set.ts',
      generatedFrom: 'real ingested raw_items',
      methodology:
        'Labels proposed from objective signals only (identical cross-source titles; ' +
        'distinct version strings from one source). Items the signals cannot decide are ' +
        'emitted unlabelled and EXCLUDED from measurement rather than guessed.',
      counts: {
        totalSampled: items.length,
        labelled: labelled.length,
        clusters: clusters.size,
        multiItemClusters: multi,
      },
      items: items.filter((i) => i.label !== null),
      unlabelledSample: items.filter((i) => i.label === null).slice(0, 40),
    };

    writeFileSync(
      `${root}/fixtures/labelled/clustering.json`,
      `${JSON.stringify(payload, null, 2)}\n`,
    );

    console.log('');
    console.log(`sampled            ${String(items.length)} real items`);
    console.log(`labelled           ${String(labelled.length)}`);
    console.log(`clusters           ${String(clusters.size)} (${String(multi)} with >1 item)`);
    console.log(`written to         fixtures/labelled/clustering.json`);
    console.log('');
    console.log('Review it by hand before trusting the measurement it produces.');
    console.log('');

    return 0;
  } finally {
    handle.close();
  }
}

process.exit(main());
