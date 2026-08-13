# ROADMAP.md

**Project:** `signal-desk` — a real-time AI / software / technology intelligence and personal
authority operations console for one technical operator.
**Written:** 2026-08-12. **Status:** in execution — see _Planning revisions_ below.

Companion documents: `ARCHITECTURE.md`, `SOURCE-INTELLIGENCE.md`, `THREAT-MODEL.md`,
`ENV-HANDBOOK.md`, `WORKING-DISCIPLINE.md`.

---

## Planning revisions

### 2026-08-13 — autonomous continuous execution

The per-phase human approval gate is removed. Phases now run continuously: once a phase's
implementation is complete, `pnpm verify` passes, and CI is green, the next phase begins without
waiting for an approval that this document previously required. The text at the foot of this
document reading _"PHASE 1 IS READY FOR APPROVAL"_ is superseded.

**What this revision does not change.** Every engineering gate in `WORKING-DISCIPLINE.md` stands:
no green CI, no next phase; tests written alongside implementation; measured numbers replace
guessed ones in the same change; no secrets in the repository; no autonomous publishing.

**What it cannot change, and this document is explicit about rather than quietly dropping.** Some
acceptance criteria here are not satisfiable by writing code, and removing the approval gate does
not convert them into criteria that are. They fall into two kinds:

| Kind                                                                          | Marked             | Examples                                                                                                                                          |
| ----------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Human acceptance gates** — require the operator's own judgment              | `PENDING-OPERATOR` | Phase 5 top-20 ordering review; Phase 6 "20 analyses judged non-obvious"; Phase 7 "≥60% of QUOTE-NOW recommendations he would act on"             |
| **Elapsed-time observations** — require the system to run for a stated period | `PENDING-ELAPSED`  | Phase 3 ≥24h continuous ingestion; Phase 9 ≥2 weeks trend tracking; Phase 11 ≤2 alerts/day over two weeks; Phase 13 7 days live; Phase 15 30 days |

A phase whose code, tests, and CI are complete but which carries one of these is recorded as
**CODE-COMPLETE**, never as done. `☑` means every criterion is met, including those two kinds.
Marking a phase done on the strength of a green test suite alone would be exactly the confident
wrongness this system exists to prevent, applied to itself.

---

## 1. Vision

> See what matters early, understand it deeply, work out what it means, find the strongest
> contribution this operator can make, and help him publish something genuinely useful before the
> conversation moves on.

This is not a news reader, a scheduler, a marketing tool, or a bot. It is an instrument for
converting information into earned technical credibility.

The optimisation target is **EARLY + ACCURATE + USEFUL + ORIGINAL** — in that combination. Fast and
wrong is worse than slow and trustworthy, because the asset being built is trust.

## 2. Objectives

1. Detect developments across AI, software, hardware, platform policy, and emerging social formats,
   from primary sources, with measured latency.
2. Deduplicate them into canonical events with attached evidence.
3. Score them on two independent axes: **objective importance** and **relevance to this operator**.
4. Produce analysis that a technically serious reader would find non-obvious — with explicit
   confidence, explicit unknowns, and traceable sources for every factual claim.
5. Recommend the single strongest action, including the recommendation not to post.
6. Keep a human in the loop for every published word.
7. Measure what actually built authority, and feed that back into scoring.

## 3. Non-goals

- Autonomous posting. Not in any phase of this plan.
- Product marketing. The engine is product-agnostic; FormAI and any future app are downstream
  content opportunities, never the system's organising principle.
- Multi-user, multi-tenant, or SaaS.
- Scraping platforms whose terms prohibit it.
- Follower-count maximisation. The system tracks visibility, authority, and audience _quality_
  separately, and reports when growth is low-quality virality rather than authority.
- Volume. More posts is not the goal and the system will actively recommend against posting.

## 4. Architecture summary

TypeScript modular monolith. Two entrypoints (`worker`, `web`) over shared packages. SQLite + WAL,
`sqlite-vec` for similarity, local ONNX embeddings, Anthropic as the only AI vendor, in-process
scheduler, Next.js dashboard. Runs locally through Phase 9; containerised from Phase 1 so
deployment is a decision, not a rewrite. Full reasoning and rejected alternatives:
`ARCHITECTURE.md`.

## 5. Information quality model

Every claim carries one tag, and the tag is rendered next to the claim in the UI:

| Tag             | Meaning                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------- |
| **VERIFIED**    | Supported by a primary source — official announcement, official docs, source code, release note               |
| **OBSERVED**    | Supported by repeated independent measurement, a large dataset, or multiple credible independent observations |
| **INFERRED**    | A reasonable conclusion from multiple known facts, stated as a conclusion                                     |
| **SPECULATIVE** | A possible interpretation, not established                                                                    |

Speculation may never be presented as fact. An event whose evidence is entirely unofficial cannot
be emitted at `confidence = HIGH` — enforced in code, tested in `THREAT-MODEL.md` §5 test 7.

## 6. Event vs trend — kept separate throughout

- **EVENT** — a factual external development. Has a timestamp, sources, and a before/after.
- **TREND** — a social behaviour, format, or interaction pattern. Has a lifecycle, not a timestamp.

An event can matter without being a trend; a trend can matter without being news. They have separate
tables, separate scoring, and separate UI. Conflating them is the most common way this kind of
system produces bad advice.

## 7. Scoring

Two scores, deliberately independent (brief §22), because "important" and "important _for me_" are
different questions and merging them hides the second.

**Importance (0–100)** — recency, source reliability, novelty, technical impact, business impact,
developer impact, consumer impact, breadth of independent corroboration, discussion velocity.

**Brand relevance (0–100)** — proximity to the operator's actual expertise, whether he can _test_ it,
whether he can add something not already said, likely audience interest, authority upside,
discussion potential, teaching potential.

**Confidence (LOW/MED/HIGH)** — derived from source category mix and corroboration count, capped by
rules (see §5).

Initial weights are **explicit constants in one file**, hand-set and clearly labelled as unvalidated
guesses. Phase 12 replaces them with weights fitted against measured outcomes, replaying three
months of immutable `raw_items` offline at zero API cost. Until then the system does not pretend the
numbers mean more than they do.

---

# Phases

Status legend: ☐ not started · ◐ in progress · ☑ done.

Every phase follows the same structure. `COMMIT/PUSH` and `CI` are identical for all phases and are
stated once here rather than repeated fifteen times: **commit on a `phase-N-*` branch, PR to `main`,
CI must be green before the next phase begins, tag `phase-N-complete` on merge** — see
`WORKING-DISCIPLINE.md`.

---

## ☑ Phase 1 — Foundation, CI, and engineering discipline

> **DONE 2026-08-13.** Tag `phase-1-complete`. All six acceptance criteria met; exit criterion
> (clean-clone build on a second path) verified. 90 tests at the time; 519 now.
>
> CI went green on `github.com/emredogan-cloud/signal-desk` once the repository existed —
> run 31721212994, Node 22 and Node 24, with the security job passing.

**OBJECTIVE** A public repository that builds, tests, lints, type-checks, and scans for secrets on
every push — containing no intelligence features whatsoever.

**WHY** Every later phase depends on the ability to change code safely without a reviewer. Building
this after the features means retrofitting discipline onto a codebase that already drifted.

**INPUTS** None. No credentials.

**IMPLEMENTATION**

- `git init`, public GitHub repo, MIT licence, `.gitignore` (with `.env` and `data/` from the first
  commit, before any key exists)
