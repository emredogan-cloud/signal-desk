/**
 * Rendering untrusted content safely.
 *
 * `ROADMAP.md` Phase 10: "Security: CSP, **no `dangerouslySetInnerHTML`**, external
 * link hosts shown as text". `THREAT-MODEL.md` §T-7 is the reason.
 *
 * Every string on this dashboard originated on the public internet. React escapes
 * text by default, so the XSS surface is not `{title}` — it is the two places where a
 * developer reaches past React's escaping:
 *
 *   1. `dangerouslySetInnerHTML`, which does not appear anywhere in this app.
 *   2. `href={url}`, where a `javascript:` URL executes on click despite escaping.
 *
 * The second is the one that looks safe and is not, which is why links go through
 * `SafeLink` rather than being written inline.
 */

/** URL schemes that are safe to put in an `href`. Everything else is rendered as text. */
const SAFE_SCHEMES = new Set(['http:', 'https:']);

export function hostOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return SAFE_SCHEMES.has(parsed.protocol) ? parsed.host : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A link that shows its destination host as text and refuses unsafe schemes.
 *
 * Showing the host is a phishing control, not decoration: an ingested item can title
 * itself "Official Anthropic announcement" while linking anywhere, and the operator
 * clicking through deserves to see where it actually goes before he does.
 */
export function SafeLink({ url, children }: { url: string; children?: React.ReactNode }) {
  const host = hostOf(url);

  if (host === undefined) {
    // A javascript:, data:, or malformed URL renders as inert text. Not silently
    // dropped — a link the system refused to make clickable is itself informative.
    return (
      <span className="unsafe-link" title="link scheme refused">
        {children ?? url} <span className="host">[unsafe link]</span>
      </span>
    );
  }

  return (
    <a href={url} rel="noopener noreferrer nofollow" target="_blank">
      {children ?? url} <span className="host">{host}</span>
    </a>
  );
}
