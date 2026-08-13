import { describe, it, expect } from 'vitest';
import {
  parseConfig,
  ConfigError,
  deriveEffectiveModes,
  isAnyModeMocked,
  databaseFilePath,
  maskSecret,
} from './config.js';

/**
 * Phase 1 TESTS, per ROADMAP.md:
 *   "Config parser: valid env, invalid enum, missing optional,
 *    missing required-with-default."
 */

describe('parseConfig — valid environments', () => {
  it('accepts a fully specified environment', () => {
    const config = parseConfig({
      DATA_MODE: 'LIVE',
      AI_MODE: 'LIVE',
      X_MODE: 'LIVE',
      DATABASE_URL: 'file:./data/other.db',
      LOG_LEVEL: 'debug',
      TZ: 'UTC',
      ANTHROPIC_API_KEY: 'sk-ant-api03-test-key-value',
      AI_TRIAGE_MODEL: 'claude-haiku-4-5',
      AI_ANALYSIS_MODEL: 'claude-opus-5',
      AI_DAILY_BUDGET_USD: '5.50',
      AI_ANALYSIS_THRESHOLD: '80',
      AI_USE_BATCH_FOR_NON_URGENT: 'false',
      X_MAX_POSTS_PER_DAY: '2',
      ALERT_MIN_PRIORITY: 'high',
    });

    expect(config.DATA_MODE).toBe('LIVE');
    expect(config.AI_DAILY_BUDGET_USD).toBe(5.5);
    expect(config.AI_ANALYSIS_THRESHOLD).toBe(80);
    expect(config.AI_USE_BATCH_FOR_NON_URGENT).toBe(false);
    expect(config.X_MAX_POSTS_PER_DAY).toBe(2);
    expect(config.ALERT_MIN_PRIORITY).toBe('high');
  });

  it('applies every documented default to a completely empty environment', () => {
    // The all-MOCK, zero-credential case. This is what CI runs.
    const config = parseConfig({});

    expect(config.DATA_MODE).toBe('MOCK');
    expect(config.AI_MODE).toBe('MOCK');
    expect(config.X_MODE).toBe('MOCK');
    expect(config.DATABASE_URL).toBe('file:./data/signal-desk.db');
    expect(config.LOG_LEVEL).toBe('info');
    expect(config.TZ).toBe('Europe/Istanbul');
    expect(config.AI_TRIAGE_MODEL).toBe('claude-haiku-4-5');
    expect(config.AI_ANALYSIS_MODEL).toBe('claude-opus-5');
    expect(config.AI_DAILY_BUDGET_USD).toBe(2.0);
    expect(config.AI_ANALYSIS_THRESHOLD).toBe(70);
    expect(config.AI_USE_BATCH_FOR_NON_URGENT).toBe(true);
    expect(config.X_DAILY_BUDGET_USD).toBe(0.5);
    expect(config.X_ENABLE_POSTING).toBe(false);
    expect(config.X_MAX_POSTS_PER_DAY).toBe(4);
    expect(config.ALERT_MIN_PRIORITY).toBe('urgent');
  });

  it('defaults match the committed .env.example, which ships every key blank', () => {
    // ENV-HANDBOOK.md §8 ships `KEY=` for every credential. Parsing that file must
    // produce "not configured", not a credential equal to the empty string — an
    // Anthropic client built with '' fails at request time with a confusing 401
    // instead of at startup with a clear one.
    const config = parseConfig({
      DATA_MODE: 'MOCK',
      AI_MODE: 'MOCK',
      X_MODE: 'MOCK',
      ANTHROPIC_API_KEY: '',
      X_API_KEY: '',
      GITHUB_TOKEN: '',
      NTFY_TOPIC: '',
      AI_DAILY_BUDGET_USD: '2.00',
    });

    expect(config.ANTHROPIC_API_KEY).toBeUndefined();
    expect(config.X_API_KEY).toBeUndefined();
    expect(config.GITHUB_TOKEN).toBeUndefined();
    expect(config.NTFY_TOPIC).toBeUndefined();
  });

  it('treats a blank value for a defaulted variable as absent rather than invalid', () => {
    const config = parseConfig({ LOG_LEVEL: '', AI_ANALYSIS_THRESHOLD: '   ', TZ: '' });
    expect(config.LOG_LEVEL).toBe('info');
    expect(config.AI_ANALYSIS_THRESHOLD).toBe(70);
    expect(config.TZ).toBe('Europe/Istanbul');
  });

  it.each([
    ['true', true],
    ['TRUE', true],
    ['1', true],
    ['yes', true],
    ['on', true],
    ['false', false],
    ['FALSE', false],
    ['0', false],
    ['no', false],
    ['off', false],
  ])('parses X_ENABLE_POSTING=%s as %s', (input, expected) => {
    expect(parseConfig({ X_ENABLE_POSTING: input }).X_ENABLE_POSTING).toBe(expected);
  });
});

