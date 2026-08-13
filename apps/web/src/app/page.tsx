import { modes, stream, health, trendCards, schemaReady } from '../lib/data';
import { MockBadge } from '../components/mock-badge';

/**
 * The dashboard. `ROADMAP.md` Phase 10.
 *
 * > **OBJECTIVE** The interface that makes the whole system usable in the 15 minutes
 * > the operator has.
 *
 * ## The 60-second constraint drives the layout
 *
 * The acceptance criterion is "operator can go from opening the dashboard to a decided
 * action in **under 60 seconds** for the top event". That rules out a design where the
 * recommendation is a click away: the top event's decision — the action, the option,
 * and the reasoning — is above the fold on the first render, and everything else is
 * progressive detail below it.
 *
 * `<details>` elements carry the breakdowns rather than JavaScript toggles, because a
 * strict CSP with no `unsafe-inline` is part of the same phase and native disclosure
 * needs no script at all.
 *
 * Server components throughout, with no `'use client'` anywhere. Next still ships its
 * own runtime — the served page carries eight script tags — so the accurate claim is
 * narrower than "no JavaScript": **none of the shipped script is ours, and none of it
 * is inline**, which is what lets the CSP omit `unsafe-inline` and a nonce pipeline.
 */

export const dynamic = 'force-dynamic';

