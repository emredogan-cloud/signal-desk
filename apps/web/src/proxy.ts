import { NextResponse, type NextRequest } from 'next/server';

/**
 * The dashboard's front door: authentication, and the per-request CSP nonce.
 *
 * ## 1. Authentication — `ARCHITECTURE.md` §11, cashed in
 *
 * > "No multi-user support. No auth beyond localhost binding until the day it is
 * > deployed remotely; at that point, a single-user session cookie, not a user system."
 *
 * 2026-08-14 is that day. Until then the only thing protecting this console was
 * `--hostname 127.0.0.1`; a public URL removes that protection completely, and what is
 * behind it is not a status page. It is the operator's unpublished analysis, his
 * content strategy, his do-not-say list, and every event he has decided not to post
 * about.
 *
 * **Why HTTP Basic and not a session cookie:** a cookie needs a login form to set it,
 * and this app's CSP is `form-action 'none'` (THREAT-MODEL §T-7) — a form post is
 * blocked by the browser before it reaches any handler. The choices were to weaken the
 * CSP for a login page or to use the scheme that needs no page at all. Fly terminates
 * TLS and `force_https` redirects, so the credential never crosses the network in the
 * clear.
 *
 * **Fail closed.** If `DASHBOARD_PASSWORD` is unset, every request is refused. The
 * alternative — "no password configured, so let everyone in" — is how a console ends up
 * public because a secret failed to propagate on one deploy.
 *
 * ## 2. The nonce — how the rebuilt dashboard got interactivity without giving up T-7
 *
 * The dashboard rebuild needs client JavaScript for the first time: copy-to-clipboard
 * on every draft is the core of the workflow, and §9 of the brief is explicit that the
 * operator must not have to select text by hand.
 *
 * The old CSP was `script-src 'self'` with no inline allowance, which is only
 * affordable for a page that ships **no** client JavaScript at all — the previous
 * dashboard's actual state. React hydration does not fit inside it: Next streams the
 * RSC payload through inline `<script>` tags, and a strict CSP blocks them with no
 * error beyond a page that silently never becomes interactive.
 *
 * The wrong fix is `'unsafe-inline'`, which would retire §T-7's central control to buy
 * a copy button. The right one is a fresh nonce per request, minted here and threaded
 * into both the CSP header and Next's own script tags. `'strict-dynamic'` then lets the
 * nonce'd bootstrap load the chunks it needs without the policy having to enumerate
 * them.
 *
 * The CSP therefore lives **here** rather than in `next.config.ts`: a nonce is
 * per-request by definition, and a static header cannot carry one.
 *
 * Two deliberate relaxations from the pre-rebuild policy, both minimal:
 *   - `connect-src` moves from `'none'` to `'self'`, because client-side navigation
 *     fetches RSC payloads from this origin. It still cannot reach any other host, so
 *     the property that mattered — hostile content has nowhere to send what it found —
 *     is unchanged.
 *   - `'unsafe-eval'` is added **in development only**, because React uses `eval` to
 *     rebuild server error stacks in the browser. Production never gets it.
 */

const REALM = 'signal-desk';

/** Constant-time comparison. No `node:crypto`, so this runs under any proxy runtime. */
function equals(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  // Length is not secret here (both are operator-chosen), but comparing unequal
  // lengths byte-wise would exit early and leak position, so fold length in instead.
  let diff = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    diff |= (left[i % left.length] ?? 0) ^ (right[i % right.length] ?? 0);
  }
  return diff === 0;
}

function buildCsp(nonce: string, isDev: boolean): string {
  return [
    // Nothing is allowed unless named below. Anything added later fails closed.
    "default-src 'none'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data:",
    "font-src 'self'",
    // Same-origin only: RSC navigation payloads, nothing else.
    "connect-src 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join('; ');
}

function unauthorised(): NextResponse {
  return new NextResponse('Authentication required.', {
    status: 401,
    headers: {
      'www-authenticate': `Basic realm="${REALM}", charset="UTF-8"`,
      'cache-control': 'no-store',
    },
  });
}

export function proxy(request: NextRequest): NextResponse {
  const expectedUser = process.env.DASHBOARD_USER ?? 'operator';
  const expectedPassword = process.env.DASHBOARD_PASSWORD;

  // Unset secret → refuse everything. See "Fail closed" above.
  if (expectedPassword === undefined || expectedPassword === '') return unauthorised();

  const header = request.headers.get('authorization');
  if (!header?.startsWith('Basic ')) return unauthorised();

  let decoded: string;
  try {
    decoded = atob(header.slice('Basic '.length));
  } catch {
    return unauthorised();
  }

  const separator = decoded.indexOf(':');
  if (separator === -1) return unauthorised();

  const user = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);

  // Both compared, and both constant-time: comparing the user first and returning
  // early would turn "is this a valid username" into a free oracle.
  const userOk = equals(user, expectedUser);
  const passwordOk = equals(password, expectedPassword);
  if (!userOk || !passwordOk) return unauthorised();

  const nonce = crypto.randomUUID().replace(/-/g, '');
  const csp = buildCsp(nonce, process.env.NODE_ENV === 'development');

  // Next reads `x-nonce` off the *request* headers to stamp its own script tags. The
  // response header is what the browser enforces. Both must carry the same value, and
  // setting only one is the failure that looks like "hydration silently never happens".
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('content-security-policy', csp);
  return response;
}

export const config = {
  /**
   * Everything except Next's own static output and `/healthz`.
   *
   * `_next/static` carries compiled CSS and JS chunks and nothing derived from the
   * database; gating it costs a round trip per asset and protects nothing.
   *
   * `/healthz` is exempt because the platform's health checker cannot authenticate.
   * Gating it produces a 401, an "unhealthy" verdict, and a restart loop over a
   * working system. See the route for what it is careful not to disclose.
   */
  matcher: ['/((?!_next/static|healthz|favicon.ico).*)'],
};
