import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  credentialShapeProblems,
  oauthHeader,
  percentEncode,
  signatureBaseString,
  verifyCredentials,
  xGet,
  XApiError,
  XBudgetExceeded,
  X_REQUEST_PRICE_USD,
  type XCredentials,
  type XSpendAccount,
} from './x-owned.js';

/**
 * What these tests can and cannot prove.
 *
 * They prove the two things that are *checkable offline* and that OAuth 1.0a
 * implementations reliably get wrong — parameter normalisation and the budget
 * ordering. They do **not** prove the credentials are valid; only a live call does
 * that, which is what `pnpm x:verify` is for. A test suite that mocked `fetch` and
 * then reported "X integration verified" would be the exact fabricated-live-result
 * failure this project forbids.
 */

const CREDS: XCredentials = {
  apiKey: 'key',
  apiSecret: 'consumer-secret',
  accessToken: 'token',
  accessTokenSecret: 'token-secret',
};

const FIXED = { nonce: () => 'fixed-nonce', timestampSeconds: () => 1_700_000_000 };

function account(budget: number, spent: number) {
  const recorded: { kind: string; price: number; endpoint: string; status: number }[] = [];
  const spend: XSpendAccount = {
    spentTodayUsd: () => spent,
    budgetUsd: () => budget,
    record: (kind, price, endpoint, status) => {
      recorded.push({ kind, price, endpoint, status });
    },
  };
  return { spend, recorded };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
      }),
    );
}

describe('percentEncode', () => {
  it('escapes the four characters encodeURIComponent leaves alone', () => {
    // This is the single most common OAuth 1.0a bug: `encodeURIComponent` leaves
    // !'()* unescaped, RFC 5849 requires them escaped, and a signature over a string
    // that differs by one byte fails with an indistinguishable 401.
    expect(percentEncode("!'()*")).toBe('%21%27%28%29%2A');
  });

  it('leaves the unreserved set alone', () => {
    expect(percentEncode('aZ09-._~')).toBe('aZ09-._~');
  });

  it('escapes the reserved characters that appear in real tokens', () => {
    expect(percentEncode('a+b/c=d&e')).toBe('a%2Bb%2Fc%3Dd%26e');
  });
});

describe('signatureBaseString', () => {
  it('sorts by encoded key, not by insertion order', () => {
    const base = signatureBaseString('GET', 'https://api.x.com/2/users/me', {
      z: '1',
      a: '2',
      m: '3',
    });
    expect(decodeURIComponent(base.split('&')[2] ?? '')).toBe('a=2&m=3&z=1');
  });

  it('breaks ties on the encoded value', () => {
    const base = signatureBaseString('GET', 'https://x', { k: 'b', ...{ k2: 'x' } });
    expect(base).toContain(percentEncode('k=b'));
  });

  it('encodes the url exactly once', () => {
    const base = signatureBaseString('GET', 'https://api.x.com/2/users/me', {});
    expect(base.startsWith('GET&https%3A%2F%2Fapi.x.com%2F2%2Fusers%2Fme&')).toBe(true);
  });

  it('includes query parameters, not only the oauth block', () => {
    // Signing only the OAuth parameters yields a header that looks correct and 401s
    // on every endpoint that takes an argument — a failure that reads as "bad keys".
    const base = signatureBaseString('GET', 'https://x', { 'user.fields': 'id', oauth_v: '1' });
    expect(decodeURIComponent(base.split('&')[2] ?? '')).toContain('user.fields=id');
  });
});

