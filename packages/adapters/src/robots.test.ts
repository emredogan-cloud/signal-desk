import { describe, it, expect } from 'vitest';
import { parseRobots, isAllowed, robotsUrlFor, PERMISSIVE } from './robots.js';

/**
 * THREAT-MODEL.md §T-8: "`robots.txt` respected for every `html_diff` source."
 *
 * The registry's two diff targets are Anthropic's, and both of their real files are
 * covered below as recorded on 2026-08-13.
 */

const UA = 'signal-desk/0.1 (+https://github.com/emredogan-cloud/signal-desk)';

describe('parseRobots — the real files this system fetches', () => {
  it('reads anthropic.com as fully permissive', () => {
    const rules = parseRobots(
      ['User-Agent: *', 'Allow: /', '', 'Sitemap: https://www.anthropic.com/sitemap.xml'].join(
        '\n',
      ),
      UA,
    );

    expect(isAllowed(rules, '/news')).toBe(true);
    expect(isAllowed(rules, '/anything/at/all')).toBe(true);
  });

  it('reads docs.claude.com as disallowing only /api/', () => {
    const rules = parseRobots(
      [
        'User-Agent: *',
        'Disallow: /api/',
        '',
        'Sitemap: https://platform.claude.com/sitemap.xml',
      ].join('\n'),
      UA,
    );

    expect(isAllowed(rules, '/en/release-notes/overview')).toBe(true);
    expect(isAllowed(rules, '/api/messages')).toBe(false);
  });
});

describe('parseRobots', () => {
  it('treats a missing file as permissive', () => {
    expect(isAllowed(PERMISSIVE, '/anything')).toBe(true);
    expect(isAllowed(parseRobots('', UA), '/anything')).toBe(true);
  });

  it('does not read an empty Disallow as blocking the whole site', () => {
    // `Disallow:` with no value means "nothing is disallowed". Reading it as "the
    // empty prefix is disallowed" would silently block every source on the host.
    const rules = parseRobots(['User-agent: *', 'Disallow:'].join('\n'), UA);
    expect(isAllowed(rules, '/news')).toBe(true);
  });

  it('blocks the whole site for Disallow: /', () => {
    const rules = parseRobots(['User-agent: *', 'Disallow: /'].join('\n'), UA);
    expect(isAllowed(rules, '/news')).toBe(false);
    expect(isAllowed(rules, '/')).toBe(false);
  });

  it('prefers a group naming this agent over the wildcard', () => {
    const rules = parseRobots(
      ['User-agent: *', 'Disallow: /', '', 'User-agent: signal-desk', 'Disallow: /private/'].join(
        '\n',
      ),
      UA,
    );

    expect(isAllowed(rules, '/news')).toBe(true);
    expect(isAllowed(rules, '/private/x')).toBe(false);
  });

  it('shares rules across consecutive User-agent lines', () => {
    const rules = parseRobots(
      ['User-agent: signal-desk', 'User-agent: othercrawler', 'Disallow: /nope/'].join('\n'),
      UA,
    );
    expect(isAllowed(rules, '/nope/x')).toBe(false);
  });

  it('lets a longer Allow override a broader Disallow', () => {
    const rules = parseRobots(
      ['User-agent: *', 'Disallow: /docs/', 'Allow: /docs/public/'].join('\n'),
      UA,
    );

    expect(isAllowed(rules, '/docs/private')).toBe(false);
    expect(isAllowed(rules, '/docs/public/page')).toBe(true);
  });

  it('ignores comments and blank lines', () => {
    const rules = parseRobots(
      ['# a comment', '', 'User-agent: *   # inline', 'Disallow: /x/  # trailing'].join('\n'),
      UA,
    );
    expect(isAllowed(rules, '/x/y')).toBe(false);
    expect(isAllowed(rules, '/y')).toBe(true);
  });

  it('supports the * and $ wildcards publishers actually use', () => {
    const rules = parseRobots(
      ['User-agent: *', 'Disallow: /*.pdf$', 'Disallow: /tmp/*/secret'].join('\n'),
      UA,
    );

    expect(isAllowed(rules, '/reports/annual.pdf')).toBe(false);
    expect(isAllowed(rules, '/reports/annual.pdf.html')).toBe(true);
    expect(isAllowed(rules, '/tmp/a/secret')).toBe(false);
    expect(isAllowed(rules, '/tmp/a/public')).toBe(true);
  });

  it('reads crawl-delay when stated', () => {
    const rules = parseRobots(['User-agent: *', 'Crawl-delay: 10'].join('\n'), UA);
    expect(rules.crawlDelaySec).toBe(10);
  });

  it('is permissive when no group matches', () => {
    const rules = parseRobots(['User-agent: googlebot', 'Disallow: /'].join('\n'), UA);
    expect(isAllowed(rules, '/news')).toBe(true);
  });

  it('tolerates a malformed file rather than blocking everything', () => {
    const rules = parseRobots('this is not robots.txt\n<<<>>>\n', UA);
    expect(isAllowed(rules, '/news')).toBe(true);
  });
});

describe('robotsUrlFor', () => {
  it('builds the origin-level path', () => {
    expect(robotsUrlFor('https://www.anthropic.com/news')).toBe(
      'https://www.anthropic.com/robots.txt',
    );
    expect(robotsUrlFor('https://docs.claude.com/en/release-notes/overview')).toBe(
      'https://docs.claude.com/robots.txt',
    );
  });
});
