import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { SafeLink, hostOf } from './safe.js';
import { MockBadge } from './mock-badge.js';
import { INJECTION_CORPUS } from '@signal-desk/core';

/**
 * `ROADMAP.md` Phase 10 TESTS: "XSS test rendering hostile titles and summaries from
 * the injection corpus." Acceptance: "Hostile content from the injection corpus
 * renders inert."
 *
 * React escapes text by default, so the interesting surface is not `{title}` — it is
 * the two places a developer reaches past that escaping: `dangerouslySetInnerHTML`
 * (which does not exist in this app) and `href` (which escaping does not protect,
 * because `javascript:` executes on click regardless).
 */

describe('hostile corpus content renders inert', () => {
  it.each(INJECTION_CORPUS.map((entry) => [entry.id, entry] as const))(
    '%s escapes to text',
    (_id, entry) => {
      const html = renderToStaticMarkup(
        <div>
          <h1>{entry.title}</h1>
          <p>{entry.body}</p>
        </div>,
      );

      // No executable markup survives. The corpus contains <script>-adjacent payloads,
      // style attributes, and forged tags; all must arrive as visible text.
      expect(html, entry.note).not.toMatch(/<script/i);
      expect(html).not.toMatch(/<style/i);
      expect(html).not.toMatch(/\son\w+\s*=/i);
      expect(html).not.toMatch(/javascript:/i);
      // Angle brackets from the content are entity-escaped rather than parsed.
      if (entry.body.includes('<div')) expect(html).toContain('&lt;div');
    },
  );

  it('never uses dangerouslySetInnerHTML anywhere in the app', () => {
    // Asserted against the source, because the property must hold for every current
    // and future component — not just the ones a test happens to render.
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir).flatMap((entry) => {
        const full = path.join(dir, entry);
        if (fs.statSync(full).isDirectory()) return entry === 'node_modules' ? [] : walk(full);
        // Test files are excluded: this one necessarily names the thing it forbids,
        // and a guard that flags its own assertion string is a guard nobody keeps.
        if (/\.test\.(tsx?|jsx?)$/.test(entry)) return [];
        return /\.(tsx?|jsx?)$/.test(entry) ? [full] : [];
      });

    for (const file of walk(path.join(process.cwd(), 'apps/web/src'))) {
      // Comments are stripped first. `safe.tsx` documents *why* it avoids the API, and
      // a guard that fires on its own rationale is one somebody deletes.
      const code = fs
        .readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      expect(code, file).not.toContain('dangerouslySetInnerHTML');
    }
  });
});

describe('SafeLink', () => {
  it('renders http and https links with the destination host as text', () => {
    const html = renderToStaticMarkup(<SafeLink url="https://anthropic.com/news/x" />);
    expect(html).toContain('href="https://anthropic.com/news/x"');
    // Showing the host is a phishing control: an item can title itself "Official
    // announcement" and link anywhere.
    expect(html).toContain('anthropic.com');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });

  it.each([
    ['javascript:', 'javascript:alert(1)'],
    ['data:', 'data:text/html,<script>alert(1)</script>'],
    ['vbscript:', 'vbscript:msgbox(1)'],
    ['file:', 'file:///etc/passwd'],
    ['malformed', 'not a url at all'],
    ['protocol-relative to nowhere', '//'],
  ])('refuses a %s URL and renders it as inert text', (_kind, url) => {
    const html = renderToStaticMarkup(<SafeLink url={url} />);
    expect(html).not.toContain('href=');
    expect(html).toContain('[unsafe link]');
  });

  it('does not silently drop a refused link', () => {
    // A link the system refused to make clickable is itself informative — dropping it
    // would hide that something tried.
    const html = renderToStaticMarkup(<SafeLink url="javascript:alert(1)" />);
    expect(html).toContain('unsafe-link');
  });

  it('parses hosts without throwing on anything', () => {
    for (const url of ['', 'https://', '://x', 'http://[', 'https://ok.com']) {
      expect(() => hostOf(url)).not.toThrow();
    }
  });
});

describe('the MOCK badge', () => {
  const base = { postingEnabled: false, degradations: [] } as const;

  it('names every mocked subsystem individually', () => {
    // A badge saying only "some things are mocked" leaves the operator guessing which.
    const html = renderToStaticMarkup(
      <MockBadge modes={{ ...base, dataMode: 'MOCK', aiMode: 'MOCK', xMode: 'LIVE' }} />,
    );
    expect(html).toContain('VERİ');
    expect(html).toContain('AI');
    expect(html).not.toContain('platform erişimi yok');
  });

  it('states plainly that nothing on screen is live', () => {
    const html = renderToStaticMarkup(
      <MockBadge modes={{ ...base, dataMode: 'MOCK', aiMode: 'MOCK', xMode: 'MOCK' }} />,
    );
    expect(html).toContain('canlı sonuç değildir');
  });

  it('renders nothing when everything is live', () => {
    const html = renderToStaticMarkup(
      <MockBadge modes={{ ...base, dataMode: 'LIVE', aiMode: 'LIVE', xMode: 'LIVE' }} />,
    );
    expect(html).toBe('');
  });

  it('appears whenever ANY single mode is mocked', () => {
    for (const mocked of ['dataMode', 'aiMode', 'xMode'] as const) {
      const modes = {
        ...base,
        dataMode: 'LIVE' as const,
        aiMode: 'LIVE' as const,
        xMode: 'LIVE' as const,
        [mocked]: 'MOCK' as const,
      };
      expect(renderToStaticMarkup(<MockBadge modes={modes} />), mocked).toContain('MOCK MOD');
    }
  });
});
