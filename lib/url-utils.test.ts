/**
 * SCA-1431 — x-forwarded-host was trusted with no allowlist on the UNAUTHENTICATED
 * /robots.txt and /sitemap.xml routes, where the resolved origin becomes every absolute
 * URL in the emitted file. A forged header steered those URLs at an attacker's host.
 *
 * Adopted as-is with upstream 1.30.11; upstream's own comment conceded the header is
 * client-controllable and shipped it anyway. Fixed at the root in our fork.
 *
 * Two defects, two groups of tests:
 *
 *   1. TRUST — the forwarded host must be ignored in production unless allowlisted.
 *      Against the old code every test in that group fails: it returned the forged host.
 *
 *   2. LAZINESS — the request origin must not be consulted at all when a canonical URL
 *      or env var is configured. Against the old code the caller computed the origin
 *      eagerly, which both read headers that were discarded (flipping /robots.txt from
 *      static to dynamic, upstream cf55f10) and kept a client-controllable value in play
 *      on requests where it could not be needed. The laziness assertion is a call
 *      counter, so it cannot pass vacuously — a resolver that never runs and a resolver
 *      that runs and is discarded are different numbers.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  getRequestOrigin,
  getSiteBaseUrl,
  resolveSiteBaseUrl,
  parseTrustedForwardedHosts,
  isForwardedHostTrusted,
} from './url-utils';

const ATTACKER = 'evil.example.com';
const REAL = 'scalability.us';

const headersOf = (entries: Record<string, string>) => new Headers(entries);

/**
 * getSiteBaseUrl consults process.env directly, so an inherited NEXT_PUBLIC_SITE_URL or
 * VERCEL_URL would make "nothing is configured" quietly untrue and the fallback tests
 * vacuous. Clear them per-test and restore after.
 */
const ENV_KEYS = ['NEXT_PUBLIC_SITE_URL', 'VERCEL_PROJECT_PRODUCTION_URL', 'VERCEL_URL', 'TRUSTED_FORWARDED_HOSTS'] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('SCA-1431 trust — a forged x-forwarded-host must not steer absolute URLs', () => {
  test('production, no allowlist: the forged forwarded host is ignored, Host wins', () => {
    const origin = getRequestOrigin(
      headersOf({ 'x-forwarded-host': ATTACKER, host: REAL }),
      { trustedForwardedHosts: null, nodeEnv: 'production' },
    );

    assert.equal(origin, `https://${REAL}`);
    assert.ok(!origin!.includes(ATTACKER), 'attacker host must not appear in the origin');
  });

  test('production, allowlist that does not contain it: still ignored', () => {
    const origin = getRequestOrigin(
      headersOf({ 'x-forwarded-host': ATTACKER, host: REAL }),
      { trustedForwardedHosts: `${REAL},www.${REAL}`, nodeEnv: 'production' },
    );

    assert.equal(origin, `https://${REAL}`);
  });

  test('production, allowlisted forwarded host: honored, so real proxies keep working', () => {
    const origin = getRequestOrigin(
      headersOf({ 'x-forwarded-host': `www.${REAL}`, host: 'internal-lb.local' }),
      { trustedForwardedHosts: `www.${REAL}`, nodeEnv: 'production' },
    );

    assert.equal(origin, `https://www.${REAL}`);
  });

  test('allowlist matching is case-insensitive and tolerates spacing', () => {
    const origin = getRequestOrigin(
      headersOf({ 'x-forwarded-host': 'WWW.Scalability.US', host: 'internal-lb.local' }),
      { trustedForwardedHosts: '  www.scalability.us ,  other.test  ', nodeEnv: 'production' },
    );

    assert.equal(origin, 'https://WWW.Scalability.US');
  });

  test('off production the forwarded host is honored — tunnels and preview hosts', () => {
    const origin = getRequestOrigin(
      headersOf({ 'x-forwarded-host': 'abc123.ngrok.io', host: 'localhost:3002' }),
      { trustedForwardedHosts: null, nodeEnv: 'development' },
    );

    assert.equal(origin, 'https://abc123.ngrok.io');
  });

  test('a chained proxy list takes the FIRST value, and it is still allowlist-checked', () => {
    const origin = getRequestOrigin(
      headersOf({ 'x-forwarded-host': `${ATTACKER}, ${REAL}`, host: REAL }),
      { trustedForwardedHosts: REAL, nodeEnv: 'production' },
    );

    // First value is the attacker's and is not allowlisted, so Host is used.
    assert.equal(origin, `https://${REAL}`);
  });

  test('x-forwarded-proto is only believed from a proxy we already trust', () => {
    const untrusted = getRequestOrigin(
      headersOf({ 'x-forwarded-host': ATTACKER, 'x-forwarded-proto': 'http', host: REAL }),
      { trustedForwardedHosts: null, nodeEnv: 'production' },
    );
    assert.equal(untrusted, `https://${REAL}`, 'untrusted proto must not downgrade the scheme');

    const trusted = getRequestOrigin(
      headersOf({ 'x-forwarded-host': REAL, 'x-forwarded-proto': 'http', host: 'lb.local' }),
      { trustedForwardedHosts: REAL, nodeEnv: 'production' },
    );
    assert.equal(trusted, `http://${REAL}`, 'a trusted proxy may report plain http');
  });

  test('no host header at all still yields null rather than a bare scheme', () => {
    assert.equal(
      getRequestOrigin(headersOf({}), { trustedForwardedHosts: null, nodeEnv: 'production' }),
      null,
    );
  });

  test('the allowlist is read from TRUSTED_FORWARDED_HOSTS when no option is passed', () => {
    process.env.TRUSTED_FORWARDED_HOSTS = REAL;

    assert.equal(
      getRequestOrigin(headersOf({ 'x-forwarded-host': REAL, host: 'lb.local' }), { nodeEnv: 'production' }),
      `https://${REAL}`,
    );
    assert.equal(
      getRequestOrigin(headersOf({ 'x-forwarded-host': ATTACKER, host: REAL }), { nodeEnv: 'production' }),
      `https://${REAL}`,
    );
  });
});

