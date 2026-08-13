# ARCHITECTURE.md

**System:** real-time AI / software / technology intelligence + personal authority operations console.
**Shape:** modular monolith, one language, one database, one AI vendor, one repository.
**Written:** 2026-08-12. Decisions here are binding until superseded by a dated revision.

---

## 1. Design constraints that actually drove the decisions

These come from the operator's real situation, not from a generic best-practices list:

| Constraint                                                         | Consequence                                                                                                                                            |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Solo operator, limited hours/day                                   | One language across the whole stack. No context-switching tax. No service mesh to debug at 1am.                                                        |
| No advertising budget; dislikes paid SaaS subscriptions            | Every external dependency must have a genuinely free tier or be self-hostable. The AI API is the only accepted recurring cost, and it must be bounded. |
| Works on Linux, prefers CLI-compatible tooling                     | Runs as a plain process with `pnpm` scripts. No mandatory cloud console.                                                                               |
| Already writes TypeScript daily (Supabase edge functions) and Dart | TypeScript. Not Python — the marginal language is the marginal maintenance cost.                                                                       |
| Repository must be public (brief §55)                              | No secrets in repo, ever. Public repo also unlocks free unlimited GitHub Actions minutes.                                                              |
| X API is pay-per-use with no free tier                             | X is a _publishing and measurement_ surface, not an ingestion surface. See `SOURCE-INTELLIGENCE.md` §0.                                                |
| Untrusted external content is the primary input                    | Prompt-injection defense is an architectural layer, not a prompt suffix. See `THREAT-MODEL.md`.                                                        |

---

## 2. Stack decision

| Layer           | Choice                                                                       | Why this and not the alternative                                                                                                                                                        |
| --------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language        | **TypeScript 6.0.3, Node 22 LTS**                                            | Operator's daily language. Strict mode, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. Version pinned — see the dated revision below.                                        |
| Package manager | **pnpm workspaces**                                                          | Workspace support without a build-system dependency.                                                                                                                                    |
| Runtime shape   | **Modular monolith, two entrypoints**                                        | `worker` (scheduler + pipeline) and `web` (dashboard). Microservices for a single-user system is pure overhead.                                                                         |
| Database        | **SQLite (WAL) via better-sqlite3 + Drizzle ORM**                            | Single file, zero ops, zero cost, fast enough by three orders of magnitude (see §7). Drizzle keeps the Postgres migration path open without an ORM rewrite.                             |
| Vector search   | **sqlite-vec** extension                                                     | In-process, no vector database, no second service.                                                                                                                                      |
| Embeddings      | **Local ONNX (`bge-small-en-v1.5` via `fastembed`/transformers.js)**         | Free, offline, no second AI vendor. Anthropic has no embeddings endpoint; adding Voyage or OpenAI purely for embeddings would violate the one-vendor rule for no benefit at this scale. |
| AI              | **Anthropic only** — `claude-haiku-4-5` (triage), `claude-opus-5` (analysis) | §63 of the brief. Tiering is the cost control; see §6.                                                                                                                                  |
| Scheduler       | **In-process (`croner`)**                                                    | The worker is already a long-lived process. An external scheduler would be a service to operate for no gain.                                                                            |
| Dashboard       | **Next.js 16 (App Router) + Tailwind + shadcn/ui**                           | Server components read SQLite directly in dev. Deploys later without a rewrite if the operator wants remote access.                                                                     |
| HTTP client     | **`undici` (built in)**                                                      | Conditional requests, timeouts, connection reuse.                                                                                                                                       |
| Feed parsing    | **`fast-xml-parser`**                                                        | No feed library that "helpfully" follows links or executes anything.                                                                                                                    |
| HTML → text     | **`@mozilla/readability` + `linkedom`, sandboxed**                           | See `THREAT-MODEL.md` §T-1 for the sanitisation contract.                                                                                                                               |
| Tests           | **Vitest**                                                                   | Fast, TS-native, no config.                                                                                                                                                             |
| Lint / format   | **ESLint (flat) + Prettier**                                                 |                                                                                                                                                                                         |
| CI              | **GitHub Actions**                                                           | Free and unlimited for public repos.                                                                                                                                                    |

