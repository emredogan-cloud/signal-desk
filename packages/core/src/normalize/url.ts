/**
 * URL canonicalisation. Deduplication **stage 1** (ARCHITECTURE.md §5).
 *
 * The same article reaches this system through several URLs: with UTM parameters
 * from a newsletter, with a trailing slash from one feed and without from another,
 * through `feedproxy` wrappers, with `?ref=` appended by an aggregator. Stage 1 costs
 * approximately nothing and catches all of it, which is what keeps the expensive
 * stages small.
 */

/**
 * Query parameters that never identify content.
 *
 * Removed rather than kept because they are how one article becomes nine rows.
 * Anything not on this list is preserved — `?id=` and `?p=` genuinely identify
 * content on some publishers, and stripping unknown parameters would merge distinct
 * articles, which is the failure that *hides* an event.
 */
const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'utm_name',
  'utm_reader',
  'utm_brand',
  'utm_social',
  'utm_social-type',
  'ref',
  'referer',
  'referrer',
  'source',
  'src',
  'fbclid',
  'gclid',
  'dclid',
  'gbraid',
  'wbraid',
  'msclkid',
  'twclid',
  'igshid',
  'mc_cid',
  'mc_eid',
  'yclid',
  '_hsenc',
  '_hsmi',
  'hsCtaTracking',
  'vero_conv',
  'vero_id',
  'wt_zmc',
  'at_medium',
  'at_campaign',
  'oly_anon_id',
  'oly_enc_id',
  'spm',
  'share',
  'sharetype',
  'trk',
  'trkCampaign',
  'cmpid',
  'campaign_id',
  'CMP',
  'ncid',
  'sr_share',
  'guccounter',
  'guce_referrer',
  'guce_referrer_sig',
]);

/** Hosts whose only job is to wrap someone else's URL. */
const REDIRECT_WRAPPERS = new Set([
  'feedproxy.google.com',
  'news.google.com',
  'out.reddit.com',
  't.co',
  'lnkd.in',
  'href.li',
]);

/**
 * Canonicalise a URL for comparison.
 *
 * Returns the input unchanged if it cannot be parsed — a URL this function cannot
 * understand is still a usable dedup key as an opaque string, and throwing here
 * would drop a real item over a formatting quirk.
 */
export function canonicalizeUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return input.trim();
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return input.trim();

  // Unwrap a redirect wrapper if it carries the real URL in a parameter.
  if (REDIRECT_WRAPPERS.has(url.hostname.toLowerCase())) {
    for (const key of ['url', 'u', 'q', 'target']) {
      const wrapped = url.searchParams.get(key);
      if (wrapped !== null && /^https?:\/\//i.test(wrapped)) {
        return canonicalizeUrl(wrapped);
      }
    }
  }

  // Scheme and host are compared case-insensitively; the path is not, because some
  // publishers do serve case-sensitive paths.
  url.protocol = 'https:';
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
  url.hash = '';
  url.port = '';
  url.username = '';
  url.password = '';

  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key) || key.toLowerCase().startsWith('utm_')) {
      url.searchParams.delete(key);
    }
  }
  // Stable parameter order, so `?a=1&b=2` and `?b=2&a=1` are one key.
  url.searchParams.sort();

  // Trailing slash on a non-root path: publishers are inconsistent, readers are not.
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.slice(0, -1);
  }

  let result = url.toString();
  if (result.endsWith('?')) result = result.slice(0, -1);
  return result;
}

/** The registrable-ish host, for "is this the same publisher" comparisons. */
export function urlHost(input: string): string | undefined {
  try {
    return new URL(input).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

export function sameCanonicalUrl(a: string, b: string): boolean {
  return canonicalizeUrl(a) === canonicalizeUrl(b);
}
