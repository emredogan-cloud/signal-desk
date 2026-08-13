import { createHash } from 'node:crypto';

/**
 * The publishing confirmation control. **`THREAT-MODEL.md` §T-4.**
 *
 * > "**No autonomous publishing, ever, in any phase covered by this plan.** Publishing
 * > requires an explicit human action per post. **This is a design property, not a
 * > setting.**"
 *
 * That last sentence is the specification for this module. A setting can be flipped;
 * a design property cannot. So the guarantee here is structural rather than
 * conditional: **there is no code path that sends a post without a confirmation token
 * derived from the exact bytes a human was shown.**
 *
 * ## How the token makes it structural
 *
 * `prepare()` returns the exact bytes and a token that is a hash of those bytes.
 * `authorise()` accepts a post only if the operator returns a token matching the bytes
 * being sent. A caller that skips the display step has no way to produce a valid
 * token, so "forgot to confirm" and "deliberately bypassed" both fail closed.
 *
 * This also closes the substitution gap: if anything alters the text between display
 * and send — a bug, a race, a compromised analysis — the hash no longer matches and
 * the send is refused. The operator confirmed *those bytes*, not "a post".
 *
 * ## What is deliberately absent
 *
 * There is no `postNow`, no `autoPublish`, no scheduler, and no retry that re-sends.
 * A retry would be a second send the operator confirmed once, and §T-4's whole point
 * is that authorisation is per-post rather than per-intent.
 */

export class PublishRefused extends Error {
  constructor(
    message: string,
    readonly code:
      'posting_disabled' | 'token_mismatch' | 'daily_limit' | 'rate_limit' | 'empty' | 'too_long',
  ) {
    super(message);
    this.name = 'PublishRefused';
  }
}

/** X's limit for a standard post. Below any published ceiling, per §T-4. */
export const MAX_POST_CHARS = 280;

export type PreparedPost = {
  /** The EXACT bytes that would be sent. Displayed verbatim, never summarised. */
  readonly text: string;
  /** Hash of those bytes. The operator's confirmation is bound to this. */
  readonly token: string;
  readonly charCount: number;
  /** Everything the operator should read before confirming. */
  readonly review: {
    readonly eventId: number | undefined;
    readonly claims: readonly string[];
    readonly doNotSay: readonly string[];
    readonly sources: readonly string[];
  };
};

function tokenFor(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32);
}

/**
 * Prepare a post for human review.
 *
 * Does **not** send. Cannot send. This function has no network access and returns a
 * value; sending requires a separate, explicitly authorised call.
 */
export function prepare(input: {
  readonly text: string;
  readonly eventId: number | undefined;
  readonly claims: readonly string[];
  readonly doNotSay: readonly string[];
  readonly sources: readonly string[];
}): PreparedPost {
  return {
    text: input.text,
    token: tokenFor(input.text),
    // Counted on code points rather than UTF-16 units: an emoji is one character to a
    // reader and two to `String.length`, and a count that disagrees with what the
    // platform enforces would let a "valid" post be rejected on send.
    charCount: [...input.text].length,
    review: {
      eventId: input.eventId,
      claims: input.claims,
      doNotSay: input.doNotSay,
      sources: input.sources,
    },
  };
}

export type AuthorisationContext = {
  /** `X_ENABLE_POSTING`. Necessary, never sufficient. */
  readonly postingEnabled: boolean;
  /** Posts already sent today. */
  readonly sentToday: number;
  readonly maxPerDay: number;
  /** Minutes since the last post, for the rate self-limit. */
  readonly minutesSinceLastPost: number | undefined;
  readonly minMinutesBetweenPosts: number;
};

/**
 * Authorise one post, or refuse with a reason.
 *
 * **Throws on refusal rather than returning false.** A boolean invites
 * `if (ok) send()` with an `else` branch somebody forgets to write; an exception
 * cannot be ignored by omission. For a control whose failure mode is "the account is
 * gone", failing loudly is the correct default.
 */