### Dated revision — 2026-08-13 — TypeScript pinned to 6.0.3, not 7.x

TypeScript 7.0.2 is the current release. This project pins **6.0.3** because
`typescript-eslint@8.67.0` declares `typescript: ">=4.8.4 <6.1.0"`, and TypeScript 7 is the Go
rewrite that its type-aware rules do not yet support.

Type-aware linting is not cosmetic here. `no-floating-promises` is what stops a dropped fetch in
the ingestion loop from becoming a silently missed source (T-9), and the `dangerouslySetInnerHTML`
ban is a T-7 control. Running on TS 7 would leave those rules installed and quietly inert — the
worst of both, since the config would still claim they were enforced.

Revisit when typescript-eslint ships TS 7 support. This is a version pin, not an architecture
change: nothing in the codebase depends on a 6.x-specific feature.

### Dated revision — 2026-08-13 — dependency build scripts

`THREAT-MODEL.md` §T-5 specifies `pnpm` config `ignore-scripts=true` with an explicit allowlist.
Implemented instead as **`onlyBuiltDependencies` in `pnpm-workspace.yaml`**, which is pnpm 10's
precise form of the same control: every dependency is denied install-time script execution unless
named. `ignore-scripts=true` in `.npmrc` is blunter — it would also block `better-sqlite3`, whose
native binding the database cannot load without, leaving the allowlist with no mechanism to
re-enable it.

Current allowlist: **`better-sqlite3` only.** `esbuild` (pulled in by vitest, tsx, and drizzle-kit)
is denied and verified working without its postinstall. Adding an entry is a security decision and
requires a note in the PR saying why the package cannot function without running code at install
time.

### Deployment decision, stated honestly

**Phases 1–9 run locally on the operator's machine.** No hosting, no cost, no platform limits,
fastest iteration.

The tradeoff is real and must not be glossed: **if the machine is off, nothing is detected.** For a
system whose §47 KPI is detection latency, that is a genuine limitation. It is accepted for now
because (a) the operator posts when he is at his machine anyway, (b) paying for hosting before the
system has proven it produces usable output is exactly the premature cost this brief warns against,
and (c) the monolith is containerised from Phase 1, so moving to a €4/month VPS or a free tier is a
deployment change, not a rewrite.

**Phase 10 revisits this with data**: if the measured miss-rate from machine-off hours is material,
deploy. If it is not, keep the €0.

Rejected alternatives, with reasons:

- **Vercel Cron on Hobby** — cron frequency limits are restrictive on the free tier and would cap
  Priority-1 sources at a polling interval that defeats the latency KPI. _Verify current limits
  before revisiting; this is an_ **INFERRED** _constraint._
- **GitHub Actions as the scheduler** — free and always-on, but scheduled workflows are documented
  best-effort and routinely fire 5–15 minutes late under load. That is an unacceptable jitter budget
  for a system that measures minutes. Fine as a _backstop_ heartbeat, not as the primary clock.
- **Supabase/Postgres from day one** — the operator knows it, but it adds a network hop, a service
  to keep alive, and a free-tier pause policy, in exchange for concurrency this system will never need.

---

## 3. Repository layout

Proposed name: **`signal-desk`**. Alternates: `frontier-desk`, `situation-desk`. Final call is the
operator's; the name only needs to be decided before Phase 1's `git init`.

