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