describe('parseConfig — invalid environments fail fast and readably', () => {
  it('rejects an invalid enum value', () => {
    expect(() => parseConfig({ DATA_MODE: 'live' })).toThrow(ConfigError);
    expect(() => parseConfig({ AI_MODE: 'PRODUCTION' })).toThrow(ConfigError);
    expect(() => parseConfig({ LOG_LEVEL: 'verbose' })).toThrow(ConfigError);
    expect(() => parseConfig({ ALERT_MIN_PRIORITY: 'critical' })).toThrow(ConfigError);
  });

  it('names the offending variable in the error message', () => {
    // ENV-HANDBOOK.md §9: "A typo in AI_ANALYSIS_MODEL should surface as a startup
    // error, not as a 404 three hours into a run." The message has to say which one.
    try {
      parseConfig({ DATA_MODE: 'live' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const configError = error as ConfigError;
      expect(configError.issues.join('\n')).toContain('DATA_MODE');
      expect(configError.message).toContain('ENV-HANDBOOK');
    }
  });

  it('reports every problem at once rather than one per restart', () => {
    try {
      parseConfig({ DATA_MODE: 'nope', AI_MODE: 'nope', LOG_LEVEL: 'nope' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as ConfigError).issues).toHaveLength(3);
    }
  });

  it('rejects a non-numeric budget instead of coercing it to NaN', () => {
    expect(() => parseConfig({ AI_DAILY_BUDGET_USD: 'two dollars' })).toThrow(ConfigError);
  });

  it('rejects a negative budget', () => {
    expect(() => parseConfig({ AI_DAILY_BUDGET_USD: '-1' })).toThrow(ConfigError);
    expect(() => parseConfig({ X_DAILY_BUDGET_USD: '-0.5' })).toThrow(ConfigError);
  });

  it('rejects an out-of-range analysis threshold', () => {
    expect(() => parseConfig({ AI_ANALYSIS_THRESHOLD: '101' })).toThrow(ConfigError);
    expect(() => parseConfig({ AI_ANALYSIS_THRESHOLD: '-5' })).toThrow(ConfigError);
  });

  it('rejects a non-boolean posting flag rather than treating it as false', () => {
    // Silently reading "maybe" as false would be safe here, but silently reading
    // "TRUE!" as false is the kind of thing that makes an operator distrust config.
    expect(() => parseConfig({ X_ENABLE_POSTING: 'maybe' })).toThrow(ConfigError);
  });

  it('rejects a fractional post-per-day ceiling', () => {
    expect(() => parseConfig({ X_MAX_POSTS_PER_DAY: '2.5' })).toThrow(ConfigError);
  });
});

describe('deriveEffectiveModes', () => {
  it('forces AI to MOCK when LIVE is requested without a key, and says why', () => {
    const modes = deriveEffectiveModes(parseConfig({ AI_MODE: 'LIVE' }));

    expect(modes.aiMode).toBe('MOCK');
    const aiDegradation = modes.degradations.find((d) => d.subsystem === 'ai');
    expect(aiDegradation).toBeDefined();
    expect(aiDegradation?.because).toContain('ANTHROPIC_API_KEY');
  });

  it('leaves AI in LIVE when a key is present', () => {
    const modes = deriveEffectiveModes(
      parseConfig({ AI_MODE: 'LIVE', ANTHROPIC_API_KEY: 'sk-ant-api03-abcdefghijklmnop' }),
    );
    expect(modes.aiMode).toBe('LIVE');
    expect(modes.degradations.some((d) => d.subsystem === 'ai')).toBe(false);
  });

  it('forces X to MOCK when any one of the four credentials is missing', () => {
    const modes = deriveEffectiveModes(
      parseConfig({
        X_MODE: 'LIVE',
        X_API_KEY: 'key',
        X_API_SECRET: 'secret',
        X_ACCESS_TOKEN: 'token',
        // X_ACCESS_TOKEN_SECRET deliberately absent
      }),
    );

    expect(modes.xMode).toBe('MOCK');
    expect(modes.degradations.find((d) => d.subsystem === 'x')?.because).toContain(
      'X_ACCESS_TOKEN_SECRET',
    );
  });

  it('never enables posting while X is effectively MOCK', () => {
    // THREAT-MODEL.md §T-4 — A2 is the X account. X_ENABLE_POSTING is necessary but
    // never sufficient, and a flag that reads "true" while the subsystem is mocked
    // must not report the capability as available.
    const modes = deriveEffectiveModes(
      parseConfig({ X_MODE: 'LIVE', X_ENABLE_POSTING: 'true' }), // no credentials
    );

    expect(modes.xMode).toBe('MOCK');
    expect(modes.postingEnabled).toBe(false);
    expect(modes.degradations.some((d) => d.effective === 'posting unavailable')).toBe(true);
  });

  it('reports the unauthenticated GitHub limit when no token is set', () => {
    const modes = deriveEffectiveModes(parseConfig({}));
    const gh = modes.degradations.find((d) => d.subsystem === 'github');
    expect(gh?.effective).toContain('60 req/hour');
    // .atom watching is the primary mechanism and needs no token — the degradation
    // note must not imply ingestion is broken.
    expect(gh?.because).toContain('.atom');
  });

  it('reports the console fallback when no ntfy topic is set', () => {
    const modes = deriveEffectiveModes(parseConfig({}));
    expect(modes.degradations.find((d) => d.subsystem === 'alerts')?.effective).toContain(
      'console',
    );
  });

  it('flags any mock mode for the dashboard badge', () => {
    expect(isAnyModeMocked(deriveEffectiveModes(parseConfig({})))).toBe(true);

    const allLive = deriveEffectiveModes(
      parseConfig({
        DATA_MODE: 'LIVE',
        AI_MODE: 'LIVE',
        X_MODE: 'LIVE',
        ANTHROPIC_API_KEY: 'sk-ant-api03-abcdefghijklmnop',
        X_API_KEY: 'a',
        X_API_SECRET: 'b',
        X_ACCESS_TOKEN: 'c',
        X_ACCESS_TOKEN_SECRET: 'd',
      }),
    );
    expect(isAnyModeMocked(allLive)).toBe(false);
  });
});

describe('helpers', () => {
  it('strips the file: prefix and passes other URLs through', () => {
    expect(databaseFilePath('file:./data/signal-desk.db')).toBe('./data/signal-desk.db');
    expect(databaseFilePath('postgres://localhost/sd')).toBe('postgres://localhost/sd');
  });

  it('masks a secret to first four and last four characters', () => {
    expect(maskSecret('sk-ant-api03-abcdefgh-wxyz')).toBe('sk-a…wxyz');
    expect(maskSecret(undefined)).toBe('(not set)');
    expect(maskSecret('short')).toBe('****');
  });
});
