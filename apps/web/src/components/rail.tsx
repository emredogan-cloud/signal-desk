import type { EffectiveModes } from '@signal-desk/shared';
import type { Health } from '@/lib/data';

/**
 * The left rail: navigation, and the truth about what the system is actually doing.
 *
 * Reference 001 put a system-status panel here and reference 003 kept it, and both were
 * right for a reason worth stating: this console's most likely real failure is not a
 * crash but **silence** — a dead feed, a suspended budget, an integration that is
 * mocked. `docs/VALIDATION.md` names silent feed death as the most probable failure of
 * the whole system. A status panel that has to be navigated to is a status panel that
 * gets checked after the operator has already wondered why nothing is happening.
 *
 * So it is always on screen, and it names subsystems individually rather than showing
 * one aggregate light. "Healthy" over a dead source is the lie this panel exists to
 * avoid telling.
 */

type NavEntry = {
  readonly href: string;
  readonly icon: string;
  readonly label: string;
  readonly count?: number;
  readonly current?: boolean;
};

function Nav({ entries }: { entries: readonly NavEntry[] }) {
  return (
    <nav className="nav" aria-label="Ana gezinme">
      {entries.map((entry) => (
        <a
          key={entry.href}
          href={entry.href}
          className="nav-item"
          {...(entry.current === true ? { 'aria-current': 'page' as const } : {})}
        >
          <span className="nav-icon" aria-hidden="true">
            {entry.icon}
          </span>
          <span className="nav-label">{entry.label}</span>
          {entry.count !== undefined && entry.count > 0 ? (
            <span className="nav-count">{entry.count}</span>
          ) : null}
        </a>
      ))}
    </nav>
  );
}

function Meter({
  label,
  spent,
  budget,
}: {
  readonly label: string;
  readonly spent: number;
  readonly budget: number;
}) {
  const pct = budget <= 0 ? 0 : Math.min(100, (spent / budget) * 100);
  // Matches the budget guard's own ladder in packages/ai/src/budget.ts, so the bar and
  // the behaviour cannot disagree about what "nearly out" means.
  const tone = pct >= 90 ? 'is-bad' : pct >= 70 ? 'is-warn' : '';

  return (
    <div className="meter">
      <div className="meter-head">
        <span>{label}</span>
        <span className="meter-val">
          ${spent.toFixed(4)} / ${budget.toFixed(2)}
        </span>
      </div>
      <div className="meter-track">
        <div className={`meter-fill ${tone}`} style={{ width: `${String(pct)}%` }} />
      </div>
    </div>
  );
}

export function Rail({
  modes,
  health,
  aiBudget,
  xBudget,
  xSpend,
  alerts,
}: {
  readonly modes: EffectiveModes;
  readonly health: Health;
  readonly aiBudget: number;
  readonly xBudget: number;
  readonly xSpend: number;
  readonly alerts: number;
}) {
  const workerAlive = health.sources.length > 0 && health.deadSources < health.sources.length;

  return (
    <aside className="rail">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          SD
        </span>
        <span className="brand-text">
          <span className="brand-name">SIGNAL-DESK</span>
          <br />
          <span className="brand-sub">AI Intelligence Studio</span>
        </span>
      </div>

      <div className="live-card">
        <div className="live-row">
          <span className={`dot ${workerAlive ? 'dot-ok' : 'dot-bad'}`} aria-hidden="true" />
          <span>{workerAlive ? 'CANLI' : 'DURDU'}</span>
        </div>
        <div className="live-note">
          {workerAlive
            ? `${String(health.sources.length - health.deadSources)}/${String(health.sources.length)} kaynak taze`
            : 'Kaynaklardan veri gelmiyor'}
        </div>
      </div>

      <Nav
        entries={[
          { href: '/', icon: '◧', label: 'Özet', current: true },
          { href: '/?tab=all', icon: '☰', label: 'Tüm Olaylar' },
          { href: '/?tab=post', icon: '➜', label: 'Strateji Önerileri' },
          { href: '/?tab=watch', icon: '◇', label: 'İzleme Listem' },
          { href: '/?tab=sources', icon: '⌗', label: 'Kaynaklar' },
          { href: '/?tab=alerts', icon: '△', label: 'Alarmlar', count: alerts },
        ]}
      />

      <div className="rail-spacer" />

      <div className="panel">
        <div className="panel-title">SİSTEM DURUMU</div>
        <div className="stat-row">
          <span className={`dot ${workerAlive ? 'dot-ok' : 'dot-bad'}`} aria-hidden="true" />
          <span className="k">Worker</span>
          <span className={`v ${workerAlive ? 'v-ok' : 'v-bad'}`}>
            {workerAlive ? 'Çalışıyor' : 'Durdu'}
          </span>
        </div>
        <div className="stat-row">
          <span
            className={`dot ${modes.aiMode === 'LIVE' ? 'dot-ok' : 'dot-warn'}`}
            aria-hidden="true"
          />
          <span className="k">AI (Anthropic)</span>
          <span className={`v ${modes.aiMode === 'LIVE' ? 'v-ok' : 'v-warn'}`}>
            {modes.aiMode === 'LIVE' ? 'Canlı' : 'Mock'}
          </span>
        </div>
        <div className="stat-row">
          <span
            className={`dot ${modes.xMode === 'LIVE' ? 'dot-ok' : 'dot-warn'}`}
            aria-hidden="true"
          />
          <span className="k">X Entegrasyonu</span>
          <span className={`v ${modes.xMode === 'LIVE' ? 'v-ok' : 'v-warn'}`}>
            {modes.xMode === 'LIVE' ? 'Canlı' : 'Mock'}
          </span>
        </div>
        <div className="stat-row">
          <span
            className={`dot ${health.deadSources === 0 ? 'dot-ok' : 'dot-warn'}`}
            aria-hidden="true"
          />
          <span className="k">Sessiz kaynak</span>
          <span className={`v ${health.deadSources === 0 ? 'v-ok' : 'v-warn'}`}>
            {health.deadSources}
          </span>
        </div>
        <div className="stat-row">
          <span className="dot dot-ok" aria-hidden="true" />
          <span className="k">Yayınlama</span>
          <span className="v v-ok">{modes.postingEnabled ? 'AÇIK' : 'Kapalı'}</span>
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">BUGÜNKÜ BÜTÇE</div>
        <Meter label="AI harcama" spent={health.costTodayUsd} budget={aiBudget} />
        <Meter label="X harcama" spent={xSpend} budget={xBudget} />
      </div>

      <div className="who">
        <span className="who-av" aria-hidden="true">
          ED
        </span>
        <span className="who-text">
          <span className="who-name">Emre Doğan</span>
          <br />
          <span className="who-role">Operator</span>
        </span>
      </div>
    </aside>
  );
}
