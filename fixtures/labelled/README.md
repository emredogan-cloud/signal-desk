# fixtures/labelled/

The labelled clustering set. `clustering.json` is the ground truth that Phase 4's
acceptance criteria are measured against:

> Dedup precision ≥0.95 and recall ≥0.85 on the labelled set — **and the actual
> measured numbers written into `ARCHITECTURE.md` §5, replacing the 0.86 guess**

## Composition, stated precisely

Every cluster carries a `provenance` field. There are two kinds and they are not
interchangeable.

### `real` — items that actually arrived through ingestion

Quoted verbatim from `raw_items`, with their real `rawItemId`, source, and timestamp.
Labelled from **objective, checkable signals**: byte-identical titles across
different sources, or a pair a human verified describes one development.

The most valuable real cluster in the set is `amazon-twitch-optout`: Ars Technica and
TechCrunch covering one policy change fifty minutes apart, with **no shared artifact
string and no shared distinctive token in the titles**. Stages 1 and 2 cannot catch
it. It is the case stage 3 exists for, and it came from the real world rather than
from imagination.

### `synthetic` — cases written to model a known pattern

Written by hand to exercise the specific behaviours `ROADMAP.md` Phase 4 names:

- **the six-outlet launch** — one announcement, six publishers, must produce **one**
  event with six evidence rows
- **two models from one vendor on one day** — must produce **two** events. This is
  the adversarial case, and the failure it guards against is the destructive one: a
  wrong merge *hides* an event, and the operator cannot see what was absorbed
- **an update three days later** — outside the 48-hour window, must not merge
- **consecutive releases from one repo** — `b10400` and `b10405` are two events

## Why the real sample is small, and why that is reported rather than padded

A ten-day window over the live registry produced **very few** multi-outlet clusters.
That is not a bug in the extraction; it is what this registry is. It is deliberately
weighted toward primary sources — GitHub release atoms, vendor changelogs, status
pages, arXiv — and primary sources do not duplicate each other. Six outlets covering
one launch is a real pattern and an *infrequent* one here.

The alternative was to pad the set to a round 200 items by guessing at labels for
ambiguous items. That would have measured the labeller rather than the algorithm, and
produced a precision figure that reads as fact in `ARCHITECTURE.md` while resting on
opinion. The set is the size the evidence supports, the composition is declared, and
the measurement reports real and synthetic separately.

## Who labelled this

**The labels were assigned by the AI agent that built Phase 4, not by the operator.**
Real clusters were verified by reading the items; synthetic clusters are correct by
construction. Before these numbers are treated as settled, the real clusters are worth
ten minutes of the operator's time.

Rebuild the real half with `pnpm labelled:build` after ingesting.
