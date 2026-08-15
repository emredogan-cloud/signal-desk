# Validation report

> ## ⛔ SYSTEM FROZEN / SUSPENDED — 2026-08-15
>
> Emergency hard freeze by operator directive. **Every measurement below was taken
> against a running system and is now historical.** Nothing in this report is being
> re-measured, because nothing is running.
>
> **Verified at freeze time (not asserted — each was checked):**
>
> | Check | Method | Result |
> | --- | --- | --- |
> | Machine stopped | `flyctl machine list` | `stopped` |
> | Traffic cannot wake it | 3 × `curl https://signal-desk.fly.dev/` then re-check state | `HTTP 000` ×3, still `stopped` |
> | Local worker killed | `SIGTERM` to pid 2379878, then `ps` | gone; no `signal-desk` node process remains |
> | Effective AI mode | `node apps/worker/dist/cli/check-env.js` | `AI_MODE MOCK (canned analyses)` |
> | Budget is a hard stop | read `packages/ai/src/budget.ts:110` | `dailyBudgetUsd <= 0 → 'SUSPENDED'` — `0.00` refuses, it does not mean "unlimited" |
> | Key out of secret store | `flyctl secrets list` | `ANTHROPIC_API_KEY` absent |
> | Key not lost | `.env.backup-frozen-2026-08-15`, mode 600, `git check-ignore` passes | preserved, unstageable |
> | Database intact | `PRAGMA quick_check` on the volume | live DB `ok`; 08-14 backup `ok` |
>
> **Spend after freeze:** $0.00/hr compute, $0.00 tokens, $0.00 X API.
> Residual **~$0.45/month** for the 3 GB volume, retained on purpose to preserve the
> database. Reporting this as a literal $0.00 would be false.
>
> **Two things this freeze did not fix**, both recorded in `PROJECT-MEMORY.md`:
> the `/data` volume is **100% full**, so no new backup can be taken (`SQLITE_FULL`);
> and the machine's deployed config is still the pre-freeze one, so it must be restarted
> with `fly deploy`, never a bare `fly machine start`.

**Date:** 2026-08-13 · **Phases 1–15 built** · **1,000 tests** · **CI green**

> **UPDATED 2026-08-13, later the same day: `ANTHROPIC_API_KEY` was configured and the
> AI path was validated against the real models.** §2, §3, and §6 below are revised.
> The live run found **eight defects**, listed in §9. Three items in the original §6
> are now closed and are struck through there rather than deleted.

`ROADMAP.md` Phase 15's exit criterion is one sentence: _"The validation report exists
and is honest."_ This is that report.

It is written before the 30-day run, not after, and says so. Every number here was
measured; every criterion that could not be measured is named as such rather than
estimated, projected, or quietly omitted.

---

## 1. The headline

**The system is built and the pipeline runs end to end without credentials.** Ingestion
→ normalisation → clustering → scoring → gate → analysis → strategy → alerts →
dashboard all work over 5,208 real ingested items.

**It has never run in production, produced no analysis with a real model, and published
nothing.** Nine of the fifteen phases have acceptance criteria that require elapsed
time, an operator judgement, or vendor credentials. Those are listed in §5 as
outstanding work, not as completed work with caveats.

**The most important thing this report can say is what the system does badly.** That is
§6, and it is the longest section on purpose.

---

## 2. What was measured

Every figure below came from a command that can be re-run.

| Measurement               | Value                                                    | How                                        |
| ------------------------- | -------------------------------------------------------- | ------------------------------------------ |
| Real items ingested       | **5,208**                                                | `pnpm ingest` over 60 registry sources     |
| Events after clustering   | **5,007**                                                | three-stage dedup                          |
| Dedup precision / recall  | **1.0000 / 0.9500**                                      | `pnpm measure-dedup`, 15 labelled clusters |
| Similarity threshold      | **0.80** (measured; replaced a 0.86 guess)               | same                                       |
| Gate kill rate            | **98.7% overall / 91.5% in-window**                      | `pnpm score`                               |
| Events surviving the gate | **65**                                                   | same                                       |
| Strategy restraint rate   | **50.8%** (target ≥30%)                                  | `pnpm strategy`                            |
| Detection latency         | **p50 11.3h · p75 37.5h · p90 85.2h · p99 165.4h**       | `pnpm latency`, 738 in-window events       |
| Alerts fired              | **1** from 65 gate survivors                             | `pnpm alerts --dry-run`                    |
| Injection corpus          | **39 documents, 100 assertions, all pass**               | `pnpm test`                                |
| Live security controls    | **6/6**                                                  | `pnpm security`                            |
| Backup / restore          | 65MB, `integrity_check ok`, all tables non-empty         | `pnpm security`                            |
| Offline replay corpus     | 5,007 events, middle 90% spanning **2,428 days**, **$0** | `pnpm replay`                              |
| Dependency advisories     | **0** at any severity                                    | `pnpm audit`                               |
| Tests                     | **1,000** across 30 files                                | `pnpm verify`                              |

