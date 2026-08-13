# Validation report

**Date:** 2026-08-13 · **Phases 1–15 built** · **1,000 tests** · **CI green**

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

### 6.3 Nothing has passed through a real model

`AI_MODE=MOCK` proves the pipeline runs; it proves nothing about analysis quality. The
prompts are untested against a model. The Haiku cache floor is satisfied by a
character-count estimate, not a measured `cache_read_input_tokens > 0`.

### 6.4 The analysis threshold and the score scale are miscalibrated

Top combined score over 5,007 events: **66**. `AI_ANALYSIS_THRESHOLD` default: **70**.
The expensive tier is unreachable by construction. Neither number was changed to hide
this — both are reported, and the CLI now says so out loud — but the system as
configured would never deep-analyse anything.

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

### 6.9 Several DON'T POST reasons have never fired on real data

`insufficient_information` and `reputational_risk` depend on `stillUnknown` and
`doNotSay`, which come from Phase 6 analyses. No event has one. They are implemented
and tested and have never run in anger.

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

### 6.13 One ingest run, one machine

Every measurement here comes from a single backfill on one developer machine. CI on
different hardware has already caught defects local runs did not (two timing failures,
one hung smoke test). A production environment will find more.

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
