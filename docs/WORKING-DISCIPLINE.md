# WORKING-DISCIPLINE.md

How work on this repository is done. This is the shortest of the six documents on purpose — a
discipline document nobody rereads is decoration.

---

## The hard rule

> **NO GREEN CI = NO NEXT PHASE.**

Not "mostly green." Not "green except that one flaky test." Green.

The reason is specific to this project: a solo operator with limited hours has no reviewer. CI is
the reviewer. The moment it is allowed to be red, it stops being a signal and becomes noise, and
from that point the codebase degrades without anyone noticing — which is the same failure mode as
T-9 in `THREAT-MODEL.md`, applied to the code instead of the feeds.

---

## The loop, per phase

```
1.  Read the phase in ROADMAP.md — objective, acceptance criteria, exit criteria.
2.  Confirm the previous phase's exit criteria are actually met. Do not take this on trust.
3.  Implement ONLY that phase. Scope creep is the failure mode this loop exists to prevent.
4.  Write tests as you go, not after.
5.  Run locally:   pnpm verify        (format:check → lint → typecheck → test → build)
6.  Fix everything. All of it.
7.  Commit with a message naming the phase:  feat(phase-3): rss + github atom adapters
8.  Push.
9.  Watch CI:  gh run watch
10. GREEN?  → update ROADMAP.md phase status to DONE, note the date, continue to the next phase.
    RED?    → STOP. Fix. Push. Re-check. Do not start the next phase.
```

`pnpm verify` runs exactly what CI runs, in the same order. If it passes locally and fails in CI,
that is a bug in the setup and it is fixed before anything else.

---

## Branching

- `main` is always green and always deployable.
- One branch per phase: `phase-3-ingestion`. PR into `main`, squash-merge.
- Solo self-merge is fine — the PR exists so CI runs on the diff and so the phase has a reviewable
  record, not to simulate a review process that isn't happening.
- Tag each completed phase: `git tag phase-3-complete`. Cheap, and it makes "what did the system
  look like before scoring changed" answerable in one command.

---

## Commit messages

Conventional commits, with the phase in the scope:

```
feat(phase-4): three-stage event deduplication
fix(phase-3): handle feeds that return 200 with an HTML body
test(phase-6): prompt injection corpus
docs: record measured dedup threshold from labelled fixtures
chore(deps): bump drizzle-orm
```

The phase scope matters because it makes `git log --oneline --grep="phase-6"` a usable history of
one subsystem.

---

## What CI runs

Every push and every PR, on Node 22, with **no secrets configured**:

| Job               | Command                         | Gate                             |
| ----------------- | ------------------------------- | -------------------------------- |
| Format            | `prettier --check .`            | must pass                        |
| Lint              | `eslint .`                      | zero errors, zero warnings       |
| Types             | `tsc --noEmit` (strict)         | must pass                        |
| Tests             | `vitest run --coverage`         | must pass                        |
| Build             | `pnpm build` (all workspaces)   | must pass                        |
| Config validation | `pnpm check:env --ci`           | schema must parse `.env.example` |
| Secret scan       | `gitleaks detect`               | zero findings                    |
| Dependency audit  | `pnpm audit --audit-level=high` | zero high/critical               |

CI running with **no credentials at all** is a deliberate property. It proves MOCK mode genuinely
works end to end, and it means a fork or a future contributor can run everything.

A scheduled weekly job runs a minimal **live** API smoke test against Anthropic using a restricted
key — the single job that holds a secret. Its purpose is to catch model/API drift (T-11), and its
failure is a warning, not a merge blocker.

---

## Definition of done, per phase

A phase is done when **all** of these hold:

- [ ] Every acceptance criterion in `ROADMAP.md` for that phase is demonstrably met
- [ ] Tests cover the phase's core logic, including its failure paths
- [ ] `pnpm verify` passes locally
- [ ] CI is green on `main`
- [ ] No `TODO` or `FIXME` introduced without a matching line in the roadmap's "known gaps"
- [ ] The six planning documents are updated where the phase changed a decision or measured a number
      that was previously a guess
- [ ] The operator can actually _run it_ and see the result

The last one is the real test. A phase whose output cannot be observed by running the system is not
finished, however green the tests are.

---

## Measured numbers replace guessed numbers

Several numbers in these documents are labelled as starting guesses: the dedup similarity threshold
(0.86), the analysis threshold (70), scoring weights, poll intervals, the cost estimate.

**When a phase measures one of them, the document gets edited in the same PR.** A planning document
that still says "starting guess" after the measurement exists is actively misleading — it invites
re-deriving something already known.

This is the mechanism by which these documents stay true instead of becoming archaeology.

---

## When credentials are missing

Never stop. Never stub something that pretends to be live.

- Use `DATA_MODE=MOCK` / `AI_MODE=MOCK` / `X_MODE=MOCK`
- Build against `fixtures/` — real recorded payloads, captured once from the real source
- Every adapter ships with its mock twin in the same PR
- The MOCK/LIVE distinction is visible in the UI and in logs at all times

Writing a fake that looks real is how an operator ends up posting a fabricated claim. The badge is a
safety control, not a developer convenience.

---

## Working with an AI assistant on this repository

Since much of this will be built with AI assistance, the rules that matter:

1. **One phase per session.** Loading the whole roadmap into one session produces plausible code for
   phases whose dependencies do not exist yet.
2. **Paste the phase section, not the whole roadmap.**
3. **Never accept generated code that adds a dependency without saying why an existing one is
   insufficient** — see `THREAT-MODEL.md` §T-5.
4. **Never accept generated code that widens a security boundary** — a tool granted to the analysis
   model, a fetch outside the allowlist, `dangerouslySetInnerHTML` — without an explicit decision
   recorded in `THREAT-MODEL.md`.
5. **Verify API facts against the vendor's current reference, not the model's memory.** Model IDs,
   prices, and parameter shapes in this project have already changed once during planning.
6. Generated tests that assert what the code does rather than what it should do are worse than no
   tests. Read them.

---

## Rollback

If a phase turns out to be wrong after merge:

```
git revert <squash-merge-sha>       # never force-push main
```

Then fix forward on a new branch. The reverted commit stays in history as a record that the approach
was tried and rejected — which is information, not embarrassment.

For a bad _decision_ rather than bad code, edit the relevant planning document with a dated revision
note explaining what changed and why. These documents are the system's memory; silently editing them
loses the reasoning.
