import type { EffectiveModes } from '@signal-desk/shared';

/**
 * The MOCK badge. **A safety control, not a developer convenience.**
 *
 * `ARCHITECTURE.md` §8: "A mock analysis that looks real on screen is how an operator
 * ends up posting a fabricated claim."
 *
 * `ROADMAP.md` Phase 10 acceptance: "**MOCK badge cannot be missed.**" So it is fixed
 * to the top of the viewport, spans the full width, and names every mocked subsystem
 * individually — a single "MOCK" chip in a corner is missable, and a badge that says
 * only "some things are mocked" leaves the operator guessing which.
 */
export function MockBadge({ modes }: { modes: EffectiveModes }) {
  const mocked: string[] = [];
  if (modes.dataMode === 'MOCK') mocked.push('VERİ — gerçek kaynak çekilmiyor');
  if (modes.aiMode === 'MOCK') mocked.push('AI — model çağrılmıyor, analizler yer tutucu');
  if (modes.xMode === 'MOCK') mocked.push('X — platform erişimi yok');

  if (mocked.length === 0) return null;

  // The degradation reasons, not just the fact of degradation. `deriveEffectiveModes`
  // knows *why* each subsystem fell back — for X on 2026-08-14 that reason was a
  // malformed access token, which is actionable in a way that the word "MOCK" is not.
  const reasons = modes.degradations.map((entry) => entry.because);

  return (
    <div className="mock-banner" role="status" aria-live="polite">
      <strong>MOCK MOD</strong>
      <span>{mocked.join(' · ')}</span>
      <span>Bu ekrandaki her şey canlı sonuç değildir.</span>
      {reasons.length > 0 ? (
        <details>
          <summary className="more">Neden?</summary>
          <ul className="list" style={{ marginTop: 6 }}>
            {reasons.map((reason, index) => (
              <li key={index}>
                <span className="li-mark li-q" aria-hidden="true">
                  !
                </span>
                <span>{reason}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
