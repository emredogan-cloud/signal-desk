# ENV-HANDBOOK.md

Every external secret and configuration value, what it is for, where to get it, and which phase
first needs it.

**Rule (brief §53): a missing credential must never block development.** Every variable below has a
defined behaviour when absent. Phases 1–5 require **no credentials at all** — the entire ingestion,
normalisation, clustering, and scoring stack is developed and tested against recorded fixtures.

---

## 1. Phase-by-phase requirement map

| Phase                     | New credentials required               | Can run with none?                |
| ------------------------- | -------------------------------------- | --------------------------------- |
| 1 — Foundation            | —                                      | ✅                                |
| 2 — Source registry       | —                                      | ✅                                |
| 3 — Ingestion adapters    | none required; `GITHUB_TOKEN` optional | ✅ (public feeds need no auth)    |
| 4 — Normalisation + dedup | —                                      | ✅ (embeddings are local)         |
| 5 — Scoring               | —                                      | ✅                                |
| 6 — AI analysis           | **`ANTHROPIC_API_KEY`**                | ⚠️ `AI_MODE=MOCK` works fully     |
| 7 — Content strategy      | (same key)                             | ⚠️ MOCK                           |
| 8 — Educational engine    | (same key)                             | ⚠️ MOCK                           |
| 9 — Trend intelligence    | (same key)                             | ⚠️ MOCK                           |
| 10 — Dashboard            | —                                      | ✅                                |
| 11 — Alerts               | `NTFY_TOPIC` optional                  | ✅ (console fallback)             |
| 12 — Analytics loop       | **`X_*`** (owned reads)                | ⚠️ MOCK                           |
| 13 — Live integration     | all of the above                       | ❌ this is the point of the phase |
| 14 — Hardening            | —                                      | ✅                                |
| 15 — E2E validation       | all                                    | ❌                                |

---

## 2. Core runtime configuration — no secrets

### `DATA_MODE`

- **Purpose:** ingestion source. `MOCK` reads `fixtures/`; `LIVE` performs real network fetches.
- **Values:** `MOCK` | `LIVE` — **Default:** `MOCK`
- **Used by:** `apps/worker`, all adapters
- **Required:** yes (has a default)
- **Notes:** CI always runs `MOCK`. The dashboard displays a permanent badge whenever this is `MOCK`.

### `AI_MODE`

- **Purpose:** LLM calls. `MOCK` returns deterministic canned analyses; `LIVE` calls Anthropic.
- **Values:** `MOCK` | `LIVE` — **Default:** `MOCK`
- **Used by:** `packages/ai`
- **Required:** yes (has a default)
- **Notes:** Independent of `DATA_MODE`. `DATA_MODE=LIVE` + `AI_MODE=MOCK` is a useful and legitimate
  combination for testing ingestion against real feeds at zero cost.

### `DATABASE_URL`

- **Purpose:** database location.
- **Dev:** `file:./data/signal-desk.db` · **Prod (optional):** a Postgres URL
- **Used by:** `packages/db`
- **Required:** yes (has a default)

### `LOG_LEVEL`

- **Values:** `trace|debug|info|warn|error` — **Default:** `info`

### `TZ`

- **Purpose:** the timezone all scheduling and the daily brief cutover use.
- **Default:** `Europe/Istanbul`
- **Notes:** Set it explicitly. The morning-brief boundary and "today's cost" both depend on it, and
  a machine defaulting to UTC will produce a brief that cuts at the wrong hour.

---

## 3. Anthropic — the only mandatory secret

### `ANTHROPIC_API_KEY`

- **Purpose:** all LLM calls — triage, analysis, content strategy, trend reasoning.
- **Where to get it:** Anthropic Console → API keys. A workspace-scoped key is preferable to an
  organisation-wide one so a leak has a bounded blast radius.
- **Required:** from Phase 6, and only in `AI_MODE=LIVE`.
- **Used by:** `packages/ai`
- **Dev / Prod:** same variable; use **separate keys** so spend is attributable and one can be
  revoked without stopping the other.
- **If missing:** `packages/ai` logs a structured warning and forces `AI_MODE=MOCK`. The pipeline
  runs end to end; analyses are canned and clearly marked.
- **Also do this in the vendor console:** set a spend limit. The in-app budget guard
  (`AI_DAILY_BUDGET_USD`) does not protect you if the key itself leaks — see `THREAT-MODEL.md` §T-3.