```
signal-desk/
├── apps/
│   ├── worker/          # long-lived process: scheduler → pipeline
│   └── web/             # Next.js dashboard
├── packages/
│   ├── core/            # domain logic — no I/O, heavily unit-tested
│   │   ├── normalize/   # source payload → CanonicalEvent
│   │   ├── cluster/     # dedup + clustering
│   │   ├── score/       # importance, brand relevance, confidence
│   │   ├── analyze/     # AI orchestration + prompt assembly
│   │   ├── strategy/    # X options, experiment generator, "don't post"
│   │   └── trends/      # Phase 9 lifecycle model
│   ├── adapters/        # one file per ingestion mechanism
│   ├── db/              # Drizzle schema + migrations + queries
│   ├── ai/              # Anthropic client, tiering, caching, budget guard
│   └── shared/          # types, zod schemas, logger, config
├── fixtures/            # recorded real payloads — the mock-mode corpus
├── docs/                # the six planning documents
└── .github/workflows/   # ci.yml
```

**`packages/core` performs no I/O.** Everything it needs is passed in. This is what makes the
scoring and clustering logic testable without a network, and it is what makes MOCK mode a first-class
citizen rather than a bolt-on.

---

## 4. The pipeline

```
                    ┌─────────────┐
  scheduler ───────▶│  ADAPTERS   │  rss · github_atom · statuspage · html_diff · x_owned
  (croner)          └──────┬──────┘
                           │ RawItem (unmodified bytes + source id + fetch metadata)
                           ▼
                    ┌─────────────┐
                    │  SANITIZE   │  strip HTML/scripts/hidden text, cap length,
                    │             │  wrap in untrusted-content envelope   ◀── THREAT-MODEL T-1
                    └──────┬──────┘
                           ▼
                    ┌─────────────┐
                    │ NORMALIZE   │  → CanonicalEvent draft: entities, product names,
                    │             │    version strings, urls, published_at
                    └──────┬──────┘
                           ▼
                    ┌─────────────┐
                    │   CLUSTER   │  3-stage dedup (§5) → attach as evidence to an
                    │             │  existing event, or open a new one
                    └──────┬──────┘
                           ▼
                    ┌─────────────┐
                    │ RULE GATE   │  cheap deterministic filters — kills ~90% before
                    │             │  any token is spent            ◀── cost control
                    └──────┬──────┘
                           ▼
                    ┌─────────────┐
                    │  TRIAGE     │  claude-haiku-4-5, structured output
                    │             │  → category, entities, importance_hint, is_noise
                    └──────┬──────┘
                           ▼
                    ┌─────────────┐
                    │   SCORE     │  importance 0–100 · brand relevance 0–100 ·
                    │             │  confidence · velocity
                    └──────┬──────┘
                           ▼
                    ┌─────────────┐
                    │  ANALYZE    │  claude-opus-5, only above threshold:
                    │             │  before/after · implications · unknowns ·
                    │             │  expert angle · X options · do-not-say
                    └──────┬──────┘
                           ▼
                    ┌─────────────┐
                    │  DASHBOARD  │  human reviews → publishes manually
                    └──────┬──────┘
                           ▼
                    ┌─────────────┐
                    │  MEASURE    │  x owned reads ($0.001) → outcomes → Phase 12 feedback
                    └─────────────┘
```

The **rule gate before the LLM** is the single most important cost decision in the system. It is what
makes the difference between a $150/month toy and a $15/month tool.

---

## 5. Event model and deduplication

### The canonical event

An **event** is a real-world development. A **source item** is one publication about it. Many source
items map to one event; the dashboard shows one event with its evidence list. This is brief §19–20.

```ts
CanonicalEvent {
  id, title, summary,
  category: 'ai' | 'software' | 'hardware' | 'policy_platform' | 'social_trend',
  entities: EntityRef[],           // ['anthropic', 'claude']
  artifacts: { models: string[], versions: string[], products: string[] },
  first_seen_at, event_occurred_at,           // ← §47 latency KPI numerator
  primary_source_id,                          // the most authoritative evidence
  evidence: Evidence[],                       // every item that mapped here
  scores: { importance, brand_relevance, confidence, velocity },
  status: 'new' | 'triaged' | 'analyzed' | 'actioned' | 'ignored' | 'expired'
}
```

