/**
 * **Every number in this file is an unvalidated starting guess.**
 *
 * ROADMAP.md §7 is explicit about it: "Initial weights are explicit constants in one
 * file, hand-set and clearly labelled as unvalidated guesses. Phase 12 replaces them
 * with weights fitted against measured outcomes, replaying three months of immutable
 * `raw_items` offline at zero API cost. Until then the system does not pretend the
 * numbers mean more than they do."
 *
 * They are all here, in one file, so that Phase 12 can rewrite this file and nothing
 * else. If a magic number appears in a scorer instead of here, that refit becomes a
 * hunt through the codebase, and the "explicit constants in one file" property — the
 * only thing making the refit cheap — is gone.
 *
 * ## What is and is not being claimed
 *
 * These weights encode **ordering claims**, not magnitudes:
 *
 *   - an official announcement outranks a comment thread *about* that announcement
 *   - something the operator can test outranks something he can only summarise
 *   - six independent sources outrank one
 *   - a rumour, however important-sounding, cannot be HIGH confidence
 *
 * Nothing here claims that 82 is meaningfully different from 79. Treat the scores as
 * a sort order with an explanation attached, which is what the dashboard renders.
 */

import type { EventCategory, SourceCategory } from '@signal-desk/shared';

// ─────────────────────────────────────────────────────────────────────
// IMPORTANCE — "is this objectively a big deal?"
// ─────────────────────────────────────────────────────────────────────

/**
 * Component weights for importance, summing to 1.0.
 *
 * GUESSES. The ordering claim: what happened and who says so matter more than how
 * loudly it is being discussed, because discussion volume is the signal most easily
 * manufactured and the one this system has the weakest instrument for
 * (`SOURCE-INTELLIGENCE.md` §0 — X velocity was priced out).
 */
export const IMPORTANCE_WEIGHTS = {
  /** Official > journalist > comment thread. The strongest single signal. */
  sourceReliability: 0.24,
  /** How many *independent* sources carry it. */
  corroboration: 0.2,
  /** Is this new, or the ninth follow-up to a week-old story? */
  novelty: 0.16,
  /** Does it change what a developer can build or how much it costs? */
  technicalImpact: 0.16,
  /** How fast it is being picked up. INFERRED proxy — see VELOCITY_WEIGHTS. */
  velocity: 0.12,
  /** Hours old. Decays; see RECENCY_HALF_LIFE_HOURS. */
  recency: 0.12,
} as const;

/**
 * Importance by event category, 0..1, before other components.
 *
 * GUESS. The claim: an outage and a model launch are both events this operator can
 * say something useful about within the hour, while a social-format shift rarely is.
 */
export const CATEGORY_IMPORTANCE: Record<EventCategory, number> = {
  ai: 0.9,
  software: 0.7,
  hardware: 0.65,
  policy_platform: 0.8,
  social_trend: 0.5,
};

/**
 * Hours after which recency has halved.
 *
 * GUESS, but a reasoned one: `ROADMAP.md` §1 optimises for EARLY, and a launch that
 * is two days old is one the operator can no longer be early on. 18 hours puts a
 * same-day event well above a yesterday event without erasing yesterday entirely.
 */
export const RECENCY_HALF_LIFE_HOURS = 18;

/**
 * Distinct corroborating sources at which the corroboration component saturates.
 *
 * GUESS. Beyond roughly this many, additional outlets carrying the same story say
 * more about the story's PR budget than about its importance.
 */
export const CORROBORATION_SATURATION = 5;

/**
 * Words in a title or body that signal genuine technical impact.
 *
 * GUESSES, and deliberately narrow: each term is one where a developer's options
 * actually change. "Announces" is absent on purpose — everything announces something.
 */
export const TECHNICAL_IMPACT_TERMS: readonly (readonly [RegExp, number])[] = [
  [/\b(?:breaking change|backwards[- ]incompatible|deprecat\w+|end[- ]of[- ]life|sunset)\b/i, 1.0],
  [/\b(?:outage|incident|degraded|elevated error rates?|down for)\b/i, 0.9],
  [/\b(?:open[- ]?weights?|open[- ]?sourc\w+|apache 2\.0|mit licen[cs]e)\b/i, 0.85],
  [/\b(?:price|pricing|cost per|per million tokens?|free tier|rate limits?)\b/i, 0.8],
  [/\b(?:release[sd]?|launch\w*|general availability|now available|ships?)\b/i, 0.7],
  [/\b(?:benchmark|state[- ]of[- ]the[- ]art|sota|outperform\w*)\b/i, 0.55],
  [/\b(?:context window|throughput|latency|tokens? per second)\b/i, 0.6],
  [/\b(?:preview|beta|experimental|research preview)\b/i, 0.45],
];

// ─────────────────────────────────────────────────────────────────────
// BRAND RELEVANCE — "is this a big deal FOR THIS OPERATOR?"
// ─────────────────────────────────────────────────────────────────────

