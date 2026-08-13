/**
 * Secret redaction for logs. THREAT-MODEL.md §5 test 4:
 *
 *   "A synthetic key planted in a fixture is caught by gitleaks and never appears in
 *    logs (log redaction test over the logger)."
 *
 * Two mechanisms, because either alone is insufficient:
 *
 *  1. **Pattern matching** catches credentials the process never knew it held — a key
 *     echoed back inside an upstream error body, a token pasted into a feed item.
 *  2. **Registered values** catch credentials with no distinctive shape. X's four
 *     OAuth values look like ordinary alphanumeric strings; no regex finds them.
 *     Config registers them at startup, and from then on they cannot be printed.
 */

export const REDACTED = '[REDACTED]';

/**
 * Well-known credential shapes. Ordered longest-prefix-first where prefixes overlap
 * (`sk-ant-` before `sk-`) so the more specific pattern wins.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{16,}/g, // Anthropic
  /\bghp_[A-Za-z0-9]{20,}/g, // GitHub personal access token (classic)
  /\bgho_[A-Za-z0-9]{20,}/g, // GitHub OAuth
  /\bghu_[A-Za-z0-9]{20,}/g, // GitHub user-to-server
  /\bghs_[A-Za-z0-9]{20,}/g, // GitHub server-to-server
  /\bghr_[A-Za-z0-9]{20,}/g, // GitHub refresh
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained PAT
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bsk-[A-Za-z0-9_-]{20,}/g, // generic OpenAI-style key
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, // Authorization header value
];

/** Header/field names whose value is a credential regardless of its shape. */
const SENSITIVE_KEY_PATTERN =
  /^(authorization|x-api-key|api[_-]?key|token|access[_-]?token|refresh[_-]?token|secret|client[_-]?secret|password|passwd|cookie|set-cookie|session|ntfy[_-]?topic)$/i;

const registeredSecrets = new Set<string>();

/**
 * Mark a literal value as unloggable for the lifetime of the process.
 *
 * Short values are ignored deliberately: registering a 3-character string would
 * replace every occurrence of those characters everywhere and make logs unreadable
 * while giving the false impression that redaction is working.
 */
export function registerSecret(value: string | undefined): void {
  if (value === undefined) return;
  const trimmed = value.trim();
  if (trimmed.length < 8) return;
  registeredSecrets.add(trimmed);
}

/** Test-only. Production code has no reason to un-register a secret. */
export function clearRegisteredSecrets(): void {
  registeredSecrets.clear();
}

export function registeredSecretCount(): number {
  return registeredSecrets.size;
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Replace every known credential in a string with [REDACTED]. */
export function scrubString(input: string): string {
  let out = input;
  for (const secret of registeredSecrets) {
    if (out.includes(secret)) {
      out = out.replaceAll(secret, REDACTED);
    }
  }
  for (const pattern of SECRET_PATTERNS) {
    // Patterns are module-level and carry /g, so lastIndex must not leak between calls.
    pattern.lastIndex = 0;
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

const MAX_DEPTH = 8;

/**
 * Recursively scrub any value about to be logged.
 *
 * Depth-capped and cycle-safe: a logger that throws or hangs on a self-referential
 * object turns an observability feature into an outage.
 */
export function scrubValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return scrubString(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[depth-limit]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((v) => scrubValue(v, depth + 1, seen));
  }

  if (value instanceof Error) {
    const scrubbed: Record<string, unknown> = {
      name: value.name,
      message: scrubString(value.message),
    };
    if (typeof value.stack === 'string') scrubbed.stack = scrubString(value.stack);
    if (value.cause !== undefined) scrubbed.cause = scrubValue(value.cause, depth + 1, seen);
    return scrubbed;
  }

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : scrubValue(val, depth + 1, seen);
  }
  return out;
}

/** True if the text still contains something that looks like a credential. */
export function containsSecret(text: string): boolean {
  for (const secret of registeredSecrets) {
    if (text.includes(secret)) return true;
  }
  return SECRET_PATTERNS.some((p) => {
    p.lastIndex = 0;
    return p.test(text);
  });
}

/** Exported for the redaction test suite, which asserts against real key shapes. */
export const __testing = { SECRET_PATTERNS, SENSITIVE_KEY_PATTERN, escapeRegExp };
