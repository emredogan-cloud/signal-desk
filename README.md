# signal-desk

A real-time AI / software / technology intelligence and personal authority operations console,
built for one technical operator.

> See what matters early, understand it deeply, work out what it means, find the strongest
> contribution this operator can make, and help him publish something genuinely useful before the
> conversation moves on.

It is not a news reader, a scheduler, a marketing tool, or a bot. It is an instrument for converting
information into earned technical credibility. The optimisation target is
**EARLY + ACCURATE + USEFUL + ORIGINAL** — in that combination. Fast and wrong is worse than slow
and trustworthy, because the asset being built is trust.

---

## What actually exists right now

**Phase 2 of 15.** This section is the honest inventory, and it is updated as each phase lands
rather than describing the finished plan.

| Built                                                                   | Not built                                      |
| ----------------------------------------------------------------------- | ---------------------------------------------- |
| pnpm workspace, TypeScript strict, ESLint + Prettier                    | Ingestion adapters and the scheduler (Phase 3) |
| Zod-validated configuration with MOCK/LIVE modes                        | Deduplication and canonical events (Phase 4)   |
| Structured logging with secret redaction                                | Scoring and the rule gate (Phase 5)            |
| SQLite + Drizzle, migrations                                            | AI analysis (Phase 6)                          |
| **60-source registry, all probed healthy**                              | Content strategy (Phase 7)                     |
| **19 entities / 83 aliases, with a resolver**                           | Trend intelligence (Phase 9)                   |
| **`sources:probe` health tooling**                                      | The dashboard (Phase 10)                       |
| Vitest with coverage; CI with secret scanning                           | Alerts (Phase 11)                              |
| Multi-stage Dockerfile (unused; keeps deployment cheap to decide later) | Analytics and the feedback loop (Phase 12)     |
| A placeholder web page carrying the MOCK badge                          |                                                |

**Nothing is ingested yet.** The registry knows about 60 sources and can tell you whether each one
is alive, but no feed is fetched on a schedule, no event is detected, and no analysis is produced.
The plan for all of it is in [`docs/ROADMAP.md`](docs/ROADMAP.md).

---

## Running it

Requires **Node 22+** and **pnpm 10**.

```bash
pnpm install
pnpm verify        # format → lint → typecheck → test → build. This is exactly what CI runs.
```

No credentials are needed. Phases 1–5 require none at all; everything runs against fixtures in
`MOCK` mode, and CI runs with no secrets configured on purpose.

```bash
pnpm check:env       # what is configured, what mode that implies, what is degraded
pnpm db:migrate      # apply migrations (the worker also does this on startup)
pnpm db:seed         # load the source and entity registries — idempotent
pnpm sources:probe   # fetch every source, report health, exit non-zero on a P1 failure
pnpm sources:add     # add a source; probes it first and refuses a URL that is not a feed
pnpm worker:dev      # start the worker (starts, migrates, seeds, self-tests, exits)
pnpm web:dev         # dashboard placeholder on http://127.0.0.1:3000
```

`sources:probe` is a **live network command** and is deliberately exempt from `DATA_MODE=MOCK`: its
whole job is to check whether real URLs still work, and a mocked probe would report the registry as
healthy without touching it.

To configure anything, copy the template — it contains names and descriptions only, never values:

```bash
cp .env.example .env
```

`.env` is gitignored, and was gitignored in the repository's first commit, before any key existed.

---

## Design commitments

These are load-bearing and are not softened as the system grows. Full reasoning in `docs/`.

- **No autonomous publishing, ever.** Every published word requires an explicit human action. This
  is a design property, not a setting, and there is no configuration that changes it.
- **All fetched content is untrusted data, never instructions.** RSS bodies, GitHub release notes,
  and commit messages are attacker-writable. The models that read them hold no tools — no network,
  no filesystem, no publishing — so a perfect prompt injection wins the ability to put wrong text in
  a JSON field and nothing more.
- **Every claim carries a confidence tag** — VERIFIED / OBSERVED / INFERRED / SPECULATIVE — and an
  evidence id. A number without a source fails validation rather than being rendered.
- **The system must be able to say DON'T POST**, and is expected to say it often.
- **MOCK is visible.** Whenever any subsystem is mocked, the dashboard says so permanently. A mock
  analysis that looks real on screen is how an operator ends up posting a fabricated claim.
- **No secrets in the repository.** CI runs with none and proves it every push.

---

## Documentation

| Document                                                     | What it owns                                                                  |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| [`docs/ROADMAP.md`](docs/ROADMAP.md)                         | The 15 phases, their acceptance and exit criteria, and current status         |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)               | Stack decisions and rejected alternatives, the pipeline, the data model, cost |
| [`docs/SOURCE-INTELLIGENCE.md`](docs/SOURCE-INTELLIGENCE.md) | Every source, with probe results and verification dates                       |
| [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md)               | Assets, trust boundaries, threats, and the tests that prove the controls      |
| [`docs/ENV-HANDBOOK.md`](docs/ENV-HANDBOOK.md)               | Every configuration value, what it does, and which phase first needs it       |
| [`docs/WORKING-DISCIPLINE.md`](docs/WORKING-DISCIPLINE.md)   | How work on this repository is done                                           |
| [`PROJECT-MEMORY.md`](PROJECT-MEMORY.md)                     | Operational handoff state, refreshed every three phases                       |

Each document owns its subject exclusively. Architecture decisions live only in `ARCHITECTURE.md`,
source facts only in `SOURCE-INTELLIGENCE.md`, and so on. When they disagree, that is a bug.

---

## Repository layout

```
apps/
  worker/      long-lived process: scheduler → pipeline, plus the CLIs
  web/         Next.js dashboard
packages/
  core/        domain logic — performs no I/O, heavily unit-tested
  adapters/    the only package that talks to the outside world
  db/          Drizzle schema, migrations, queries
  ai/          the Anthropic client — the only package that spends money
  shared/      config, logging, redaction, shared vocabulary
fixtures/      recorded real payloads — the MOCK-mode corpus
docs/          the six planning documents
```

---

## Cost

The only recurring expense is the Anthropic API, and it is bounded by a hard daily ceiling that
degrades rather than crashes. Estimated at **$37–60/month** as designed, or **$10–20/month** with
the levers in `docs/ARCHITECTURE.md` §6 applied. That estimate is replaced with a measured figure in
Phase 6. Embeddings run locally, the database is a file, and hosting is currently nothing.

## Licence

MIT — see [LICENSE](LICENSE).
