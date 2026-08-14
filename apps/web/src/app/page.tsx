import { health, modes, schemaReady, stream, type StreamRow } from '@/lib/data';
import { brief } from '@/lib/brief';
import { serverConfig } from '@/lib/env';
import { EventCard, relativeTime } from '@/components/event-card';
import { Detail } from '@/components/detail';
import { MockBadge } from '@/components/mock-badge';

/**
 * The console.
 *
 * ## What changed in the rebuild, and why
 *
 * The previous page was a single scrolling column: a mode badge, a brief, a health
 * panel, then every event with its full strategy expanded inline. It rendered
 * everything the system knew and made the operator do the ranking himself.
 *
 * §3 of the brief is the correction: the screen must answer "what happened that I
 * should care about, and what do I do about it" *immediately*. So the shape is now
 * rail / ranked feed / decision panel, and the expensive per-event work — analysis
 * payload, strategy, drafts, media plan — happens for **one** event, the selected one,
 * rather than for forty.
 *
 * ## Selection is a URL, not client state
 *
 * `?event=123` is server-rendered. That keeps the entire console server-side except
 * the copy buttons, which means the detail panel is never a loading spinner and the
 * operator can bookmark or share a specific brief. It also keeps the client bundle to
 * one small component — see `copy-button.tsx` for why that one is worth it.
 */

export const dynamic = 'force-dynamic';

const TABS = [
  { id: 'priority', label: 'ÖNCELİKLİ' },
  { id: 'all', label: 'TÜM OLAYLAR' },
  { id: 'post', label: 'PAYLAŞILABİLİR' },
] as const;

type Search = Record<string, string | string[] | undefined>;

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Rank, then explain the ranking. See `event-card.tsx` for what each signal carries. */
function rank(rows: readonly StreamRow[], tab: string): StreamRow[] {
  const ACTION_WEIGHT: Record<string, number> = {
    POST_NOW: 4,
    POST_SOON: 3,
    VERIFY: 2,
    WAIT: 1,
    DONT_POST: 0,
  };

  const filtered =
    tab === 'post'
      ? rows.filter(
          (row) =>
            ACTION_WEIGHT[row.strategy.recommendation.action] !== undefined &&
            ACTION_WEIGHT[row.strategy.recommendation.action]! >= 3,
        )
      : tab === 'all'
        ? rows
        : rows.filter((row) => row.gatePassed);

  // Sorted by what to do first, then by score. §5: "Do NOT simply sort by raw score."
  // An 88 that the system says to WAIT on is genuinely below a 71 it says to post now.
  return [...filtered].sort((a, b) => {
    const byAction =
      (ACTION_WEIGHT[b.strategy.recommendation.action] ?? 0) -
      (ACTION_WEIGHT[a.strategy.recommendation.action] ?? 0);
    if (byAction !== 0) return byAction;
    return b.combined - a.combined;
  });
}

export default async function Page({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams;
  const tab = one(params.tab) ?? 'priority';
  const requested = Number(one(params.event) ?? '');

  const config = serverConfig();
  const effective = modes();
  const now = new Date();

  if (!schemaReady()) {
    return (
      <main style={{ padding: 40 }}>
        <h1>Veritabanı henüz hazır değil</h1>
        <p>
          Panel okur; şemayı worker yazar ve yönetir. Önce <code>pnpm ingest:once</code>, sonra{' '}
          <code>pnpm cluster</code> ve <code>pnpm score</code> çalıştırın.
        </p>
      </main>
    );
  }

  const rows = stream(200);
  // §25: the operator needs to know how fresh the picture is without hunting for it.
  const freshest = rows.reduce<Date | undefined>(
    (newest, row) => (newest === undefined || row.occurredAt > newest ? row.occurredAt : newest),
    undefined,
  );
  const ranked = rank(rows, tab);
  const selectedId = Number.isFinite(requested) && requested > 0 ? requested : ranked[0]?.eventId;
  const selected = selectedId === undefined ? undefined : brief(selectedId);
  const systemHealth = health();

  return (
    <>
      <MockBadge modes={effective} />

      {/*
        The whole of the old rail and KPI wall, reduced to one line.
        §26 of the brief: the operator still wants ingest freshness, spend, source
        health and integration state — but they must be SECONDARY. A status bar can be
        read in a glance and ignored; a sidebar of panels cannot be ignored, which is
        why it kept winning attention from the decision it was supposed to support.
      */}
      <div className="statusbar">
        <span
          className={`dot ${systemHealth.deadSources === 0 ? 'dot-ok' : 'dot-warn'}`}
          aria-hidden="true"
        />
        <span>worker {systemHealth.deadSources === 0 ? 'sağlıklı' : 'kaynak sorunu'}</span>
        <span className="sb-sep" aria-hidden="true">
          ·
        </span>
        <span>
          kaynak {systemHealth.sources.length - systemHealth.deadSources}/
          {systemHealth.sources.length}
        </span>
        <span className="sb-sep" aria-hidden="true">
          ·
        </span>
        <span>
          AI ${systemHealth.costTodayUsd.toFixed(2)}/${config.AI_DAILY_BUDGET_USD.toFixed(2)}
        </span>
        <span className="sb-sep" aria-hidden="true">
          ·
        </span>
        <span>X {effective.xMode === 'LIVE' ? 'canlı' : 'mock'}</span>
        <span className="sb-sep" aria-hidden="true">
          ·
        </span>
        <span>son olay {freshest === undefined ? '—' : relativeTime(freshest, now)}</span>
      </div>

      <div className="shell">
        <div className="centre">
          <header className="topbar">
            <div>
              <h1>Günün Özeti</h1>
              <div className="topbar-sub">
                {ranked.length} olay · en yenisi{' '}
                {freshest === undefined ? '—' : relativeTime(freshest, now)}
              </div>
            </div>
          </header>

          <nav className="tabs" aria-label="Görünüm">
            {TABS.map((entry) => (
              <a
                key={entry.id}
                href={`/?tab=${entry.id}`}
                className="tab"
                {...(entry.id === tab ? { 'aria-current': 'page' as const } : {})}
              >
                {entry.label}
                <span className="tab-count">{rank(rows, entry.id).length}</span>
              </a>
            ))}
          </nav>

          <div className="feed">
            {ranked.length === 0 ? (
              <div className="empty">
                <strong>Kapıyı geçen olay yok</strong>
                Toplama, kümeleme, skorlama ve kural kapısı çalıştı; hiçbir olay geçemedi. Bu bir
                hata değil, bir sonuç — soldaki panel kaynakların canlı olup olmadığını gösterir.
              </div>
            ) : (
              ranked
                .slice(0, 40)
                .map((row) => (
                  <EventCard
                    key={row.eventId}
                    row={row}
                    now={now}
                    tab={tab}
                    selected={row.eventId === selectedId}
                  />
                ))
            )}
          </div>
        </div>

        {selected === undefined ? (
          <section className="detail" aria-label="Olay detayı">
            <div className="detail-inner">
              <div className="empty">
                <strong>Bir olay seçin</strong>
                Soldaki listeden bir olaya tıklayın; ne olduğu, neden önemli olduğu ve ne yapmanız
                gerektiği burada görünecek.
              </div>
            </div>
          </section>
        ) : (
          <Detail brief={selected} now={now} />
        )}
      </div>
    </>
  );
}