type Mode = 'brief' | 'live' | 'eod';

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = params.mode;
  const mode: Mode = raw === 'live' ? 'live' : raw === 'eod' ? 'eod' : 'brief';

  const effective = modes();
  const ready = schemaReady();
  const rows = stream(mode === 'brief' ? 5 : 40);
  const stats = health();
  const trends = trendCards();

  const actionable = rows.filter(
    (row) =>
      row.strategy.recommendation.action === 'POST_NOW' ||
      row.strategy.recommendation.action === 'POST_SOON',
  );
  const top = actionable[0] ?? rows[0];
  const flagged = rows.filter((row) => row.strategy.recommendation.manualFlag);

  return (
    <main>
      <MockBadge modes={effective} />

      <nav className="modes" aria-label="Dashboard mode">
        <a href="/?mode=brief" aria-current={mode === 'brief' ? 'page' : undefined}>
          MORNING BRIEF
        </a>
        <a href="/?mode=live" aria-current={mode === 'live' ? 'page' : undefined}>
          LIVE
        </a>
        <a href="/?mode=eod" aria-current={mode === 'eod' ? 'page' : undefined}>
          END OF DAY
        </a>
      </nav>

      {/* ── The dashboard does not migrate; the worker owns the schema. Saying so is
             better than a raw SQLite error, which is what the first run produced. */}
      {!ready && (
        <section className="empty" role="alert">
          <h1>The database has no schema yet.</h1>
          <p>
            The dashboard reads; the worker writes and owns migrations. Run <code>pnpm ingest</code>
            , then <code>pnpm score</code>, then reload.
          </p>
        </section>
      )}

      {/* ── The decision, first. This is the 60-second path. */}
      {top === undefined ? (
        <section className="empty">
          <h1>Nothing has cleared the gate.</h1>
          <p>
            Ingestion, clustering, scoring, and the rule gate all ran. No event passed. That is a
            result, not an error — the health panel below shows whether the sources are alive.
          </p>
        </section>
      ) : (
        <section className="decision" aria-labelledby="decision-heading">
          <h1 id="decision-heading">
            <span className={`action action-${top.strategy.recommendation.action.toLowerCase()}`}>
              {top.strategy.recommendation.action.replace('_', ' ')}
            </span>{' '}
            {top.title}
          </h1>

          <p className="reasoning">{top.strategy.recommendation.reasoning}</p>

          <dl className="panel">
            <dt>WHY NOW</dt>
            <dd>{top.strategy.panel.whyNow}</dd>
            <dt>WHY ME</dt>
            <dd>{top.strategy.panel.whyMe}</dd>
            <dt>WHAT CAN I ADD</dt>
            <dd>{top.strategy.panel.whatCanIAdd}</dd>
            <dt>EXPECTED OUTCOME</dt>
            <dd>{top.strategy.panel.expectedOutcome}</dd>
          </dl>

          {top.strategy.doNotSay.length > 0 && (
            <div className="do-not-say">
              <h2>DO NOT SAY</h2>
              <ul>
                {top.strategy.doNotSay.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          )}

          <details>
            <summary>All five options</summary>
            <ul className="options">
              {top.strategy.options.map((option) => (
                <li key={option.kind}>
                  <strong>{option.kind}</strong>{' '}
                  <span className="fit">{option.fit.toFixed(2)}</span>
                  <p>{option.approach}</p>
                  <p className="muted">{option.rationale}</p>
                </li>
              ))}
            </ul>
          </details>

          <details>
            <summary>
              Score breakdown — importance {top.importance}, relevance {top.brandRelevance},
              combined {top.combined}, confidence {top.confidence}
            </summary>
            <ScoreBreakdown breakdown={top.breakdown} caps={top.caps} />
          </details>
        </section>
      )}

      {/* ── Health. Positioned high because a dead source must be noticed
             WITHOUT being looked for (Phase 10 acceptance). */}
      <section
        className={stats.deadSources > 0 ? 'health health-alarm' : 'health'}
        aria-labelledby="health-heading"
      >
        <h2 id="health-heading">
          HEALTH
          {stats.deadSources > 0 && (
            <span className="alarm" role="alert">
              {stats.deadSources} SOURCE{stats.deadSources === 1 ? '' : 'S'} SILENT &gt;48h
            </span>
          )}
        </h2>
        <dl className="metrics">
          <div>
            <dt>gate kill rate</dt>
            <dd>
              {pct(stats.gate.killRate)}{' '}
              <span className="muted">({pct(stats.gate.inWindowKillRate)} in-window)</span>
            </dd>
          </div>
          <div>
            <dt>cost today</dt>
            <dd>${stats.costTodayUsd.toFixed(4)}</dd>
          </div>
          <div>
            <dt>calls today</dt>
            <dd>{stats.callsToday}</dd>
          </div>
          <div>
            <dt>cache reads</dt>
            <dd>
              {stats.cacheReadTokens === 0 && stats.callsToday > 1 ? (
                <span className="alarm">0 — prefix not caching</span>
              ) : (
                `${stats.cacheReadTokens} tok`
              )}
            </dd>
          </div>
          <div>
            <dt>events past gate</dt>
            <dd>
              {stats.gate.total - stats.gate.killed} of {stats.gate.total}
            </dd>
          </div>
        </dl>

        <details>
          <summary>Source freshness ({stats.sources.length} active)</summary>
          <table>
            <thead>
              <tr>
                <th scope="col">source</th>
                <th scope="col">last success</th>
                <th scope="col">failures</th>
              </tr>
            </thead>
            <tbody>
              {stats.sources.map((source) => {
                const dead = source.hoursSinceSuccess === null || source.hoursSinceSuccess > 48;
                return (
                  <tr key={source.id} className={dead ? 'dead' : undefined}>
                    <td>{source.id}</td>
                    <td>
                      {source.hoursSinceSuccess === null
                        ? 'never'
                        : `${source.hoursSinceSuccess.toFixed(1)}h ago`}
                    </td>
                    <td>{source.consecutiveFailures}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </details>
      </section>

      {/* ── Suspicious content. THREAT-MODEL §T-1 mitigation 6: flagged content is
             surfaced, never silently dropped. */}
      {flagged.length > 0 && (
        <section className="suspicious" aria-labelledby="suspicious-heading">
          <h2 id="suspicious-heading">SUSPICIOUS CONTENT ({flagged.length})</h2>
          <p className="muted">
            Flagged and kept, not dropped. A filter the operator cannot inspect is one he cannot
            trust.
          </p>
          <ul>
            {flagged.map((row) => (
              <li key={row.eventId}>
                {row.title}
                <p className="muted">{row.strategy.recommendation.forcing.reason}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ── The stream. */}
      <section className="stream" aria-labelledby="stream-heading">
        <h2 id="stream-heading">
          {mode === 'brief' ? 'TOP 5' : mode === 'eod' ? 'TODAY' : 'LIVE STREAM'} ({rows.length})
        </h2>
        <table>
          <thead>
            <tr>
              <th scope="col">action</th>
              <th scope="col">event</th>
              <th scope="col">cat</th>
              <th scope="col">imp</th>
              <th scope="col">rel</th>
              <th scope="col">conf</th>
              <th scope="col">src</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.eventId}>
                <td>
                  <span
                    className={`action action-${row.strategy.recommendation.action.toLowerCase()}`}
                  >
                    {row.strategy.recommendation.action.replace('_', ' ')}
                  </span>
                </td>
                <td>{row.title}</td>
                <td>{row.category}</td>
                <td className="num">{row.importance}</td>
                <td className="num">{row.brandRelevance}</td>
                <td>{row.confidence}</td>
                <td className="num">{row.distinctSourceCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {mode === 'eod' && (
        <section className="eod" aria-labelledby="eod-heading">
          <h2 id="eod-heading">END OF DAY</h2>
          <p>
            {rows.length} event(s) cleared the gate. {actionable.length} carried a publishable
            recommendation; {rows.length - actionable.length} did not, which is the system
            exercising judgment rather than failing to find anything.
          </p>
          <p className="muted">
            What was missed is not knowable from inside the system — that is what the Phase 12
            feedback loop is for.
          </p>
        </section>
      )}

      {trends.length > 0 && (
        <section className="trends" aria-labelledby="trends-heading">
          <h2 id="trends-heading">TRENDS ({trends.length})</h2>
          <ul>
            {trends.map((card) => (
              <li key={card.name}>
                <strong>{card.name}</strong> <span className="muted">{card.platform}</span>{' '}
                <span className={`stage stage-${card.lifecycle.stage.toLowerCase()}`}>
                  {card.lifecycle.stage}
                </span>{' '}
                → {card.lifecycle.decision}
                <p className="muted">{card.lifecycle.explanation}</p>
                {card.missing.length > 0 && (
                  <p className="muted">MISSING: {card.missing.join('; ')}</p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

/** Renders a stored score breakdown. Every component with its own explanation. */
function ScoreBreakdown({ breakdown, caps }: { breakdown: unknown; caps: string[] }) {
  const parsed = breakdown as Record<
    string,
    { name: string; value: number; weight: number; contribution: number; explanation: string }[]
  > | null;

  if (parsed === null) return <p className="muted">No stored breakdown.</p>;

  return (
    <>
      {caps.length > 0 && (
        <div className="caps">
          <strong>Caps applied:</strong>
          <ul>
            {caps.map((cap) => (
              <li key={cap}>{cap}</li>
            ))}
          </ul>
        </div>
      )}
      {Object.entries(parsed).map(([axis, components]) => (
        <div key={axis}>
          <h3>{axis}</h3>
          <table>
            <thead>
              <tr>
                <th scope="col">component</th>
                <th scope="col">value</th>
                <th scope="col">weight</th>
                <th scope="col">why</th>
              </tr>
            </thead>
            <tbody>
              {(components ?? []).map((component) => (
                <tr key={component.name}>
                  <td>{component.name}</td>
                  <td className="num">{component.value.toFixed(2)}</td>
                  <td className="num">{component.weight.toFixed(2)}</td>
                  <td>{component.explanation}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </>
  );
}