`primary_source_id` is chosen by source category, not by arrival order: `OFFICIAL_SOURCE` outranks
`JOURNALIST` even if the journalist published first. A journalist's report _about_ a launch is
evidence; the launch post is the record.

### Three-stage dedup — cheap first, expensive last

| Stage | Method                                                                                                                                              | Catches                                    | Cost              |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ----------------- |
| 1     | Exact URL + canonical-URL + content hash                                                                                                            | Re-fetches, syndication, feed duplicates   | ~0                |
| 2     | Entity + artifact + time-window match — same entity, same version/model string, within 48h                                                          | "Anthropic ships Claude X" from 6 outlets  | ~0                |
| 3     | Embedding cosine similarity (`bge-small`, sqlite-vec) over title+summary, threshold ~0.86, restricted to same-category candidates within the window | Paraphrases with no shared artifact string | local CPU, no API |

Stage 3's threshold is a **starting guess, not a validated number.** Phase 4's acceptance criterion
is a labelled fixture set with measured precision/recall — the number gets tuned there, and the
document gets updated with the measured value.

Merges are **reversible.** Every merge writes an audit row; the dashboard has an "unmerge" action.
A silent wrong merge hides an event, which is a worse failure than a visible duplicate.

---

## 6. AI layer — model choice, cost control, and the numbers

All facts in this section are from the current Anthropic API reference (see `ENV-HANDBOOK.md` for
where to re-check them).

### Model tiering

| Stage                                                                         | Model                     | Price (in / out per MTok) | Why                                                                                   |
| ----------------------------------------------------------------------------- | ------------------------- | ------------------------- | ------------------------------------------------------------------------------------- |
| Triage — every item that passes the rule gate                                 | **`claude-haiku-4-5`**    | $1.00 / $5.00             | High volume, low judgment. 200K context is ample.                                     |
| Deep analysis — only events above threshold                                   | **`claude-opus-5`**       | $5.00 / $25.00            | This is where the operator's credibility is manufactured. Do not economise here.      |
| Nightly non-urgent work (educational mining, trend scoring, weekly synthesis) | Either, via **Batch API** | **50% off**               | Results within an hour, max 24h. Nothing about a nightly job needs to be synchronous. |

`claude-sonnet-5` ($3/$15, with an introductory $2/$10 through 2026-08-31) is the fallback if Opus
analysis quality proves unnecessary for the marginal event. Decide with an eval in Phase 6, not by
guessing.

**Do not downgrade the analysis model to save money without measuring the quality delta.** The whole
premise of this system is that the output is better than what the operator would write unaided. A
cheaper model that produces plausible-but-shallow analysis destroys the only asset being built.

### Structured output

Every AI call uses **structured outputs** (`output_config.format` with a JSON schema), not prose
parsing. Triage returns a fixed schema; analysis returns a fixed schema. Benefits: no regex parsing,
no retry-on-malformed-JSON loop, and — critically for `THREAT-MODEL.md` — a hostile document cannot
make the model emit a field that isn't in the schema.

### Prompt caching — with a trap that must not be missed

Caching the shared system prompt (source-quality rules, the operator's positioning, the do-not-say
list) is the main lever on triage cost. But:

> **The minimum cacheable prefix is model-dependent, and it is not monotonic.**
> `claude-opus-5`: **512 tokens.** `claude-sonnet-5`: **1024.** **`claude-haiku-4-5`: 4096.**
> A shorter prefix silently does not cache — no error, `cache_creation_input_tokens: 0`.

Since triage runs on Haiku, **the triage system prompt must exceed 4096 tokens or caching does
nothing at all.** This is not a reason to pad the prompt; it is a reason to _verify_. Phase 6
acceptance includes asserting `cache_read_input_tokens > 0` on the second triage call of a run. If it
is zero, either the prompt is under the floor or something volatile is invalidating the prefix.

Cache hygiene rules, enforced by a unit test over the prompt builder:

- The system prompt is **frozen** — no timestamps, no UUIDs, no per-event interpolation before the
  breakpoint. Volatile content goes after the last `cache_control` marker.
