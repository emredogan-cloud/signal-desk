import { describe, it, expect, beforeEach } from 'vitest';
import {
  scrubString,
  scrubValue,
  containsSecret,
  registerSecret,
  clearRegisteredSecrets,
  REDACTED,
} from './redact.js';
import { createLogger } from './logger.js';

/**
 * THREAT-MODEL.md §5 test 4 — log redaction.
 *
 * Every key in this file is synthetic. They are shaped like real credentials on
 * purpose, because a redactor tested only against `"my-secret"` proves nothing.
 */

/**
 * A credential with no distinctive prefix — the case only `registerSecret` can catch.
 *
 * Assembled at runtime rather than written as a literal. A high-entropy alphanumeric
 * string in source is indistinguishable from a real X OAuth token to a secret
 * scanner, and gitleaks running clean over this repository is a Phase 1 acceptance
 * criterion. The alternative — allowlisting `**\/*.test.ts` in `.gitleaks.toml` — would
 * mean a genuine key pasted into a fixture goes unnoticed forever. Trading a real
 * control for a convenient literal is the wrong side of that bargain.
 */
export const shapelessToken = ['k7Hs92', 'LmQx4T', 'bV0nRz', 'YwPcEjA8'].join('');

const SYNTHETIC = {
  // These are safe as literals: each payload is a repeated character, so it matches
  // the vendor *shape* the redactor looks for while scoring zero entropy — which is
  // exactly how `.gitleaks.toml` distinguishes a fixture from a credential.
  anthropic: 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  githubClassic: 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  githubFineGrained: 'github_pat_AAAAAAAAAAAAAAAAAA_BBBBBBBBBBBBBBBBBBBBBBBB',
  aws: 'AKIAIOSFODNN7EXAMPLE',
  openai: 'sk-proj-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  slack: 'xoxb-1111111111-2222222222-AAAAAAAAAAAAAAAAAAAA',
  bearer: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9AAAA',
  xOauth: shapelessToken,
} as const;

beforeEach(() => {
  clearRegisteredSecrets();
});

describe('scrubString — pattern-based redaction', () => {
  it.each(Object.entries(SYNTHETIC).filter(([name]) => name !== 'xOauth'))(
    'redacts a %s-shaped credential',
    (_name, secret) => {
      const scrubbed = scrubString(`request failed: ${secret} rejected`);
      expect(scrubbed).not.toContain(secret);
      expect(scrubbed).toContain(REDACTED);
    },
  );

  it('redacts a key echoed back inside an upstream error body', () => {
    // The realistic leak path: a 401 body that quotes the offending key.
    const body = JSON.stringify({
      type: 'error',
      error: { message: `invalid x-api-key: ${SYNTHETIC.anthropic}` },
    });
    expect(scrubString(body)).not.toContain(SYNTHETIC.anthropic);
  });

  it('redacts multiple distinct credentials in one string', () => {
    const scrubbed = scrubString(`${SYNTHETIC.anthropic} and ${SYNTHETIC.githubClassic}`);
    expect(scrubbed).not.toContain(SYNTHETIC.anthropic);
    expect(scrubbed).not.toContain(SYNTHETIC.githubClassic);
  });

  it('is stable across repeated calls', () => {
    // Module-level /g regexes carry lastIndex. If it is not reset, the second call
    // silently misses — the worst possible failure mode for a redactor.
    const text = `key=${SYNTHETIC.anthropic}`;
    for (let i = 0; i < 5; i++) {
      expect(scrubString(text)).not.toContain(SYNTHETIC.anthropic);
    }
  });

  it('leaves ordinary text alone', () => {
    const text = 'Anthropic released claude-opus-5 on 2026-08-12 with a 512-token cache floor.';
    expect(scrubString(text)).toBe(text);
  });
});

describe('registerSecret — value-based redaction', () => {
  it('redacts a shapeless credential once registered', () => {
    expect(scrubString(`token=${SYNTHETIC.xOauth}`)).toContain(SYNTHETIC.xOauth);

    registerSecret(SYNTHETIC.xOauth);

    const scrubbed = scrubString(`token=${SYNTHETIC.xOauth}`);
    expect(scrubbed).not.toContain(SYNTHETIC.xOauth);
    expect(scrubbed).toBe(`token=${REDACTED}`);
  });

  it('ignores values too short to redact safely', () => {
    // Registering "abc" would replace those letters everywhere and produce unreadable
    // logs while looking like it worked.
    registerSecret('abc');
    expect(scrubString('abcdefg the alphabet')).toBe('abcdefg the alphabet');
  });

  it('ignores undefined, so an unset optional credential is not an error', () => {
    expect(() => {
      registerSecret(undefined);
    }).not.toThrow();
  });
});