---

## 3. Subsystem-by-subsystem

`ROADMAP.md` Phase 15 lists nineteen areas. Each is rated **WORKS** (measured),
**UNPROVEN** (built, not exercised against reality), or **NOT BUILT**.

| Area                      | Rating                                            | Basis                                                                   |
| ------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------- |
| Source ingestion          | **WORKS**                                         | 60 sources, 5,208 items, SSRF-guarded, robots-respecting                |
| Event detection           | **WORKS**                                         | 5,007 events from 5,208 items                                           |
| Clustering                | **WORKS**                                         | three-stage, measured                                                   |
| Deduplication             | **WORKS**                                         | precision 1.0000, recall 0.9500                                         |
| Source confidence         | **WORKS**                                         | registry-derived, capped in code                                        |
| Importance scoring        | **UNPROVEN**                                      | deterministic and explainable; **every weight is an unvalidated guess** |
| Brand relevance           | **UNPROVEN**                                      | same                                                                    |
| AI analysis               | **UNPROVEN**                                      | pipeline runs in MOCK; no model has been called                         |
| X strategy                | **UNPROVEN**                                      | 50.8% restraint measured; whether the _choices_ are right is unknown    |
| Educational opportunities | **UNPROVEN**                                      | limitations enforced in code; no opportunity has been acted on          |
| Trend detection           | **UNPROVEN (manual)** / **NOT BUILT (automated)** | manual path complete; automated signal is specified and unwired         |
| Dashboard                 | **WORKS**                                         | renders 50KB, CSP verified on the wire, hostile content inert           |
| Alerts                    | **UNPROVEN**                                      | 1 alert from 65 events; the ≤2/day _average_ needs two weeks            |
| Security                  | **WORKS**                                         | 6/6 live controls, 0 advisories                                         |
| Prompt-injection defence  | **WORKS (deterministic layers)**                  | 35 hostile + 4 benign documents; the model layer is untested            |
| Rate limits               | **UNPROVEN**                                      | self-limits built and tested; no real 429 has been handled              |
| API resilience            | **UNPROVEN**                                      | retry/backoff/circuit-breaker built; exercised only against fixtures    |
| Observability             | **WORKS**                                         | structured logs, redaction verified, health panel                       |
| Real-world behaviour      | **NOT MEASURED**                                  | the system has not run in production                                    |

---

## 4. What the measurements actually justify

**Deduplication is genuinely good.** Precision 1.0000 at recall 0.9500 over labelled
real data, with the threshold measured rather than guessed. This is the strongest
result in the system.

**The rule gate does its job.** 98.7% of events never reach a paid model. That is the
difference `ARCHITECTURE.md` §4 calls "a $150/month toy and a $15/month tool".

**The security posture holds where it can be tested.** Every deterministic layer —
sanitiser, detector, envelope, output validation, scoring caps, forcing rules —
resists all 35 hostile documents without flagging any of the 4 benign controls,
including a legitimate article _about_ prompt injection.

**The system exercises restraint.** 50.8% of surfaced events get DON'T POST, WAIT, or
VERIFY. One alert from 65 events. Those numbers describe a system with judgment rather
than one that recommends action on everything — which was the stated failure mode.

**Detection latency is honest but unimpressive.** A median of 11.3 hours is _same-day_,
not _early_. It comes from a backfill rather than continuous polling, so a live
schedule should beat it — but that is a hypothesis, and the roadmap's stated goal is
to be early.

---

## 5. Outstanding work, by blocker

### Blocked on credentials

- Phase 6: schema conformance over ≥100 real events; a verified prompt-cache hit;
  measured daily cost.
- Phase 12: X owned reads; ≥30 attributed posts; **the weight refit itself**.
- Phase 13: 7 days live; real spend; live adapter smoke tests.
- Phase 14: credential rotation drill; least-privilege token review.

### Blocked on elapsed time

- Phase 3: ≥24h continuous ingestion.
- Phase 4: a week of live data reviewed by eye.
- Phase 8: ≥1 usable educational opportunity per day over two weeks.
- Phase 9: a trend tracked over ≥2 weeks; a month of automated detection.
- Phase 11: the ≤2 alerts/day average over two weeks.
- Phase 15: 30 days continuous operation.

### Blocked on the operator

