# PROJECT-MEMORY.md

**Operational handoff state. Refreshed every three completed phases.**
Last written: **2026-08-13**, after Phase 3.

This file exists so that an agent with **no conversation history** can open this
repository and continue correctly. It is not a summary, a changelog, or a second copy
of the roadmap. Where it repeats something from `docs/`, that is because the fact is
load-bearing enough that a handoff without it would go wrong.

If this file and `docs/` disagree, **`docs/` wins** and this file is stale — say so
and fix it.

---

## A. Project identity

|                       |                                                                                                                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Name**              | `signal-desk`                                                                                                                                                                                                                         |
| **What it is**        | A real-time AI / software / technology intelligence and personal authority operations console, for **one** technical operator. Not a news reader, scheduler, marketing tool, or bot.                                                  |
| **Mission**           | Convert information into earned technical credibility. Optimisation target: **EARLY + ACCURATE + USEFUL + ORIGINAL**, in that combination. Fast and wrong is worse than slow and trustworthy, because the asset being built is trust. |
| **Version**           | 0.1.0                                                                                                                                                                                                                                 |
| **Phases done**       | 1 (foundation), 2 (registry)                                                                                                                                                                                                          |
| **Phase in progress** | 3 (ingestion) — **CODE-COMPLETE**, exit criterion pending elapsed time                                                                                                                                                                |
| **Next phase**        | **4 — Normalisation, clustering, deduplication**                                                                                                                                                                                      |
| **Completion**        | 3 of 15 phases. Minimum viable release is Phases 1–7 + 10.                                                                                                                                                                            |

### Two things that are true and easy to get wrong

1. **No autonomous publishing, ever.** Not a setting, not a phase, not a future
   option. `THREAT-MODEL.md` §T-4 makes it a design property. Every published word
   requires an explicit human action.
2. **X is never an ingestion source.** X moved to pay-per-use pricing with no free
   tier; monitoring 50 accounts costs ~$150/month. X is a **publishing and
   measurement** surface only (`SOURCE-INTELLIGENCE.md` §0). Adding an X ingestion
   adapter would be a design reversal, not a feature.

---

## B. Current system state — what actually exists

### Exists and works

| Subsystem           | State                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Config**          | Zod-validated, fails fast on invalid values, never on missing optional ones. Three independent modes: `DATA_MODE`, `AI_MODE`, `X_MODE`.                |
| **Logging**         | `pino`, structured JSON, `trace_id` per item. **Secret redaction on every line** — pattern-based plus a runtime registry of literal credential values. |
| **Database**        | SQLite/WAL via Drizzle. 3 migrations. Tables: `sources`, `entities`, `entity_aliases`, `raw_items`, `fetch_log`.                                       |
| **Source registry** | **60 sources**, all probed healthy. Seeded from code, idempotently, without clobbering learned state.                                                  |
| **Entity registry** | **19 entities, 83 aliases**, with a longest-match resolver.                                                                                            |
| **Ingestion**       | Feed adapters (RSS/Atom/GitHub-atom/Statuspage), HTML diffing, MOCK twins. Conditional requests, SSRF guards, circuit breaker, `robots.txt`.           |
| **Scheduler**       | In-process `croner`, one tick per minute, per-source intervals with jitter, non-overlapping.                                                           |
| **CLIs**            | `check:env`, `db:migrate`, `db:seed`, `sources:probe`, `sources:add`, `ingest:once`.                                                                   |
| **CI**              | **GREEN on GitHub Actions.** `github.com/emredogan-cloud/signal-desk`, Node 22 + 24 matrix, gitleaks pinned, dependency audit. Run 31721212994.        |

### Does NOT exist yet

Sanitisation · canonical events · clustering/deduplication · embeddings · scoring ·
the rule gate · **any AI call at all** (`packages/ai` is an empty documented
scaffold) · content strategy · trends · the dashboard (`apps/web` is a placeholder
page) · alerts · analytics · any X integration.

**No LLM has ever been called by this system. No credential has ever been used.**

---

## C. Architecture

### Repository layout

```
apps/
  worker/      long-lived process: scheduler → ingest, plus every CLI
  web/         Next.js 16 placeholder — carries the MOCK badge, nothing else
packages/
  core/        domain logic. PERFORMS NO I/O. Currently: entity registry only
  adapters/    the ONLY package that talks to the outside world
  db/          Drizzle schema, migrations, queries, registry seeds
  ai/          empty scaffold — Phase 6
  shared/      config, logging, redaction, normalisation, vocabulary
fixtures/      recorded real payloads — the MOCK corpus
docs/          the six planning documents (authoritative)
```

