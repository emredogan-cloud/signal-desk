/**
 * A minimal `.env` parser.
 *
 * Node's own `process.loadEnvFile()` covers the common case, but it mutates
 * `process.env`. `pnpm check:env --ci` needs to parse `.env.example` *in isolation*
 * to prove the committed template still satisfies the schema — mutating the real
 * environment to do that would make the check depend on what was already set.
 *
 * Deliberately small. THREAT-MODEL.md §T-5 counts a dependency as a cost, and this
 * is thirty lines against a package with a transitive tree.
 */

export type DotenvRecord = Record<string, string>;

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;

export function parseDotenv(contents: string): DotenvRecord {
  const out: DotenvRecord = {};

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const match = LINE.exec(rawLine);
    if (match === null) continue;

    const key = match[1];
    let value = match[2] ?? '';
    if (key === undefined) continue;

    // Quoted values keep their inline '#'; unquoted values treat it as a comment,
    // which is what every .env implementation and every reader expects.
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') {
        value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\"/g, '"');
      }
    } else {
      const commentAt = value.indexOf(' #');
      if (commentAt !== -1) value = value.slice(0, commentAt).trimEnd();
    }

    out[key] = value;
  }

  return out;
}

/** The variable names declared in a `.env` template, in file order. */
export function dotenvKeys(contents: string): string[] {
  return Object.keys(parseDotenv(contents));
}
