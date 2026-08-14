import { NextResponse, type NextRequest } from 'next/server';

/**
 * The dashboard's front door. **`ARCHITECTURE.md` §11, cashed in.**
 *
 * > "No multi-user support. No auth beyond localhost binding until the day it is
 * > deployed remotely; at that point, a single-user session cookie, not a user system."
 *
 * 2026-08-14 is that day. Until now the only thing protecting this console was
 * `--hostname 127.0.0.1`; a public URL removes that protection completely, and what is
 * behind it is not a status page. It is the operator's unpublished analysis, his
 * content strategy, his do-not-say list, and every event he has decided not to post
 * about. That is a competitive and personal disclosure, not a leak of "some metrics".
 *
 * ## Why HTTP Basic and not a session cookie
 *
 * The architecture note says "session cookie", and a cookie needs a login form to set
 * it. This app's CSP is `form-action 'none'` (THREAT-MODEL §T-7) — a form post is
 * blocked by the browser before it reaches any handler. The choices were to weaken the
 * CSP for a login page or to use the authentication scheme that needs no page at all.
 * Basic sends the credential on every request over TLS, needs no form, no cookie, no
 * session store, and no state to get wrong for a single operator. Weakening a security
 * control to satisfy a note about the *shape* of the control is the wrong trade.
 *
 * Fly terminates TLS and redirects HTTP → HTTPS (`force_https` in `fly.toml`), so the
 * credential never crosses the network in the clear.
 *
 * ## Fail closed
 *
 * If `DASHBOARD_PASSWORD` is unset, every request is refused. The alternative —
 * "no password configured, so let everyone in" — is how a console ends up public
 * because a secret failed to propagate on one deploy.
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

  return NextResponse.next();
}

export const config = {
  /**
   * Everything except Next's own static output and `/healthz`.
   *
   * `_next/static` carries compiled CSS and nothing derived from the database; gating
   * it costs a round trip per asset and protects nothing.
   *
   * `/healthz` is exempt because the platform's health checker cannot authenticate.
   * Gating it produces a 401, an "unhealthy" verdict, and a restart loop over a
   * working system. See the route for what it is careful not to disclose.
   */
  matcher: ['/((?!_next/static|healthz|favicon.ico).*)'],
};
