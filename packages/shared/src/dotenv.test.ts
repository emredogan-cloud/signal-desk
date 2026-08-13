import { describe, it, expect } from 'vitest';
import { parseDotenv, dotenvKeys } from './dotenv.js';

describe('parseDotenv', () => {
  it('parses simple assignments', () => {
    expect(parseDotenv('DATA_MODE=MOCK\nLOG_LEVEL=info')).toEqual({
      DATA_MODE: 'MOCK',
      LOG_LEVEL: 'info',
    });
  });

  it('keeps blank values blank rather than dropping the key', () => {
    // `.env.example` ships every credential as `KEY=`. The key must still be
    // declared — that is what the schema-drift check compares against.
    expect(parseDotenv('ANTHROPIC_API_KEY=')).toEqual({ ANTHROPIC_API_KEY: '' });
  });

  it('ignores comments and blank lines', () => {
    const contents = ['# a heading', '', 'DATA_MODE=MOCK', '   # indented comment', ''].join('\n');
    expect(parseDotenv(contents)).toEqual({ DATA_MODE: 'MOCK' });
  });

  it('strips a trailing inline comment from an unquoted value', () => {
    expect(parseDotenv('DATA_MODE=MOCK              # MOCK | LIVE')).toEqual({
      DATA_MODE: 'MOCK',
    });
  });

  it('preserves a # inside a quoted value', () => {
    expect(parseDotenv('NTFY_TOPIC="topic#with-hash"')).toEqual({
      NTFY_TOPIC: 'topic#with-hash',
    });
  });

  it('strips matching quotes and unescapes double-quoted sequences', () => {
    expect(parseDotenv('A="x\\ny"\nB=\'literal\\n\'')).toEqual({ A: 'x\ny', B: 'literal\\n' });
  });

  it('accepts the export prefix', () => {
    expect(parseDotenv('export DATA_MODE=LIVE')).toEqual({ DATA_MODE: 'LIVE' });
  });

  it('tolerates CRLF line endings', () => {
    expect(parseDotenv('DATA_MODE=MOCK\r\nAI_MODE=MOCK\r\n')).toEqual({
      DATA_MODE: 'MOCK',
      AI_MODE: 'MOCK',
    });
  });

  it('ignores malformed lines instead of throwing', () => {
    // A hand-edited .env with a stray line should degrade to "that line is ignored",
    // not "the process will not start".
    expect(parseDotenv('this is not an assignment\nDATA_MODE=MOCK')).toEqual({
      DATA_MODE: 'MOCK',
    });
  });

  it('takes the last assignment when a key repeats', () => {
    expect(parseDotenv('LOG_LEVEL=info\nLOG_LEVEL=debug')).toEqual({ LOG_LEVEL: 'debug' });
  });

  it('reports keys in file order', () => {
    expect(dotenvKeys('B=2\nA=1\nC=3')).toEqual(['B', 'A', 'C']);
  });
});