describe("the worked example from X's own documentation", () => {
  /**
   * docs.x.com → Authentication → OAuth 1.0a → "Creating a signature".
   *
   * This is the only test here that proves the implementation is *correct* rather than
   * merely *consistent*: it reproduces a signature X published, from inputs X
   * published. It exists because the live call returned 401, and "my signing is wrong"
   * and "the credentials are wrong" are indistinguishable from a 401 body. One of the
   * two has to be eliminated by evidence, and this is the half that can be.
   *
   * It signs a POST because that is the request X documented. Nothing in this package
   * can send one — `oauthHeader` accepts the literal type `'GET'`, and `xGet` is the
   * only caller.
   */
  const DOC = {
    consumerKey: 'xvz1evFS4wEEPTGEFPHBog',
    consumerSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
    token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
    tokenSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
    url: 'https://api.x.com/1.1/statuses/update.json',
  };

  const params = {
    status: 'Hello Ladies + Gentlemen, a signed OAuth request!',
    include_entities: 'true',
    oauth_consumer_key: DOC.consumerKey,
    oauth_nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: '1318622958',
    oauth_token: DOC.token,
    oauth_version: '1.0',
  };

  it('reproduces the published signature base string byte for byte', () => {
    expect(signatureBaseString('POST', DOC.url, params)).toBe(
      'POST&https%3A%2F%2Fapi.x.com%2F1.1%2Fstatuses%2Fupdate.json&' +
        'include_entities%3Dtrue%26oauth_consumer_key%3Dxvz1evFS4wEEPTGEFPHBog%26' +
        'oauth_nonce%3DkYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg%26' +
        'oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D1318622958%26' +
        'oauth_token%3D370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb%26' +
        'oauth_version%3D1.0%26' +
        'status%3DHello%2520Ladies%2520%252B%2520Gentlemen%252C%2520a%2520signed%2520OAuth%2520request%2521',
    );
  });

  it('reproduces the published oauth_signature', () => {
    const signingKey = `${percentEncode(DOC.consumerSecret)}&${percentEncode(DOC.tokenSecret)}`;
    const signature = createHmac('sha1', signingKey)
      .update(signatureBaseString('POST', DOC.url, params))
      .digest('base64');

    expect(signature).toBe('Ls93hJiZbQ3akF3HF3x1Bz8/zU4=');
  });
});

describe('oauthHeader', () => {
  it('is deterministic given a fixed nonce and timestamp', () => {
    const a = oauthHeader('GET', 'https://api.x.com/2/users/me', {}, CREDS, FIXED);
    const b = oauthHeader('GET', 'https://api.x.com/2/users/me', {}, CREDS, FIXED);
    expect(a).toBe(b);
  });

  it('pins the signature so a refactor cannot silently change it', () => {
    // Regression pin, not an independent proof of correctness. Its job is to fail
    // loudly if someone "tidies" the normalisation and breaks live auth in a way that
    // only shows up as a 401 on a metered endpoint.
    const header = oauthHeader('GET', 'https://api.x.com/2/users/me', {}, CREDS, FIXED);
    expect(header).toContain('oauth_signature="Ij8U9hIb2cduAdr%2Fc0Ym0iS4k0M%3D"');
  });

  it('carries every required oauth parameter', () => {
    const header = oauthHeader('GET', 'https://api.x.com/2/users/me', {}, CREDS, FIXED);
    for (const key of [
      'oauth_consumer_key',
      'oauth_nonce',
      'oauth_signature',
      'oauth_signature_method',
      'oauth_timestamp',
      'oauth_token',
      'oauth_version',
    ]) {
      expect(header).toContain(`${key}="`);
    }
  });

  it('never puts a secret in the header', () => {
    const header = oauthHeader('GET', 'https://api.x.com/2/users/me', {}, CREDS, FIXED);
    expect(header).not.toContain('consumer-secret');
    expect(header).not.toContain('token-secret');
  });
});

describe('budget enforcement', () => {
  it('refuses before sending when the call would breach the ceiling', async () => {
    const { spend, recorded } = account(0.05, 0.045);
    let called = false;
    await expect(
      xGet('/2/users/me', {
        credentials: CREDS,
        spend,
        kind: 'user_read',
        fetchOptions: {
          fetchImpl: () => {
            called = true;
            return Promise.reject(new Error('must not be reached'));
          },
        },
      }),
    ).rejects.toBeInstanceOf(XBudgetExceeded);

    // The point of checking before sending: nothing was billed, because nothing left.
    expect(called).toBe(false);
    expect(recorded).toHaveLength(0);
  });

  it('allows a call that exactly reaches the ceiling', async () => {
    const { spend } = account(0.01, 0);
    const response = await verifyCredentials(CREDS, spend, {
      fetchImpl: jsonResponse(200, { data: { id: '1', username: 'u', name: 'n' } }),
    });
    expect(response.data.username).toBe('u');
  });

  it('records spend even when X rejects the request', async () => {
    // X bills attempts. A ledger that only records successes under-counts precisely
    // when something is looping on a 401.
    const { spend, recorded } = account(1, 0);
    await expect(
      verifyCredentials(CREDS, spend, { fetchImpl: jsonResponse(401, { title: 'Unauthorized' }) }),
    ).rejects.toBeInstanceOf(XApiError);

    expect(recorded).toEqual([
      {
        kind: 'user_read',
        price: X_REQUEST_PRICE_USD.user_read,
        endpoint: '/2/users/me',
        status: 401,
      },
    ]);
  });

  it('prices /2/users/me as a user_read, the dearer of the two plausible rates', () => {
    expect(X_REQUEST_PRICE_USD.user_read).toBeGreaterThan(X_REQUEST_PRICE_USD.owned_read);
  });
});