- Tool definitions (if any) are sorted deterministically. Tools render at position 0; any reordering
  invalidates everything.
- Economics: cache reads ~0.1× input price; 5-minute-TTL writes 1.25×; 1-hour-TTL writes 2×.
  Break-even at 5m TTL is two requests. Use the default 5m TTL — a polling run makes dozens of
  triage calls within seconds of each other.

### Budget guard — non-negotiable

`packages/ai` wraps every call. It:

1. Records `usage` (input, output, `cache_read_input_tokens`, `cache_creation_input_tokens`) per call
   into a `llm_calls` table, with the event id and stage.
2. Enforces a **daily USD ceiling** from `AI_DAILY_BUDGET_USD`. On breach it degrades rather than
   crashing: triage falls back to rules-only, deep analysis is deferred to the next day's batch, and
   a banner appears on the dashboard. **It never silently stops detecting.**
3. Uses `count_tokens` — never a `tiktoken`-style estimator, which is the wrong tokenizer for Claude.

### Honest cost estimate

| Line                          | Assumption                                                                        | Monthly            |
| ----------------------------- | --------------------------------------------------------------------------------- | ------------------ |
| Triage (Haiku)                | 600 items/day survive the rule gate, ~600 in / 150 out tokens each, cached prefix | **$6–12**          |
| Deep analysis (Opus 5)        | 8 events/day, ~15K in / 3K out                                                    | **$25–40**         |
| Nightly batch work            | Batch API, 50% off                                                                | **$2–4**           |
| X owned reads (analytics)     | ~100 owned reads/day @ $0.001                                                     | **~$3**            |
| X assisted posting (optional) | 3 link-free posts/day @ $0.015                                                    | **~$1.35**         |
| Embeddings, DB, hosting       | local                                                                             | **$0**             |
| **Total**                     |                                                                                   | **≈ $37–60/month** |

That is the honest number for the design as specified, and it is more than an operator with "no
budget" should spend without proof of value. The knobs that bring it to **$10–20/month**, in the
order they should be pulled:

1. Raise the deep-analysis threshold: 8 events/day → 3 events/day cuts the largest line by ~60%.
2. Route deep analysis through the Batch API for everything that isn't breaking (−50% on those).
3. Tighten the rule gate — every item killed before the LLM is free.
4. Swap analysis to `claude-sonnet-5` _only after_ an eval shows the quality delta is acceptable.

Phase 6 must ship with the budget guard and a real measured cost-per-day figure before Phase 7 starts.
"It's probably fine" is not a number.

---

## 7. Data layer

SQLite with WAL, one file, checkpointed nightly, backed up by file copy.

Sizing sanity check: ~800 items/day × ~4KB ≈ 3MB/day ≈ **1.1GB/year**. SQLite handles this without
noticing. The system has exactly one writer (the worker) and one reader (the dashboard). This is the
workload SQLite is best at, not a compromise.

Core tables:

