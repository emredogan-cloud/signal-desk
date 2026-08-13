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
  if (modes.dataMode === 'MOCK') mocked.push('DATA (no real sources fetched)');
  if (modes.aiMode === 'MOCK') mocked.push('AI (no model called — analyses are placeholders)');
  if (modes.xMode === 'MOCK') mocked.push('X (no platform access)');

  if (mocked.length === 0) return null;

  return (
    <div className="mock-badge" role="status" aria-live="polite">
      <strong>MOCK MODE</strong>
      <span>{mocked.join(' · ')}</span>
      <span className="mock-badge-warning">Nothing on this screen is a live result.</span>
    </div>
  );
}