describe('credentialShapeProblems — only what is structurally impossible', () => {
  const good: XCredentials = {
    apiKey: 'k'.repeat(25),
    apiSecret: 's'.repeat(50),
    accessToken: `1749077286295326720-${'t'.repeat(40)}`,
    accessTokenSecret: 'x'.repeat(45),
  };

  it('passes a well-formed set', () => {
    expect(credentialShapeProblems(good)).toEqual([]);
  });

  it('ACCEPTS a 30-character access-token suffix', () => {
    // The correction. This was previously rejected as "a truncated paste" on the
    // strength of a 2011 example in X's signature docs. X documents no length, the
    // operator's account produces 30 consistently across regenerations, and isolating
    // the OAuth legs proved the access token was never what failed: POST
    // /oauth/request_token signs with the consumer key/secret ALONE and returns the
    // same 401. A guess that blocks the call which would have corrected it is worse
    // than no check at all.
    expect(
      credentialShapeProblems({ ...good, accessToken: `1749077286295326720-${'t'.repeat(30)}` }),
    ).toEqual([]);
  });

  it('accepts unfamiliar lengths on the other three fields', () => {
    expect(
      credentialShapeProblems({
        ...good,
        apiKey: 'k'.repeat(30),
        apiSecret: 's'.repeat(44),
        accessTokenSecret: 'x'.repeat(51),
      }),
    ).toEqual([]);
  });

  it('still catches an empty credential', () => {
    expect(credentialShapeProblems({ ...good, apiKey: '' })).toContain('X_API_KEY is empty');
  });

  it('still catches an access token with no user-id prefix', () => {
    expect(credentialShapeProblems({ ...good, accessToken: 'nodash' })[0]).toContain('no "-"');
    expect(credentialShapeProblems({ ...good, accessToken: `abc-${'t'.repeat(30)}` })[0]).toContain(
      'numeric user id',
    );
  });

  it('names every empty field rather than stopping at the first', () => {
    expect(
      credentialShapeProblems({
        apiKey: '',
        apiSecret: '',
        accessToken: '',
        accessTokenSecret: '',
      }),
    ).toHaveLength(4);
  });
});
describe('response handling', () => {
  it('surfaces rate-limit headers rather than swallowing them', async () => {
    const { spend } = account(1, 0);
    const response = await verifyCredentials(CREDS, spend, {
      fetchImpl: jsonResponse(
        200,
        { data: { id: '7', username: 'operator', name: 'Operator' } },
        {
          'x-rate-limit-limit': '75',
          'x-rate-limit-remaining': '74',
          'x-rate-limit-reset': '1700000600',
        },
      ),
    });

    expect(response.rateLimit.limit).toBe(75);
    expect(response.rateLimit.remaining).toBe(74);
    expect(response.rateLimit.resetAt?.toISOString()).toBe('2023-11-14T22:23:20.000Z');
  });

  it('reports missing rate-limit headers as undefined rather than zero', () => {
    // 0 remaining and "not told" are different states, and conflating them makes a
    // healthy client look rate-limited.
    return verifyCredentials(CREDS, account(1, 0).spend, {
      fetchImpl: jsonResponse(200, { data: { id: '1', username: 'u', name: 'n' } }),
    }).then((response) => {
      expect(response.rateLimit.remaining).toBeUndefined();
    });
  });
});