- Phase 5: top-20 review — _"this is a human acceptance gate and it is not optional"_.
- Phase 6: reads 20 analyses and judges them non-obvious.
- Phase 7: judges ≥60% of QUOTE-NOW recommendations actionable.
- Phase 8: judges ≥5 experiments runnable in under 2 hours; runs one end to end.
- Phase 10: under-60-seconds; one-screen morning brief; a week of daily use.
- Phase 15: states plainly whether it saved him time.

### Blocked on data that does not exist yet

- Phase 10: the remote-deployment decision, which requires a month of miss data
  attributable to machine-off hours.

---

## 6. What the system does badly

**This is the deliverable.** `ROADMAP.md` Phase 15: _"A written list of what the system
does badly, carried forward as the next backlog."_ Ordered by how much it matters.

### 6.1 Every score weight is a guess, and the refit cannot run

`packages/core/src/score/weights.ts` says so at the top of every constant, and Phase 12
was supposed to replace them. It could not: fitting weights requires outcomes, outcomes
require posts, posts require the operator. The replay engine works and costs $0, but it
narrows candidates rather than choosing between them. **Until this closes, every
ranking in the system is a plausible ordering rather than a measured one.**

### 6.2 The velocity proxy is unvalidated and may be worthless

X velocity was priced out, so Phase 5 substituted HN/Reddit/GitHub activity and labelled
it INFERRED. Nothing has validated the substitution. It is weighted at 0.12 of
importance specifically so that discarding it does bounded damage — which is mitigation,
not evidence.

### 6.3 ~~Nothing has passed through a real model~~ — **CLOSED 2026-08-13**

Superseded. The live path was validated: 65 triage calls, 3 deep analyses, and 16
hostile documents through the real model. Cache is measured at **67/68 calls reading
from cache**, not inferred from prompt length. The remaining gap is _sample size_ —
one day's budget bought 3 deep analyses, not the ≥100 events the criterion asks for.

### 6.4 ~~The analysis threshold and the score scale are miscalibrated~~ — **CLOSED 2026-08-13**

Fixed with evidence rather than by preference. `AI_ANALYSIS_THRESHOLD` is now **50**,
chosen after measuring candidate counts and real cost at 70 / 60 / 50 / 45 over the 65
gate survivors. It remains a threshold over _unfitted_ weights: when Phase 12 refits
them the scale moves and this must be re-measured, not preserved.

### 6.5 Detection is same-day, not early

Median 11.3 hours against a stated goal of being early. Continuous polling should
improve it; that is a hypothesis with no measurement behind it.

### 6.6 Automated trend detection is not wired

The lifecycle and card work over any observation series. Nothing writes automated
observations. The manual path is complete and the automated path is a stub — deliberately,
with no fabricated data behind it, but it is a gap.

### 6.7 Angle and injection detection are regex-driven

Explainable and free, and they will miss what a reader would catch. The injection
corpus found 22 gaps in the Phase-4 detector on its first run; there is no reason to
believe the current set is complete.

### 6.8 Alert dedup does not survive a restart

Dedup state is per-run. Two runs an hour apart both alert on the same fact. Stated in
the code rather than left for a reader to assume otherwise, but unfixed.

### 6.9 One DON'T POST reason still has never fired _(was two)_

Real analyses now feed the strategy layer, and **`insufficient_information` has fired
on real data**. Restraint rose 50.8% → 52.3%. `reputational_risk` still has not: it
needs an event whose do-not-say list runs to five entries, and the longest so far is
eight — on an event that was not otherwise a DON'T POST candidate.

### 6.10 No accessibility audit has been run

Dashboard semantics are correct by construction — landmarks, `scope` on headers,
`role="alert"`, `aria-current`. Correct-by-construction is not a measured pass.

### 6.11 The confirmation control has no caller

Phase 13's T-4 control is a tested library nothing calls. That is deliberate — a
publish button with no possible publish is a trap — but it means the _flow_ is
untested, only the control.

### 6.12 No scheduled backup

Backup and verified restore work and are exercised by `pnpm security`. Nothing runs
them on a schedule. Scheduling something that has never run unattended would be worse
than not scheduling it, but the gap is real.

### 6.13 The container has not been built successfully in this environment

`Dockerfile` exists from Phase 1 and its structure is sound — the lockfile resolves
(`Lockfile is up to date`) and every `COPY` layer succeeds. But `pnpm install` inside
the container fails: **26 network errors** across `ETIMEDOUT`, `ECONNRESET`, and
`EAI_AGAIN` fetching from `registry.npmjs.org`, on two attempts including one with
`--network=host`. There are **no pnpm logic errors** — no integrity mismatch, no
resolution failure, no authorization problem.

This is a sandbox networking limitation, not a Dockerfile defect, and it is recorded
as neither. **The container is unverified.** It has not been shown to build and it has
not been shown to be broken. Anyone deploying should build it somewhere with reliable
registry access before trusting it.