- pnpm workspace: `apps/worker`, `apps/web`, `packages/{core,adapters,db,ai,shared}`
- TypeScript strict (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`)
- ESLint flat config + Prettier; `dangerouslySetInnerHTML` banned in `apps/web`
- Vitest with coverage
- Drizzle + SQLite; one migration creating the `sources` table; `pnpm db:migrate`
- `packages/shared/config.ts` — Zod-validated environment parsing, fails fast on invalid values
- `.env.example` exactly as in `ENV-HANDBOOK.md` §8
- `pnpm verify` = format:check → lint → typecheck → test → build
- `pnpm check:env` — prints the variable/mode/degradation table
- `.github/workflows/ci.yml` running every gate from `WORKING-DISCIPLINE.md`, **with no secrets**
- gitleaks + GitHub push protection enabled
- `pnpm` configured with `ignore-scripts=true`
- Dockerfile (multi-stage) — unused for now, keeps the deployment option open cheaply
- README: what this is, how to run it, honest statement of current capability
- The six planning documents committed under `docs/`

**COMPONENTS** Repo scaffold, config layer, DB layer skeleton, CI pipeline.

**TESTS** Config parser: valid env, invalid enum, missing optional, missing required-with-default.
A smoke test asserting the worker starts and exits cleanly in MOCK mode.

**ACCEPTANCE CRITERIA**

- [ ] `pnpm install && pnpm verify` passes from a clean clone
- [ ] CI green on `main` with zero secrets configured
- [ ] `pnpm check:env` correctly reports all-MOCK with no `.env` present
- [ ] gitleaks passes; a deliberately planted fake key in a scratch commit is caught (then removed)
- [ ] `docker build` succeeds
- [ ] README does not overstate what exists

**EXIT CRITERIA** All of the above, plus: the operator has cloned the repo fresh on a second path
and run `pnpm verify` successfully. A build that only works on the author's machine has not been
verified.

**ROLLBACK** N/A — nothing to roll back to.

### Phase 1 outcome — 2026-08-13

| Acceptance criterion                             | Result                                                                                                                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm install && pnpm verify` from a clean clone | ✅ verified on a second path — and it failed there first; see below                                                                                                |
| CI green on `main` with zero secrets             | ✅ **VERIFIED 2026-08-13** on `github.com/emredogan-cloud/signal-desk`, run 31721212994: `verify (node 22)` ✅ · `verify (node 24)` ✅ · `security` ✅             |
| `pnpm check:env` reports all-MOCK with no `.env` | ✅                                                                                                                                                                 |
| gitleaks passes; a planted fake key is caught    | ⚠️→✅ **failed on first run** — the default ruleset has no Anthropic pattern at all. Fixed with `.gitleaks.toml`; re-tested and caught. See `THREAT-MODEL.md` §T-3 |
| `docker build` succeeds                          | ✅ multi-stage, non-root, unused by design                                                                                                                         |
| README does not overstate what exists            | ✅ carries an explicit built/not-built table                                                                                                                       |

**Delivered beyond the literal list, and why.** Two items were pulled forward because they are
cheaper to build now than to retrofit:

- **Log secret redaction** (`packages/shared/redact.ts`) — `THREAT-MODEL.md` §5 test 4 assigns this
  to Phase 14, but the logger is written in Phase 1 and every later phase logs through it. Adding
  redaction afterwards means auditing every existing call site instead of none. 30 tests.
- **The MOCK badge** on the placeholder page — nothing can be mislabelled yet, which is exactly why
  it is free to add now and guarantees it is never a Phase 10 afterthought.

**What the exit criterion caught.** The clean-clone requirement — "a build that only works on the
author's machine has not been verified" — earned its place immediately. On a fresh clone `pnpm
verify` failed with **183 lint errors**, none of which appeared locally: the verify chain lints
before it builds, so the workspace packages' `dist/*.d.ts` files did not exist yet and
typescript-eslint could not resolve a single cross-package type. Locally it passed only because a
previous build had left `dist/` behind.

Fixed by pointing each internal package's `types` and `exports.types` at `./src/index.ts` while
`main` stays on `./dist/index.js` — type resolution from source, runtime resolution from build
output. Lint and typecheck no longer depend on build order, which is also why they are now faster.
Re-verified from a fresh clone: green.

**Measurements.** None of this phase's numbers were previously guesses, so no document values were
replaced. Recorded for reference: `pnpm verify` takes ~25s cold; the test suite runs in 0.6s; the
Docker image builds in ~2min.

**Known gaps carried forward.**

1. The **repository name** is settled as `signal-desk` (§12 listed it as deliberately unresolved).
2. The **individuals watchlist** (`SOURCE-INTELLIGENCE.md` §4) is still empty. It is Phase 2 work.
3. The scheduled **weekly live API smoke test** from `WORKING-DISCIPLINE.md` is not created. It is
   the one job that holds a secret and has nothing to test until `packages/ai` exists in Phase 6.
4. `packages/{core,adapters,ai}` are documented scaffolds with no logic, as this phase specifies.
5. ~~No GitHub repository yet.~~ **Resolved 2026-08-13** — the operator created
   `github.com/emredogan-cloud/signal-desk` and CI has run green. Two real defects surfaced on the
   first run that no amount of local checking had caught:
   - the smoke-test step invoked the worker without `--once`, so it started a scheduler and hung
     until the job was killed. Phase 3 introduced the flag and never updated the workflow.
   - two pipeline tests exceeded vitest's 5s default on the CI runner while passing in ~1s locally.
     The cause was not the runner: `attachToEvent` reloaded every event with all of its evidence on
     every merge. Fixed; the suite went from 29.6s to 7.4s.
6. **One moderate dependency advisory**, below the `--audit-level=high` CI gate and left in place
   deliberately: `esbuild <=0.24.2` (GHSA-67mh-4wv8-2f99) reaching the tree through
   `drizzle-kit > @esbuild-kit/esm-loader > @esbuild-kit/core-utils`. The vulnerability is that
   esbuild's _development server_ accepts cross-origin requests. Nothing here runs that server;
   drizzle-kit uses esbuild to transpile a config file at CLI invocation. The fix belongs upstream
   in drizzle-kit's deprecated `@esbuild-kit` chain, and a `pnpm.overrides` pin would silence the
   advisory without changing what actually executes. Re-check at Phase 14's dependency audit.
7. **GitHub push protection** is not verified. It is the redundant half of the T-3 secret-scanning
   control, and the Anthropic finding above showed that assuming a scanner covers a format is
   exactly the wrong move. Enable and test it when the repository is created.

---

## ☑ Phase 2 — Source registry and watchlist

> **DONE 2026-08-13.** Tag `phase-2-complete`. All six acceptance criteria met; exit criterion
> (`SOURCE-INTELLIGENCE.md` updated with every newly verified and newly dead feed) met.
> **60 sources registered, 60 probed healthy, 1 warning, 0 failures.** 294 tests.
> CI green on GitHub Actions, run 31721212994.

**OBJECTIVE** Every source from `SOURCE-INTELLIGENCE.md` in the database, probed, with a working
health view.

**WHY** Silent source death (T-9) is the single most likely operational failure. The registry and
its freshness tracking exist before ingestion, not after.

**INPUTS** `SOURCE-INTELLIGENCE.md`. No credentials.

**IMPLEMENTATION**

- Full `sources` schema per `SOURCE-INTELLIGENCE.md` §6
- Seed file with all VERIFIED sources, including `verified_at`
- `pnpm sources:probe` — fetches every registered source, reports HTTP status, content type, item
  count, and elapsed time as a table; writes `verified_at`
- Entity registry: canonical entities (`anthropic`, `openai`, `nvidia`, …) with aliases, so
  "Claude", "Anthropic", and "claude-opus-5" resolve to one entity
- `pnpm sources:add` CLI
- Default poll intervals by priority

**COMPONENTS** `packages/db` source + entity models, probe CLI.

**TESTS** Seed integrity (no duplicate ids, every URL parses, every priority in range, every
category valid). Entity alias resolution. Probe result parsing against fixtures including the
"200 with HTML body" case that killed three candidate feeds during research.

**ACCEPTANCE CRITERIA**

- [ ] ≥30 sources seeded, every one probed and VERIFIED with a date
- [ ] `pnpm sources:probe` produces a readable table and exits non-zero if any Priority-1 source fails
- [ ] Anthropic's `html_diff` target chosen, its `robots.txt` checked and recorded
- [ ] Cloudflare / Vercel / AWS / Supabase status feeds probed and added
- [ ] Entity registry resolves the alias set for the top 15 entities
- [ ] The individuals list gap (§4 of the source doc) is either filled or explicitly deferred in writing

**EXIT CRITERIA** Above + `SOURCE-INTELLIGENCE.md` updated with every newly verified feed and every
newly discovered dead one.

**ROLLBACK** Registry is data. Revert the seed.

### Phase 2 outcome — 2026-08-13

| Acceptance criterion                                                                        | Result                                                                                                                             |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| ≥30 sources seeded, every one probed and VERIFIED with a date                               | ✅ **60 sources, 60 healthy.** No unprobed row exists in the registry                                                              |
| `sources:probe` produces a readable table and exits non-zero if any Priority-1 source fails | ✅ Table + failure detail + warning detail; exit code unit-tested across every outcome                                             |
| Anthropic's `html_diff` target chosen, `robots.txt` checked and recorded                    | ✅ `anthropic.com/news`; `robots.txt` = `Allow: /`                                                                                 |
| Cloudflare / Vercel / AWS / Supabase status feeds probed and added                          | ✅ all four VERIFIED                                                                                                               |
| Entity registry resolves the alias set for the top 15 entities                              | ✅ 19 entities, 83 aliases, 32 resolution cases asserted                                                                           |
| The individuals list gap is filled or explicitly deferred in writing                        | ✅ **filled** — 9 new sources, with the one selection criterion that went unverified stated plainly in `SOURCE-INTELLIGENCE.md` §4 |

**Measured values recorded** (replacing the document's 2026-08-12 hand-probe figures): arXiv cs.AI
**344 → 306** items; OpenAI News 1125 → 1126; Vercel 1457 → 1463; OpenAI Status 92 → 91. Whole-registry
probe wall time ≈ 12s at concurrency 6.

**Three things the live probe found that no amount of code review would have.**

1. **`XMLValidator` as a gate is wrong in both directions.** Validating before parsing rejected
   `hamel.dev/index.xml` outright — a feed that is genuinely malformed (two concatenated documents,
   line 5536) and genuinely carries 20 real items. Skipping validation entirely mislabels truncated
   XML as `empty_feed`, sending the operator to the publisher when the fault is the transfer. The
   design is now: **items decide the outcome, validity decides whether there is a warning.** A
   warning never affects the exit code.
2. **Alias normalisation must decompose, not compose.** `normalizeAlias` used NFKC, which leaves
   "á" as one code point that no combining-mark class matches — so diacritics survived and the fold
   silently did nothing. NFKD fixed it. A unit test caught this; nothing else would have.
3. **The unique index on `entity_aliases.normalized` earned its place on first use**, rejecting the
   seed because "Next.js"/"NextJS", "Hugging Face"/"HuggingFace", and "x-algorithm"/"X algorithm"
   fold to one key each. Within one entity that is correct behaviour, not a collision, so seeding
   now folds duplicates and raises `CrossEntityAliasError` only when two _different_ entities claim
   one alias.

**Delivered beyond the literal list.** `safeFetch` (timeout, response size cap enforced against
bytes actually read rather than a trusted `content-length`, manual redirect following capped at 3,
scheme allowlist). The roadmap places these in Phase 3, but the probe needed them, and a fetch
without them is how one misbehaving feed hangs the worker. The T-6 SSRF controls proper — host
allowlist, private-range blocking, per-hop re-checking — remain Phase 3, where the system first
follows URLs found _inside_ content.

**Known gaps carried forward.**

1. `hn-100points` depends on `hnrss.org`, which has no SLA. The official HN feed is registered
   alongside it, but **client-side score filtering is not built** — so the fallback covers
   availability, not the ≥100-point filter. Phase 3/5 work; seeded at reliability 0.4 meanwhile.
2. **Reddit's Data API terms have not been read directly** (`SOURCE-INTELLIGENCE.md` §7 item 5).
   Deferred deliberately: the design conclusion — public `.rss` only, no durable storage of user
   text — is unaffected either way.
3. The individuals list is _probed_, not _vetted_: the "first on a checkable claim twice in six
   months" criterion needs an archive read. Prune at Phase 12 against measured precision.
4. `hamel.dev` warns on every probe run until its publisher fixes their build.

---

## ◐ Phase 3 — Ingestion adapters

> **CODE-COMPLETE 2026-08-13.** Tag `phase-3-complete`. Five of six acceptance
> criteria met and measured. 428 tests at the time. CI green.
>
> **Outstanding: `PENDING-ELAPSED` — the exit criterion** requires "≥24 hours of
> continuous live ingestion with source-freshness telemetry recorded for every
> source". The telemetry exists and is recorded; the 24 hours have not passed. Start
> the worker (`pnpm worker:dev`) and re-check tomorrow.

**OBJECTIVE** Scheduled, polite, resilient fetching from every source type into an immutable
`raw_items` table.

**WHY** Everything downstream is a function of this. It must be boring and correct.

**INPUTS** Phase 2 registry. `GITHUB_TOKEN` optional.

**IMPLEMENTATION**

- Adapter interface: `fetch(source, cursor) → RawItem[]`
- `RssAdapter` (RSS + Atom, `fast-xml-parser`)
- `GithubAtomAdapter` (`releases.atom`, `commits/{branch}.atom`) — no auth required
- `GithubApiAdapter` — enrichment only, with the 60/hour unauthenticated limit respected explicitly
- `StatusPageAdapter`
- `HtmlDiffAdapter` — `robots.txt` respected, content-hash diffing, ≥15-minute floor
- Every adapter has a `Mock*` twin reading `fixtures/`
- Conditional requests (`If-None-Match` / `If-Modified-Since`); 304 handling
- SSRF guards and host allowlist per `THREAT-MODEL.md` §T-6
- Timeouts, response size caps, retry with exponential backoff, per-source circuit breaker
- Descriptive `User-Agent` naming the project and linking the repo
- `croner` scheduler honouring per-source intervals with jitter
- `raw_items` written immutably with fetch metadata

**COMPONENTS** `packages/adapters`, scheduler in `apps/worker`.

**TESTS** Per-adapter parsing against recorded fixtures; malformed XML; a feed returning 200 with
HTML; empty feed; 304; 429 with backoff; redirect chain ending at a private IP (must be rejected);
oversized response; timeout. Scheduler interval and jitter logic.

**ACCEPTANCE CRITERIA**

- [ ] `DATA_MODE=LIVE` run ingests from all seeded sources with zero unhandled errors
- [ ] A one-hour live run produces a plausible item count with no duplicates in `raw_items`
- [ ] 304s are observed and cost no parsing work
- [ ] All SSRF tests pass
- [ ] `DATA_MODE=MOCK` reproduces a full run from fixtures with no network access at all
      (verified by running with networking disabled)
- [ ] Circuit breaker demonstrably opens on a source returning persistent 500s

**EXIT CRITERIA** Above + ≥24 hours of continuous live ingestion with source-freshness telemetry
recorded for every source.

**ROLLBACK** Adapters are additive per source type. Disable a source row rather than reverting code.

### Phase 3 outcome — 2026-08-13

| Acceptance criterion                                                            | Result                                                                                                                                                           |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATA_MODE=LIVE` run ingests from all seeded sources with zero unhandled errors | ✅ **60/60, 5,198 items, 0 failures** (after the registry fix below)                                                                                             |
| A run produces a plausible item count with no duplicates in `raw_items`         | ✅ 5,198 items; `duplicateExternalIds()` returns empty, and the second pass inserted **0**                                                                       |
| 304s are observed and cost no parsing work                                      | ✅ **measured: 45 of 60 sources answered 304** on the second pass — 75% of the registry supports conditional requests                                            |
| All SSRF tests pass                                                             | ✅ 33 cases including the redirect-into-metadata chain from `THREAT-MODEL.md` §5 test 3                                                                          |
| `DATA_MODE=MOCK` reproduces a full run with no network access at all            | ✅ **verified under `unshare -r -n`** — 60 sources, 962 items, network namespace with no interfaces. Also enforced as a unit test whose `fetch` throws if called |
| Circuit breaker demonstrably opens on persistent 500s                           | ✅ end-to-end against the real database: opens at 3 failures, skips the source, closes on recovery, and does **not** trip on a 304                               |
| **≥24h continuous live ingestion** (exit criterion)                             | ⏳ **PENDING-ELAPSED**                                                                                                                                           |

**Measured values.**

| Measurement                                 | Value                                   |
| ------------------------------------------- | --------------------------------------- |
| Live registry sweep, 60 sources, sequential | ~35s                                    |
| Items on first ingest                       | 5,198                                   |
| Conditional-request support                 | **45/60 sources (75%)**                 |
| Largest single feed                         | `vercel-changelog`, 1,463 items / 3.1MB |
| MOCK run (fixtures, no network)             | 962 items                               |

**What the first LIVE run found that nothing else would have.**

**Two registered hosts had moved, and only ingestion noticed.** `status.anthropic.com`
now 302s to `status.claude.com`, and `docs.claude.com` 301s to `platform.claude.com`.
`pnpm sources:probe` reported both as _healthy_ — a probe follows redirects — while
ingestion refused them, because the SSRF allowlist is built from **registered**
hostnames and a cross-host hop lands outside it.

The allowlist was right; the registry was stale. Both URLs are now registered at
their canonical hosts, and **the probe now warns on any cross-host redirect** so this
drift surfaces at health-check time instead of costing a detection. A Priority-1
source failing while the health check says green is exactly the T-9 shape the
registry exists to prevent, and it had reproduced itself inside the tooling.

**Design decisions worth recording.**

- **`page_snapshots` was designed, then deleted before it shipped.** HTML diffing
  needs to know whether a page changed. Rather than store last-seen hashes, the hash
  is encoded into the item's identity: link mode keys on the URL, text mode on
  `page:<hash>`. An unchanged page therefore produces an id already in `raw_items` and
  inserts nothing. A snapshot table would have been a second source of truth able to
  drift from `raw_items`, for no additional capability.
- **One scheduler tick, not sixty cron jobs.** Due-ness is computed from the
  persisted `lastCheckedAt`, so a restart resumes rather than re-fetching everything —
  which sixty in-memory jobs would do on every deploy, turning a restart into a burst
  against every publisher at once.
- **A 304 is a success for the circuit breaker.** Counting it as a failure would open
  the breaker on precisely the 45 sources behaving best.
- **`not_a_feed` and `empty_feed` do not trip the breaker.** They mean the source is
  reachable and its _content_ is wrong — a registry problem for a human, not a reason
  to stop asking. Backing off would hide the fault behind an open breaker instead of
  surfacing it on the freshness panel.

**Known gaps carried forward.**

1. **The 24-hour continuous run has not happened.** This is the exit criterion.
2. `GithubApiClient` exists with its budget tracking and is **not yet called** —
   enrichment is driven from Phase 5 scoring, which does not exist. Registered as
   `github_api`, it deliberately throws if the scheduler ever reaches it.
3. Retry-with-backoff is implemented and unit-tested, but the ingest loop currently
   makes **one attempt per tick** rather than retrying inside a tick. For a source
   polled every 5 minutes the next tick _is_ the retry, and an in-tick retry would
   mostly serve to hit a struggling host three times instead of once. Revisit if
   measurement shows single-attempt failures that a 30-second retry would have caught.
4. `eugeneyan.com` serves its full 212-item archive; the first ingest reads as a burst
   of activity that is really history.

---

## ◐ Phase 4 — Normalisation, clustering, deduplication

> **CODE-COMPLETE 2026-08-13.** Tag `phase-4-complete`. Five of six acceptance
> criteria met and measured; the sixth is `PENDING-ELAPSED`. 519 tests.
>
> **Measured: precision 1.0000, recall 0.9500** (bar: ≥0.95 / ≥0.85). The 0.86 guess
> is replaced by a measured **0.80** in `ARCHITECTURE.md` §5.
>
> **Outstanding: `PENDING-ELAPSED`** — the exit criterion is "a week of live data
> reviewed by eye, with any misclustering added to the labelled set as a regression
> case". One pass over 5,208 real items has been reviewed and produced three
> corrections (below); a week has not elapsed.

**OBJECTIVE** Many source items become one canonical event with attached evidence.

**WHY** Brief §19–20. Without this the dashboard is a feed reader showing the same launch nine times.

**INPUTS** Phase 3 `raw_items`. No credentials — embeddings are local.

**IMPLEMENTATION**

- Sanitisation pipeline (T-1 mitigation 3) — runs here, before anything stores or reads content
- Normalisation → `CanonicalEvent` draft: entity extraction via the Phase-2 registry, artifact
  extraction (model names, version strings, product names) by rule, URL canonicalisation,
  `event_occurred_at` from feed timestamps
- Three-stage dedup per `ARCHITECTURE.md` §5
- `sqlite-vec` + local `bge-small-en-v1.5` ONNX embeddings
- Primary-source selection by source category, not arrival order
- Merge audit log; reversible unmerge

**COMPONENTS** `packages/core/normalize`, `packages/core/cluster`.

**TESTS** A **labelled fixture set**: ~200 real items covering ~40 known events, hand-labelled with
the correct clustering. Measured precision and recall reported by the test suite. Adversarial cases:
two genuinely different models from the same vendor announced the same day (must NOT merge); the
same launch reported by six outlets (must merge); an update to an existing event arriving 3 days
later. Sanitiser tests from `THREAT-MODEL.md` §5.

**ACCEPTANCE CRITERIA**

- [ ] Dedup precision ≥0.95 and recall ≥0.85 on the labelled set — **and the actual measured numbers
      written into `ARCHITECTURE.md` §5, replacing the 0.86 guess**
- [ ] The six-outlet launch case produces exactly one event with six evidence rows
- [ ] The two-models-same-day case produces two events
- [ ] Unmerge restores prior state exactly
- [ ] Sanitiser neutralises every case in the hidden-text fixture set
- [ ] Full pipeline replay over `raw_items` is deterministic — same input, same clusters

**EXIT CRITERIA** Above + a week of live data reviewed by eye, with any misclustering added to the
labelled set as a regression case.

**ROLLBACK** Clustering runs over immutable `raw_items`. Any change can be re-run from scratch;
`events` is a derived table.

### Phase 4 outcome — 2026-08-13

| Acceptance criterion                                                                           | Result                                                                                          |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Dedup precision ≥0.95 and recall ≥0.85, **measured numbers written into `ARCHITECTURE.md` §5** | ✅ **precision 1.0000, recall 0.9500**; threshold **0.86 → 0.80**, recorded with the full sweep |
| The six-outlet launch case produces exactly one event with six evidence rows                   | ✅                                                                                              |
| The two-models-same-day case produces two events                                               | ✅                                                                                              |
| Unmerge restores prior state exactly                                                           | ✅ transactional; also re-points the primary and recomputes aggregates                          |
| Sanitiser neutralises every case in the hidden-text fixture set                                | ✅ 8-document corpus; every one neutralised **and flagged**                                     |
| Full pipeline replay over `raw_items` is deterministic                                         | ✅ asserted by rebuilding and comparing an event signature                                      |
| **A week of live data reviewed by eye** (exit criterion)                                       | ⏳ **PENDING-ELAPSED** — one pass reviewed, a week has not elapsed                              |

**Measured values.**

| Measurement                                       | Value                                   |
| ------------------------------------------------- | --------------------------------------- |
| Dedup threshold                                   | **0.80** (was a 0.86 guess)             |
| Precision / recall, all clusters                  | **1.0000 / 0.9500**                     |
| Precision / recall, real clusters only            | **1.0000 / 1.0000**                     |
| Cross-category similarity margin                  | **+0.04**                               |
| Real items clustered                              | **5,208 → 5,007 events**                |
| Merges by stage                                   | s1 = 48 · s2 = 23 · s3 = 130            |
| Clustering wall time, 5,208 items incl. embedding | ~109s                                   |
| Embedding model load (first, incl. download)      | ~50s · warm batch of 3: 16ms · 384 dims |

**Three rules the real data forced, none of which the labelled set could have found.**

1. **A repository is a container, not an identity.** Every `llama.cpp` release shares
   `repo:ggml-org/llama.cpp`, so stage 2 merged **seven consecutive builds into one
   event**, hiding six releases. Only model ids and version strings identify an event.
2. **An artifact in a title is a claim; in a body it is a mention.** Five unrelated
   arXiv papers merged because each abstract said "gpt-4o" — they all _evaluated_ the
   model, none _was_ its release.
3. **Conflicting identity artifacts block a stage-3 merge at any similarity.**
   `b10400` and `b10405` embed at cosine **0.9649**.

> Rules 1 and 2 were invisible to a 25-item labelled set and appeared within seconds
> over 5,208 real items. This is precisely why the exit criterion is real data
> reviewed by eye rather than a green measurement.

**Other real bugs the tests caught.**

- `unmergeEvidence` moved the row but never recomputed the source event's counts, so
  the event kept claiming evidence it no longer had — and nothing would ever have
  noticed, because those counts are only read, never re-derived.
- The pipeline read a query's `LIMIT 5000` as a ceiling and **silently processed
  5,000 of 5,208 items while reporting success**. Now cursor-paginated to drain.
- `normalizeAlias` used NFKC (composing) rather than NFKD, so diacritic folding
  silently did nothing.
- An unparseable publisher timestamp propagated as `Invalid Date`, which compares
  false against everything — such an item would never cluster and nothing would say why.

**Known gaps carried forward.**

1. The **labelled set is 25 items across 15 clusters**, not the ~200/~40 the phase
   text asks for. Ten days of this registry produced very few genuine multi-outlet
   clusters, because it is deliberately weighted toward primary sources that do not
   duplicate each other. Padding it with guessed labels would have measured the
   labeller. Composition and the exact labelling method are declared in
   `fixtures/labelled/README.md`; **the labels were assigned by the agent, not the
   operator**, and the real ones are worth ten minutes of review.
2. `sqlite-vec` is **installed and verified working** (v0.1.9, KNN confirmed) but
   **not used**: stage 3 compares against a window-bounded candidate set of a few
   hundred vectors, which is a brute-force cosine loop taking microseconds. It earns
   its place when the candidate set stops being small, not before.
3. GitHub _activity_ items ("simonw pushed sqlite-utils", ×9) cluster together at
   stage 3. Defensible as one "activity" event, but it is a judgment the operator
   should confirm.
4. The one missed merge in the labelled set is an outage reported by a status page and
   by Hacker News in different words. Stage 3 scores it just under the threshold.

---

## ◐ Phase 5 — Scoring: importance, brand relevance, confidence

> **CODE-COMPLETE 2026-08-13.** Tag `phase-5-complete`. Three of four acceptance
> criteria met and measured. 565 tests, CI green.
>
> **Measured gate kill rate: 98.7% overall, 91.5% excluding the staleness rule**
> (target ≥85%). Both reported, because one would mislead — see the outcome below.
>
> **Outstanding: `PENDING-OPERATOR`** — "Operator reviews the top-20 by importance
> over a week of real data and agrees the ordering is defensible. **This is a human
> acceptance gate and it is not optional.**" `pnpm score -- --top` prints that list.
> Engineering continues; the judgment is recorded as outstanding.

**OBJECTIVE** Deterministic, explainable, LLM-free scoring.

**WHY** Rules before models. This is the gate that keeps ~90% of items away from the LLM, and it is
the cost-control mechanism for the entire system. It must also be _explainable_ — an operator who
cannot see why something scored 82 will not trust the number.

**INPUTS** Phase 4 events. No credentials.

**IMPLEMENTATION**

- Importance, brand relevance, and confidence scorers as pure functions in `packages/core/score`
- All weights as named constants in one file, each with a comment stating it is an unvalidated
  starting guess
- **Score explanation**: every score returns its component breakdown, stored and rendered
- Velocity from corroboration arrival rate + HN points delta + Reddit comment delta + GitHub star
  delta (the X-velocity substitute — explicitly labelled INFERRED, to be validated in Phase 12)
- Confidence capping rules: unofficial-only evidence → LOW + SPECULATIVE
- The **rule gate**: deterministic kill filters before any LLM spend (known-noise sources, duplicate
  suppression, below-floor scores, off-topic categories, the arXiv corroboration gate)

**COMPONENTS** `packages/core/score`.

**TESTS** Golden-file tests: a fixed set of events with expected score ranges. Monotonicity (adding
an official source never lowers confidence). Boundary cases. Gate kill-rate measured against a week
of real data.

**ACCEPTANCE CRITERIA**

- [ ] Every score is reproducible and accompanied by a component breakdown
- [ ] Gate kill rate is measured and reported; target ≥85% of raw items killed before the LLM
- [ ] Confidence capping rules provably cannot be bypassed
- [ ] Operator reviews the top-20 by importance over a week of real data and agrees the ordering is
      defensible — **this is a human acceptance gate and it is not optional**

**EXIT CRITERIA** Above. If the operator disagrees with the ordering, the weights change and the
review repeats. Shipping a scorer he does not trust makes every later phase worthless.

**ROLLBACK** Scores are derived; recompute.

### Phase 5 outcome — 2026-08-13

| Acceptance criterion                                                  | Result                                                                                                                                                       |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Every score is reproducible and accompanied by a component breakdown  | ✅ every component carries value, weight, contribution, and a readable sentence; stored as JSON in `event_scores.breakdown`                                  |
| Gate kill rate measured and reported; target ≥85%                     | ✅ **98.7% overall / 91.5% in-window** over 5,007 real events                                                                                                |
| Confidence capping rules provably cannot be bypassed                  | ✅ exhaustive property test over the entire input space (3 levels × 4 tags × 2³ flags × 4 source counts) asserting the caps are monotonically non-increasing |
| **Operator reviews the top-20 and agrees the ordering is defensible** | ⏳ **PENDING-OPERATOR** — `pnpm score -- --top`                                                                                                              |

**Measured values.**

| Measurement                             | Value                      |
| --------------------------------------- | -------------------------- |
| Events scored                           | 5,007                      |
| Gate kill rate, overall                 | **98.7%** (4,942 of 5,007) |
| Gate kill rate, excluding staleness     | **91.5%** (702 of 767)     |
| Passed to the LLM tier                  | **65 events**              |
| Killed by staleness                     | 4,240 (84.7%)              |
| Killed as uncorroborated and unspecific | 643 (12.8%)                |
| Killed as promotional noise             | 22                         |
| Killed as GitHub activity chatter       | 20                         |

**The first measurement failed, at 17%.** The cause was visible in the top-20: entries
from the Vercel changelog archive, some years old, scoring 53 and passing. Recency was
a score _component_, so an old event lost points and still cleared the floor. But
`ROADMAP.md` §1 optimises for **EARLY** — "before the conversation moves on" — and no
score makes a two-year-old changelog entry actionable. **Staleness is a kill rule, not
a penalty**, and adding it took the rate from 17% to 98.7%.

**Why two kill rates are reported rather than one.** The first ingest backfilled whole
archives — Vercel alone carries 1,463 entries — so an overall rate is dominated by
`too_old` and flatters the gate enormously. The in-window figure excludes everything
staleness killed and is the closer proxy for steady-state daily volume, where almost
nothing is old. Quoting only 98.7% would be technically true and misleading.

**Two design corrections the tests forced.**

1. **The artifact bonus saturated where it mattered most.** Testability started as
   `entity + 0.1 if artifact`, and for Anthropic or Supabase the base is already 1.0 —
   so the bonus did nothing at exactly the top of the list. An Anthropic _policy post_
   scored identically to a model release. Now it scales: `entity × (artifact ? 1 : 0.6)`.
2. **Cap explanations are reported only when a cap actually changed something.** A cap
   firing on an already-capped value did no work, and listing it pads the explanation
   with rules that changed nothing.

**Known gaps carried forward.**

1. **Every weight in `packages/core/src/score/weights.ts` is an unvalidated guess**, and
   the file says so at the top of every constant. Phase 12 refits them against measured
   outcomes. The weights encode _ordering_ claims only — nothing here claims 82 differs
   meaningfully from 79.
2. **Velocity remains INFERRED.** The HN/Reddit/GitHub substitute for X velocity is
   weighted at 0.12 of importance deliberately, so that if Phase 12 discards it the
   damage to the ordering is bounded. The label travels with the number in the
   breakdown so it cannot quietly harden into an assumption.
3. The 65 events that pass the gate include `v2.1.231`-style bare version titles from
   release atoms. They are real releases and correctly specific, but the title alone is
   poor reading; Phase 6's analysis is what turns them into something legible.
4. The `too_old` threshold of 7 days is a guess. It will look different once ingestion
   has been running continuously rather than backfilling.

---

## ◐ Phase 6 — AI analysis engine

> **CODE-COMPLETE 2026-08-13.** Tag `phase-6-complete`. 708 tests, CI green.
>
> **Three acceptance criteria are `PENDING-CREDENTIALS`** and honestly cannot be met
> without `ANTHROPIC_API_KEY`: schema conformance over ≥100 real events, a verified
> prompt-cache hit, and the measured daily cost that replaces the `ARCHITECTURE.md` §6
> estimate. All three require live calls. The code measures and reports each of them;
> none is asserted.
>
> **Met and measured without credentials:** the full 39-document injection corpus
> (§5 test 1), provenance validation (§5 test 6), the rumour cap on output (§5 test 7),
> budget-guard degradation (§5 test 5), and `AI_MODE=MOCK` determinism.
>
> **Outstanding human gate:** "Operator reads 20 analyses and judges them non-obvious."

**OBJECTIVE** Turn a scored event into structured analysis: what happened, what changed, before/after,
implications by audience, what is still unknown, confidence, and the do-not-say list.

**WHY** This is where the system stops being a filter and starts being an analyst.

**INPUTS** Phase 5 events. **`ANTHROPIC_API_KEY`** (or `AI_MODE=MOCK`).

**IMPLEMENTATION**

- `packages/ai`: Anthropic client wrapper, model tiering, budget guard, token accounting
- Triage call (`claude-haiku-4-5`), structured output, over the gate survivors
- Analysis call (`claude-opus-5`), structured output, only above `AI_ANALYSIS_THRESHOLD`
- **Untrusted-content envelope** with per-request random delimiter (T-1 mitigation 4)
- Prompt caching with a **verified** cache hit — assert `cache_read_input_tokens > 0`, remembering
  Haiku's 4096-token prefix floor
- Batch API path for non-urgent work at 50% cost
- Injection detector as a flagging signal, not a silent filter
- Per-claim confidence tags and evidence ids; **claims without evidence ids fail validation**
- Prompt versioning — every stored analysis records model id + prompt version
- `AI_MODE=MOCK` returning deterministic canned analyses

**COMPONENTS** `packages/ai`, `packages/core/analyze`.

**TESTS** The full injection corpus from `THREAT-MODEL.md` §5 (~30 hostile documents). Schema
conformance on every response. Budget guard degradation under simulated overspend. Provenance
validation rejecting an unsourced number. Cache-hit assertion. MOCK determinism.

**ACCEPTANCE CRITERIA**

- [ ] Analyses conform to schema 100% of the time across ≥100 real events
- [ ] Prompt cache demonstrably hits (`cache_read_input_tokens > 0` on the second call of a run)
- [ ] No injection-corpus document alters schema, raises importance above the rules baseline, or
      escapes the detector
- [ ] **Measured cost per day recorded in `ARCHITECTURE.md` §6, replacing the estimate**
- [ ] Budget guard degrades gracefully, never crashes, never silently stops detection
- [ ] Operator reads 20 analyses and judges them non-obvious — **human acceptance gate**

**EXIT CRITERIA** Above. The human gate is the important one: if the analyses read like a summary of
the press release, the prompts are wrong and the phase is not done.

**ROLLBACK** Analyses are versioned rows; revert the prompt version and re-run.

### Phase 6 outcome — 2026-08-13

| Acceptance criterion                                                                   | Result                                                                                       |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Analyses conform to schema 100% of the time across ≥100 real events                    | ⏳ **PENDING-CREDENTIALS** — needs live calls                                                |
| Prompt cache demonstrably hits (`cache_read_input_tokens > 0`)                         | ⏳ **PENDING-CREDENTIALS** — `pnpm analyze` measures and reports it; never asserted          |
| No injection-corpus document alters schema, raises importance, or escapes the detector | ✅ **39 documents, 100 assertions, all green**                                               |
| Measured cost per day recorded in `ARCHITECTURE.md` §6                                 | ⏳ **PENDING-CREDENTIALS** — the ledger and breakdown exist; there is nothing to measure yet |
| Budget guard degrades gracefully, never crashes, never silently stops detection        | ✅ tested across the whole ladder including 500× overspend                                   |
| Operator reads 20 analyses and judges them non-obvious                                 | ⏳ **PENDING-OPERATOR**, and blocked on credentials                                          |

**The injection corpus found 22 real detector gaps.** The Phase-4 detector covered
override attempts and hidden text. Against the corpus it missed every invisible-
character payload, every score-manipulation attempt, every fake-authority claim, every
exfiltration probe, and both schema attacks — 22 of 35 hostile documents passed
undetected. Two findings mattered most:

1. **Obfuscation defeated the detector completely.** `I<ZWSP>g<ZWSP>n<ZWSP>o…` matches
   no keyword pattern, so the payload most obviously _designed_ to evade detection was
   the one that evaded it. The fix runs patterns against both the raw text and a
   de-obfuscated copy, and treats the presence of the characters as a signal in its
   own right.
2. **The four benign controls are what make the corpus meaningful.** A detector that
   flags everything passes all 35 hostile cases. The hardest control is a legitimate
   article _about_ prompt injection — exactly the content this operator monitors most.
   It must not be flagged, and it is not.

**The triage prompt is long on purpose, and the arithmetic says so.** Haiku 4.5's
minimum cacheable prefix is 4,096 tokens — the highest of any current model — and
below it there is no error, just `cache_creation_input_tokens: 0` and full price
forever. At ~100 triage calls a day a 1,600-token prompt never caches and costs
160,000 tokens; a 4,500-token prompt caches and costs ~48,000 token-equivalents. The
first draft measured 1,626 tokens and a test caught it. The added material is a
source-shape guide and 30 worked examples — the judgements triage gets wrong most
often — because padding to reach the floor would be a much worse trade.

**Zero events reached deep analysis in the first real run**, and the run now says so.
The top combined score over 5,007 events is 66; `AI_ANALYSIS_THRESHOLD` defaults to 70. Each event recorded its own reason, but nobody reads 65 reasons, and a tier that
is unreachable by construction looks exactly like a system correctly finding nothing.
Neither number has been changed to make the output look better — Phase 12 refits the
weights against measured outcomes, and that is the right time to reconcile them.

**Two corrections the tests forced.**

1. **The provenance check flagged "Claude Opus 5".** Any digit counted as a factual
   claim, so a model name in the narrative failed validation and discarded the
   analysis. It now matches measurement-_shaped_ numbers only: multi-digit, decimal,
   or unit-carrying.
2. **The spend table reported 25 calls to `claude-opus-5` in a MOCK run that made
   none.** Skipped stages record the model they would have used, and the query counted
   rows rather than requests. Sent calls and skips are now separate columns — a
   fabricated live result is exactly what this project forbids.

**Known gaps carried forward.**

1. `MOCK` mode proves the pipeline, not the analyses. Every field is marked `[MOCK]`,
   confidence is forced LOW, and the recommendation is always VERIFY, so a MOCK run
   can never recommend publishing anything.
2. The corpus tests the **deterministic** layers. Whether a live model resists these
   documents is untested; §T-1 mitigation 1 (no tools) is why that is tolerable, and
   §6 records the residual risk as accepted.
3. The Batch API path (50% cost) is specified in the roadmap and **not implemented** —
   there is no non-urgent backlog to batch until analysis is actually running.
4. `@anthropic-ai/sdk@0.72.1` does not type `stop_details`; the refusal handler reads
   it defensively and can collapse to a direct property access when typings catch up.

---

## ◐ Phase 7 — X content strategy engine

> **CODE-COMPLETE 2026-08-13.** Tag `phase-7-complete`. 791 tests, CI green.
>
> **MEASURED restraint: 50.8%** over the 65 gate survivors (DONT_POST 16.9% +
> WAIT 32.3% + VERIFY 1.5%), against the ≥30% target.
>
> **Outstanding: `PENDING-OPERATOR`** — "Operator judges ≥60% of QUOTE-NOW
> recommendations as ones he would actually act on." `pnpm strategy -- --top` prints
> them with the full WHY NOW / WHY ME / WHAT CAN I ADD / EXPECTED OUTCOME panel.

**OBJECTIVE** For each high-priority event, produce the five options — quote / reply / original /
educational / wait — plus the one decisive recommendation and its reasoning.

**WHY** Analysis without a recommended action leaves the hardest judgment to the operator at exactly
the moment he is short of time.

**INPUTS** Phase 6 analyses.

**IMPLEMENTATION**

- Expert-angle engine (brief §26): technical explanation, comparison, previous-version diff,
  benchmark interpretation, cost implication, second-order effect, myth correction, skepticism
- Five option generators with per-option rationale
- The **"WHY NOW / WHY ME / WHAT CAN I ADD / EXPECTED OUTCOME"** panel
- The **DON'T POST** path with explicit reasons (saturated, no unique angle, weak evidence, better
  explained elsewhere, low authority gain, reputational risk, insufficient information)
- Forcing rules: rumour/leak → WAIT-VERIFY; accusation/attribution → WAIT-VERIFY + manual flag
- DO-NOT-SAY generation per event
- Suggested commentary with every factual claim carrying its evidence id

**COMPONENTS** `packages/core/strategy`.

**TESTS** Forcing rules cannot be bypassed by any input. Every generated claim carries an evidence
id. Recommendation distribution over a week of real events includes a meaningful WAIT/IGNORE share.

**ACCEPTANCE CRITERIA**

- [ ] Every high-priority event produces all five options with distinct, non-generic reasoning
- [ ] **≥30% of scored events over a representative week receive DON'T POST or WAIT** — a system that
      recommends action on everything has no judgment
- [ ] No generated commentary contains an unsourced number
- [ ] Accusation and rumour forcing rules pass adversarial tests
- [ ] Operator judges ≥60% of QUOTE-NOW recommendations as ones he would actually act on —
      **human acceptance gate**

**EXIT CRITERIA** Above.

**ROLLBACK** Derived from analyses; regenerate.

### Phase 7 outcome — 2026-08-13

| Acceptance criterion                                                                     | Result                                                                                                |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Every high-priority event produces all five options with distinct, non-generic reasoning | ✅ tested across five event shapes; the five rationales must be pairwise distinct                     |
| **≥30% of scored events receive DON'T POST or WAIT**                                     | ✅ **50.8% measured** over the 65 gate survivors                                                      |
| No generated commentary contains an unsourced number                                     | ✅ inherited from Phase 6 provenance validation; the strategy layer generates no new numbers          |
| Accusation and rumour forcing rules pass adversarial tests                               | ✅ 15 forcing cases + 4 explicit "talk it out of the rule" attempts + all 35 hostile corpus documents |
| Operator judges ≥60% of QUOTE-NOW recommendations as actionable                          | ⏳ **PENDING-OPERATOR**                                                                               |

**The first restraint measurement failed at 20.6%**, and both causes were real bugs
rather than a mis-set threshold:

1. **The CLI hardcoded `expertSourceCount: 0`**, which silently disabled three of the
   seven DON'T POST reasons — `saturated` and `better_explained_elsewhere` cannot fire
   without it. It is now derived from the evidence's source categories.
2. **It ran over all 5,000 scored events**, of which the Phase 5 rule gate had already
   killed 4,942. Asking "should he post about this?" of an event the pipeline already
   rejected is a question with no meaning, and the answers made the distribution
   describe a population the operator never sees. The strategy layer now runs over gate
   survivors only, matching the pipeline.

**Forcing rules run FIRST, before any positive recommendation.** That ordering is what
makes them unbypassable: there is nothing for a positive decision to argue with. An
event scoring 100 on every axis, fresh, testable, and uncrowded is still forced to
WAIT if its title reads as a rumour — tested directly. This is the same pattern as the
Phase 5 confidence caps and the Phase 6 output caps: **compute, then cap in code,
never in a prompt.**

**An accusation is escalated, not merely delayed.** A rumour that proves false costs a
correction; an unverified accusation amplified by the operator damages a third party
who had no say in it. So accusations force VERIFY _and_ set `manualFlag`.

**A correction the tests forced.** At LOW confidence the `original` option still
outranked `wait`, because option fit measured how well an option suited the event and
ignored whether the evidence could support saying anything at all. Every publishing
option is now discounted by confidence; `wait` is exempt, because waiting gets better
as confidence falls.

**Known gaps carried forward.**

1. `stillUnknown` and `doNotSay` come from the Phase 6 analysis, and no event has one
   yet — nothing cleared `AI_ANALYSIS_THRESHOLD`. So `insufficient_information` and
   `reputational_risk` are implemented and tested but have never fired on real data.
2. Angle applicability is regex-driven over titles and summaries. It is explainable
   and free, and it will miss angles a reader would spot.
3. `EARLY_WINDOW_HOURS = 6` is a guess, like the Phase 5 weights.

---

## ◐ Phase 8 — Educational content engine

> **CODE-COMPLETE 2026-08-13.** Tag `phase-8-complete`. 857 tests, CI green.
>
> The one non-negotiable is met and **enforced in code**: an opportunity that cannot
> state its limitations is not emitted at all.
>
> **`PENDING-ELAPSED`:** "≥1 usable educational opportunity per day over a two-week
> run". **`PENDING-OPERATOR`:** "≥5 experiments the operator judges genuinely runnable
> in under 2 hours", and the exit criterion that he has run one end to end.
> **`PENDING-CREDENTIALS`:** confirming the Batch API discount against a real batch.

**OBJECTIVE** Identify one or two genuine teaching opportunities per day, with the exact method,
worked example, and stated limitations.

**WHY** Teaching a working technique is one of the highest-authority content types available and it
does not depend on being first.

**INPUTS** Phase 6/7. Recent events + the operator's own tooling context (optional, per brief §73).

**IMPLEMENTATION**

- Opportunity detection: topic, why now, audience, hook, teaching point, exact prompt/method,
  worked example, limitations, suggested format
- Runs nightly via the Batch API (50% cost)
- **Every technique must state its limitations and failure modes.** A workflow presented without its
  failure cases is the kind of content that damages credibility when a reader tries it.
- The **experiment generator** (brief §34): question, hypothesis, required inputs, procedure,
  metrics, result (operator-filled), content angle
- Experiment queue with status tracking

**COMPONENTS** `packages/core/strategy` (educational + experiment modules).

**TESTS** Schema conformance. Limitations section is non-empty and non-generic. Experiment
procedures are concrete enough to execute (checked by human review of a sample).

**ACCEPTANCE CRITERIA**

- [ ] ≥1 usable educational opportunity per day over a two-week run
- [ ] Every technique includes limitations and failure modes
- [ ] ≥5 experiments generated that the operator judges genuinely runnable in under 2 hours
- [ ] Batch API path confirmed working at reduced cost

**EXIT CRITERIA** Above + the operator has actually run one generated experiment end to end.

**ROLLBACK** Additive.

### Phase 8 outcome — 2026-08-13

| Acceptance criterion                                       | Result                                                                                     |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| ≥1 usable educational opportunity per day over two weeks   | ⏳ **PENDING-ELAPSED**                                                                     |
| **Every technique includes limitations and failure modes** | ✅ enforced in code — an opportunity with none is not emitted                              |
| ≥5 experiments judged genuinely runnable in under 2 hours  | ⏳ **PENDING-OPERATOR** — the generator caps at 120 minutes and a test asserts it          |
| Batch API path confirmed working at reduced cost           | ◐ wired and tested against a fake client; the **measured** saving is `PENDING-CREDENTIALS` |

**Why the limitations rule is a code path, not a prompt instruction.** The roadmap
says "a workflow presented without its failure cases is the kind of content that
damages credibility when a reader tries it". A field that is _usually_ filled is a
field that will one day be empty, so `buildEducationalOpportunity` returns `undefined`
rather than a lesson someone could follow into a wall. The limitations are generic per
angle and specific per event: the angle contributes the technique's real failure mode,
and `stillUnknown` and `doNotSay` from the Phase 6 analysis contribute the rest.

**The experiment generator never produces a `result` field.** The system proposes the
experiment; the operator runs it and fills the result in. A generated result is a
fabricated measurement, which is the one thing this project does not do — and a test
asserts the key is absent rather than merely empty.

**Every experiment carries a content angle for BOTH outcomes.** An experiment only
worth writing up when it confirms the hypothesis is one that gets quietly abandoned
when it does not. "I expected X and got Y" is a more honest post than most, and it is
one only somebody who ran it can write.

**Batch is a deadline decision, not a cost decision.** Batches complete within 24
hours, which is fine for the nightly educational sweep and useless for an outage the
operator wants to post about in twenty minutes. Triage and deep analysis stay
synchronous; the educational sweep and any post-budget-pause backfill go to batch.

**Results are keyed by `custom_id`, never by position** — `collectBatch` returns a
`Map` specifically so the correct usage is the only convenient one. Position-based
matching produces a silent, plausible-looking mis-attribution (analysis for event 40
stored against event 12), which is worse than a crash. A duplicate `custom_id` is
refused before submission for the same reason.

**Known gaps carried forward.**

1. Angle detection is regex-driven, so a teaching opportunity phrased unusually is
   missed. It is explainable and free; Phase 12 can measure what it misses.
2. The two limitation sources beyond the angle — `stillUnknown` and `doNotSay` — come
   from Phase 6 analyses, and no event has one yet.
3. Experiment time estimates (45–90 minutes) are guesses. The operator running one is
   what turns them into measurements.

---

## ◐ Phase 9 — Trend intelligence

> **CODE-COMPLETE 2026-08-13.** Tag `phase-9-complete`. 879 tests, CI green.
>
> Built to the roadmap's own honest scoping: **human-observed, machine-tracked**.
> Manual entry is the primary interface (`pnpm trend`), and the CLI ends every run by
> printing what automated detection cannot do rather than leaving it implied.
>
> **`PENDING-ELAPSED`:** tracking a manually-entered trend over ≥2 weeks, and whether
> automated detection surfaces a genuine emerging format over a month.

**OBJECTIVE** Detect emerging social formats and behaviours — separately from news — and place them
on a lifecycle.

**WHY** Brief §9–11, §44. This is the capability most likely to be shallow, so it is scoped honestly.

**INPUTS** Phases 3–7. Human observation.

**IMPLEMENTATION**

- `trends` table and the full trend card: name, platform, first observed, growth, maturity,
  mechanism, how to participate, original version, creator adaptation, risk, decision
- Lifecycle: UNKNOWN → EMERGING → ACCELERATING → MAINSTREAM → SATURATED → DECLINING
- Recommendations by stage: emerging → act; accelerating → differentiated angle; mainstream → only
  with a strong unique perspective; saturated → ignore; declining → ignore
- Automated signal: format/technique repetition across HN, Reddit, Lobsters, GitHub topic velocity
- **Manual trend entry is a first-class feature, not a fallback**

**Honest scoping.** Without paid social data, automated cross-platform trend detection is weak.
Formats on X, TikTok, and Instagram are largely invisible to free feeds. The realistic design is
**human-observed, machine-tracked**: the operator enters a trend he has seen; the system tracks its
trajectory, scores saturation, generates a differentiated angle, and tells him when the window has
closed. Claiming automated cross-platform trend detection would be the kind of overclaim this whole
system is built to avoid.

**COMPONENTS** `packages/core/trends`.

**TESTS** Lifecycle transition logic. Saturation scoring against historical fixtures with known
outcomes. Recommendation-by-stage matrix.

**ACCEPTANCE CRITERIA**

- [ ] Manual trend entry → complete trend card → tracked trajectory over ≥2 weeks
- [ ] Lifecycle stage transitions are explainable
- [ ] Automated detection surfaces ≥1 genuine emerging technical format from HN/Reddit/GitHub over
      a month — **and if it does not, that is documented as a limitation rather than papered over**
- [ ] Saturation detection correctly marks a known-saturated format as SATURATED

**EXIT CRITERIA** Above, including the honest documentation of what automated detection cannot do.

**ROLLBACK** Isolated subsystem.

### Phase 9 outcome — 2026-08-13

| Acceptance criterion                                                           | Result                                                                                                                              |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Manual trend entry → complete trend card → tracked trajectory over ≥2 weeks    | ◐ entry, card, and tracking work end to end; the two weeks are **PENDING-ELAPSED**                                                  |
| Lifecycle stage transitions are explainable                                    | ✅ every placement returns the numbers it decided on, and a test asserts the explanation is non-trivial for each branch             |
| Automated detection surfaces ≥1 genuine emerging technical format over a month | ⏳ **PENDING-ELAPSED** — and the criterion's own escape clause applies: if it does not, that is documented rather than papered over |
| Saturation detection correctly marks a known-saturated format as SATURATED     | ✅ tested against the characteristic curve                                                                                          |

**A test forced a real modelling correction.** Saturation was gated on overall growth —
the recent half of the series against the earlier half. But a format that ramped hard
and then plateaued still shows strong overall growth, because the early half _contains
the ramp_. The plainly saturated curve `40, 70, 72, 68, 65` reported +24% growth and
was placed MAINSTREAM. Two different questions were being conflated:

- **growth** — how far has it come since we started watching
- **momentum** — is it still climbing _now_

Saturation turns on the second. Both are now computed and both appear in the
explanation, so the operator can see a trend that has travelled a long way and stopped.

**Saturation scores BREADTH, not volume.** A format discussed loudly in one community
is not saturated; one that has reached every community is, however quietly. Falling
breadth after a wide peak is the clearest saturation signal available without paid
social data, and a test asserts the quiet-broad case outscores the loud-narrow one.

**The machine never writes a human field.** `mechanism`, `howToParticipate`, and
`originalVersion` are `string | undefined` rather than optional, so "the operator has
not filled this in" is a state the type can represent — and `missing` names each gap
explicitly. A fabricated mechanism ("this format works because it rewards curiosity")
reads exactly like a real one, and once stored it is indistinguishable from something
he actually observed.

**What automated detection cannot do, stated in the product.** `pnpm trend` prints it
at the end of every run: formats on X, TikTok, and Instagram are invisible to free
feeds; the automated signal covers technical-format repetition on HN, Reddit,
Lobsters, and GitHub only. This is the phase most at risk of quietly overclaiming, so
the limitation is in the output rather than only in the documentation.

**Known gaps carried forward.**

1. The automated signal is **specified but not wired to ingestion**. The lifecycle and
   card work over any observation series; nothing yet writes automated observations.
   That is the honest state: the manual path is complete and the automated path is a
   stub with no fabricated data behind it.
2. `MIN_OBSERVATIONS_FOR_STAGE = 3` and `STALE_AFTER_DAYS = 14` are guesses.
3. Saturation weights (0.6 breadth, 0.4 decay) are guesses, like the Phase 5 weights.

---

## ◐ Phase 10 — Dashboard command centre

> **CODE-COMPLETE 2026-08-13.** Tag `phase-10-complete`. 932 tests, CI green.
>
> Rendered and checked against a running server: 50KB of HTML, all panels present,
> CSP verified on the wire. The top event's decision is above the fold on first
> render — the 60-second path is a layout property, not a click sequence.
>
> **`PENDING-OPERATOR`:** the under-60-seconds claim, the one-screen morning brief on
> his laptop, and the exit criterion of a week's daily use.
> **`PENDING-DATA`:** the remote-deployment decision, which the roadmap requires be
> made _with_ a month of machine-off-hours miss data that does not exist yet.

**OBJECTIVE** The interface that makes the whole system usable in the 15 minutes the operator has.

**WHY** Everything before this is invisible without it.

**INPUTS** All prior phases.

**IMPLEMENTATION**

- **Live intelligence stream**: time, event, source, entity, category, priority, confidence,
  velocity, trend stage, brand relevance, status
- **Event detail**: what happened · primary source · secondary sources · exact time · what changed ·
  before · after · key technical details · business/developer/consumer implications · why it matters ·
  what is still unknown · confidence · source quality
- **Action panel**: the five options, WHY NOW, WHY ME, DO-NOT-SAY, the single recommendation
- **Modes**: MORNING BRIEF · LIVE · END OF DAY (what happened, what we missed, what to learn)
- **Health panel**: source freshness, detection latency, dedup rate, cost today, cache hit ratio,
  gate kill rate
- **Suspicious content panel** (flagged injection attempts)
- MOCK badge, permanent and unmissable, whenever any mode is MOCK
- Score breakdown visible on demand for every score
- Security: CSP, no `dangerouslySetInnerHTML`, external link hosts shown as text, bound to `127.0.0.1`

**COMPONENTS** `apps/web`.

**TESTS** Component tests for the stream, detail, and action panels. Accessibility pass. XSS test
rendering hostile titles and summaries from the injection corpus.

**ACCEPTANCE CRITERIA**

- [ ] Operator can go from opening the dashboard to a decided action in **under 60 seconds** for the
      top event
- [ ] Morning brief renders in one screen without scrolling on a laptop
- [ ] Health panel makes a dead source obvious without being looked for
- [ ] Hostile content from the injection corpus renders inert
- [ ] MOCK badge cannot be missed
- [ ] **Decision on remote deployment made here, with data**: measure detection misses attributable
      to machine-off hours over the preceding month; deploy only if the number justifies it, and add
      auth in the same change if so

**EXIT CRITERIA** Above + one week of the operator actually using it daily as his primary surface.

**ROLLBACK** UI only.

### Phase 10 outcome — 2026-08-13

| Acceptance criterion                                              | Result                                                                                                                                                                     |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dashboard → decided action in under 60 seconds for the top event  | ◐ the decision, its reasoning, and all four panel fields render above the fold with no interaction; the **timing** is `PENDING-OPERATOR`                                   |
| Morning brief renders in one screen without scrolling             | ⏳ **PENDING-OPERATOR** — brief mode caps at 5 events for this reason                                                                                                      |
| Health panel makes a dead source obvious without being looked for | ✅ dead-source count is a red banner in the panel heading, and the panel sits directly under the decision rather than at the bottom                                        |
| Hostile content from the injection corpus renders inert           | ✅ all 39 documents rendered through the real components; no `<script>`, no event handlers, no `javascript:` survives                                                      |
| MOCK badge cannot be missed                                       | ✅ full-width, fixed, names each mocked subsystem individually, and states plainly that nothing on screen is live                                                          |
| Remote-deployment decision made with data                         | ⏳ **PENDING-DATA** — the criterion requires a month of miss data attributable to machine-off hours. Deciding without it would be exactly the guess the criterion forbids. |

**Verified on the wire, not asserted.** The CSP was checked against a running server:
`default-src 'none'` with no `unsafe-inline` and no `unsafe-eval`, plus `nosniff`,
`no-referrer`, and `DENY` framing. Every component is a server component, so Next's
runtime is served from `'self'` and nothing inline is emitted — which is what makes
omitting a nonce pipeline honest rather than lucky.

**Three real defects the first render exposed.**

1. **The dashboard was migrating the schema on page load.** A browser refresh could
   alter the schema while the worker was mid-write. It is a reader; the worker owns
   migrations. Removing the call was right on the merits and _also_ fixed the build —
   the reverse order would have been a workaround.
2. **`MIGRATIONS_FOLDER` failed the Turbopack build.** `new URL('../migrations',
import.meta.url)` reads to a bundler as a **static asset reference**, so it tried
   to resolve a directory of `.sql` files as a module. `path.join` produces the same
   string and says unambiguously that it is a path.
3. **A missing schema produced a raw `SqliteError` and a Next error page.** A reader
   that depends on a writer having run has to say so; it now names the commands to
   run instead.

**One claim corrected.** A comment said "no client JavaScript is shipped". Next ships
its own runtime regardless — the served page carries eight script tags. The accurate
claim is narrower: none of the shipped script is ours, and none of it is inline.

**Known gaps carried forward.**

1. Event detail is rendered inline in the stream row rather than on a dedicated route.
   Every field the roadmap lists that _exists_ is shown; the ones that do not exist
   yet (before/after, implications, still-unknown) come from Phase 6 analyses, and no
   event has one.
2. No accessibility audit tool has been run. Semantics are correct by construction —
   landmarks, `scope` on headers, `role="alert"` on the dead-source banner, `aria-current`
   on the mode nav — but that is not the same as a measured pass.
3. `DO NOT SAY` renders only when a Phase 6 analysis supplies it, so it is currently
   never shown on real data.

---

## ◐ Phase 11 — Alerts

> **CODE-COMPLETE 2026-08-13.** Tag `phase-11-complete`. 956 tests, CI green.
>
> **Measured on real data: 1 alert from 65 gate survivors** — an accusation
> ("Stolen LLM Reasoning…") escalated for human review by the Phase 7 forcing rules.
>
> **`PENDING-ELAPSED`:** the ≤2/day average over two weeks.
> **`PENDING-OPERATOR`:** whether each alert was worth interrupting him.

**OBJECTIVE** Tell the operator about URGENT things without training him to ignore notifications.

**INPUTS** Phase 10.

**IMPLEMENTATION** Four tiers (URGENT / HIGH / TREND / EDUCATIONAL); ntfy push with console
fallback; `ALERT_MIN_PRIORITY` defaulting to `urgent`; deduplication so one event alerts once;
quiet hours; **source-freshness alerting (T-9)** — Priority-1 silent 6h, Priority-2 silent 24h.

**TESTS** Tier routing, dedup, quiet hours, freshness alert firing.

**ACCEPTANCE CRITERIA**

- [ ] **≤2 alerts per day on average** over two weeks — brief §46 is explicit that noise is the
      failure mode, and an alert system the operator mutes has negative value
- [ ] Every alert fired is one the operator agrees was worth interrupting him
- [ ] A deliberately disabled Priority-1 source produces a freshness alert within 6 hours

**EXIT CRITERIA** Above.

**ROLLBACK** Set `ALERT_MIN_PRIORITY` beyond any tier.

### Phase 11 outcome — 2026-08-13

| Acceptance criterion                                                    | Result                                                                                         |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| ≤2 alerts per day on average over two weeks                             | ◐ **1 alert from 65 gate survivors** on real data; the two-week average is **PENDING-ELAPSED** |
| Every alert fired is one the operator agrees was worth interrupting him | ⏳ **PENDING-OPERATOR**                                                                        |
| A disabled Priority-1 source produces a freshness alert within 6 hours  | ✅ threshold is 6h and tested; the live disable is **PENDING-OPERATOR**                        |

**Every mechanism here exists to suppress, not to notify.** Tiering, deduplication,
quiet hours, and the daily cap are four independent reasons _not_ to fire. The default
`ALERT_MIN_PRIORITY` is `urgent`, so the system ships silent and the operator opts into
more — the opposite of the usual default, and the only one consistent with "an alert
system the operator mutes has negative value".

**POST_SOON deliberately does not alert.** It has no deadline, so interrupting for it
is precisely how an operator learns to ignore interruptions. Only two things
interrupt: something to act on _now_, and something escalated for human review.

**The daily cap is 4, not 2, on purpose.** The criterion is an average over two weeks.
A hard cap at the average would clip every genuinely busy day to look like an average
one — manufacturing the number instead of measuring it. The cap exists to stop a
runaway; if the average lands above 2, the tiering is wrong and that is what to fix.
Suppressed alerts are returned and counted rather than dropped, because hitting the
cap is information about the tiering, and hiding it would let the system look calm
while failing.

**A LIMIT read as a truncation — the same bug class as Phase 5.** `latestScores`
applied its LIMIT _before_ filtering to gate survivors and filtered the rest in
JavaScript, so asking for 100 survivors returned however many fell inside the top 100
by score. The measured restraint rate swung between **50.8% and 21.1% depending only
on the `--limit` flag**, and the alerts CLI missed the manual-flagged event entirely.
The filter now runs in SQL.

**One derivation, three callers.** The recommendation logic was independently
reimplemented in the `strategy` CLI, the dashboard, and the `alerts` CLI — and the
third had already drifted, hard-coding `POST_SOON` so the event-alert path could never
fire. `strategyFromScore` is now the single derivation. Three copies of a judgement
become three different answers, and the one that drifts is the one nobody is watching.

**The ntfy topic is treated as a credential.** It is never logged, and a delivery
failure surfaces only the error's _class_ — the message could contain the URL, and the
URL contains the topic. Failures always fall back to the console and always say they
fell back: an unreachable server that silently swallowed an urgent alert would leave
the operator believing he was covered.

**Known gaps carried forward.**

1. **Dedup state is per-run.** Two runs an hour apart will both alert on the same
   fact. Persisting it is a Phase 14 concern and is stated in the code rather than
   left for a reader to assume otherwise.
2. Quiet hours (23:00–07:00) and the daily cap are guesses.
3. Only `ntfy.sh` is supported; a self-hosted server needs a config key that does not
   exist yet.

---

## ◐ Phase 12 — Analytics and the feedback loop

> **PARTIALLY COMPLETE 2026-08-13.** Tag `phase-12-complete`. 971 tests, CI green.
>
> **The offline replay engine works and is measured:** 5,007 real events, middle 90%
> spanning **2,428 days**, five candidate weightings, **$0 API cost**. Candidates
> disagree meaningfully (67%–100% agreement with the shipped weights), which is what
> makes the machinery useful rather than decorative.
>
> **The refit itself has NOT happened and cannot yet.** Fitting weights requires
> measured outcomes; outcomes require posts; posts require the operator and X
> credentials. Writing "refitted" weights against no outcomes would be fabricating the
> measurement this phase exists to produce. **The guesses stay, labelled as guesses.**
>
> The roadmap's exit criterion is explicit that this is not done: _"This phase is where
> the system starts learning; a green CI with unfitted weights does not satisfy it."_
> That is the correct reading, and it is recorded rather than worked around.

**OBJECTIVE** Measure what actually built authority, and use it to fix the scoring.

**WHY** Without this the weights stay guesses forever and the system never improves.

**INPUTS** **`X_*` credentials** (owned reads at $0.001). Phase 10 action log.

**IMPLEMENTATION**

- X owned reads for the operator's own posts: impressions, replies, reposts, profile visits, follows
- Four tracked dimensions kept separate (brief §40): **visibility**, **authority**, **audience**,
  **content quality**
- Authority signals: replies from accounts the registry classifies as high-signal; mentions by
  respected accounts; conversation depth — not raw engagement
- **Low-quality virality vs authority growth** classifier, reported explicitly
- Attribution: which recommendation → which post → what outcome
- **Offline weight refitting** over immutable `raw_items` — replay three months of history under
  candidate weights at zero API cost and compare which events would have surfaced
- Validate or discard the HN/Reddit/GitHub velocity proxy for X velocity (the INFERRED assumption
  from Phase 5)

**TESTS** Attribution correctness. Replay determinism. Weight-fitting produces reproducible output.

**ACCEPTANCE CRITERIA**

- [ ] ≥30 posts attributed to recommendations with outcomes recorded
- [ ] Visibility / authority / audience / quality reported separately, never merged into one number
- [ ] Offline replay runs over ≥3 months of history at **$0 API cost**
- [ ] **Refitted weights written into the scoring constants file, replacing the guesses, with the
      measurement recorded in this document**
- [ ] The velocity-proxy assumption is explicitly validated or explicitly discarded in writing
- [ ] X spend stays within `X_DAILY_BUDGET_USD`

**EXIT CRITERIA** Above. This phase is where the system starts learning; a green CI with unfitted
weights does not satisfy it.

**ROLLBACK** Weights are constants; revert the file.

### Phase 12 outcome — 2026-08-13

| Acceptance criterion                                                          | Result                                                                                             |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| ≥30 posts attributed to recommendations with outcomes recorded                | ⏳ **PENDING-OPERATOR** — zero posts exist                                                         |
| Visibility / authority / audience / quality reported separately, never merged | ✅ the `Dimensions` type has **no** combined field and no function produces one; a test asserts it |
| Offline replay runs over ≥3 months of history at $0 API cost                  | ✅ **5,007 events, middle 90% spanning 2,428 days, no network calls**                              |
| **Refitted weights written into the constants file, replacing the guesses**   | ❌ **NOT DONE, and cannot be** — see below                                                         |
| The velocity-proxy assumption explicitly validated or discarded               | ◐ **explicitly NOT validated** — recorded below rather than left ambiguous                         |
| X spend stays within `X_DAILY_BUDGET_USD`                                     | ✅ trivially — no X calls have been made                                                           |

**Why the refit did not happen.** Fitting weights means choosing the candidate whose
surfaced events produced the best outcomes. There are no outcomes. Running the fitting
code against an empty outcome set would produce numbers, and those numbers would be
noise wearing the label "measured" — which is worse than a guess honestly labelled as
one. The five candidates are recorded and the machinery is proven; the choice waits
for data.

**Two Phase-3/5 decisions are what made a $0 replay possible**, and neither cost
anything at the time:

1. `raw_items` is append-only and immutable, so history survives whatever the pipeline
   did to it later.
2. `scoreEvent` and `applyGate` take `now` as a **parameter** rather than reading the
   clock. A scorer calling `Date.now()` internally would make every replay meaningless
   _while appearing to work_ — the replay would silently re-age every event to today.

**The velocity proxy is explicitly NOT validated.** Phase 5 introduced HN/Reddit/GitHub
activity as a substitute for the X velocity that pricing removed, labelled INFERRED.
Validating it requires correlating the proxy against real X velocity, which requires
X reads, which require credentials. It remains INFERRED, weighted at 0.12 of importance
precisely so that discarding it later does bounded damage. Saying "we checked and it
seems fine" would be the overclaim this system exists to avoid.

**Low-quality virality is classified explicitly**, because it is the failure mode the
whole project is built against and it looks like success on any dashboard reporting a
single number: 90,000 impressions, 400 reposts, and nobody worth hearing from in the
replies. `classifyOutcome` names it, and ranks it _below_ a 1,200-impression post that
earned three high-signal replies.

**Known gaps carried forward.**

1. Candidate weights are applied as **axis multipliers**, not per-component. That
   explores the _shape_ of the weighting, not its detail. A true per-component refit
   needs the constants file to be parameterised, which is worth doing only once there
   are outcomes to fit against.
2. Attribution (recommendation → post → outcome) is **specified and not built**. It has
   nothing to attribute.
3. The corpus's full date range is 9,375 days, inflated by a few items with implausible
   publisher dates. The replay reports both the full range and the middle-90% span
   rather than quoting the misleading number.

---

## ☐ Phase 13 — Live platform integration

**OBJECTIVE** Everything running live, end to end, with real credentials and real spend.

**INPUTS** All credentials.

**IMPLEMENTATION** All modes LIVE. Optional assisted publishing behind `X_ENABLE_POSTING`, requiring
per-post human confirmation showing the exact bytes to be sent. Rate self-limits.
`X_MAX_POSTS_PER_DAY`. Write scope granted to the X token **only here** and only if this feature is
actually built.

**TESTS** Live smoke tests for every adapter. Rate-limit handling under real conditions. Posting
confirmation flow, including cancellation.

**ACCEPTANCE CRITERIA**

- [ ] 7 consecutive days live with no unhandled errors
- [ ] Real costs within both budget ceilings, with the actuals recorded
- [ ] Detection latency measured against ≥10 events with known publication times
- [ ] If posting is enabled: no post can be sent without an explicit confirmation showing final text
- [ ] Rate limits handled without data loss

**EXIT CRITERIA** Above + measured `event_occurred → detected` and `detected → actionable` medians
written into this document.

**ROLLBACK** Every mode has a MOCK setting. Revert per subsystem.

---

## ☐ Phase 14 — Security, observability, and hardening

**OBJECTIVE** Close every control in `THREAT-MODEL.md` §4 and exercise the runbooks.

**IMPLEMENTATION** Full security test suite; expanded injection red-team corpus; dependency audit;
permission review across all tokens; **credential rotation drill actually performed** for all three
vendors; log redaction verification; backup and restore of the SQLite file verified by restoring to
a clean path; incident runbook written.

**ACCEPTANCE CRITERIA**

- [ ] Every security test in `THREAT-MODEL.md` §5 passes
- [ ] Rotation performed for Anthropic, X, and GitHub with recorded downtime
- [ ] Backup restored successfully to a clean environment
- [ ] No high or critical dependency advisories
- [ ] Every token verified least-privilege
- [ ] Log redaction verified against a planted synthetic secret

**EXIT CRITERIA** Above.

---

## ☐ Phase 15 — Production E2E validation

**OBJECTIVE** Prove the system works, and write down honestly where it does not.

**IMPLEMENTATION** 30-day continuous run. Full validation report covering: source ingestion, event
detection, clustering, deduplication, source confidence, importance scoring, brand relevance, AI
analysis, X strategy, educational opportunities, trend detection, dashboard, alerts, security,
prompt-injection defense, rate limits, API resilience, observability, and real-world behaviour.

**ACCEPTANCE CRITERIA**

- [ ] 30 days continuous operation with uptime recorded
- [ ] Detection latency, dedup precision/recall, alert precision, and cost all measured and reported
- [ ] ≥20 posts published through the system's recommendations with outcomes attributed
- [ ] The operator states plainly whether the system saved him time and improved his output — and if
      it did not, that answer is recorded rather than explained away
- [ ] **A written list of what the system does badly**, carried forward as the next backlog

**EXIT CRITERIA** The validation report exists and is honest.

---

# 8. Dependencies between phases

```
1 ──▶ 2 ──▶ 3 ──▶ 4 ──▶ 5 ──▶ 6 ──▶ 7 ──▶ 10 ──▶ 11
                                    ├──▶ 8 ──┘      │
                                    └──▶ 9 ─────────┤
                                                    ▼
                                          12 ──▶ 13 ──▶ 14 ──▶ 15
```

Phases 8 and 9 are parallelisable with 7 and are the safest to defer if time is short.
Phases 1–5 require **no credentials whatsoever**.

# 9. Minimum viable release

**Phases 1–7 + 10.** That is: real ingestion, real deduplication, real scoring, real analysis, real
recommendations, and a usable dashboard. Alerts, trends, education, and the feedback loop are
genuine improvements but the system is _useful_ at Phase 10.

If the operator has to stop somewhere, stop there — do not stop mid-pipeline at Phase 5, which
produces a scored list nobody can act on.

# 10. What can remain mocked, and for how long

| Subsystem | Mockable through | Notes                                                   |
| --------- | ---------------- | ------------------------------------------------------- |
| Ingestion | Phase 5          | Fixtures are recorded real payloads                     |
| AI        | Phase 9          | `AI_MODE=MOCK` runs the full pipeline deterministically |
| X         | Phase 12         | Nothing before analytics needs X at all                 |
| Alerts    | Phase 11         | Console fallback                                        |

**Nothing may remain mocked after Phase 13**, and the MOCK badge exists so that this is never in
doubt.

# 11. Biggest risks

| Risk                                                | Severity | Mitigation                                                               | Where                       |
| --------------------------------------------------- | -------- | ------------------------------------------------------------------------ | --------------------------- |
| **X API pricing makes monitoring infeasible**       | Resolved | Architecture split: free feeds for ingestion, owned reads for analytics  | `SOURCE-INTELLIGENCE.md` §0 |
| Prompt injection via ingested content               | High     | Capability starvation + structured outputs + sanitisation + human review | T-1                         |
| Confidently wrong analysis published                | High     | Confidence tags, evidence ids, DO-NOT-SAY, WAIT forcing rules            | T-2                         |
| Silent source death                                 | High     | Freshness tracking + alerting + startup self-test                        | T-9                         |
| Cost blowout                                        | Medium   | Rule gate, tiering, batch API, dual budget guards                        | T-10                        |
| Local-only means missed detections                  | Medium   | Measured in Phase 10; deploy only if data justifies it                   | `ARCHITECTURE.md` §2        |
| Trend detection is genuinely weak without paid data | Medium   | Scoped honestly as human-observed / machine-tracked                      | Phase 9                     |
| Analysis is competent but obvious                   | **High** | Human acceptance gates in Phases 5, 6, 7                                 | Phases 5–7                  |
| Operator has no time to use it                      | High     | 60-second decision target; ≤2 alerts/day                                 | Phase 10, 11                |
| Model/API drift                                     | Low      | Config-driven model ids, scheduled live smoke test                       | T-11                        |

The risk worth staring at is **"competent but obvious."** Every other risk has a technical
mitigation. This one is only caught by the human acceptance gates, and it is the one that decides
whether the system is worth running at all.

# 12. Cross-document consistency check

Performed 2026-08-12 across all six documents:

- ✅ X's role is identical in all four documents that mention it: publishing + measurement, never
  ingestion.
- ✅ Model IDs, prices, and the Haiku 4096-token cache floor agree between `ARCHITECTURE.md` §6 and
  `ENV-HANDBOOK.md` §3.
- ✅ Every threat in `THREAT-MODEL.md` §4 maps to a phase that exists here; every phase's security
  work maps back.
- ✅ Every source-registry field in `SOURCE-INTELLIGENCE.md` §6 is created in Phase 2.
- ✅ MOCK/LIVE semantics are identical in `ARCHITECTURE.md` §8, `ENV-HANDBOOK.md` §2, and
  `WORKING-DISCIPLINE.md`.
- ✅ No duplicated scope: architecture decisions live only in `ARCHITECTURE.md`, source facts only in
  `SOURCE-INTELLIGENCE.md`, secrets only in `ENV-HANDBOOK.md`, security only in `THREAT-MODEL.md`,
  process only in `WORKING-DISCIPLINE.md`. This document sequences and gates them.
- ⚠️ **Deliberately unresolved:** the repository name (`signal-desk` proposed) and the individuals
  watchlist (Phase 2). Both need the operator's input.

---

# FINAL ROADMAP DECISION

**Total phases:** 15.

| #   | One line                                                         |
| --- | ---------------------------------------------------------------- |
| 1   | Public repo, CI/CD, config, test infrastructure — no features    |
| 2   | Source registry, entity registry, probe tooling                  |
| 3   | Ingestion adapters: RSS, GitHub Atom, status pages, HTML diff    |
| 4   | Normalisation, three-stage deduplication, canonical events       |
| 5   | Deterministic scoring + the pre-LLM rule gate                    |
| 6   | AI analysis engine with injection defense and budget control     |
| 7   | X content strategy: five options, one recommendation, DON'T POST |
| 8   | Educational opportunities + experiment generator                 |
| 9   | Trend intelligence — human-observed, machine-tracked             |
| 10  | Dashboard command centre; deployment decision made with data     |
| 11  | Alerts with a hard noise ceiling                                 |
| 12  | Analytics, attribution, offline weight refitting                 |
| 13  | Live platform integration; optional assisted publishing          |
| 14  | Security hardening, rotation drills, runbooks                    |
| 15  | 30-day production validation and an honest limitations report    |

**Major dependencies:** strictly linear 1→7, with 8 and 9 parallel to 7; 10 gates 11; 12 requires 10;
13 requires everything.

**Biggest architectural risks:** local-only deployment means detection stops when the machine is off
(measured and revisited at Phase 10); SQLite is right for this scale but a migration to Postgres
would be required if the design ever became multi-user; the modular monolith is deliberately hard to
scale horizontally, which is correct for one user and wrong for any other shape.

**Biggest data-source risks:** X pricing eliminated the richest social signal — the free-feed
substitute is INFERRED and unvalidated until Phase 12; Anthropic publishes no RSS, so its coverage
depends on HTML diffing that can break; individual expert monitoring is largely unsolved without
paid access.

**External services:** Anthropic (paid, the only mandatory one) · X API (paid, optional, metered) ·
GitHub (free) · ntfy (free, optional). That is the complete list.

**Recommended stack:** TypeScript · Node 22 · pnpm workspaces · SQLite + Drizzle + sqlite-vec ·
local ONNX embeddings · Anthropic (`claude-haiku-4-5` triage, `claude-opus-5` analysis) · croner ·
Next.js 16 · Vitest · GitHub Actions.

**Minimum viable release:** Phases 1–7 + 10.

**What can remain mocked:** ingestion through Phase 5, AI through Phase 9, X through Phase 12,
alerts through Phase 11. Nothing after Phase 13.

**What requires real credentials:** Anthropic from Phase 6, X from Phase 12, everything from Phase 13.

**When live X integration happens:** Phase 12 (read-only owned analytics), Phase 13 (optional
assisted posting, human-confirmed).

**When trend detection becomes active:** Phase 9, scoped honestly as human-observed and
machine-tracked.

**When the system becomes useful:** Phase 10. Before that it is infrastructure.

**When full E2E validation happens:** Phase 15, over 30 continuous days.

**Estimated recurring cost:** $37–60/month as designed; $10–20/month with the cost levers in
`ARCHITECTURE.md` §6 applied. This is the one real expense and it should be re-measured, not
assumed, at Phase 6.

---

> ## **EXECUTION IS UNDER WAY.**

Approval was given on 2026-08-13 for continuous execution of the whole roadmap. See _Planning
revisions_ at the top of this document for what that changed and, more importantly, what it did
not — the human acceptance gates in Phases 5, 6, 7, 8 and the elapsed-time criteria in Phases 3, 9,
11, 13, 15 remain outstanding regardless of how much code is written.
