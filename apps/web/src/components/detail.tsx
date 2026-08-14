import type { Brief } from '@/lib/brief';
import { CopyButton } from './copy-button';
import { ACTION_LABELS, band, relativeTime } from './event-card';
import { SafeLink } from './safe';

/**
 * The decision panel. Everything about one event, in the order a decision needs it.
 *
 * ## The order is the argument
 *
 * §17 of the brief specifies the interaction: understand in under 30 seconds → why it
 * matters → recommendation → angle → ready-to-copy post → media → publish by hand. The
 * sections below are in exactly that order, and the ordering is doing real work:
 *
 *   1. the verdict first, because that is what he came for;
 *   2. what happened / what changed, because a verdict he cannot check is an oracle;
 *   3. why now / why me, because those are the two questions that stop a bad post;
 *   4. what is NOT known, before the drafts rather than after them;
 *   5. the drafts;
 *   6. what to attach to make it evidence rather than commentary.
 *
 * Putting "still unknown" *above* the drafts is deliberate and slightly awkward — it
 * interrupts the run toward the copy button. That is the point. It is the last cheap
 * moment to not post something.
 *
 * ## Sections disappear rather than render empty
 *
 * Most events never reach deep analysis: 5,005 scored, 75 past the gate, 3 analysed on
 * the last live pass. A panel that renders "WHAT CHANGED: —" for the other 5,002
 * teaches the operator that the section is always empty and he stops reading it. An
 * absent section is honest; a placeholder is noise.
 */

/**
 * Long analysis prose, clamped with a native disclosure.
 *
 * `<details>` rather than a client component: this is the one interaction on the page
 * the platform already implements, and reaching for state here would put a React
 * bundle on the critical path to hide a paragraph.
 */
function Prose({ text }: { readonly text: string }) {
  const words = text.trim().split(/\s+/).length;
  if (words < 90) return <p>{text}</p>;

  return (
    <details>
      <summary className="more">Tamamını göster ({words} kelime)</summary>
      <p className="prose-clamp">{text}</p>
    </details>
  );
}

function Bar({
  label,
  value,
  total,
}: {
  readonly label: string;
  readonly value: number;
  readonly total?: boolean;
}) {
  return (
    <div className={`bar-row ${total === true ? 'is-total' : ''}`}>
      <span className="bar-k">{label}</span>
      <span className="bar-track">
        <span className="bar-fill" style={{ width: `${String(Math.min(100, value))}%` }} />
      </span>
      <span className="bar-v">{value}/100</span>
    </div>
  );
}