/**
 * Component weights for brand relevance, summing to 1.0.
 *
 * GUESSES. The ordering claim comes straight from `ROADMAP.md` §7: the question is
 * not "is this interesting" but "can he add something not already said". Testability
 * therefore outranks audience size — an operator who has *run the thing* has
 * something to say that a summariser does not.
 */
export const RELEVANCE_WEIGHTS = {
  /** Proximity to entities he actually works with. */
  entityProximity: 0.3,
  /** Can he test it today, on his own machine, for free? */
  testability: 0.28,
  /** Is there an angle not already covered by the obvious commentary? */
  differentiation: 0.22,
  /** Does it teach something reusable? */
  teachingPotential: 0.2,
} as const;

/**
 * Entities the operator can test directly, and how strongly.
 *
 * GUESSES derived from his actual stack: TypeScript on Supabase edge functions,
 * Dart/Flutter, Anthropic tooling, Vercel deployment. Testability is what separates
 * "I read the announcement" from "I ran it and here is what broke".
 */
export const TESTABLE_ENTITIES: Record<string, number> = {
  anthropic: 1.0,
  supabase: 1.0,
  flutter: 0.95,
  vercel: 0.9,
  openai: 0.85,
  huggingface: 0.8,
  github: 0.75,
  'google-deepmind': 0.7,
  cloudflare: 0.65,
  alibaba: 0.6,
  deepseek: 0.6,
  mistral: 0.6,
  meta: 0.55,
  google: 0.5,
  microsoft: 0.45,
  nvidia: 0.4,
  amazon: 0.4,
  xai: 0.4,
  apple: 0.25,
};

/**
 * Source categories whose coverage means the obvious angle is already taken.
 *
 * GUESS. `SOURCE-INTELLIGENCE.md` §3 names Simon Willison specifically: "if he has
 * already published the experiment, the operator's angle must be different, not
 * duplicative." Heavy expert coverage *lowers* differentiation.
 */
export const DIFFERENTIATION_PENALTY_PER_EXPERT_SOURCE = 0.25;