- **Alternative credential path:** the SDK also resolves `ANTHROPIC_AUTH_TOKEN` or an `ant auth login`
  profile. If `ANTHROPIC_API_KEY` is unset, a bare client may still authenticate from a profile on
  disk — which is convenient, but means "the variable is unset" does not prove "no credentials are
  configured." Check `ant auth status` before assuming.

### `AI_TRIAGE_MODEL`

- **Default:** `claude-haiku-4-5` · **Purpose:** high-volume, low-judgment classification.
- **Notes:** its prompt-cache floor is **4096 tokens** — the highest of the current models. If the
  triage system prompt is shorter, caching silently does nothing. See `ARCHITECTURE.md` §6.

### `AI_ANALYSIS_MODEL`

- **Default:** `claude-opus-5` · **Purpose:** deep analysis and content strategy.
- **Notes:** do not downgrade to save money without running the Phase-6 quality eval. This is the
  output the operator's credibility rests on.

### `AI_DAILY_BUDGET_USD`

- **Purpose:** hard daily ceiling enforced by the AI wrapper.
- **Default:** `2.00`
- **On breach:** graceful degradation — triage falls back to rules-only, deep analysis defers to the
  next batch window, dashboard shows a banner. **Never** a crash, never a silent stop to detection.

### `AI_ANALYSIS_THRESHOLD`

- **Purpose:** minimum combined score for an event to reach the expensive analysis model.
- **Default:** `70`
- **Notes:** the single largest cost lever in the system. Raising it from 70 to 80 roughly halves the
  Opus line item. Tune it against measured output quality in Phase 12, not by feel.

### `AI_USE_BATCH_FOR_NON_URGENT`

- **Values:** `true` | `false` — **Default:** `true`
- **Purpose:** route nightly, non-time-sensitive work (educational mining, trend scoring, weekly
  synthesis) through the Batch API at **50% of standard price**. Most batches complete within an
  hour; the maximum is 24 hours, which is irrelevant for overnight work.

---

## 4. X / Twitter — optional, metered, and easy to overspend

Read `SOURCE-INTELLIGENCE.md` §0 before configuring any of this. The short version: X is a
**publishing and measurement** surface here, not a monitoring one, because post reads at $0.005 each
make monitoring cost roughly $150/month.

### `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET`

- **Purpose:** authenticate as the operator's own account.
- **Where:** X Developer Console (`console.x.com`) → create a project/app → keys and tokens.
  Pay-per-use requires purchasing credits upfront; there is no free tier.
- **Required:** from Phase 12 (analytics), and only in `X_MODE=LIVE`.
- **Scopes:** read-only until Phase 13. Grant write scope **only** if assisted publishing is
  actually built — see `THREAT-MODEL.md` §T-4.
- **If missing:** the analytics loop runs against fixture data and the dashboard marks outcome
  metrics as MOCK.

### `X_MODE`

- **Values:** `MOCK` | `LIVE` — **Default:** `MOCK`
- **Notes:** deliberately separate from `DATA_MODE` and `AI_MODE`. X spend is metered per request and
  should be switched on consciously and independently.

### `X_DAILY_BUDGET_USD`

- **Default:** `0.50`
- **Purpose:** a separate, smaller ceiling from the AI budget, because X billing is per-request with
  no plan cap to bump into.
- **Reference prices to sanity-check any usage estimate against:** post read $0.005, user read $0.010,
  **owned read $0.001**, post create $0.015, **post create containing a URL $0.200**, trends $0.010.
  Pay-per-use plans cap at 2,000,000 post reads per billing cycle.

### `X_ENABLE_POSTING`

- **Values:** `true` | `false` — **Default:** `false`
- **Notes:** must remain `false` until Phase 13 ships with per-post human confirmation. Even then,
  every post requires an explicit click. There is no autonomous-posting configuration in this system,
  and adding one would be a design change requiring a revision of `THREAT-MODEL.md`.

### `X_MAX_POSTS_PER_DAY`

- **Default:** `4`
- **Purpose:** a hard self-limit well under any platform ceiling. Also a content-quality guard —
  posting frequency past a handful per day works against the operator, not for him.

---

## 5. GitHub — optional, and worth adding

### `GITHUB_TOKEN`