export function authorise(
  prepared: PreparedPost,
  confirmationToken: string,
  bytesToSend: string,
  context: AuthorisationContext,
): void {
  // ─── 1. The flag. Necessary but nowhere near sufficient.
  if (!context.postingEnabled) {
    throw new PublishRefused(
      'X_ENABLE_POSTING is not set — posting is disabled. This flag is necessary but never sufficient; a per-post human confirmation is also required.',
      'posting_disabled',
    );
  }

  if (bytesToSend.length === 0) {
    throw new PublishRefused('refusing to send an empty post', 'empty');
  }

  if ([...bytesToSend].length > MAX_POST_CHARS) {
    throw new PublishRefused(
      `post is ${String([...bytesToSend].length)} characters, over the ${String(MAX_POST_CHARS)} limit`,
      'too_long',
    );
  }

  // ─── 2. The token must match the bytes ACTUALLY being sent.
  //
  // Not the bytes that were prepared — the bytes going out. If anything changed in
  // between, the operator confirmed something else, and this is the check that
  // notices. Comparing against `prepared.text` instead would verify the wrong thing.
  const expected = tokenFor(bytesToSend);
  if (confirmationToken !== expected || prepared.token !== expected) {
    throw new PublishRefused(
      'confirmation token does not match the bytes being sent — the text changed after it was reviewed, or the confirmation step was skipped. Refusing.',
      'token_mismatch',
    );
  }

  // ─── 3. Daily ceiling.
  if (context.sentToday >= context.maxPerDay) {
    throw new PublishRefused(
      `${String(context.sentToday)} posts already sent today, at the X_MAX_POSTS_PER_DAY ceiling of ${String(context.maxPerDay)}`,
      'daily_limit',
    );
  }

  // ─── 4. Rate self-limit, set below any published platform limit.
  //
  // Not to avoid a 429 — to avoid looking automated. §T-4 lists mass automation as an
  // account-loss risk, and a burst of posts minutes apart is what that looks like.
  if (
    context.minutesSinceLastPost !== undefined &&
    context.minutesSinceLastPost < context.minMinutesBetweenPosts
  ) {
    throw new PublishRefused(
      `last post was ${context.minutesSinceLastPost.toFixed(0)} minutes ago; the self-imposed minimum is ${String(context.minMinutesBetweenPosts)} minutes. Posting faster looks automated, and §T-4 lists that as an account-loss risk.`,
      'rate_limit',
    );
  }
}

/**
 * The exact block the operator reads before confirming.
 *
 * Shows the bytes verbatim inside markers, so trailing whitespace and invisible
 * characters are visible rather than trimmed away by a renderer. A confirmation
 * screen that tidies the text is showing something other than what will be sent.
 */
export function renderForConfirmation(prepared: PreparedPost): string {
  const lines = [
    '─'.repeat(72),
    'REVIEW BEFORE SENDING — these are the exact bytes that will be posted',
    '─'.repeat(72),
    '',
    `>>>${prepared.text}<<<`,
    '',
    `${String(prepared.charCount)}/${String(MAX_POST_CHARS)} characters`,
    '',
  ];

  if (prepared.review.claims.length > 0) {
    lines.push('CLAIMS MADE (each must be supported by the evidence below):');
    for (const claim of prepared.review.claims) lines.push(`  · ${claim}`);
    lines.push('');
  }

  if (prepared.review.doNotSay.length > 0) {
    lines.push('DO NOT SAY — check the text above against every line:');
    for (const item of prepared.review.doNotSay) lines.push(`  ✗ ${item}`);
    lines.push('');
  }

  if (prepared.review.sources.length > 0) {
    lines.push('EVIDENCE:');
    for (const source of prepared.review.sources) lines.push(`  · ${source}`);
    lines.push('');
  }

  lines.push(`CONFIRMATION TOKEN: ${prepared.token}`);
  lines.push('');
  lines.push('Nothing is sent unless this token is passed back with the identical text.');
  lines.push('─'.repeat(72));

  return lines.join('\n');
}
