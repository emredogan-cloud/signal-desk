import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * SSRF defence. THREAT-MODEL.md §T-6.
 *
 * Feeds contain attacker-controlled URLs. From this phase the system follows some of
 * them, so the fetcher needs to be unable to be pointed at anything internal.
 *
 * Two independent controls, because either alone leaks:
 *
 *  1. **Host allowlist**, derived from the source registry. The fetcher will not
 *     retrieve an arbitrary URL discovered inside content — only hosts the operator
 *     put in the registry, plus explicitly permitted enrichment hosts.
 *  2. **Post-resolution address checking.** An allowlisted or attacker-chosen
 *     hostname can still resolve to `127.0.0.1` or `169.254.169.254`. Names are
 *     checked, then *addresses* are checked, and the check is repeated on every
 *     redirect hop — a 302 into the metadata service is the classic bypass.
 */

export class SsrfBlockedError extends Error {
  readonly url: string;
  readonly reason: string;
  constructor(url: string, reason: string) {
    super(`refusing to fetch ${url}: ${reason}`);
    this.name = 'SsrfBlockedError';
    this.url = url;
    this.reason = reason;
  }
}

/** IPv4 ranges that must never be fetched, as [network, prefix length]. */
const BLOCKED_V4: readonly (readonly [string, number])[] = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // RFC1918 private
  ['100.64.0.0', 10], // RFC6598 carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local — includes 169.254.169.254, the cloud metadata endpoint
  ['172.16.0.0', 12], // RFC1918 private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.168.0.0', 16], // RFC1918 private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, includes 255.255.255.255
];

function v4ToInt(address: string): number | undefined {
  const parts = address.split('.');
  if (parts.length !== 4) return undefined;

  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    value = value * 256 + octet;
  }
  return value;
}

function isBlockedV4(address: string): boolean {
  const value = v4ToInt(address);
  if (value === undefined) return true; // unparseable → refuse

  return BLOCKED_V4.some(([network, prefix]) => {
    const base = v4ToInt(network);
    if (base === undefined) return false;
    const mask = prefix === 0 ? 0 : (-1 << (32 - prefix)) >>> 0;
    return (value & mask) >>> 0 === (base & mask) >>> 0;
  });
}

function isBlockedV6(address: string): boolean {
  const normalised = address.toLowerCase().split('%')[0] ?? '';

  // IPv4-mapped (::ffff:127.0.0.1) and IPv4-compatible forms must be unwrapped and
  // judged as IPv4, or every private range is reachable through a v6 literal.
  const mapped = /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(normalised);
  if (mapped?.[1] !== undefined) return isBlockedV4(mapped[1]);

  if (normalised === '::1' || normalised === '::') return true;
  if (/^f[cd]/.test(normalised)) return true; // fc00::/7 unique-local
  if (/^fe[89ab]/.test(normalised)) return true; // fe80::/10 link-local
  if (normalised.startsWith('ff')) return true; // ff00::/8 multicast

  return false;
}

/** True when this literal address must never be connected to. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isBlockedV4(address);
  if (family === 6) return isBlockedV6(address);
  return true; // not an IP at all → refuse rather than guess
}

export type DnsResolver = (hostname: string) => Promise<string[]>;

/** Default resolver: every address the OS would connect to, not just the first. */
export const systemResolver: DnsResolver = async (hostname) => {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((r) => r.address);
};

export type UrlGuardOptions = {
  /**
   * Hosts this fetcher may contact. Derived from the source registry.
   * `undefined` disables the allowlist — correct for `sources:probe`, which is
   * *checking* the registry, and wrong for anything that follows content URLs.
   */
  readonly allowedHosts?: ReadonlySet<string> | undefined;
  readonly resolver?: DnsResolver | undefined;
};

/**
 * Throw unless this URL is safe to fetch. Called for the initial URL and again for
 * every redirect target.
 */
export async function assertFetchable(url: string, options: UrlGuardOptions = {}): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SsrfBlockedError(url, 'not a valid absolute URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SsrfBlockedError(url, `scheme "${parsed.protocol}" is not http or https`);
  }

  // URL keeps IPv6 literals in brackets; the resolver and the range checks do not.
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');

  if (hostname === '') {
    throw new SsrfBlockedError(url, 'no hostname');
  }

  if (options.allowedHosts !== undefined && !options.allowedHosts.has(parsed.hostname)) {
    throw new SsrfBlockedError(
      url,
      `host "${parsed.hostname}" is not in the registry-derived allowlist`,
    );
  }

  // A literal address needs no DNS and must be judged directly.
  if (isIP(hostname) !== 0) {
    if (isBlockedAddress(hostname)) {
      throw new SsrfBlockedError(url, `address ${hostname} is in a blocked range`);
    }
    return;
  }

  const resolve = options.resolver ?? systemResolver;
  let addresses: string[];
  try {
    addresses = await resolve(hostname);
  } catch (error) {
    throw new SsrfBlockedError(
      url,
      `DNS resolution failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (addresses.length === 0) {
    throw new SsrfBlockedError(url, 'DNS returned no addresses');
  }

  // EVERY address must be safe, not just the first. A hostname that resolves to one
  // public and one private address is a DNS-rebinding primitive, and which one the
  // socket picks is not ours to predict.
  for (const address of addresses) {
    if (isBlockedAddress(address)) {
      throw new SsrfBlockedError(url, `${hostname} resolves to ${address}, which is blocked`);
    }
  }
}

/** Build the allowlist from registered source URLs. */
export function allowlistFromUrls(urls: Iterable<string>): Set<string> {
  const hosts = new Set<string>();
  for (const url of urls) {
    try {
      hosts.add(new URL(url).hostname);
    } catch {
      // A malformed registry URL is a seed-integrity problem, caught by its own
      // test. Silently skipping here would be wrong; failing here would take down
      // ingestion for every other source. It is skipped and the seed test is the
      // control.
      continue;
    }
  }
  return hosts;
}