export function Detail({ brief, now }: { readonly brief: Brief; readonly now: Date }) {
  const { klass, label } = band(brief.combined);
  const action = brief.strategy.recommendation.action;
  const panel = brief.strategy.panel;

  return (
    <section className="detail" aria-label="Olay detayı">
      <div className="detail-inner">
        {/* ── 1. The verdict ─────────────────────────────────────────────── */}
        <div className="detail-top">
          <span className={`score ${klass}`} style={{ width: 54, flex: 'none' }}>
            <span className="score-n">{brief.combined}</span>
            <span className="score-l">{label}</span>
          </span>
          <span className={`act act-${action}`}>{ACTION_LABELS[action] ?? action}</span>
          {brief.injectionObserved ? <span className="act act-VERIFY">ENJEKSİYON İZİ</span> : null}
        </div>

        <h2>{brief.title}</h2>
        <div className="detail-meta">
          {brief.entities.join(', ') || brief.category} · {relativeTime(brief.occurredAt, now)} ·{' '}
          {brief.distinctSourceCount} bağımsız kaynak · güven {brief.confidence}
        </div>

        <div className="qa">
          <div className="qa-q">SİSTEM NE DİYOR?</div>
          <div className="qa-a">{brief.strategy.recommendation.reasoning}</div>
        </div>

        {!brief.gatePassed ? (
          <div className="warn">
            Bu olay kuralları geçemedi: {brief.gateReason}. Derin analiz yapılmadı — aşağıdaki
            değerlendirme yalnızca deterministik skorlamaya dayanıyor.
          </div>
        ) : null}

        {/* ── 2. What happened, what changed ─────────────────────────────── */}
        {brief.whatHappened !== '' ? (
          <div className="sec">
            <div className="sec-h">NE OLDU</div>
            <Prose text={brief.whatHappened} />
          </div>
        ) : null}

        {brief.whatChanged !== '' ? (
          <div className="sec">
            <div className="sec-h">NE DEĞİŞTİ</div>
            <Prose text={brief.whatChanged} />
            {brief.before !== '' && brief.after !== '' ? (
              <div className="ba">
                <div className="ba-row ba-before">
                  <div className="ba-k">ÖNCE</div>
                  <div className="ba-v">{brief.before}</div>
                </div>
                <div className="ba-row ba-after">
                  <div className="ba-k">SONRA</div>
                  <div className="ba-v">{brief.after}</div>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {brief.claims.length > 0 ? (
          <div className="sec">
            <div className="sec-h">TEMEL BULGULAR</div>
            <ul className="list">
              {brief.claims.slice(0, 7).map((claim, index) => (
                <li key={index}>
                  <span className="li-mark li-ok" aria-hidden="true">
                    ✓
                  </span>
                  <span>
                    {claim.text}
                    {claim.tag !== '' ? (
                      <span className="tag" style={{ marginLeft: 6 }}>
                        {claim.tag}
                      </span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {brief.implications.length > 0 ? (
          <div className="sec">
            <div className="sec-h">NEDEN ÖNEMLİ</div>
            <ul className="list">
              {brief.implications.map((entry, index) => (
                <li key={index}>
                  <span className="li-mark" aria-hidden="true">
                    →
                  </span>
                  <span>
                    <strong>{entry.audience}:</strong> {entry.implication}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* ── 3. Why now, why me ─────────────────────────────────────────── */}
        <div className="sec">
          <div className="sec-h">KARAR PANELİ</div>
          <div className="qa">
            <div className="qa-q">NEDEN ŞİMDİ?</div>
            <div className="qa-a">{panel.whyNow}</div>
          </div>
          <div className="qa">
            <div className="qa-q">NEDEN BEN?</div>
            <div className="qa-a">{panel.whyMe}</div>
          </div>
          <div className="qa">
            <div className="qa-q">NE KATABİLİRİM?</div>
            <div className="qa-a">{panel.whatCanIAdd}</div>
          </div>
          <div className="qa">
            <div className="qa-q">BEKLENEN SONUÇ</div>
            <div className="qa-a">{panel.expectedOutcome}</div>
          </div>
        </div>

        {/* ── Attention, computed from named drivers ──────────────────────── */}
        <div className="sec">
          <div className="sec-h">YAYILMA POTANSİYELİ</div>
          <div className="viral">
            <div className="viral-top">
              <span className={`viral-lvl viral-${brief.attention.level}`}>
                {brief.attention.level}
              </span>
              <span className="draft-chars">{brief.attention.score.toFixed(2)}</span>
            </div>
            <div className="viral-why">{brief.attention.reason}</div>
            {brief.attention.limitation !== undefined ? (
              <div className="viral-lim">{brief.attention.limitation}</div>
            ) : null}
            {brief.attention.drivers.length > 0 ? (
              <div className="drivers">
                {brief.attention.drivers.map((driver) => (
                  <span key={driver} className="tag">
                    {driver.replace(/_/g, ' ')}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        </div>

        {/* ── Scores, so the ranking is checkable ─────────────────────────── */}
        <div className="sec">
          <div className="sec-h">SKOR DAĞILIMI</div>
          <div className="bars">
            <Bar label="Önem" value={brief.importance} />
            <Bar label="İlgi" value={brief.brandRelevance} />
            <Bar label="Birleşik" value={brief.combined} total />
          </div>
        </div>

        {/* ── 4. What is NOT known — deliberately before the drafts ───────── */}
        {brief.stillUnknown.length > 0 ? (
          <div className="sec">
            <div className="sec-h">HENÜZ BİLİNMEYEN</div>
            <ul className="list">
              {brief.stillUnknown.map((entry, index) => (
                <li key={index}>
                  <span className="li-mark li-q" aria-hidden="true">
                    ?
                  </span>
                  <span>{entry}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {brief.doNotSay.length > 0 ? (
          <div className="sec">
            <div className="sec-h">SÖYLENMEYECEKLER</div>
            <ul className="list">
              {brief.doNotSay.map((entry, index) => (
                <li key={index}>
                  <span className="li-mark li-no" aria-hidden="true">
                    ✕
                  </span>
                  <span>{entry}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* ── 5. The drafts ──────────────────────────────────────────────── */}
        <div className="sec">
          <div className="sec-h">HAZIR GÖNDERİ TASLAKLARI</div>

          {brief.drafts.length === 0 ? (
            <div className="empty" style={{ padding: '20px 16px' }}>
              <strong>Taslak yok</strong>
              {brief.analysed
                ? 'Analiz taslağa dönüşecek malzeme üretmedi, ya da üretilen her taslak "söylenmeyecekler" listesine takıldı. Bu bir hata değil — söylenecek şey yok demek.'
                : 'Bu olay derin analize ulaşmadı, dolayısıyla taslak üretecek malzeme yok.'}
            </div>
          ) : (
            brief.drafts.map((draft) => (
              <article className="draft" key={draft.format}>
                <div className="draft-head">
                  <span className="draft-fmt">{DRAFT_LABELS[draft.format] ?? draft.format}</span>
                  <span className="draft-kind">{KIND_LABELS[draft.kind] ?? draft.kind}</span>
                  <span
                    className={`draft-chars ${draft.parts.some((p) => p.chars > 250) ? 'is-tight' : ''}`}
                  >
                    {draft.parts.length > 1
                      ? `${String(draft.parts.length)} gönderi · ${draft.parts.map((p) => String(p.chars)).join(' / ')}`
                      : `${String(draft.chars)} / 280`}
                  </span>
                </div>
                <pre className="draft-text">{draft.text}</pre>
                <div className="draft-foot">
                  <span className="draft-why">{draft.rationale}</span>
                  <CopyButton text={draft.text} />
                </div>
              </article>
            ))
          )}

          <div className="manual-note">
            Yayınlama her zaman elle yapılır. Bu panelde gönderen bir düğme yoktur — THREAT-MODEL
            §T-4.
          </div>
        </div>

        {/* ── 6. What to attach ──────────────────────────────────────────── */}
        {brief.media !== undefined ? (
          <div className="sec">
            <div className="sec-h">NE EKLEMELİYİM</div>
            <div className="media">
              <div className="media-top">
                <span className="media-kind">{brief.media.label}</span>
              </div>

              <div className="media-field">
                <div className="media-k">NE GÖSTERİLECEK</div>
                <div className="media-v">{brief.media.whatToShow}</div>
              </div>

              <div className="media-field">
                <div className="media-k">NEDEN İŞE YARAR</div>
                <div className="media-v">{brief.media.whyItHelps}</div>
              </div>

              <div className="media-field">
                <div className="media-k">NASIL YAPILIR</div>
                <ol className="steps">
                  {brief.media.howToMake.map((step, index) => (
                    <li key={index}>{step}</li>
                  ))}
                </ol>
              </div>

              <div className="media-field">
                <div className="media-k">KAYNAK</div>
                <div className="media-v">{brief.media.source}</div>
              </div>

              <div className="media-field">
                <div className="media-k">ARAÇ</div>
                <div className="media-v">{brief.media.tool}</div>
              </div>

              {brief.media.imagePrompt !== undefined ? (
                <div className="media-field">
                  <div className="media-k">GPT IMAGE PROMPT</div>
                  <pre className="draft-text" style={{ padding: '9px 0 0' }}>
                    {brief.media.imagePrompt}
                  </pre>
                  <div style={{ marginTop: 6 }}>
                    <CopyButton
                      text={brief.media.imagePrompt}
                      label="Prompt'u kopyala"
                      doneLabel="Kopyalandı ✓"
                    />
                  </div>
                </div>
              ) : null}

              {brief.media.video !== undefined ? (
                <>
                  <div className="media-field">
                    <div className="media-k">SÜRE</div>
                    <div className="media-v">{brief.media.video.seconds}</div>
                  </div>
                  <div className="media-field">
                    <div className="media-k">İLK 2 SANİYE</div>
                    <div className="media-v">{brief.media.video.firstTwoSeconds}</div>
                  </div>
                  <div className="media-field">
                    <div className="media-k">SIRALAMA</div>
                    <ol className="steps">
                      {brief.media.video.sequence.map((shot, index) => (
                        <li key={index}>{shot}</li>
                      ))}
                    </ol>
                  </div>
                  <div className="media-field">
                    <div className="media-k">EKRAN YAZISI</div>
                    <div className="media-v">
                      {brief.media.video.overlayText}{' '}
                      <CopyButton text={brief.media.video.overlayText} />
                    </div>
                  </div>
                  <div className="media-field">
                    <div className="media-k">SESLENDİRME</div>
                    <div className="media-v">{brief.media.video.narration}</div>
                  </div>
                  <div className="media-field">
                    <div className="media-k">SON KARE</div>
                    <div className="media-v">{brief.media.video.finalFrame}</div>
                  </div>
                </>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* ── Evidence ───────────────────────────────────────────────────── */}
        {brief.sources.length > 0 ? (
          <div className="sec">
            <div className="sec-h">KANIT</div>
            <ul className="list">
              {brief.sources.map((source, index) => (
                <li key={index}>
                  <span className="li-mark" aria-hidden="true">
                    {source.isOfficial ? '★' : '·'}
                  </span>
                  <span>
                    <SafeLink url={source.url}>{source.title}</SafeLink>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  );
}

const DRAFT_LABELS: Record<string, string> = {
  reaction: 'KISA TEPKİ',
  breakdown: 'TEKNİK ÖZET',
  operator_take: 'KENDİ TESTİN',
  quote: 'ALINTI GÖNDERİSİ',
  thread: 'THREAD',
};

const KIND_LABELS: Record<string, string> = {
  standalone: 'tek gönderi',
  quote: 'alıntı',
  thread: 'zincir',
};
