/**
 * Vocabulary shared by every package.
 *
 * These are the words the six planning documents use. Keeping them in one place is
 * what stops `OFFICIAL_SOURCE` and `official_source` from both existing six months
 * from now.
 */

/**
 * The information quality tag carried by every claim the system makes.
 * ROADMAP.md §5. The tag is rendered next to the claim in the UI; an untagged claim
 * is a schema violation, not a stylistic lapse (THREAT-MODEL.md §T-2).
 */
export const EVIDENCE_TAGS = ['VERIFIED', 'OBSERVED', 'INFERRED', 'SPECULATIVE'] as const;
export type EvidenceTag = (typeof EVIDENCE_TAGS)[number];

/** Ordered weakest → strongest. Used to cap confidence, never to raise it. */
export const EVIDENCE_TAG_STRENGTH: Record<EvidenceTag, number> = {
  SPECULATIVE: 0,
  INFERRED: 1,
  OBSERVED: 2,
  VERIFIED: 3,
};

/** SOURCE-INTELLIGENCE.md §6. */
export const SOURCE_CATEGORIES = [
  'OFFICIAL_SOURCE',
  'EARLY_SIGNAL',
  'EXPERT_ANALYST',
  'JOURNALIST',
  'TECHNICAL_RESEARCHER',
  'AMPLIFIER',
  'COMMUNITY_SIGNAL',
] as const;
export type SourceCategory = (typeof SOURCE_CATEGORIES)[number];

/** The fetch mechanism, not the publisher. SOURCE-INTELLIGENCE.md §6. */
export const SOURCE_PLATFORMS = [
  'rss',
  'atom',
  'github_atom',
  'github_api',
  'html_diff',
  'statuspage',
  'x_api',
] as const;
export type SourcePlatform = (typeof SOURCE_PLATFORMS)[number];

/** 1 = a human looks at this today. SOURCE-INTELLIGENCE.md §6. */
export const SOURCE_PRIORITIES = [1, 2, 3, 4] as const;
export type SourcePriority = (typeof SOURCE_PRIORITIES)[number];

/**
 * Seed reliability by source category, 0.0–1.0.
 *
 * **Every one of these is an unvalidated starting guess.** They encode one ordering
 * claim — that a vendor announcing its own launch is more reliable about that launch
 * than a journalist reporting it, who is in turn more reliable than a comment thread
 * — and nothing finer. Phase 12 replaces them with measured precision per source.
 * Until then the system does not pretend the numbers mean more than they do.
 */
export const SOURCE_CATEGORY_RELIABILITY: Record<SourceCategory, number> = {
  OFFICIAL_SOURCE: 0.95,
  TECHNICAL_RESEARCHER: 0.8,
  EXPERT_ANALYST: 0.75,
  EARLY_SIGNAL: 0.65,
  JOURNALIST: 0.6,
  COMMUNITY_SIGNAL: 0.45,
  AMPLIFIER: 0.3,
};

/**
 * What an entity is. Models and products are stored as *aliases* of the
 * organisation, not as entities — "Anthropic shipped Opus 5" and "claude-opus-5 is
 * out" describe one event, and resolving them to one entity is the point.
 */
export const ENTITY_KINDS = ['org', 'project', 'person'] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

/** ROADMAP.md §6 — events and trends are deliberately never merged. */
export const EVENT_CATEGORIES = [
  'ai',
  'software',
  'hardware',
  'policy_platform',
  'social_trend',
] as const;
export type EventCategory = (typeof EVENT_CATEGORIES)[number];

export const CONFIDENCE_LEVELS = ['LOW', 'MED', 'HIGH'] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

/**
 * Legitimate reasons a post earns unusual attention.
 *
 * Lives in `shared` because both ends need it: `packages/ai` constrains what the model
 * may emit, and `packages/core` computes the verdict from what it emitted.
 *
 * A closed enum, deliberately. The operator asked the system to spot "viral potential",
 * and the fastest way to build something that optimises for engagement rather than
 * credibility is to let a model free-associate about what gets attention. Every member
 * here is a property **of the event**, not a technique for provoking a reaction — there
 * is no `controversy_bait`, no `hot_take`, no `outrage`. Adding one would be a change
 * to what this product is for, not a new option.
 */
export const ATTENTION_DRIVERS = [
  /** Genuinely new — not an iteration anyone expected. */
  'novelty',
  /** The result contradicts what a competent person would have predicted. */
  'surprising_result',
  /** Anyone can run it and see for themselves, today. */
  'independently_testable',
  /** A number, benchmark, or price that can be compared directly. */
  'measurable_comparison',
  /** It changes what a competitor has to do next. */
  'competitive_implication',
  /** The consequence lands on real work, not on discourse. */
  'practical_consequence',
  /** It shows better than it tells — there is something to see. */
  'visually_demonstrable',
  /** The before/after gap is large enough to be the whole story. */
  'strong_before_after',
  /** Being early is itself the advantage, and the window is open now. */
  'timing_window',
] as const;
export type AttentionDriver = (typeof ATTENTION_DRIVERS)[number];

/** What visual would turn a comment into evidence. `none` is a first-class answer. */
export const MEDIA_KINDS = [
  'none',
  'screenshot',
  'benchmark_run',
  'comparison_chart',
  'screen_recording',
  'official_image',
] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export type Mode = 'MOCK' | 'LIVE';

/**
 * Default poll intervals by priority, in seconds. SOURCE-INTELLIGENCE.md §6.
 *
 * STARTING GUESSES, not measured. Phase 12 tunes these against measured
 * `event_occurred → detected` latency.
 */
export const DEFAULT_POLL_INTERVAL_SEC: Record<SourcePriority, number> = {
  1: 5 * 60,
  2: 15 * 60,
  3: 60 * 60,
  4: 6 * 60 * 60,
};

export function isSourcePriority(n: number): n is SourcePriority {
  return n === 1 || n === 2 || n === 3 || n === 4;
}