describe('SCA-1431 allowlist parsing', () => {
  test('unset or empty means trust nothing', () => {
    assert.deepEqual(parseTrustedForwardedHosts(undefined), []);
    assert.deepEqual(parseTrustedForwardedHosts(null), []);
    assert.deepEqual(parseTrustedForwardedHosts('   '), []);
    assert.deepEqual(parseTrustedForwardedHosts(',, ,'), []);
  });

  test('entries are trimmed and lowercased', () => {
    assert.deepEqual(parseTrustedForwardedHosts(' A.test , B.TEST '), ['a.test', 'b.test']);
  });

  test('an empty production allowlist trusts nothing — the safe default', () => {
    assert.equal(isForwardedHostTrusted(REAL, [], 'production'), false);
    assert.equal(isForwardedHostTrusted(REAL, [REAL], 'production'), true);
    assert.equal(isForwardedHostTrusted(ATTACKER, [], 'test'), true);
  });
});

describe('SCA-1431 laziness — a configured base URL must never reach for headers', () => {
  test('a canonical URL short-circuits: the origin resolver is NEVER invoked', async () => {
    let calls = 0;
    const resolveRequestOrigin = async () => {
      calls++;
      return `https://${ATTACKER}`;
    };

    const baseUrl = await resolveSiteBaseUrl({
      globalCanonicalUrl: 'https://scalability.us',
      resolveRequestOrigin,
    });

    assert.equal(baseUrl, 'https://scalability.us');
    assert.equal(calls, 0, 'headers must not be read when a canonical URL is configured');
  });

  test('NEXT_PUBLIC_SITE_URL short-circuits too', async () => {
    process.env.NEXT_PUBLIC_SITE_URL = 'https://from-env.test';
    let calls = 0;

    const baseUrl = await resolveSiteBaseUrl({
      resolveRequestOrigin: async () => {
        calls++;
        return `https://${ATTACKER}`;
      },
    });

    assert.equal(baseUrl, 'https://from-env.test');
    assert.equal(calls, 0);
  });

  test('with nothing configured the resolver IS used, exactly once', async () => {
    let calls = 0;

    const baseUrl = await resolveSiteBaseUrl({
      resolveRequestOrigin: async () => {
        calls++;
        return `https://${REAL}`;
      },
    });

    assert.equal(baseUrl, `https://${REAL}`, 'the fallback must still work for unconfigured deploys');
    assert.equal(calls, 1, 'population check: the resolver really did run, so calls===0 above means something');
  });

  test('nothing configured and no resolvable origin yields null, not a broken URL', async () => {
    const baseUrl = await resolveSiteBaseUrl({ resolveRequestOrigin: async () => null });
    assert.equal(baseUrl, null);
  });

  test('a trailing slash is stripped from every source', async () => {
    assert.equal(getSiteBaseUrl({ globalCanonicalUrl: 'https://scalability.us/' }), 'https://scalability.us');
    assert.equal(
      await resolveSiteBaseUrl({ resolveRequestOrigin: async () => 'https://scalability.us/' }),
      'https://scalability.us',
    );
  });
});
