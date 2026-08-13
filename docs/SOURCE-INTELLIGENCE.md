# SOURCE-INTELLIGENCE.md

**Source registry for the AI / Software / Technology intelligence system.**
Last verified: **2026-08-13** — every entry re-probed by `pnpm sources:probe`.
Evidence tags per `ROADMAP.md` §Information Quality Model.

---

## Probe run — 2026-08-13 (Phase 2)

**60 sources registered. 60 healthy. 1 warning. 0 failures.** The registry now lives in
`packages/db/src/seed/sources.ts`; this document is its reasoning, and the two are kept in step by
the seed-integrity tests.

**What changed since the 2026-08-12 hand-probe:**

| Change                                             | Detail                                                                                                                                                                                                                                                    |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **+4 status feeds**                                | Cloudflare, Vercel, AWS, and Supabase probed and added — the §1c to-do is closed. AWS's _legacy_ `status.aws.amazon.com/rss/all.rss` still serves (200, 36 items) even though the human-facing page moved to `health.aws.amazon.com`, which is HTML only. |
| **+9 individuals**                                 | §4's "single largest remaining gap" is filled. See the revised §4.                                                                                                                                                                                        |
| **Anthropic diff target chosen**                   | `www.anthropic.com/news`. `robots.txt` is `User-Agent: * / Allow: /` (checked 2026-08-13). Reasoning below.                                                                                                                                               |
| **`docs.anthropic.com` has moved**                 | It now 301s to **`platform.claude.com/docs/`**. Anything in these documents referencing the old host is stale.                                                                                                                                            |
| **Anthropic still has no feed**                    | Re-verified: `anthropic.com/news/rss.xml`, `anthropic.com/rss.xml`, and `anthropic.com/engineering/rss.xml` all 404. `docs.claude.com/rss.xml` answers **200 and serves the docs home page** — a fresh instance of the trap in the next row.              |
| **The "200 with an HTML body" trap is still live** | `changelog.cursor.com/rss` still answers 200 with `text/html`. It is now a committed fixture (`fixtures/probe/two-hundred-with-html-body.html`) so the classifier is tested against the real thing.                                                       |
| **Dead entries re-confirmed dead**                 | `mistral.ai/news/feed.xml` 404 · `deeplearning.ai/the-batch/feed/` 404 · `openai.com/index/rss.xml` 404.                                                                                                                                                  |

**Measured item counts, where they differ from the 2026-08-12 figures.** Feeds move; these are
recorded so a future drop is visible as a drop rather than mistaken for normal.

| Source        | 08-12 | 08-13   |
| ------------- | ----- | ------- |
| OpenAI News   | 1125  | 1126    |
| arXiv cs.AI   | 344   | **306** |
| Vercel        | 1457  | 1463    |
| OpenAI Status | 92    | 91      |

**One warning, not a failure.** `hamel.dev/index.xml` is malformed: it serves a complete document,
a stray `em>`, and then a **second concatenated document** from a `netlify.app` staging domain
(line 5536). The lenient parser recovers 20 real items. The probe reports this as healthy with a
warning rather than failing it — rejecting a working source over a publisher's build bug would be
the wrong trade, and hiding the bug would be the other wrong trade. See `packages/adapters/src/probe.ts`.

### Two hosts moved, found by the first LIVE ingest run

The Phase-2 probe reported both of these as healthy, because a probe follows
redirects. Ingestion refused them, because the SSRF allowlist is built from
**registered** hostnames and a cross-host hop lands outside it (`THREAT-MODEL.md`
§T-6). The allowlist was right and the registry was stale.

| Registered as                               | Actually serves                                                | Status                                                                                            |
| ------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `status.anthropic.com/history.rss`          | **`status.claude.com/history.rss`** (302)                      | Anthropic moved its status page to the claude.com domain. Registry updated to the canonical host. |
| `docs.claude.com/en/release-notes/overview` | **`platform.claude.com/docs/en/release-notes/overview`** (301) | Registry updated.                                                                                 |

`pnpm sources:probe` now **warns on any cross-host redirect** and names the
destination, so this class of drift surfaces at probe time rather than costing a
detection. Finding it the other way round — ingestion failing on a Priority-1 source
while the health check said green — is precisely the T-9 shape this registry exists
to prevent.

### Why `anthropic.com/news` and not the release-notes page

