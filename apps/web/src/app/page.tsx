import { parseConfig, deriveEffectiveModes, isAnyModeMocked } from '@signal-desk/shared';

/**
 * Phase 1 placeholder.
 *
 * There is no dashboard yet — that is Phase 10. What this page does carry already is
 * the MOCK badge, because ARCHITECTURE.md §8 makes it a safety control rather than a
 * developer convenience: "A mock analysis that looks real on screen is how an
 * operator ends up posting a fabricated claim." Shipping the badge before there is
 * anything to mislabel is the cheap way to guarantee it is never retrofitted.
 */
export default function HomePage() {
  const config = parseConfig(process.env);
  const modes = deriveEffectiveModes(config);
  const mocked = isAnyModeMocked(modes);

  return (
    <main>
      {mocked && (
        <div className="mock-badge" role="status">
          MOCK MODE — DATA {modes.dataMode} · AI {modes.aiMode} · X {modes.xMode}
        </div>
      )}

      <h1>signal-desk</h1>
      <p className="tagline">
        Real-time AI, software, and technology intelligence for one technical operator.
      </p>

      <h2>What exists right now</h2>
      <p>
        Phase 1 of 15. This is repository scaffolding and nothing else: configuration parsing, the
        database layer, the test and lint pipeline, and CI. There is no ingestion, no scoring, and
        no analysis. This page is a placeholder that proves the build works.
      </p>

      <h2>Current state</h2>
      <dl className="status">
        <dt>DATA_MODE</dt>
        <dd>{modes.dataMode}</dd>
        <dt>AI_MODE</dt>
        <dd>{modes.aiMode}</dd>
        <dt>X_MODE</dt>
        <dd>{modes.xMode}</dd>
        <dt>Publishing</dt>
        <dd>
          {modes.postingEnabled ? 'enabled (human confirmation required per post)' : 'disabled'}
        </dd>
        <dt>Degraded</dt>
        <dd>
          {modes.degradations.length === 0 ? 'none' : `${modes.degradations.length} subsystem(s)`}
        </dd>
      </dl>

      <h2>Next</h2>
      <ul>
        <li>Phase 2 — source registry, entity registry, probe tooling</li>
        <li>Phase 3 — ingestion adapters</li>
        <li>Phase 4 — normalisation and deduplication</li>
      </ul>
      <p>
        Run <code>pnpm check:env</code> for the full configuration table. See{' '}
        <code>docs/ROADMAP.md</code> for the plan.
      </p>
    </main>
  );
}
