import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { RawItem } from './types.js';

/**
 * Feed parsing, shared by every feed-shaped adapter.
 *
 * RSS 2.0, Atom, and RDF/RSS 1.0 differ in element names and in almost nothing else
 * that matters here. Four near-identical parsers would be four places for the same
 * bug, so there is one, and the adapters differ where they actually differ:
 * in what a "source" means and in how the item's identity is derived.
 */

export const feedParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // A one-item feed must still parse to an array of length 1, or the count silently
  // depends on how busy the publisher was that day.
  isArray: (name) => name === 'item' || name === 'entry' || name === 'link',
  processEntities: true,
  htmlEntities: true,
  trimValues: true,
});

export const HTML_SNIFF = /^\s*(?:<!doctype\s+html|<html[\s>])/i;

export type XmlNode = Record<string, unknown>;

export function asNode(value: unknown): XmlNode | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as XmlNode)
    : undefined;
}

/**
 * Read a scalar out of a node that may be a scalar, `{ '#text': … }`, or an array.
 *
 * fast-xml-parser returns whichever of those the document happened to produce, and
 * treating one shape as the only shape is how a title becomes `[object Object]` in
 * production while every test passes.
 */
export function text(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() === '' ? undefined : value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = text(entry);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const node = asNode(value);
  if (node !== undefined) return text(node['#text']);
  return undefined;
}

/** The first present field, in preference order. */
function firstText(node: XmlNode, fields: readonly string[]): string | undefined {
  for (const field of fields) {
    const found = text(node[field]);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Atom `<link>` is an element with attributes, and a feed usually carries several —
 * `alternate`, `self`, `replies`, `enclosure`. Picking the first one gives you the
 * feed's own URL surprisingly often, which makes every item in that feed look like
 * the same item to a URL-keyed deduplicator.
 */
function atomLink(value: unknown): string | undefined {
  const candidates = Array.isArray(value) ? value : [value];
  let fallback: string | undefined;

  for (const candidate of candidates) {
    const node = asNode(candidate);
    if (node === undefined) {
      const plain = text(candidate);
      if (plain !== undefined) fallback ??= plain;
      continue;
    }
    const href = text(node['@_href']);
    if (href === undefined) continue;
    const rel = text(node['@_rel']);
    if (rel === undefined || rel === 'alternate') return href;
    fallback ??= href;
  }

  return fallback;
}

const DATE_FIELDS = ['pubDate', 'published', 'updated', 'dc:date', 'date'] as const;

export function parseDate(node: XmlNode): Date | undefined {
  for (const field of DATE_FIELDS) {
    const raw = text(node[field]);
    if (raw === undefined) continue;
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return undefined;
}

function parseAuthor(node: XmlNode): string | undefined {
  const direct = firstText(node, ['dc:creator', 'author', 'creator']);
  if (direct !== undefined) return direct;

  // Atom: <author><name>…</name></author>
  const author = asNode(node.author);
  return author === undefined ? undefined : text(author.name);
}

/**
 * Stage-1 content hashing lives in `@signal-desk/core` so that ingestion and
 * clustering compute the same value from the same code. Two implementations that
 * drift apart would silently stop deduplicating, and nothing would report it.
 */
import { contentHashFor } from '@signal-desk/core';
export { contentHashFor as contentHash };

export type ParsedFeed = {
  readonly items: readonly RawItem[];
  /** Set when the document is not well-formed but items were still recovered. */
  readonly warning: string | undefined;
};

export class NotAFeedError extends Error {}
export class EmptyFeedError extends Error {}

/**
 * Parse a feed body into items.
 *
 * Throws `NotAFeedError` / `EmptyFeedError` rather than returning a status, because
 * every caller has to handle those two cases distinctly anyway and a union return
 * would just move the switch.
 */
export function parseFeed(sourceId: string, body: string): ParsedFeed {
  if (HTML_SNIFF.test(body)) {
    throw new NotAFeedError('200 with an HTML body — this URL is a web page, not a feed');
  }

  let parsed: unknown;
  try {
    parsed = feedParser.parse(body) as unknown;
  } catch (error) {
    throw new NotAFeedError(
      `XML parse failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const nodes = extractItemNodes(parsed);
  if (nodes === undefined) {
    throw new NotAFeedError(
      xmlFault(body) ?? 'parsed as XML but has neither an <rss><channel> nor an Atom <feed> root',
    );
  }

  if (nodes.length === 0) {
    const fault = xmlFault(body);
    if (fault !== undefined) throw new NotAFeedError(fault);
    throw new EmptyFeedError('feed parsed but contains zero items');
  }

  const items = nodes
    .map((node) => toRawItem(sourceId, node))
    .filter((i): i is RawItem => i !== undefined);

  if (items.length === 0) {
    throw new EmptyFeedError('feed contains items, but none had both a title and a URL');
  }

  return { items, warning: xmlFault(body) };
}

/** `undefined` when well-formed, otherwise a description of the fault. */
export function xmlFault(body: string): string | undefined {
  const validation = XMLValidator.validate(body, { allowBooleanAttributes: true });
  if (validation === true) return undefined;
  return `malformed XML at line ${String(validation.err.line)}: ${validation.err.msg}`;
}

/** Returns the item nodes, or undefined when this is not a recognisable feed. */
export function extractItemNodes(parsed: unknown): XmlNode[] | undefined {
  const root = asNode(parsed);
  if (root === undefined) return undefined;

  const rss = asNode(root.rss);
  if (rss !== undefined) {
    const channel = asNode(rss.channel);
    if (channel === undefined) return [];
    return toNodeArray(channel.item);
  }

  const feed = asNode(root.feed);
  if (feed !== undefined) return toNodeArray(feed.entry);

  const rdf = asNode(root['rdf:RDF']) ?? asNode(root.RDF);
  if (rdf !== undefined) return toNodeArray(rdf.item);

  return undefined;
}

function toNodeArray(value: unknown): XmlNode[] {
  if (!Array.isArray(value)) {
    const single = asNode(value);
    return single === undefined ? [] : [single];
  }
  return value.map(asNode).filter((n): n is XmlNode => n !== undefined);
}

function toRawItem(sourceId: string, node: XmlNode): RawItem | undefined {
  const title = firstText(node, ['title']) ?? '';
  const url = firstText(node, ['link']) ?? atomLink(node.link) ?? firstText(node, ['guid', 'id']);

  // An item with no URL cannot be evidence, cannot be linked from the dashboard, and
  // cannot be deduplicated by URL. Dropping it is better than storing a stub.
  if (url === undefined || title === '') return undefined;

  const body =
    firstText(node, ['content:encoded', 'content', 'description', 'summary', 'subtitle']) ?? '';

  // Prefer the publisher's own id. Falling back to the URL is safe because the
  // uniqueness constraint is (source_id, external_id), and a feed that omits guids
  // is almost always one whose links are stable.
  const externalId = firstText(node, ['guid', 'id']) ?? url;

  return {
    sourceId,
    externalId,
    url,
    title,
    body,
    author: parseAuthor(node),
    publishedAt: parseDate(node),
    contentHash: contentHashFor({ title, url, body }),
    rawPayload: JSON.stringify(node),
  };
}