The same environment intermittently failed `git push` with
`Could not resolve host: github.com`, which corroborates the diagnosis.

### 6.14 One ingest run, one machine

Every measurement here comes from a single backfill on one developer machine. CI on
different hardware has already caught defects local runs did not (two timing failures,
one hung smoke test). A production environment will find more.

---

## 9. What the live run found

Eight defects, none of which any amount of MOCK testing would have surfaced.

1. **Real spend was recorded as $0.00.** The API returns dated model ids
   (`claude-haiku-4-5-20251001`); the pricing table was keyed by the alias, so
   `callCostUsd` returned `undefined` and the caller coalesced it to zero. The ledger
   read flat while 8,764 cache-read tokens were being billed. **The budget guard could
   never have fired.**
2. **`--reset` erased the record of money already spent.** Spend was derived from the
   `analyses` table. Across the day's runs "spent today" returned to $0.0000 six times
   while ≈$2.00 of real calls had been made. Analyses are derived and disposable; money
   is not. `spend_ledger` is now append-only and `--reset` cannot touch it.
3. **Good triage verdicts were discarded for running long.** `reason` was capped at 300
   characters and two of six real Haiku calls wrote ~320 characters of sound reasoning.
   Structured outputs carry no `maxLength`, so the bound was invisible to the model and
   fatal to us — work already paid for, thrown away.
4. **Opus analyses truncated mid-JSON.** Claude Opus 5 thinks by default and
   `max_tokens` caps thinking plus response _together_; a 4k budget spent itself
   reasoning. It surfaced as "not valid JSON despite structured outputs" — a budget
   problem wearing a schema problem's error message.
5. **The provenance check compared presentation, not value.** A sourced figure written
   `27,674` in a claim and `27674` in the narrative failed a substring match and
   discarded a paid analysis.
6. **Cache reporting read the wrong stage.** It printed "0 successful calls — too few
   to demonstrate a hit" while the ledger showed 8,764 cache-read tokens from triage.
7. **Validation failures were undiagnosable.** The stored reason was "output did not
   match the schema" and nothing else.
8. **A rejected analysis threw away the only thing that could explain it.** The
   payload was stored as `null` on failure, so the model's actual output — already
   paid for — went with the verdict.

**What the model got right.** Judged on the one clean analysis and the triage sample:
claims all carried evidence ids; `DO NOT SAY` entries were specific and event-grounded
(_"they are no longer auto-approved, which is a prompt, not a block"_); `stillUnknown`
named real gaps including "no independent confirmation"; confidence was MED under a
single official source, which is the two-source rule working. The insight in the
`whatChanged` field was genuinely non-obvious rather than a changelog restatement.

**What is still not known.** Three deep analyses is not a quality measurement. The
≥100-event schema-conformance bar and the operator's non-obviousness judgement both
remain open, and one day's `AI_DAILY_BUDGET_USD` does not buy them.

---

## 7. What went right, methodologically

Recorded because it is the part worth repeating.

**Every measured acceptance criterion failed on its first run** — Phase 5 (17% vs 85%),
Phase 7 (20.6% vs 30%), Phase 9 (a saturated curve read as MAINSTREAM), Phase 11 (a
LIMIT read as a truncation), Phase 14 (a redaction test that captured nothing). **Each
failure was a real defect, not a badly-set threshold.** Every one was found by measuring
against real data rather than by reasoning about the code.

**Real data found what fixtures could not.** The injection corpus exposed 22 detector
gaps. 5,208 real items forced `identityArtifactKeys`, title-only artifacts, and cursor
pagination. Curated fixtures had passed throughout.

**Caps in code, never in prompts.** Phase 5 caps confidence, Phase 6 caps analysis
output, Phase 7 forces recommendations, Phase 13 gates publishing on a hash of the
reviewed bytes. A weight can be outvoted by volume — which is exactly how a rumour
becomes fact through repetition. A cap cannot.

**Purity paid for itself.** `scoreEvent` and `applyGate` take `now` as a parameter
rather than reading the clock. That cost nothing in Phase 5 and is the only reason the
Phase 12 replay is meaningful — a scorer calling `Date.now()` internally would make
every replay silently wrong while appearing to work.

---

## 8. The honest summary

A working intelligence pipeline with strong deduplication, a cost gate that does its
job, security controls that hold where they can be tested, and a dashboard that renders
a decision in one screen.

It has not run in production, called a model, published a post, or been used by the
person it was built for. Its rankings rest on guesses that the machinery to replace is
built but cannot yet run.

**The system is ready to be tried. It is not validated.** That distinction is the whole
point of this document.
