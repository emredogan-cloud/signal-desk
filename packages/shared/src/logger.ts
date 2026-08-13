import pino, { type Logger, type LoggerOptions } from 'pino';
import { scrubValue } from './redact.js';

/**
 * Structured JSON logging. ARCHITECTURE.md §9.
 *
 * Every log line passes through the redactor before it is written. This is a
 * security control, not a convenience: THREAT-MODEL.md §T-3 lists API credentials as
 * asset A3, and an upstream 401 body that echoes the key back is the realistic way
 * one ends up in a log file.
 */

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

export type CreateLoggerOptions = {
  readonly level?: LogLevel;
  readonly name?: string;
  /** Test seam. Anything writable; defaults to stdout. */
  readonly destination?: { write(chunk: string): void };
};

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const pinoOptions: LoggerOptions = {
    level: options.level ?? 'info',
    base: options.name !== undefined ? { name: options.name } : {},
    // Structural redaction by path, as a second line of defence behind the hook.
    redact: {
      paths: [
        'authorization',
        'cookie',
        'token',
        'secret',
        'password',
        '*.authorization',
        '*.cookie',
        '*.token',
        '*.secret',
        '*.password',
        'headers.authorization',
        'headers.cookie',
        'req.headers.authorization',
        'res.headers["set-cookie"]',
      ],
      censor: '[REDACTED]',
      remove: false,
    },
    hooks: {
      logMethod(inputArgs, method) {
        // Scrub message strings and merged objects alike. Called once per log line;
        // at this system's volume (~800 items/day) the cost is irrelevant next to
        // the risk of writing a key to disk.
        const scrubbed = inputArgs.map((arg) => scrubValue(arg)) as typeof inputArgs;
        return method.apply(this, scrubbed);
      },
    },
    formatters: {
      level(label) {
        return { level: label };
      },
    },
  };

  return options.destination !== undefined
    ? pino(pinoOptions, options.destination as never)
    : pino(pinoOptions);
}

/**
 * A child logger carrying a trace id that follows one item from fetch to analysis.
 * ARCHITECTURE.md §9 — this is what makes "why didn't we detect this?" answerable.
 */
export function withTrace(logger: Logger, traceId: string): Logger {
  return logger.child({ trace_id: traceId });
}

export type { Logger };