### The layering rule that must not be broken

```
shared ← db ← adapters
   ↑      ↑       ↑
   └── core (no I/O, ever) ──┘
              ↑
        apps/worker, apps/web
```

`packages/core` performs **no I/O**. Everything it needs is passed in. That is what
makes scoring and clustering testable without a network, and what makes MOCK mode
first-class rather than bolted on. A `fetch`, an `fs` import, or a database handle
appearing in `core` is a design error.

_(One deliberate exception: `core` has `@signal-desk/db` as a **devDependency** so its
registry test runs against the real seed rather than a copy that can drift. The
production import graph is unchanged.)_

### Module resolution — a trap that already bit once

Internal packages resolve **types from `src/`** and **runtime from `dist/`**:

```json
"exports": { ".": {
  "types": "./src/index.ts",
  "development": "./src/index.ts",
  "default": "./dist/index.js"
}}
```

Every `tsx`-based script passes **`--conditions=development`**. Without it, a CLI
silently executes a stale `dist/` build while type-checking against current source —
which produced a genuinely baffling "the function I just wrote does not exist" for
several minutes. If you add a `tsx` script, add the flag.

---

## D. Database

Schema lives in `packages/db/src/schema.ts`. Migrations in `packages/db/migrations/`.

| Table            | Rows now                   | Purpose                                                                                                                                                            |
| ---------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sources`        | 60                         | The registry: URL, platform, category, priority, reliability, poll interval, **three freshness timestamps**, conditional-request cache keys, circuit-breaker state |
| `entities`       | 19                         | Canonical orgs/projects with `operatorRelevance`                                                                                                                   |
| `entity_aliases` | 83                         | One row per surface form; **unique index on `normalized`**                                                                                                         |
| `raw_items`      | ~5,200 after one live pass | **APPEND-ONLY.** Everything fetched, verbatim                                                                                                                      |
| `fetch_log`      | one row per fetch          | Per-run telemetry: outcome, status, items found/new, bytes, 304, error                                                                                             |

### Three schema decisions that matter downstream

1. **`raw_items` is append-only.** Nothing updates or deletes it, and no query module
   offers a path to. Phase 4's clustering is a _derived_ view — change the algorithm,
   re-run over these rows. Phase 12 replays three months of history offline at **zero
   API cost** only because the inputs were kept. Adding an update path silently
   removes both.

2. **Three freshness timestamps, not one** (`lastCheckedAt`, `lastSuccessAt`,
   `lastEventAt`). They answer different questions, and collapsing them is how silent
   source death (T-9) stays invisible: a dead scheduler looks like a dead feed, a 500
   loop looks like a quiet feed, and a feed that parses to zero items has died in the
   way that matters while still answering 200.

3. **Unique index on `entity_aliases.normalized`.** An alias owned by two entities
   mis-attributes every event carrying it, silently. This index rejected the seed on
   first use and was right to.

### The `page_snapshots` table that was designed and then deleted

HTML diffing needs to know whether a page changed. The obvious answer is a table of
last-seen hashes. Instead **the hash is encoded into the item's identity**: link mode
keys on the URL, text mode on `page:<hash>`. An unchanged page produces an id already
in `raw_items` and inserts nothing. A snapshot table would have been a second source
of truth able to drift from `raw_items`, for no additional capability. Do not
re-introduce it without a reason this reasoning does not cover.

---

## E. The pipeline as it exists today

```
croner tick (60s)
   → for each active source:
        circuit open?           → skip
        due? (interval+jitter)  → skip if not
        adapter.fetch()
           ├─ safeFetch: timeout, size cap, ≤3 redirects, scheme allowlist
           ├─ SSRF guard on EVERY hop: registry allowlist + post-DNS address check
           ├─ conditional request (If-None-Match / If-Modified-Since)
           └─ 304? → done, no parse
        parse feed / diff page  → RawItem[]
        insert into raw_items   → onConflictDoNothing (source_id, external_id)
        write fetch_log         → always, success or failure
        update freshness + circuit-breaker state