| Table             | Purpose                                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sources`         | The registry from `SOURCE-INTELLIGENCE.md` §6                                                                                                                |
| `raw_items`       | Immutable. Unmodified fetched payload + fetch metadata. Never mutated; enables replay of the whole pipeline against real historical data without re-fetching |
| `events`          | Canonical events                                                                                                                                             |
| `evidence`        | `raw_item` → `event`, with role (`primary`, `corroborating`, `reaction`)                                                                                     |
| `event_scores`    | Score history — scores change as evidence accumulates; keep the series                                                                                       |
| `analyses`        | AI output, versioned, with the model id and prompt version that produced it                                                                                  |
| `content_options` | Generated quote/reply/original/educational/wait recommendations                                                                                              |
| `experiments`     | §34 — question, hypothesis, procedure, metrics, result (operator-filled)                                                                                     |
| `trends`          | §44 trend cards with lifecycle stage                                                                                                                         |
| `outcomes`        | Post → measured impressions, replies, profile visits, follows                                                                                                |
| `llm_calls`       | Per-call token and cost accounting                                                                                                                           |
| `audit_log`       | Merges, unmerges, overrides, budget events                                                                                                                   |

`raw_items` being immutable and replayable is what makes Phase 12 possible: scoring changes can be
re-run over three months of real history offline, at zero API cost, to see whether the new weights
would actually have surfaced better events.

---

## 8. Configuration and modes

Two axes, both explicit, never inferred:

- **`DATA_MODE = MOCK | LIVE`** — MOCK reads from `fixtures/`. Every adapter has a mock twin. CI runs
  MOCK only.
- **`AI_MODE = MOCK | LIVE`** — MOCK returns deterministic canned analyses. Lets the whole pipeline,
  dashboard, and scoring be developed with no key and no spend.

The dashboard renders a **persistent, unmissable badge** when either is MOCK. Brief §53: never
pretend a live integration exists. A mock analysis that looks real on screen is how an operator ends
up posting a fabricated claim.

Missing credentials never block startup. An adapter with no key logs a structured warning, marks
itself `unavailable`, and the rest of the system runs.

---

## 9. Observability

Structured JSON logs (`pino`) with a `trace_id` that follows one item from fetch to analysis.

Metrics written to a `metrics` table and surfaced on a dashboard health panel:

| Metric                                                         | Answers                                                                             |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `source_last_success_at` per source                            | "Why didn't we detect this?" — brief §66. A stale source is the most common answer. |
| `detect_latency_seconds` = `first_seen_at − event_occurred_at` | §47 KPI 1                                                                           |
| `analyze_latency_seconds`                                      | §47 KPI 2                                                                           |
| `dedup_merge_rate` and `unmerge_rate`                          | Clustering health. A rising unmerge rate means the threshold is too aggressive.     |
| `llm_cost_usd_today`, `cache_hit_ratio`                        | Budget and caching health                                                           |
| `gate_kill_rate`                                               | What fraction died before the LLM. If this drops, cost spikes.                      |
| `ai_error_rate`, `rate_limit_events`                           |                                                                                     |

The single most valuable operational feature is the **source freshness panel**. Silent feed death is
the most likely real-world failure of this system, and it is invisible unless something watches for it.

---

## 10. Security posture

Full treatment in `THREAT-MODEL.md`. The architectural commitments:

1. **All fetched content is untrusted data, never instructions.** It is sanitised, length-capped, and
   passed inside a delimited envelope, and every prompt states that content within the envelope is
   data to analyse.
2. **Structured outputs constrain the blast radius.** A successful injection can at worst produce a
   wrong _value_ in a known field — it cannot invent an action, call a tool, or exfiltrate.
3. **No tools with side effects are exposed to any model that reads untrusted content.** The analysis
   model has no network, no filesystem, no publishing capability. Publishing is a human action.
4. **The dashboard is the trust boundary.** Nothing leaves the system without a human clicking.
5. **Operator instructions travel on a channel content cannot forge.** Where the model supports
   `role: "system"` messages mid-conversation, use that rather than embedding operator text inside a
   user turn — content inside user/tool blocks is forgeable by anything that writes to the input.
6. **Secrets never enter the repository.** `.env` is gitignored; `.env.example` carries names only;
   CI runs entirely in MOCK mode with no secrets configured.

---

## 11. What this architecture deliberately does not do

Recording non-goals prevents scope creep later:

- **No autonomous publishing.** Human-in-the-loop is a permanent design property through Phase 15,
  not a temporary safety measure (brief §28).
- **No scraping of platforms that prohibit it.** Not X, not TikTok, not Instagram.
- **No multi-user support.** No auth beyond localhost binding until the day it is deployed remotely;
  at that point, a single-user session cookie, not a user system.
- **No message queue, no Redis, no container orchestration.** One process, one file, one cron.
- **No second AI vendor.** Embeddings are local specifically to avoid one.
- **No microservices.** If a component needs to scale independently, that is a signal the design was
  wrong, not a reason to split it.
