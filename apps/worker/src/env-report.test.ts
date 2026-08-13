import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseConfig } from '@signal-desk/shared';
import { validateEnvExample, renderEnvReport, ALL_CONFIG_KEYS } from './env-report.js';
import { findRepoRoot } from './repo-root.js';

const REPO_ROOT = findRepoRoot();
const ENV_EXAMPLE = readFileSync(resolve(REPO_ROOT, '.env.example'), 'utf8');

describe('the committed .env.example', () => {
  it('validates against the configuration schema', () => {
    // This is the `pnpm check:env --ci` gate, run as a unit test so that a schema
    // change which forgets the template fails locally rather than in CI.
    expect(validateEnvExample(ENV_EXAMPLE)).toEqual([]);
  });

  it('declares exactly the variables the schema knows about', () => {
    const problems = validateEnvExample(ENV_EXAMPLE);
    expect(problems.filter((p) => p.includes('missing variables'))).toEqual([]);
    expect(problems.filter((p) => p.includes('does not know'))).toEqual([]);
  });

  it('contains no credential values', () => {
    // THREAT-MODEL.md §T-3. The one assertion in this file that protects asset A3.
    for (const line of ENV_EXAMPLE.split('\n')) {
      const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (match === null) continue;
      const [, key = '', rawValue = ''] = match;
      const value = rawValue.split(' #')[0]?.trim() ?? '';
      if (/KEY|SECRET|TOKEN|TOPIC/.test(key)) {
        expect(value, `${key} must ship blank`).toBe('');
      }
    }
  });
});

describe('validateEnvExample catches drift', () => {
  it('rejects a template missing a schema variable', () => {
    const problems = validateEnvExample('DATA_MODE=MOCK\nAI_MODE=MOCK\n');
    expect(problems.some((p) => p.includes('missing variables'))).toBe(true);
  });

  it('rejects a template declaring an unknown variable', () => {
    const problems = validateEnvExample(`${ENV_EXAMPLE}\nSOME_REMOVED_VARIABLE=1\n`);
    expect(problems.some((p) => p.includes('SOME_REMOVED_VARIABLE'))).toBe(true);
  });

  it('rejects a template that ships a real credential', () => {
    // A repeated-character payload: the right vendor shape, zero entropy, so
    // .gitleaks.toml reads it as a fixture rather than a credential.
    const leaked = ENV_EXAMPLE.replace(
      'ANTHROPIC_API_KEY=',
      'ANTHROPIC_API_KEY=sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    expect(validateEnvExample(leaked).some((p) => p.includes('ANTHROPIC_API_KEY'))).toBe(true);
  });

  it('rejects a template that defaults a mode to LIVE', () => {
    const live = ENV_EXAMPLE.replace('DATA_MODE=MOCK', 'DATA_MODE=LIVE');
    expect(validateEnvExample(live).some((p) => p.includes('all-MOCK') || p.includes('MOCK'))).toBe(
      true,
    );
  });

  it('rejects a template that enables posting', () => {
    const posting = ENV_EXAMPLE.replace('X_ENABLE_POSTING=false', 'X_ENABLE_POSTING=true');
    expect(validateEnvExample(posting).some((p) => p.includes('X_ENABLE_POSTING'))).toBe(true);
  });
});

describe('renderEnvReport', () => {
  it('lists every configuration variable', () => {
    const report = renderEnvReport({
      config: parseConfig({}),
      present: new Set(),
      dotenvFound: false,
    });

    for (const key of ALL_CONFIG_KEYS) {
      expect(report, `${key} must appear in the report`).toContain(key);
    }
  });

  it('reports all-MOCK with no .env present', () => {
    // ROADMAP.md Phase 1 acceptance: "pnpm check:env correctly reports all-MOCK with
    // no .env present."
    const report = renderEnvReport({
      config: parseConfig({}),
      present: new Set(),
      dotenvFound: false,
    });

    expect(report).toContain('DATA_MODE  MOCK');
    expect(report).toContain('AI_MODE    MOCK');
    expect(report).toContain('X_MODE     MOCK');
    expect(report).toContain('not present (defaults apply)');
  });

  it('masks a configured secret rather than printing it', () => {
    const key = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz';
    const report = renderEnvReport({
      config: parseConfig({ ANTHROPIC_API_KEY: key }),
      present: new Set(['ANTHROPIC_API_KEY']),
      dotenvFound: true,
    });

    expect(report).not.toContain(key);
    expect(report).toContain('sk-a…wxyz');
  });

  it('names each degraded subsystem and the reason', () => {
    const report = renderEnvReport({
      config: parseConfig({ AI_MODE: 'LIVE' }),
      present: new Set(['AI_MODE']),
      dotenvFound: true,
    });

    expect(report).toContain('[ai]');
    expect(report).toContain('ANTHROPIC_API_KEY');
  });

  it('warns that an unset key does not prove the absence of credentials', () => {
    // ENV-HANDBOOK.md §3 — the SDK can authenticate from a profile on disk.
    const report = renderEnvReport({
      config: parseConfig({}),
      present: new Set(),
      dotenvFound: false,
    });
    expect(report).toContain('ant auth status');
  });
});