```

**Everything after `raw_items` is Phase 4 and does not exist.** No sanitisation, no
normalisation, no clustering, no scoring, no analysis.

---

## F. Completed work

### Phase 1 — Foundation (DONE)

pnpm workspace, TypeScript 6 strict, ESLint flat + Prettier, Vitest, Drizzle+SQLite,
Zod config, `pnpm verify`, CI workflow, multi-stage Dockerfile, MIT licence.

**Pulled forward deliberately:** log secret redaction (nominally Phase 14) because the
logger is written here and every later phase logs through it — retrofitting means
auditing every call site instead of none.

**The acceptance test that failed first, and mattered:** _"a deliberately planted fake
key in a scratch commit is caught"_. It was **not** caught. gitleaks 8.30.1's default
ruleset has **no Anthropic pattern at all** — a correctly shaped 110-character
`sk-ant-api03-…` key scanned clean, in a `.env` and in a `.ts`. A GitHub PAT in the
same commit _was_ caught, so the scanner worked; it simply could not see the one
credential this project holds. Fixed by `.gitleaks.toml`. **Do not assume GitHub push
protection covers Anthropic either — verify it independently in Phase 14.**

**The exit criterion that failed first:** a clean clone failed `pnpm verify` with 183
lint errors, because the chain lints _before_ it builds and workspace `dist/*.d.ts`
did not exist. Fixed by resolving types from source (§C).

### Phase 2 — Source and entity registry (DONE)

60 sources, 19 entities, 83 aliases, `sources:probe`, `sources:add`, `db:seed`.

**Three findings the live probe produced:**

1. **`XMLValidator` as a gate is wrong in both directions.** Validating before parsing
   rejected `hamel.dev/index.xml` — genuinely malformed (two concatenated documents at
   line 5536) and genuinely carrying 20 real items. Skipping validation entirely
   mislabels truncated XML as `empty_feed`. Final design: **items decide the outcome,
   validity decides whether there is a warning, warnings never fail a run.**
2. **`normalizeAlias` used NFKC**, which composes rather than decomposes, so "á"
   stayed one code point no combining-mark class matches and diacritic folding
   silently did nothing. **NFKD.**
3. The unique alias index rejected the seed because `Next.js`/`NextJS` and
   `Hugging Face`/`HuggingFace` fold to one key each. Within one entity that is
   correct; seeding now folds duplicates and raises `CrossEntityAliasError` only
   across entities.

### Phase 3 — Ingestion (CODE-COMPLETE)

Feed adapters, HTML diff with `robots.txt`, MOCK twins, SSRF guards, circuit breaker,
scheduler, `raw_items`, `fetch_log`, `ingest:once`.

**The finding that matters most for the next agent:** **two registered hosts had
moved, and only ingestion noticed.** `status.anthropic.com` → `status.claude.com`
(302); `docs.claude.com` → `platform.claude.com` (301). `sources:probe` reported both
**healthy** — a probe follows redirects — while ingestion **refused** them, because
the SSRF allowlist is built from _registered_ hostnames and a cross-host hop lands
outside it. The allowlist was right; the registry was stale. Both are now registered
at canonical hosts, and the probe warns on any cross-host redirect.

---

## G. Decisions, with reasons

| Decision                                                                    | Why                                                                                                                                                                                                                       | Rejected alternative                     | Date       |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ---------- |
| TypeScript **6.0.3**, not 7.x                                               | `typescript-eslint@8` declares `typescript <6.1.0`. On TS 7 its type-aware rules install and go **quietly inert** — silently disabling `no-floating-promises` (a T-9 control) and the `dangerouslySetInnerHTML` ban (T-7) | TS 7 with type-aware linting off         | 2026-08-13 |
| `onlyBuiltDependencies` in `pnpm-workspace.yaml`, not `ignore-scripts=true` | Same T-5 intent, precise mechanism. Blanket `ignore-scripts` also blocks `better-sqlite3`'s native binding with no way to grant an exception — so whoever needs the database working bypasses the control                 | `.npmrc` `ignore-scripts=true`           | 2026-08-13 |
| `.gitleaks.toml` with explicit Anthropic rules                              | The default ruleset cannot see `sk-ant-` keys, and that is this project's only mandatory secret in a public repo                                                                                                          | Trusting the default ruleset             | 2026-08-13 |
| Entropy floor, **not** a path allowlist, for test fixtures                  | Allowlisting `**/*.test.ts` means a genuine key pasted into a fixture goes unnoticed forever                                                                                                                              | `[allowlist] paths`                      | 2026-08-13 |
| Types from `src/`, runtime from `dist/`                                     | Lint and typecheck must not depend on build order — the clean-clone failure                                                                                                                                               | `types: ./dist/index.d.ts`               | 2026-08-13 |
| One scheduler tick, not one cron per source                                 | Due-ness is computed from **persisted** `lastCheckedAt`, so a restart resumes instead of re-fetching everything — which 60 in-memory jobs would do on every deploy                                                        | 60 registered cron jobs                  | 2026-08-13 |
| Hash-in-identity for HTML diffing                                           | Removes a second source of truth that can drift from `raw_items`                                                                                                                                                          | `page_snapshots` table                   | 2026-08-13 |
| 304 counts as **success** for the breaker                                   | Otherwise the breaker opens on the 45 sources behaving best                                                                                                                                                               | Counting non-200 as failure              | 2026-08-13 |
| `not_a_feed` / `empty_feed` do **not** trip the breaker                     | The source is reachable and its content is wrong — a registry problem for a human. Backing off hides it behind an open breaker                                                                                            | Treating all non-ok as transport failure | 2026-08-13 |
| `no-unnecessary-condition` off                                              | This codebase parses untrusted XML/HTML/JSON. A TS type over external input is a claim, not a guarantee; the rule flags exactly the runtime guards that make it safe                                                      | Enabling it                              | 2026-08-13 |

---

## H. MEASURED vs ASSUMED — do not confuse these

### MEASURED (2026-08-13, real runs)

| Value                                  | Measurement                                       |
| -------------------------------------- | ------------------------------------------------- |
| Sources healthy                        | **60/60**                                         |
| Items on first live ingest             | **5,198**                                         |
| **Conditional-request support**        | **45/60 sources (75%) answer 304**                |
| Live sweep, 60 sources, sequential     | **~35s**                                          |
| MOCK run, no network (`unshare -r -n`) | **962 items**                                     |
| Duplicates in `raw_items`              | **0**                                             |
| arXiv cs.AI feed size                  | **306 items** (was 344 on 2026-08-12 — it shrank) |
| Largest feed                           | `vercel-changelog`, 1,463 items / 3.1MB           |
| Tests                                  | **428**, ~5s                                      |
| `pnpm verify` cold                     | ~25s                                              |

### ASSUMED (plausible, unvalidated — treat as guesses)

- **Every scoring weight and reliability value.** `SOURCE_CATEGORY_RELIABILITY`
  encodes exactly one claim: vendor > journalist > comment thread. Nothing finer.
- **`operatorRelevance` per entity.** Ordering only.
- **Poll intervals** (5/15/60min/6h by priority).
- **Circuit-breaker constants** (3 failures, 30min opening, doubling).
- **Dedup threshold 0.86** — not yet implemented; Phase 4 must measure and replace it.
- **`AI_ANALYSIS_THRESHOLD=70`** and the **$37–60/month** cost estimate. Phase 6 must
  replace the estimate with a measurement.

### SPECULATIVE

- **HN/Reddit/GitHub velocity as a substitute for X velocity.** Explicitly INFERRED.
  Phase 12 must validate or discard it. Do not let it harden into an assumption.

### TO VALIDATE

1. Dedup precision/recall against a labelled set (Phase 4 — blocks that phase).
2. Rule-gate kill rate; target ≥85% (Phase 5).
3. Real cost per day (Phase 6).
4. Whether analyses are _non-obvious_ — human gate, and the risk the roadmap calls the
   one worth staring at.
5. Whether GitHub push protection covers Anthropic keys (Phase 14).
6. Reddit's Data API terms, read directly rather than via reporting.

---

## I. Environment

Full detail in `docs/ENV-HANDBOOK.md`. Run `pnpm check:env` for live state.

- **Phases 1–5 need no credentials at all.** Everything so far has run on zero.
- `.env` is gitignored (from the first commit, before any key existed).
  `.env.example` ships every credential **blank**, and `pnpm check:env:ci` fails the
  build if that ever changes.
- **`ANTHROPIC_API_KEY`** — the only mandatory secret, first needed in **Phase 6**,
  and only in `AI_MODE=LIVE`. _A key exists in the operator's environment; nothing has
  used it._
- `X_*` — Phase 12. `GITHUB_TOKEN` — optional, raises REST 60/h → 5000/h.
  `NTFY_TOPIC` — optional, and **the topic name IS the credential**.
- Missing credentials **degrade loudly**, never block startup. Every degradation is
  logged as a warning naming the subsystem and the reason.

> **`ANTHROPIC_API_KEY` being unset does not prove no credentials are configured.**
> The SDK also resolves `ANTHROPIC_AUTH_TOKEN` and an `ant auth login` profile on
> disk. Check `ant auth status` before assuming a run costs nothing.

---

## J. Test state

**879 tests, 25 files, all green.** `pnpm verify` = typecheck + lint + format-check + test + audit.

- **428 tests, 15 files, all passing.** `pnpm verify` green.
- `pnpm verify` = `format:check → lint → typecheck → test → build`. Identical to CI.
- Zero flaky tests. Nothing is skipped. No test requires a network or a credential.
- Security tests present: log redaction (30 cases), SSRF (33 cases including the
  redirect-into-metadata chain), `.env.example` leak checks, robots.txt.
- **Not yet written:** the prompt-injection corpus (Phase 6, ~30 hostile documents)
  and the labelled clustering fixture set (Phase 4, ~200 items / ~40 events). Both are
  blocking acceptance criteria for their phases.

---

## K. Known risks

| Risk                                  | Severity | State                                                                                                                                                 |
| ------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CI has never actually run**         | HIGH     | No GitHub repository exists. Every gate passes locally, but "CI is green" is unproven. See Open issues #1                                             |
| Analysis is competent but obvious     | HIGH     | The roadmap's own "risk worth staring at". Only caught by human gates in Phases 5–7                                                                   |
| Prompt injection                      | HIGH     | Mitigated by design (no tools on any model reading untrusted content) but **nothing is implemented yet** — Phase 6                                    |
| Silent source death (T-9)             | MEDIUM   | Freshness tracking done; alerting is Phase 11. The `status.claude.com` move is a live example of the class                                            |
| Cost blowout                          | MEDIUM   | Budget guard is Phase 6. **Nothing spends money today**                                                                                               |
| Local-only means missed detections    | MEDIUM   | Accepted through Phase 9; revisited with data at Phase 10                                                                                             |
| `hn-100points` depends on `hnrss.org` | LOW      | Third party, no SLA. Official HN feed registered alongside; client-side score filtering not built                                                     |
| One moderate dependency advisory      | LOW      | `esbuild <=0.24.2` via `drizzle-kit`'s deprecated `@esbuild-kit` chain. Dev-server CVE; that server is never run. Below the `--audit-level=high` gate |

---

## L. Open issues

| #   | Issue                                                                                                                                                                                                                                                                                                                   | Priority | Phase | Where                                 |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----- | ------------------------------------- |
| 1   | **No GitHub repository.** `git init` done, CI written, `gh` authenticated, but creating a public repo under the operator's account was not done on his behalf. Until it exists, "CI green" cannot be claimed and phase tags are local. Unblock: `gh repo create signal-desk --public --source=. --remote=origin --push` | **HIGH** | all   | —                                     |
| 2   | Phase 3 exit criterion: **≥24h continuous live ingestion** not yet run                                                                                                                                                                                                                                                  | HIGH     | 3     | `pnpm worker:dev`                     |
| 3   | Ingest makes one attempt per tick; retry/backoff is implemented but unused inside a tick                                                                                                                                                                                                                                | LOW      | 3     | `apps/worker/src/ingest.ts`           |
| 4   | `GithubApiClient` written and never called                                                                                                                                                                                                                                                                              | LOW      | 5     | `packages/adapters/src/github-api.ts` |
| 5   | Individuals list is _probed_, not _vetted_ — the "first on a checkable claim twice in 6 months" criterion needs an archive read                                                                                                                                                                                         | MEDIUM   | 12    | `SOURCE-INTELLIGENCE.md` §4           |
| 6   | Reddit Data API terms unread                                                                                                                                                                                                                                                                                            | LOW      | —     | `SOURCE-INTELLIGENCE.md` §7           |
| 7   | `hamel.dev` warns on every probe until its publisher fixes their build                                                                                                                                                                                                                                                  | LOW      | —     | —                                     |
| 8   | Weekly live API smoke test (the one CI job holding a secret) not created                                                                                                                                                                                                                                                | LOW      | 6     | `.github/workflows/`                  |

---

## M. Phases 5 and 6 — the record

### Phase 5 — Scoring and the rule gate (CODE-COMPLETE, tag `phase-5-complete`)

`packages/core/src/score/` — `weights.ts` (every constant, each labelled an
unvalidated guess), `importance.ts`, `relevance.ts`, `confidence.ts`, `gate.ts`.
`packages/db` gained `event_scores` (append-only). `pnpm score -- --top` runs it.

**MEASURED:** gate kill rate **98.7% overall / 91.5% excluding staleness** over 5,007
real events, against a ≥85% target. 65 events pass the gate.

**The first measurement failed at 17%.** Recency was a score _component_, so
years-old Vercel changelog entries lost points and still cleared the floor. Staleness
is a **kill rule**, not a penalty — `ROADMAP.md` §1 optimises for EARLY. 17% → 98.7%.

**Two kill rates are reported, not one.** The first ingest backfilled whole archives,
so an overall rate is dominated by `too_old`. Quoting only 98.7% would be true and
misleading.

**Confidence is computed then CAPPED.** A weight can be outvoted — six comment
threads carry more weighted confidence than one official post, which is how a rumour
launders itself into fact (§T-2). A cap cannot. `applyCaps` is monotonically
non-increasing, proved by exhaustive property test over the whole input space.

### Phase 6 — AI analysis engine (CODE-COMPLETE, tag `phase-6-complete`)

`packages/ai/` — `envelope.ts` (random per-request delimiter, §T-1 mit 4),
`schema.ts` (`additionalProperties:false` everywhere, §T-1 mit 2), `budget.ts`
(NORMAL→FRUGAL→TRIAGE→SUSPENDED), `prompts.ts` (versioned), `client.ts` (**no tools,
ever** — §T-1 mit 1, asserted against the source), `validate.ts`, `engine.ts`,
`mock.ts`. `packages/core/src/security/` holds the 39-document injection corpus.
`packages/db` gained `analyses`. `pnpm analyze` runs it.

**The corpus found 22 real detector gaps.** Phase 4's detector covered overrides and
hidden text and missed every invisible-character payload, every score-manipulation
attempt, every fake-authority claim, every exfiltration probe, both schema attacks.

**Obfuscation defeated it completely** — `I<ZWSP>g<ZWSP>n…` matches no keyword, so
the payload most obviously designed to evade detection was the one that did. Fix:
match raw AND de-obfuscated, and treat invisible characters as a signal themselves.

**The four benign controls are the point.** A detector that flags everything passes
all 35 hostile cases. The hardest control is a legitimate article _about_ prompt
injection — what this operator monitors most. It must not be flagged.

**Haiku's 4,096-token cache floor is real and silent.** Below it:
`cache_creation_input_tokens: 0`, no error, full price forever. The first triage
prompt measured 1,626 tokens and a test caught it. At ~100 calls/day, crossing the
floor with useful content costs a third of a terse prompt.

**Zero events reached deep analysis, and the run says so.** Top combined score is 66;
`AI_ANALYSIS_THRESHOLD` is 70. Neither number was changed to make output look better.

---

## M2. Phases 7, 8 and 9 — the record

### Phase 7 — X content strategy engine (tag `phase-7-complete`)

`packages/core/src/strategy/` — `angles.ts` (8 expert angles), `forcing.ts`,
`options.ts` (five options, the panel, DON'T POST). `pnpm strategy -- --top`.

**MEASURED restraint: 50.8%** over the 65 gate survivors, against ≥30%.

**The first measurement failed at 20.6%, from two real bugs.** The CLI hardcoded
`expertSourceCount: 0`, silently disabling three of seven DON'T POST reasons; and it
ran over all 5,000 scored events, of which the gate had already killed 4,942. Asking
"should he post about this?" of an event the pipeline rejected is meaningless.

**Forcing rules run FIRST.** That ordering is what makes them unbypassable — there is
nothing for a positive recommendation to argue with. An event scoring 100 on every
axis is still forced to WAIT if its title reads as a rumour.

### Phase 8 — Educational content engine (tag `phase-8-complete`)

`packages/core/src/strategy/educational.ts`, `packages/ai/src/batch.ts`.

**Limitations are a code path, not a prompt instruction.** An opportunity that cannot
state its failure modes is not emitted. A field that is _usually_ filled is a field
that will one day be empty.

**The experiment generator never produces a `result`.** A test asserts the key is
absent, not merely empty. A generated result is a fabricated measurement.

**Batch is a deadline decision, not a cost decision.** `collectBatch` returns a Map
keyed by `custom_id` so correct usage is the only convenient usage — position-based
matching silently mis-attributes results, which is worse than a crash.

### Phase 9 — Trend intelligence (tag `phase-9-complete`)

`packages/core/src/trends/`, `trends` + `trend_observations` tables, `pnpm trend`.

**A test forced a modelling correction.** Saturation was gated on overall growth, but
a format that ramped then plateaued still shows strong growth because the early half
_contains the ramp_ — `40, 70, 72, 68, 65` reported +24% and was placed MAINSTREAM.
Growth ("how far has it come") and momentum ("is it still climbing") are different
questions; saturation turns on the second.

**Saturation scores breadth, not volume.** Loud in one community ≠ saturated.

**The machine never writes a human field.** `mechanism` etc. are `string | undefined`
rather than optional, so "not filled in" is representable, and `missing` names the
gaps. The automated signal is specified and deliberately **not wired** — the manual
path is complete and the automated path is a stub with no fabricated data behind it.

---

## M3. NEXT PHASE: Phase 10 — Dashboard command centre

Read `docs/ROADMAP.md` Phase 10 in full first.

**The house style, now established across five phases and worth stating once:**
compute, then cap in code — never in a prompt, never as a weight that volume can
outvote. Phase 5 caps confidence, Phase 6 caps the analysis output, Phase 7 forces the
recommendation. Anything a hostile document could influence gets this treatment.

**The second recurring lesson:** every measured acceptance criterion in Phases 5, 7 and
9 failed on its first run, and every failure was a real defect rather than a badly-set
threshold. Measure against real data before believing anything.

---

## N. Commands

```bash
pnpm install
pnpm verify              # format:check → lint → typecheck → test → build. What CI runs.
pnpm test                # vitest
pnpm build