describe('scrubValue — structured redaction', () => {
  it('redacts by sensitive key name regardless of the value shape', () => {
    const scrubbed = scrubValue({
      url: 'https://api.anthropic.com/v1/messages',
      headers: {
        'x-api-key': SYNTHETIC.xOauth,
        authorization: 'anything',
        accept: 'application/json',
      },
    }) as { headers: Record<string, string> };

    expect(scrubbed.headers['x-api-key']).toBe(REDACTED);
    expect(scrubbed.headers.authorization).toBe(REDACTED);
    expect(scrubbed.headers.accept).toBe('application/json');
  });

  it('redacts the ntfy topic, which is itself the credential', () => {
    // ENV-HANDBOOK.md §6: "an ntfy topic name *is* the credential."
    const scrubbed = scrubValue({ ntfy_topic: 'a-long-unguessable-topic-name' }) as Record<
      string,
      unknown
    >;
    expect(scrubbed.ntfy_topic).toBe(REDACTED);
  });

  it('descends into nested objects and arrays', () => {
    const scrubbed = scrubValue({
      calls: [{ meta: { note: `used ${SYNTHETIC.anthropic}` } }],
    });
    expect(JSON.stringify(scrubbed)).not.toContain(SYNTHETIC.anthropic);
  });

  it('scrubs error messages and stacks', () => {
    const error = new Error(`auth failed for ${SYNTHETIC.anthropic}`);
    const scrubbed = scrubValue(error) as { message: string; stack?: string };
    expect(scrubbed.message).not.toContain(SYNTHETIC.anthropic);
    expect(scrubbed.stack ?? '').not.toContain(SYNTHETIC.anthropic);
  });

  it('survives a circular reference instead of hanging', () => {
    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;
    expect(scrubValue(circular)).toEqual({ name: 'loop', self: '[circular]' });
  });

  it('caps depth instead of recursing without bound', () => {
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 40; i++) deep = { nested: deep };
    expect(() => JSON.stringify(scrubValue(deep))).not.toThrow();
  });
});

describe('logger integration — nothing reaches the output stream unredacted', () => {
  function captureLogs() {
    const lines: string[] = [];
    const logger = createLogger({
      level: 'trace',
      destination: {
        write(chunk: string) {
          lines.push(chunk);
        },
      },
    });
    return { logger, lines, text: () => lines.join('') };
  }

  it('redacts a credential in the log message', () => {
    const { logger, text } = captureLogs();
    logger.error(`anthropic call failed with key ${SYNTHETIC.anthropic}`);

    expect(text()).not.toContain(SYNTHETIC.anthropic);
    expect(containsSecret(text())).toBe(false);
  });

  it('redacts a credential in a merged object', () => {
    const { logger, text } = captureLogs();
    logger.info({ source: 'anthropic', headers: { 'x-api-key': SYNTHETIC.anthropic } }, 'request');

    expect(text()).not.toContain(SYNTHETIC.anthropic);
  });

  it('redacts a registered shapeless credential', () => {
    registerSecret(SYNTHETIC.xOauth);
    const { logger, text } = captureLogs();
    logger.warn({ oauth: SYNTHETIC.xOauth }, 'x api call');

    expect(text()).not.toContain(SYNTHETIC.xOauth);
  });

  it('redacts a credential inside a logged Error', () => {
    const { logger, text } = captureLogs();
    logger.error({ err: new Error(`401 from ${SYNTHETIC.anthropic}`) }, 'upstream rejected');

    expect(text()).not.toContain(SYNTHETIC.anthropic);
  });

  it('still logs the useful part of the line', () => {
    const { logger, text } = captureLogs();
    logger.info({ source_id: 'openai-news', items: 12 }, 'fetch complete');

    expect(text()).toContain('openai-news');
    expect(text()).toContain('fetch complete');
  });
});

describe('containsSecret', () => {
  it('detects an unredacted credential', () => {
    expect(containsSecret(`key: ${SYNTHETIC.anthropic}`)).toBe(true);
  });

  it('reports clean text as clean', () => {
    expect(containsSecret('nothing sensitive here')).toBe(false);
  });

  it('reports scrubbed text as clean', () => {
    expect(containsSecret(scrubString(`key: ${SYNTHETIC.githubClassic}`))).toBe(false);
  });
});
