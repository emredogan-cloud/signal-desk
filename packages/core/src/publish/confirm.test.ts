import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  prepare,
  authorise,
  renderForConfirmation,
  PublishRefused,
  MAX_POST_CHARS,
  type AuthorisationContext,
} from './confirm.js';

/**
 * `THREAT-MODEL.md` §T-4 and `ROADMAP.md` Phase 13:
 *
 * > "No post can be sent without an explicit confirmation showing final text."
 * > "No autonomous publishing, ever, in any phase. **This is a design property, not a
 * > setting.**"
 *
 * These tests exist to make that structural rather than aspirational.
 */

const text = 'Anthropic shipped prompt caching. Cache reads bill at a tenth of input rate.';

const prepared = prepare({
  text,
  eventId: 1,
  claims: ['Cache reads bill at 0.1x input rate [ev-1]'],
  doNotSay: ['Do not say it is generally available — the post says research preview.'],
  sources: ['anthropic-news-diff · https://example.com/1'],
});

function context(overrides: Partial<AuthorisationContext> = {}): AuthorisationContext {
  return {
    postingEnabled: true,
    sentToday: 0,
    maxPerDay: 5,
    minutesSinceLastPost: undefined,
    minMinutesBetweenPosts: 30,
    ...overrides,
  };
}

describe('there is no autonomous publishing path', () => {
  it('exposes no function that sends', () => {
    // Asserted against the source, because the guarantee must hold for every future
    // edit — not just the shapes a test happens to call.
    const source = readFileSync(fileURLToPath(new URL('./confirm.ts', import.meta.url)), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/\bpostNow\b|\bautoPublish\b|\bpublishNow\b/);
    expect(source).not.toMatch(/https?:\/\/api\./);
  });

  it('prepare() returns a value and cannot send', () => {
    // No network, no side effect. Preparation and sending are separate calls, and only
    // the second is authorised.
    expect(prepared.text).toBe(text);
    expect(prepared.token).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('the confirmation token binds to the exact bytes', () => {
  it('accepts the reviewed text', () => {
    expect(() => {
      authorise(prepared, prepared.token, text, context());
    }).not.toThrow();
  });

  it('REFUSES when the text changed after review', () => {
    // The substitution gap. If a bug, a race, or a compromised analysis alters the
    // text between display and send, the operator confirmed something else — and this
    // is the check that notices.
    const altered = `${text} Follow me for more.`;
    expect(() => {
      authorise(prepared, prepared.token, altered, context());
    }).toThrow(PublishRefused);
    try {
      authorise(prepared, prepared.token, altered, context());
    } catch (error) {
      expect((error as PublishRefused).code).toBe('token_mismatch');
    }
  });

  it('REFUSES when the confirmation step was skipped', () => {
    // "Forgot to confirm" and "deliberately bypassed" both fail closed, because a
    // caller that skipped the display has no way to produce a valid token.
    for (const forged of ['', 'yes', 'confirmed', 'a'.repeat(32)]) {
      expect(() => {
        authorise(prepared, forged, text, context());
      }, forged).toThrow(PublishRefused);
    }
  });

  it('refuses even a single changed character', () => {
    expect(() => {
      authorise(prepared, prepared.token, `${text} `, context());
    }).toThrow(/does not match/);
  });

  it('THROWS rather than returning false', () => {
    // A boolean invites `if (ok) send()` with an else branch somebody forgets. For a
    // control whose failure mode is "the account is gone", failing loudly is correct.
    expect(() => {
      authorise(prepared, 'wrong', text, context());
    }).toThrow();
  });
});

describe('X_ENABLE_POSTING is necessary and never sufficient', () => {
  it('refuses when the flag is off, even with a perfect token', () => {
    expect(() => {
      authorise(prepared, prepared.token, text, context({ postingEnabled: false }));
    }).toThrow(/never sufficient/);
  });

  it('still requires the token when the flag is on', () => {
    // The flag alone must not be enough. This is the pair of conditions §T-4 requires.
    expect(() => {
      authorise(prepared, 'wrong', text, context({ postingEnabled: true }));
    }).toThrow(PublishRefused);
  });
});

describe('rate self-limits', () => {
  it('enforces the daily ceiling', () => {
    expect(() => {
      authorise(prepared, prepared.token, text, context({ sentToday: 5, maxPerDay: 5 }));
    }).toThrow(/X_MAX_POSTS_PER_DAY/);
  });

  it('enforces a minimum gap between posts', () => {
    // Not to avoid a 429 — to avoid LOOKING automated. §T-4 lists mass automation as
    // an account-loss risk, and a burst minutes apart is what that looks like.
    expect(() => {
      authorise(prepared, prepared.token, text, context({ minutesSinceLastPost: 5 }));
    }).toThrow(/looks automated/);
  });

  it('allows a post once the gap has passed', () => {
    expect(() => {
      authorise(prepared, prepared.token, text, context({ minutesSinceLastPost: 45 }));
    }).not.toThrow();
  });

  it('refuses empty and over-length posts', () => {
    const empty = prepare({ text: '', eventId: undefined, claims: [], doNotSay: [], sources: [] });
    expect(() => {
      authorise(empty, empty.token, '', context());
    }).toThrow(/empty/);

    const long = 'x'.repeat(MAX_POST_CHARS + 1);
    const oversized = prepare({
      text: long,
      eventId: undefined,
      claims: [],
      doNotSay: [],
      sources: [],
    });
    expect(() => {
      authorise(oversized, oversized.token, long, context());
    }).toThrow(/over the/);
  });

  it('counts code points, not UTF-16 units', () => {
    // An emoji is one character to a reader and two to String.length. A count that
    // disagrees with the platform would let a "valid" post be rejected on send.
    const emoji = prepare({
      text: '🎉🎉🎉',
      eventId: undefined,
      claims: [],
      doNotSay: [],
      sources: [],
    });
    expect(emoji.charCount).toBe(3);
  });
});

describe('the confirmation screen shows what will actually be sent', () => {
  const rendered = renderForConfirmation(prepared);

  it('shows the bytes verbatim inside markers', () => {
    // Markers make trailing whitespace and invisible characters visible. A screen that
    // tidies the text is showing something other than what will be sent.
    expect(rendered).toContain(`>>>${text}<<<`);
  });

  it('shows the DO-NOT-SAY list next to the text', () => {
    expect(rendered).toContain('DO NOT SAY');
    expect(rendered).toContain('research preview');
  });

  it('shows the claims and the evidence', () => {
    expect(rendered).toContain('CLAIMS MADE');
    expect(rendered).toContain('EVIDENCE');
    expect(rendered).toContain('anthropic-news-diff');
  });

  it('states that nothing is sent without the token', () => {
    expect(rendered).toContain('Nothing is sent unless this token is passed back');
    expect(rendered).toContain(prepared.token);
  });

  it('shows the character count', () => {
    expect(rendered).toContain(`${String(prepared.charCount)}/${String(MAX_POST_CHARS)}`);
  });
});
