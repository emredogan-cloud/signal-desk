# fixtures/

Recorded payloads. These are the MOCK-mode corpus and the input to every parser test.

**Recordings are real, captured once from the real source**, per `docs/WORKING-DISCIPLINE.md`.
A parser tested only against hand-written XML passes on XML nobody actually serves.

| Path | What it is |
|---|---|
| `feeds/` | Valid feeds, captured live. One per distinct shape rather than one per source. |
| `probe/` | The failure shapes the probe must classify correctly. |

## `probe/two-hundred-with-html-body.html`

`https://changelog.cursor.com/rss` — captured 2026-08-13. It answers **HTTP 200** and serves a
web page. `docs/SOURCE-INTELLIGENCE.md` records this shape as having "killed three candidate
feeds during research", and it is the reason the probe classifies on body content rather than on
status code. Truncated to the first 16KB: the classifier decides on the doctype, and the
remaining 163KB of page markup would be repository weight for no additional coverage.

## Synthetic fixtures

Three files here are hand-written rather than captured, because the shapes are hard to find on
demand and trivial to state exactly:

- `empty-feed.rss.xml` — valid RSS, zero items. The T-9 failure that looks like good health.
- `malformed.xml` — truncated mid-element.
- `not-a-feed.json` — a 200 that is neither XML nor HTML.

## Third-party credentials in recorded pages

Recorded HTML often carries the publisher's own analytics keys and tokens. They are not ours and
they are not what any fixture tests, but committing another party's credential to a public
repository is both impolite and a `gitleaks` failure — which is how this rule was discovered rather
than reasoned about.

**Scrub them at capture time**, replacing the value with `SCRUBBED-AT-CAPTURE` and leaving the
surrounding markup intact. Never solve it by allowlisting the fixture path in `.gitleaks.toml`: an
allowlisted path is one where a real leak would go unnoticed forever.
