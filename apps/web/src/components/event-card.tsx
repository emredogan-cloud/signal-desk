import type { StreamRow } from '@/lib/data';

/**
 * One row in the ranked feed.
 *
 * ## The ranking has to explain itself
 *
 * §5 of the brief: the user should understand *why* something is #1, and the score
 * alone must not be the explanation. So every card carries four independent signals,
 * and they are chosen so that a disagreement is visible rather than hidden inside one
 * number:
 *
 *   score + band   how important, and how important that is on a scale
 *   action pill    what the system thinks he should DO — the decision, before the click
 *   category tags  what kind of thing it is
 *   freshness      how much of the timing advantage is left
 *
 * A card showing 88 / POST NOW / 2 saat önce is a different instruction from
 * 88 / WAIT / 3 gün önce, and the score is identical. That difference is the product.
 */

export const ACTION_LABELS: Record<string, string> = {
  POST_NOW: 'ŞİMDİ PAYLAŞ',
  POST_SOON: 'YAKINDA PAYLAŞ',
  WAIT: 'BEKLE',
  VERIFY: 'DOĞRULA',
  DONT_POST: 'PAYLAŞMA',
};

export function band(combined: number): { klass: string; label: string } {
  // Thresholds match the score scale as measured, not an idealised 0–100: over 5,007
  // real events the maximum combined score observed was 66 (ARCHITECTURE §6). Bands
  // drawn at 80/60 would have marked the entire corpus LOW, which is how a
  // correctly-working ranking looks broken.
  if (combined >= 55) return { klass: 's-high', label: 'YÜKSEK' };
  if (combined >= 40) return { klass: 's-med', label: 'ORTA' };
  return { klass: 's-low', label: 'DÜŞÜK' };
}

export function relativeTime(from: Date, now: Date): string {
  const hours = Math.max(0, (now.getTime() - from.getTime()) / 3_600_000);
  if (hours < 1) return `${String(Math.round(hours * 60))} dk önce`;
  if (hours < 48) return `${String(Math.round(hours))} saat önce`;
  return `${String(Math.round(hours / 24))} gün önce`;
}

/** First letter of the leading entity — a favicon stand-in that needs no network. */
function markFor(row: StreamRow): string {
  const source = row.entities[0] ?? row.category;
  return source.slice(0, 2).toUpperCase();
}

export function EventCard({
  row,
  now,
  selected,
  tab,
}: {
  readonly row: StreamRow;
  readonly now: Date;
  readonly selected: boolean;
  readonly tab: string;
}) {
  const { klass, label } = band(row.combined);
  const action = row.strategy.recommendation.action;

  return (
    <a
      href={`/?tab=${tab}&event=${String(row.eventId)}`}
      className="ev"
      aria-current={selected}
      aria-label={`${row.title} — skor ${String(row.combined)}`}
    >
      <span className={`score ${klass}`}>
        <span className="score-n">{row.combined}</span>
        <span className="score-l">{label}</span>
      </span>

      <span className="ev-mark" aria-hidden="true">
        {markFor(row)}
      </span>

      <span className="ev-body">
        <span className="ev-title">{row.title}</span>
        <span className="ev-meta">
          <span>{row.entities[0] ?? row.category}</span>
          <span aria-hidden="true">·</span>
          <span>{relativeTime(row.occurredAt, now)}</span>
          <span aria-hidden="true">·</span>
          <span>{row.distinctSourceCount} kaynak</span>
        </span>
        <span className="ev-tags">
          <span className={`act act-${action}`}>{ACTION_LABELS[action] ?? action}</span>
          <span className="tag tag-ai">{row.category}</span>
          {row.entities.slice(0, 2).map((entity) => (
            <span key={entity} className="tag">
              {entity}
            </span>
          ))}
        </span>
      </span>

      <span className="ev-chev" aria-hidden="true">
        ›
      </span>
    </a>
  );
}