/** Terms suggesting something teachable rather than merely reportable. GUESSES. */
export const TEACHING_TERMS: readonly RegExp[] = [
  /\b(?:how to|tutorial|guide|walkthrough|worked example|step[- ]by[- ]step)\b/i,
  /\b(?:technique|pattern|workflow|recipe|approach)\b/i,
  /\b(?:gotcha|pitfall|caveat|limitation|failure mode|does ?n[o']t work)\b/i,
  /\b(?:benchmark|measured|we tested|in practice|real[- ]world)\b/i,
  /\b(?:migration|upgrade path|breaking change)\b/i,
];

// ─────────────────────────────────────────────────────────────────────
// VELOCITY — the substitute for the X signal that pricing removed
// ─────────────────────────────────────────────────────────────────────

/**
 * **INFERRED, NOT MEASURED. Phase 12 must validate or discard this entirely.**
 *
 * `SOURCE-INTELLIGENCE.md` §0: X post reads at $0.005 made social velocity
 * unaffordable, so this system substitutes Hacker News, Reddit, and GitHub activity.
 * The substitution is a hypothesis — that developer-audience attention on those
 * surfaces correlates with attention generally — and `THREAT-MODEL.md` §6 lists it as
 * an accepted residual risk precisely because it is unvalidated.
 *
 * It is weighted at 0.12 of importance deliberately: low enough that if the proxy
 * turns out to predict nothing, the damage to the ordering is bounded.
 */
export const VELOCITY_WEIGHTS = {
  /** How fast independent sources arrived after the first. The most direct signal. */
  corroborationRate: 0.45,
  /** Presence on a community-signal source at all. */
  communityPickup: 0.35,
  /** How many distinct community sources carry it. */
  communityBreadth: 0.2,
} as const;

/** Hours within which corroboration counts as "fast". GUESS. */
export const VELOCITY_WINDOW_HOURS = 6;

// ─────────────────────────────────────────────────────────────────────
// CONFIDENCE — capped by rule, never merely computed
// ─────────────────────────────────────────────────────────────────────

/**
 * Source-category confidence contribution.
 *
 * GUESSES, but the ORDER is a hard requirement rather than a preference:
 * `THREAT-MODEL.md` §T-2 mitigation 4 requires that evidence which is entirely
 * non-official be hard-capped at LOW, and §5 test 7 tests it. The capping rules in
 * `confidence.ts` enforce that regardless of what these numbers say.
 */
export const CONFIDENCE_BY_SOURCE_CATEGORY: Record<SourceCategory, number> = {
  OFFICIAL_SOURCE: 1.0,
  TECHNICAL_RESEARCHER: 0.7,
  EXPERT_ANALYST: 0.65,
  EARLY_SIGNAL: 0.5,
  JOURNALIST: 0.45,
  COMMUNITY_SIGNAL: 0.25,
  AMPLIFIER: 0.1,
};

/** Score at or above which confidence may be HIGH — if the caps also allow it. GUESS. */
export const CONFIDENCE_HIGH_THRESHOLD = 0.75;
/** Score at or above which confidence may be MED. GUESS. */
export const CONFIDENCE_MED_THRESHOLD = 0.45;

/**
 * Distinct sources required before confidence may reach HIGH.
 *
 * NOT a guess — this is `THREAT-MODEL.md` §T-1 mitigation 7, the two-source rule:
 * "A single unofficial source can never produce a VERIFIED claim, no matter what it
 * says about itself."
 */
export const HIGH_CONFIDENCE_MIN_SOURCES = 2;

// ─────────────────────────────────────────────────────────────────────
// THE RULE GATE — cost control, before any token is spent
// ─────────────────────────────────────────────────────────────────────

/**
 * Combined score below which an event never reaches the LLM.
 *
 * GUESS, and the single largest cost lever in the system after
 * `AI_ANALYSIS_THRESHOLD`. `ARCHITECTURE.md` §4: the rule gate "is what makes the
 * difference between a $150/month toy and a $15/month tool."
 */
export const GATE_MIN_COMBINED_SCORE = 30;

/** Importance floor regardless of brand relevance. GUESS. */
export const GATE_MIN_IMPORTANCE = 20;

/**
 * Age past which an event never reaches the LLM, in days.
 *
 * **The single largest filter in the gate, and the one the first measurement was
 * missing entirely.** Scoring 5,007 real events produced a 17% kill rate against an
 * 85% target, and the reason was visible in the top-20: two-year-old entries from the
 * Vercel changelog archive scoring 53 and passing.
 *
 * Recency was a score *component*, which meant an old event lost some points and
 * still cleared the floor. But `ROADMAP.md` §1 optimises for **EARLY** — "before the
 * conversation moves on" — and an event from 2023 is not something this operator can
 * be early on at any score. That is a kill rule, not a penalty.
 *
 * Seven days is the guess. It is generous on purpose: a launch the operator missed by
 * five days is still worth an angle, and one he missed by a month is archaeology.
 */
export const GATE_MAX_AGE_DAYS = 7;

/**
 * Events with a single source and no artifact never reach the LLM.
 *
 * GUESS, but with a clear rationale: `THREAT-MODEL.md` §T-1 mitigation 7 already says
 * a single unofficial source cannot produce a VERIFIED claim, and `§T-2` biases such
 * events toward WAIT/VERIFY anyway. Paying Opus to analyse something the system will
 * then refuse to stand behind is spending money to produce a recommendation of "wait".
 */
export const GATE_REQUIRE_CORROBORATION_OR_ARTIFACT = true;

/**
 * Sources whose items are killed unless something else corroborates them.
 *
 * NOT a guess for arXiv — `SOURCE-INTELLIGENCE.md` §2 states the rule directly:
 * "an arXiv item may not reach the LLM tier unless it is *already* corroborated by a
 * Tier-1 or Tier-2 discussion source (HN ≥100 points, a lab blog post, or ≥2
 * monitored GitHub repos referencing it)." 344 items in one pull would otherwise
 * dominate ingestion and burn the budget on papers that never become content.
 */
export const CORROBORATION_REQUIRED_SOURCES = new Set(['arxiv-cs-ai']);

/**
 * Titles that are structurally not events.
 *
 * GUESSES, all derived from real ingested data: Wired publishes dozens of promo-code
 * pages a day, GitHub activity atoms emit "pushed" lines by the hundred, and Product
 * Hunt carries listings with no technical content. Each was observed in the 5,208-item
 * corpus, not imagined.
 */
export const NOISE_TITLE_PATTERNS: readonly RegExp[] = [
  /\b(?:promo|discount|coupon)\s+codes?\b/i,
  /\b\d+%\s+off\b/i,
  /^best\s+\d+\b/i,
  /\bdeals?\s+(?:of the day|this week)\b/i,
  /\bgift guide\b/i,
  /^\s*(?:re:|fwd:)/i,
];

/** Off-topic categories. Currently none — all five are in scope per ROADMAP.md §5. */
export const OFF_TOPIC_CATEGORIES: ReadonlySet<EventCategory> = new Set();

/**
 * Sources whose items are pure activity noise unless they carry a version artifact.
 *
 * GUESS, from observation: `github.com/{user}.atom` emits "X commented on an issue"
 * and "X pushed Y" continuously. A *release* from the same user is a real event; a
 * comment is not.
 */
export const ACTIVITY_ONLY_SOURCES = new Set([
  'gh-user-simonw',
  'gh-user-karpathy',
  'gh-user-ggerganov',
]);

export const ACTIVITY_NOISE_PATTERNS: readonly RegExp[] = [
  /\b(?:commented on|opened|closed|reopened|contributed to|starred|forked|deleted)\b/i,
  /\bpushed\b/i,
];