Both were probed. Both are server-rendered, so both are diffable. The news page wins on three counts:

- **Size:** 413KB against 1.6MB.
- **Noise:** the release-notes page is **64% `<script>` bytes**. Raw-byte diffing there fires on
  every deploy of the docs site. The news page exposes a clean `/news/<slug>` link set — a new slug
  is unambiguously a new announcement.
- **Latency:** announcements are what the KPI measures; release notes lag them.

The release-notes page is registered too, at Priority 2, because it names model IDs — but it is
diffed on **extracted text**, never on raw bytes. Both respect the ≥15-minute floor, enforced by a
seed test rather than by convention.

Every feed marked **VERIFIED** was fetched with `curl` on 2026-08-12 and returned HTTP 200 with
well-formed XML and a non-zero item count. Feeds marked **DEAD** returned 404 or HTML. Nothing in
this file is copied from a source-aggregator blog post; entries with no probe result are tagged
**INFERRED** and must be probed in Phase 2 before entering the registry.

---

## 0. The finding that shapes the whole system

**X cannot be an ingestion source at this operator's budget. VERIFIED.**

X moved to pay-per-use API pricing in February 2026. Per the official pricing page
(`docs.x.com/x-api/getting-started/pricing`), reads are billed per resource fetched:

| Operation                                                     | Price                | Notes                     |
| ------------------------------------------------------------- | -------------------- | ------------------------- |
| Post read                                                     | **$0.005**           | per post fetched          |
| User read                                                     | **$0.010**           |                           |
| Trends read                                                   | **$0.010**           |                           |
| Post create                                                   | **$0.015**           | per request               |
| **Post create containing a URL**                              | **$0.200**           | 13× a plain post          |
| **Owned reads** (your own account's data, specific endpoints) | **$0.001**           | since 2026-04-20          |
| Monthly cap                                                   | 2,000,000 post reads | pay-per-use plans         |
| Free tier                                                     | **none**             | credits purchased upfront |

Cost of using X as a monitoring surface: watching 50 accounts at ~20 posts/day each is 1,000 post
reads/day = **$5.00/day ≈ $150/month**. That is not viable for an operator with no budget, and it
buys information that the _same companies publish for free_ on RSS, GitHub, and status pages —
usually at the same time or earlier.

**Therefore the architecture splits X into two roles:**

- **X as ingestion → dropped.** Company announcements are ingested from official feeds (below),
  which are free, structured, and higher-fidelity than a post about the announcement.
- **X as publishing + measurement → kept, cheaply.** Owned reads at $0.001 make the analytics loop
  (§40 of the brief: impressions, profile visits, reply quality) cost roughly **$3/month**. Assisted
  posting is $0.015/post — and the $0.20 URL surcharge is a hard economic reason not to put links
  in posts, which independently matches what the ranker rewards.

The one thing genuinely lost is _social velocity on X_ — "how fast is this being discussed" (§21).
Phase 9 substitutes Hacker News points velocity, Reddit comment velocity, and GitHub star velocity,
which are free and, for developer-audience topics, correlated. That substitution is **INFERRED**,
not measured, and Phase 12 must test whether it actually predicts anything.

---

## 1. MUST MONITOR — Tier 1 official primary sources

These are the sources an event's canonical record should be built from. Priority 1 means: if this
fires, a human looks at it today.

### 1a. AI labs and model vendors

| Name                      | Feed                                                  | Probe                        | Entity          | Signal type                 | Priority | Latency | Why                                                                                                                                                  |
| ------------------------- | ----------------------------------------------------- | ---------------------------- | --------------- | --------------------------- | -------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI News               | `https://openai.com/news/rss.xml`                     | **VERIFIED** 200, 1125 items | OpenAI          | OFFICIAL SOURCE             | 1        | minutes | Model launches, pricing, deprecations. Note `openai.com/blog/rss.xml` is the same feed (also 200/1125); `openai.com/index/rss.xml` is **DEAD** (404) |
| Google DeepMind Blog      | `https://deepmind.google/blog/rss.xml`                | **VERIFIED** 200, 100 items  | Google DeepMind | OFFICIAL SOURCE             | 1        | minutes | Gemini + research                                                                                                                                    |
| Google Research Blog      | `https://research.google/blog/rss/`                   | **VERIFIED** 200, 100 items  | Google          | TECHNICAL RESEARCHER        | 2        | hours   | Deeper, less product                                                                                                                                 |
| Google — The Keyword (AI) | `https://blog.google/technology/ai/rss/`              | **VERIFIED** 200, 20 items   | Google          | OFFICIAL SOURCE             | 1        | minutes | Consumer-facing AI announcements                                                                                                                     |
| Hugging Face Blog         | `https://huggingface.co/blog/feed.xml`                | **VERIFIED** 200, 839 items  | Hugging Face    | OFFICIAL SOURCE / COMMUNITY | 2        | hours   | Open-model releases, technique writeups                                                                                                              |
| Qwen (Alibaba)            | `https://qwenlm.github.io/blog/index.xml`             | **VERIFIED** 200, 44 items   | Alibaba         | OFFICIAL SOURCE             | 2        | hours   | The most under-covered high-signal lab in Western feeds                                                                                              |
| NVIDIA Blog               | `https://blogs.nvidia.com/feed/`                      | **VERIFIED** 200, 18 items   | NVIDIA          | OFFICIAL SOURCE             | 2        | hours   | Hardware, pricing, CUDA ecosystem                                                                                                                    |
| AWS ML Blog               | `https://aws.amazon.com/blogs/machine-learning/feed/` | **VERIFIED** 200, 20 items   | Amazon          | OFFICIAL SOURCE             | 3        | hours   | High volume, low density — aggressive filtering required                                                                                             |
| Azure Blog                | `https://azure.microsoft.com/en-us/blog/feed/`        | **VERIFIED** 200, 10 items   | Microsoft       | OFFICIAL SOURCE             | 3        | hours   | Same caveat                                                                                                                                          |

**Anthropic has no RSS feed. VERIFIED** — `anthropic.com/news/rss.xml` and `anthropic.com/rss.xml`
both return 404 with an HTML body. `mistral.ai/news/feed.xml` is likewise **DEAD** (404).

This is a real gap, since Anthropic is the operator's highest-relevance vendor. Three options, in
order of preference:

1. **Poll the docs release-notes page and diff it** (Phase 3 `HtmlDiffAdapter`). Deterministic,
   no third party, no scraping of anything the vendor asks you not to read. Respect `robots.txt`
   and a ≥15-minute interval.
2. **Watch `github.com/anthropics/*` release atoms** (below) — SDK releases frequently ship
   _before or with_ a model announcement and name the new model IDs. This is an early signal, not
   a substitute.
3. Community RSS mirrors — **rejected**. Unverifiable provenance; a mirror is exactly the kind of
   source that can inject content into an LLM pipeline (see `THREAT-MODEL.md` §T-1).

Do the same diff-based treatment for **Mistral**, **Cursor** (`changelog.cursor.com/rss` returns
200 but serves HTML, not a feed — **DEAD as a feed**), and any other vendor that drops RSS.

### 1b. GitHub — the highest value-per-byte channel in the system

**GitHub's `.atom` endpoints work unauthenticated, with no token and no API quota. VERIFIED.**

| Pattern                                                   | Probe                                                                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `https://github.com/{owner}/{repo}/releases.atom`         | **VERIFIED** — `anthropics/anthropic-sdk-python` 200/10 items, `vercel/next.js` 200/10, `ggml-org/llama.cpp` 200/10 |
| `https://github.com/{owner}/{repo}/commits/{branch}.atom` | **VERIFIED** — `xai-org/x-algorithm` 200/3 items                                                                    |
| `https://api.github.com/...` (REST)                       | **VERIFIED** — unauthenticated limit is **60 requests/hour** (`x-ratelimit-limit: 60`)                              |

Design consequence: **use `.atom` for watching, REST only for enrichment.** Atom has no visible
quota; the REST 60/hour ceiling is exhausted by ~60 repos on a single hourly pass. A token raises
it to 5,000/hour, so `GITHUB_TOKEN` is _optional but recommended_ (see `ENV-HANDBOOK.md`).

Initial watchlist (all Priority 2 unless noted; expand in Phase 2):

- **SDKs that leak model IDs early:** `anthropics/anthropic-sdk-python`, `anthropics/anthropic-sdk-typescript`, `openai/openai-python`, `googleapis/python-genai`
- **Inference / local:** `ggml-org/llama.cpp`, `vllm-project/vllm`, `ollama/ollama`, `huggingface/transformers`
- **Agent / dev tooling:** `anthropics/claude-code`, `modelcontextprotocol/servers`, `cline/cline`
- **Web / app platform (operator's own stack):** `vercel/next.js`, `flutter/flutter`, `supabase/supabase`
- **Priority 1 — `xai-org/x-algorithm`:** the live X For You ranker. `commits/main.atom` **VERIFIED**.

> **Dated fact, corrected:** as of 2026-08-12 the x-algorithm repo's `pushed_at` is
> **2026-05-15T21:55:27Z** — roughly three months stale, with 26,977 stars. The commonly repeated
> "republished about every 4 weeks" cadence **does not currently hold**. Treat any future push to
> this repo as a Priority-1 event: it is a rare, checkable, high-authority topic on which this
> operator can be first with real analysis rather than commentary.

### 1c. Status pages — free, precise outage detection

Statuspage exposes RSS at `/history.rss` on every tenant. All **VERIFIED**:

| Source       | Feed                                           | Items                     |
| ------------ | ---------------------------------------------- | ------------------------- |
| Anthropic    | `https://status.anthropic.com/history.rss`     | 25                        |
| OpenAI       | `https://status.openai.com/history.rss`        | 92                        |
| GitHub       | `https://www.githubstatus.com/history.rss`     | 25                        |
| Google Cloud | `https://status.cloud.google.com/en/feed.atom` | 1 (Atom, different shape) |

Category A of the brief lists "major outages" as a monitored event class. This is the cheapest,
highest-precision detector in the entire system — and outages are one of the few events where
being 10 minutes early is genuinely differentiating, because the affected audience is actively
searching. **Add Cloudflare, Vercel, AWS, and Supabase status in Phase 2.**

---

## 2. SHOULD MONITOR — Tier 2 discussion, discovery, and velocity

These rarely produce the canonical record. They produce _velocity_, _sentiment_, and _"what is
being misunderstood"_ — which is where the operator's differentiated angle usually comes from.

| Name                   | Feed                                       | Probe                        | Category             | Priority | Why                                                                                            |
| ---------------------- | ------------------------------------------ | ---------------------------- | -------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| Hacker News front page | `https://news.ycombinator.com/rss`         | **VERIFIED** 200, 30 items   | COMMUNITY SIGNAL     | 2        | Official, no key                                                                               |
| HN filtered by score   | `https://hnrss.org/newest?points=100`      | **VERIFIED** 200, 20 items   | COMMUNITY SIGNAL     | 2        | Third-party (hnrss.org) but supports server-side thresholds; treat availability as best-effort |
| Lobsters               | `https://lobste.rs/rss`                    | **VERIFIED** 200, 25 items   | COMMUNITY SIGNAL     | 3        | Higher signal-to-noise than HN, much lower volume                                              |
| r/LocalLLaMA           | `https://www.reddit.com/r/LocalLLaMA/.rss` | **VERIFIED** 200, 25 items   | COMMUNITY SIGNAL     | 2        | **Public `.rss` works with no auth**                                                           |
| Product Hunt           | `https://www.producthunt.com/feed`         | **VERIFIED** 200, 50 items   | COMMUNITY SIGNAL     | 3        | Launch discovery; low technical density                                                        |
| arXiv cs.AI            | `https://export.arxiv.org/rss/cs.AI`       | **VERIFIED** 200, 344 items  | TECHNICAL RESEARCHER | 3        | Very high volume — must be gated hard, see below                                               |
| GitHub Blog            | `https://github.blog/feed/`                | **VERIFIED** 200, 10 items   | OFFICIAL SOURCE      | 2        |                                                                                                |
| GitHub Changelog       | `https://github.blog/changelog/feed/`      | **VERIFIED** 200, 10 items   | OFFICIAL SOURCE      | 2        | Platform/policy changes (Category D)                                                           |
| Cloudflare Blog        | `https://blog.cloudflare.com/rss/`         | **VERIFIED** 200, 20 items   | OFFICIAL SOURCE      | 3        | Unusually deep engineering writeups                                                            |
| Vercel                 | `https://vercel.com/atom`                  | **VERIFIED** 200, 1457 items | OFFICIAL SOURCE      | 3        |                                                                                                |
| GitLab                 | `https://about.gitlab.com/atom.xml`        | **VERIFIED** 200, 20 items   | OFFICIAL SOURCE      | 4        |                                                                                                |

**Reddit — use public `.rss`, not the API. VERIFIED / OBSERVED.**
The public per-subreddit `.rss` endpoint returned 200 with 25 items and no authentication.
The _Data API_ is a different matter: reporting from 2026 describes free non-commercial access at
~100 queries/minute per OAuth client but with **manual approval required** under a June 2026
"Responsible Builder Policy," with multi-week approval times, plus a content-deletion obligation
(delete content that users delete or mods remove; the wiki recommends purging stored user data
within 48 hours). That reporting is **OBSERVED**, not verified against Reddit's own terms — but
the direction is clear and the design conclusion is safe either way: **stay on public RSS, store
Reddit content only as short-lived signal, and never mirror Reddit user text into a durable
store.** Revisit only if a phase genuinely needs comment-level data.

**arXiv needs a hard gate.** 344 items in one feed pull. Ungated, it would dominate ingestion
volume and burn the LLM budget on papers that will never become content. Phase 5 rule: an arXiv
item may not reach the LLM tier unless it is _already_ corroborated by a Tier-1 or Tier-2
discussion source (HN ≥100 points, a lab blog post, or ≥2 monitored GitHub repos referencing it).

---

## 3. SHOULD MONITOR — Tier 3 journalism and expert analysis

Used for corroboration and for the "what is the mainstream reading of this" input to the expert-angle
engine. **Never** the sole basis of a factual claim in generated content — that rule is enforced in
`ROADMAP.md` Phase 6.

| Name           | Feed                                              | Probe                      | Category                      |
| -------------- | ------------------------------------------------- | -------------------------- | ----------------------------- |
| TechCrunch     | `https://techcrunch.com/feed/`                    | **VERIFIED** 200, 20 items | JOURNALIST                    |
| The Verge      | `https://www.theverge.com/rss/index.xml`          | **VERIFIED** 200, 10 items | JOURNALIST                    |
| Ars Technica   | `https://feeds.arstechnica.com/arstechnica/index` | **VERIFIED** 200, 20 items | JOURNALIST                    |
| Wired          | `https://www.wired.com/feed/rss`                  | **VERIFIED** 200, 50 items | JOURNALIST                    |
| IEEE Spectrum  | `https://spectrum.ieee.org/feeds/feed.rss`        | **VERIFIED** 200, 30 items | EXPERT ANALYST                |
| Simon Willison | `https://simonwillison.net/atom/everything/`      | **VERIFIED** 200, 30 items | EXPERT ANALYST / EARLY SIGNAL |

Simon Willison's feed is called out specifically: it is one of the few individual feeds where the
author reliably _tests things and publishes the result within hours_, which is exactly the behaviour
this system is trying to help the operator produce. Treat it as a benchmark for latency and as a
competitive check — if he has already published the experiment, the operator's angle must be
different, not duplicative.

`deeplearning.ai/the-batch/feed/` is **DEAD** (404) — do not add it despite its presence on
aggregator lists.

---

## 4. Individuals worth monitoring — and why this list is deliberately short

The brief asks for high-signal individuals (§14). The honest position:

**Monitoring individuals on X is exactly the capability the pricing model removed.** At $0.005 per
post read there is no cheap way to watch 30 people's timelines. Options that remain:

1. **Their blogs/newsletters, where they have one.** Reliable and free. Simon Willison (above) is
   the model case. Build this list in Phase 2 by taking each Tier-1 entity and finding the
   individual-authored feed that covers it.
2. **Their GitHub activity.** `https://github.com/{user}.atom` exposes public activity, and the
   `.atom` pattern is verified working. For engineers and maintainers this is often _earlier_ than
   their social posting.
3. **Manual X Lists, read by a human.** Free, requires no API, and costs the operator attention
   rather than money. This is the correct answer for the first 90 days and it belongs in the daily
   routine, not in the software.

**Do not** build an X scraper. It is against the platform's terms, it risks the account this whole
operation exists to build, and the operator's own operating rules already exclude account-risking
tactics. `THREAT-MODEL.md` §T-8 records this as an explicit non-goal.

Selection criteria when the Phase-2 list is built (per §14 — _not_ follower count):

- Has been _first_ on a checkable claim at least twice in the last 6 months
- Publishes evidence (numbers, code, screenshots) rather than reaction
- Corrects themselves publicly when wrong
- Operates in the operator's actual niche: applied AI engineering, not AI commentary

### The list — built 2026-08-13, and what is unverified about it

Route 1 (blogs) and route 2 (GitHub activity) are both in the registry. Route 3 (manual X Lists)
remains correctly outside the software.

| Source                   | Feed                                         | Probe 2026-08-13                                                 | Category             |
| ------------------------ | -------------------------------------------- | ---------------------------------------------------------------- | -------------------- |
| Simon Willison           | `https://simonwillison.net/atom/everything/` | **VERIFIED** 200, 30 items                                       | EXPERT_ANALYST       |
| Sebastian Raschka        | `https://magazine.sebastianraschka.com/feed` | **VERIFIED** 200, 20 items                                       | EXPERT_ANALYST       |
| Hamel Husain             | `https://hamel.dev/index.xml`                | **VERIFIED** 200, 20 items — _malformed, see the probe-run note_ | EXPERT_ANALYST       |
| Eugene Yan               | `https://eugeneyan.com/rss/`                 | **VERIFIED** 200, 212 items (full archive)                       | EXPERT_ANALYST       |
| Chip Huyen               | `https://huyenchip.com/feed.xml`             | **VERIFIED** 200, 10 items                                       | EXPERT_ANALYST       |
| Lilian Weng              | `https://lilianweng.github.io/index.xml`     | **VERIFIED** 200, 53 items                                       | TECHNICAL_RESEARCHER |
| Answer.AI                | `https://www.answer.ai/index.xml`            | **VERIFIED** 200, 20 items                                       | EXPERT_ANALYST       |
| Simon Willison — GitHub  | `https://github.com/simonw.atom`             | **VERIFIED** 200, 25 items                                       | EARLY_SIGNAL         |
| Andrej Karpathy — GitHub | `https://github.com/karpathy.atom`           | **VERIFIED** 200, 5 items                                        | EARLY_SIGNAL         |
| Georgi Gerganov — GitHub | `https://github.com/ggerganov.atom`          | **VERIFIED** 200, 13 items                                       | EARLY_SIGNAL         |

**Newly discovered dead, 2026-08-13:**

- `karpathy.bearblog.dev/feed/` — **403** to non-browser clients. His GitHub activity atom is the
  only free route, and it is registered instead.
- `jxnl.co/feed.xml` — **404**.

> **What is NOT verified about this list, stated plainly.** Three of the four §14 criteria are
> observable from a handful of posts and were applied: publishes evidence rather than reaction,
> operates in applied AI engineering rather than commentary, and — for the GitHub atoms — is a
> maintainer whose commits precede their writing.
>
> The fourth, **"has been _first_ on a checkable claim at least twice in the last six months"**,
> requires reading six months of archives against a timeline of what broke when. It was **not**
> done. This list is therefore _probed and plausible_, not _vetted_.
>
> That distinction is the whole point of this document's evidence tagging, and it applies to the
> document's own contents. Prune the list at the Phase 12 review, when there is measured precision
> per source to prune on — not by feel before then.

---

## 5. IGNORE — explicitly out of scope

Recording these prevents re-litigating them later.

| Excluded                                      | Reason                                                                                                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SEO content farms, "AI news" aggregator sites | Zero original information; they _are_ the noise the system exists to filter. Also the highest-risk prompt-injection vector — see `THREAT-MODEL.md` §T-1 |
| Community RSS mirrors of vendor blogs         | Unverifiable provenance; a mirror can alter content between vendor and pipeline                                                                         |
| X scraping / Nitter-style frontends           | ToS violation, account risk, unreliable                                                                                                                 |
| Reddit Data API (for now)                     | Manual approval, multi-week lead time, deletion obligations. Public RSS covers the need                                                                 |
| TikTok / Instagram APIs                       | No cheap programmatic access; Category E trend detection is handled by human observation in Phase 9, not by scraping                                    |
| Paid data vendors, social listening SaaS      | Violates the minimal-external-services constraint; costs exceed the entire budget                                                                       |
| Google Trends (unofficial libraries)          | No stable official API; unofficial clients break constantly and are a maintenance tax                                                                   |

---

## 6. Registry schema

Every source in the database carries the following (Phase 2 deliverable). This is the shape the
`sources` table implements.

```
id                  stable slug, e.g. "openai-news"
name                display name
url                 feed or page URL
platform            rss | atom | github_atom | github_api | html_diff | statuspage | x_api
category            OFFICIAL_SOURCE | EARLY_SIGNAL | EXPERT_ANALYST | JOURNALIST
                    | TECHNICAL_RESEARCHER | AMPLIFIER | COMMUNITY_SIGNAL
entity              canonical entity slug ("anthropic", "nvidia") — nullable
priority            1..4  (1 = look at this today)
is_official         boolean
reliability         0.0..1.0, seeded by category, adjusted in Phase 12 by measured precision
poll_interval_sec   per-source; defaults by priority (see below)
etag / last_modified  conditional-request cache keys
active              boolean
last_checked_at     timestamp
last_event_at       timestamp — a source that has produced nothing in 60 days gets flagged
verified_at         date this URL last returned a valid feed  ← this file's probe date
expected_value      free text: what this source is for
```

Default poll intervals (Phase 3; tuned in Phase 12 against measured `event_occurred → detected`):

| Priority | Interval | Rationale                                                      |
| -------- | -------- | -------------------------------------------------------------- |
| 1        | 5 min    | Model launches and outages; the only tier where minutes matter |
| 2        | 15 min   |                                                                |
| 3        | 60 min   |                                                                |
| 4        | 6 h      |                                                                |

All polling uses conditional requests (`If-None-Match` / `If-Modified-Since`). A 304 is free
bandwidth and free CPU, and it is the difference between polite polling and getting blocked.

---

## 7. What must be re-verified before Phase 2 closes — **resolved 2026-08-13**

| #   | Item                                                                                       | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Every **INFERRED** feed added beyond this list must be probed and get a `verified_at` date | ✅ **Done.** All 60 registered sources probed; every one carries a `verified_at`. Nothing in the registry is unprobed.                                                                                                                                                                                                                                                                                                                                 |
| 2   | The Anthropic diff target URL must be chosen and its `robots.txt` checked                  | ✅ **Done.** `www.anthropic.com/news`, `robots.txt` = `Allow: /`. Reasoning in the probe-run note at the top.                                                                                                                                                                                                                                                                                                                                          |
| 3   | Cloudflare / Vercel / AWS / Supabase status feeds probed and added                         | ✅ **Done.** All four VERIFIED and registered.                                                                                                                                                                                                                                                                                                                                                                                                         |
| 4   | `hnrss.org` has no SLA — add a fallback                                                    | ⚠️ **Partly.** Both `hnrss.org/newest?points=100` and the official `news.ycombinator.com/rss` are registered, so the official feed is present and will keep producing if the third party fails. **Client-side score filtering is not built** — that is Phase 3/5 work, and until it exists the fallback covers availability but not the ≥100-point filter. `hn-100points` is seeded at reliability 0.4 to reflect that.                                |
| 5   | Reddit's Data API terms must be read directly rather than via reporting                    | ❌ **Not done, and deliberately deferred.** Reading and interpreting a platform's legal terms is a judgment call this phase should not fake. What matters is that the design conclusion is unaffected either way: the system uses only the public `.rss` endpoint (VERIFIED 200, 25 items), stores Reddit content as short-lived signal, and never mirrors user text into durable storage. Revisit only if a phase genuinely needs comment-level data. |
| 6   | The individuals list (§4) does not exist                                                   | ✅ **Done**, with an explicit caveat about which selection criterion went unverified. See §4.                                                                                                                                                                                                                                                                                                                                                          |

### New Phase-2 findings that belong on this list

7. **`docs.anthropic.com` now redirects to `platform.claude.com/docs/`.** Any URL in these
   documents or in code using the old host is stale.
8. **`hamel.dev/index.xml` is malformed at source** (two concatenated documents). It works, it is
   registered, and the probe warns about it on every run. If the publisher fixes their build, the
   warning disappears on its own; if the feed degrades further, the warning becomes a failure.
9. **`eugeneyan.com/rss/` serves the full 212-item archive.** The first ingest will be large and
   almost entirely historical. Expected, not a fault — but worth knowing before Phase 3's first run
   makes it look like a burst of activity.