- **Purpose:** raise the REST API rate limit.
- **Where:** GitHub → Settings → Developer settings → fine-grained PAT. **Public-repo read only.**
  No write scopes, no private-repo access.
- **Required:** no.
- **If missing:** REST enrichment is capped at **60 requests/hour** (verified unauthenticated limit),
  which about 60 watched repos on an hourly pass will exhaust. With a token the limit is 5,000/hour.
- **Important:** the `.atom` endpoints (`releases.atom`, `commits/{branch}.atom`) need **no token at
  all** and are the primary watch mechanism. The token only improves enrichment. Ingestion degrades
  gracefully without it.

---

## 6. Notifications — optional

### `NTFY_TOPIC`

- **Purpose:** push alerts for URGENT-tier events to phone/desktop.
- **Where:** `ntfy.sh` — pick an unguessable topic name; no account required, free, self-hostable.
- **Required:** no. **If missing:** alerts log to console and appear in the dashboard only.
- **Security note:** an ntfy topic name _is_ the credential. Anyone who knows it can read your
  alerts. Use a long random string, and do not put event bodies containing anything sensitive in the
  notification payload — title and a dashboard link only.

### `ALERT_MIN_PRIORITY`

- **Values:** `urgent|high|trend|educational` — **Default:** `urgent`
- **Notes:** start at `urgent`. Brief §46 explicitly warns against alert noise, and an alerting
  system the operator learns to ignore is worse than none.

---

## 7. Never in this file, never in the repo

- No credential value, ever — `.env.example` carries names and descriptions only.
- No production database dump or `raw_items` export (may contain third-party content).
- No API responses containing tokens in logs — the logger has a redaction list covering
  `authorization`, `x-api-key`, `token`, `secret`, `password`, `cookie`.

---

## 8. `.env.example` (the file that ships in the repo)

```bash
# ─── Mode ─────────────────────────────────────────────────────────────
DATA_MODE=MOCK              # MOCK | LIVE
AI_MODE=MOCK                # MOCK | LIVE
X_MODE=MOCK                 # MOCK | LIVE

# ─── Core ─────────────────────────────────────────────────────────────
DATABASE_URL=file:./data/signal-desk.db
LOG_LEVEL=info
TZ=Europe/Istanbul

# ─── Anthropic (required from Phase 6, LIVE only) ─────────────────────
ANTHROPIC_API_KEY=
AI_TRIAGE_MODEL=claude-haiku-4-5
AI_ANALYSIS_MODEL=claude-opus-5
AI_DAILY_BUDGET_USD=2.00
AI_ANALYSIS_THRESHOLD=70
AI_USE_BATCH_FOR_NON_URGENT=true

# ─── X (optional, Phase 12+; metered per request) ─────────────────────
X_API_KEY=
X_API_SECRET=
X_ACCESS_TOKEN=
X_ACCESS_TOKEN_SECRET=
X_DAILY_BUDGET_USD=0.50
X_ENABLE_POSTING=false
X_MAX_POSTS_PER_DAY=4

# ─── GitHub (optional — raises REST limit 60/h → 5000/h) ──────────────
GITHUB_TOKEN=

# ─── Alerts (optional) ────────────────────────────────────────────────
NTFY_TOPIC=
ALERT_MIN_PRIORITY=urgent
```

---

## 9. Validation

`packages/shared/config.ts` parses the environment through a **Zod schema at startup** and fails
fast with a readable message on invalid values — not on missing optional ones. A typo in
`AI_ANALYSIS_MODEL` should surface as a startup error, not as a 404 three hours into a run.

`pnpm run check:env` prints a table of every variable: name, present/absent, effective value
(secrets shown as `sk-…abcd`), the mode it implies, and which subsystems are consequently degraded.
This is the first command to run when something is not working.

---

## 10. Rotation runbook

Exercised once during Phase 14, not first attempted during an incident.

**Anthropic:** create the new key in the console → update `.env` → restart the worker → confirm a
successful call in `llm_calls` → revoke the old key in the console. Downtime is one restart.

**X:** regenerate tokens in the developer console → update all four variables → restart → verify with
a single owned read → confirm the old tokens fail.

**GitHub:** generate a new fine-grained PAT → update → restart → delete the old PAT.

**If a key is believed leaked:** revoke first, then investigate. Check the vendor's usage dashboard
for spend during the exposure window. Rotate before determining scope — an unrevoked leaked key
costs money every minute of analysis.