pnpm check:env           # what is configured, what mode, what is degraded
pnpm check:env:ci        # validate .env.example (a CI gate)

pnpm db:migrate          # apply migrations
pnpm db:seed             # load source + entity registries (idempotent)
pnpm db:generate         # generate a migration after a schema change

pnpm sources:probe       # LIVE network. Health-check every source; non-zero on a P1 failure
pnpm sources:add         # add a source; probes first, refuses a URL that is not a feed

pnpm ingest:once         # one ingestion pass; honours DATA_MODE
pnpm ingest:once -- --force    # ignore poll intervals
pnpm worker:dev          # long-running worker with the scheduler
pnpm web:dev             # dashboard placeholder, 127.0.0.1:3000
```

**Verify the no-network claim:**

```bash
pnpm build && unshare -r -n -- node apps/worker/dist/cli/ingest.js --force --quiet
```

---

## O. Git state

- Branch: **`phase-1-foundation`** (all phases so far committed here; **no remote**)
- Tags: `phase-1-complete`, `phase-2-complete`, `phase-3-complete` — **local only**
- Working tree: clean at the time of writing
- Migrations: 3, all applied. `pnpm db:migrate` is idempotent
- `main` exists as the initial branch; **CI has never run** — there is nowhere for it
  to run

---

## P. CONTINUATION PROTOCOL

```
1.  Read this file.
2.  Read docs/ROADMAP.md — the current phase, in full, not a summary.
3.  Read the relevant sections of ARCHITECTURE.md, THREAT-MODEL.md, ENV-HANDBOOK.md.
4.  Read docs/WORKING-DISCIPLINE.md if you have not.
5.  pnpm install && pnpm verify        → must be green before you change anything.
6.  Verify the PREVIOUS phase's exit criteria yourself. Do not take this file's
    word for it; this file can be stale and says so.
7.  Implement ONLY the current phase.
8.  Write tests alongside, not after.
9.  When a phase measures a number that a document calls a guess, edit the document
    in the same change. A planning document still saying "starting guess" after the
    measurement exists is actively misleading.
10. pnpm verify → commit on a phase branch → push → CI green → next phase.
11. Every three phases, rewrite this file.
```

### The rule that overrides convenience

**Do not mark a phase done unless every acceptance criterion is actually met.**
Several criteria in this roadmap cannot be satisfied by writing code — they are human
judgment gates (Phases 5, 6, 7, 8) or elapsed-time observations (3, 9, 11, 13, 15).
Those are recorded as `PENDING-OPERATOR` / `PENDING-ELAPSED` and the phase is
**CODE-COMPLETE**, never `☑`.

Marking a phase done on the strength of a green test suite would be exactly the
confident wrongness this system exists to prevent, turned on itself.
