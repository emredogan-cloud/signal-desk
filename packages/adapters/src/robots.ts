/**
 * A minimal `robots.txt` parser. THREAT-MODEL.md §T-8:
 *
 *   "`robots.txt` respected for every `html_diff` source"
 *
 * Deliberately small and deliberately conservative. This is not a general-purpose
 * crawler: it checks a handful of registry URLs, and where the spec is ambiguous it
 * chooses the interpretation that fetches less.
 */

export type RobotsRules = {
  /** Path prefixes this agent may not fetch. */
  readonly disallow: readonly string[];
  /** Path prefixes that override a broader Disallow. */
  readonly allow: readonly string[];
  /** Seconds the publisher asks between requests, if stated. */
  readonly crawlDelaySec: number | undefined;
};

export const PERMISSIVE: RobotsRules = { disallow: [], allow: [], crawlDelaySec: undefined };

/**
 * Parse for one user-agent.
 *
 * Group selection follows the usual rule: the most specific matching `User-agent`
 * group wins, and `*` is the fallback. A file with no matching group is permissive.
 */
export function parseRobots(contents: string, userAgent: string): RobotsRules {
  const agent = userAgent.toLowerCase();

  const groups: { agents: string[]; disallow: string[]; allow: string[]; delay?: number }[] = [];
  let current: (typeof groups)[number] | undefined;
  let lastLineWasAgent = false;

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.split('#')[0]?.trim() ?? '';
    if (line === '') continue;

    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === 'user-agent') {
      // Consecutive User-agent lines share one group of rules.
      if (current === undefined || !lastLineWasAgent) {
        current = { agents: [], disallow: [], allow: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastLineWasAgent = true;
      continue;
    }

    lastLineWasAgent = false;
    if (current === undefined) continue;

    if (field === 'disallow') current.disallow.push(value);
    else if (field === 'allow') current.allow.push(value);
    else if (field === 'crawl-delay') {
      const parsed = Number.parseFloat(value);
      if (Number.isFinite(parsed) && parsed >= 0) current.delay = parsed;
    }
  }

  const specific = groups.find((g) => g.agents.some((a) => a !== '*' && agent.includes(a)));
  const wildcard = groups.find((g) => g.agents.includes('*'));
  const chosen = specific ?? wildcard;

  if (chosen === undefined) return PERMISSIVE;

  return {
    // An empty `Disallow:` means "nothing is disallowed" and must not be read as
    // "the empty prefix is disallowed", which would block the entire site.
    disallow: chosen.disallow.filter((p) => p !== ''),
    allow: chosen.allow.filter((p) => p !== ''),
    crawlDelaySec: chosen.delay,
  };
}

/**
 * May this path be fetched?
 *
 * Longest-match wins between Allow and Disallow, which is the behaviour every major
 * crawler implements and the one publishers write their files expecting. On a tie,
 * Allow wins — that is the documented convention.
 */
export function isAllowed(rules: RobotsRules, path: string): boolean {
  const matchLength = (patterns: readonly string[]): number =>
    patterns.reduce((longest, pattern) => {
      if (!matchesPattern(path, pattern)) return longest;
      return Math.max(longest, pattern.length);
    }, -1);

  const disallowed = matchLength(rules.disallow);
  if (disallowed === -1) return true;
  return matchLength(rules.allow) >= disallowed;
}

/** Supports the `*` and `$` wildcards that robots.txt files use in practice. */
function matchesPattern(path: string, pattern: string): boolean {
  if (pattern === '') return false;
  if (!pattern.includes('*') && !pattern.endsWith('$')) return path.startsWith(pattern);

  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');

  return new RegExp(`^${escaped}${anchored ? '$' : ''}`).test(path);
}

export function robotsUrlFor(pageUrl: string): string {
  const parsed = new URL(pageUrl);
  return `${parsed.origin}/robots.txt`;
}
