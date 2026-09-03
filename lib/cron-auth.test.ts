/**
 * Regression cover for the fail-open cron guard (security audit, 2026-09-02).
 *
 * The airtable-webhooks route guarded itself with:
 *
 *   if (cronSecret && authHeader !== `Bearer ${cronSecret}`) return 401;
 *
 * With CRON_SECRET unset — its actual state in this deployment — the condition is never
 * entered, so the route served 200 to anonymous callers. The guard vanished in exactly the
 * configuration where it was most likely to be absent.
 *
 * The property that matters is asymmetric: a MISSING secret must refuse, not admit. The
 * "no secret configured" case below is the one that fails against the old code.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isCronRequestAuthorized } from './cron-auth';

const SECRET = 'f4c1a9d0e7b25836aa19c4d7e0b13f6288ce5a7419d3b0e6c85f2a1d7b9e4c30';
const VALID_HEADER = `Bearer ${SECRET}`;

describe('cron auth — fail closed when no secret is configured', () => {
  test('an unset secret refuses an anonymous request', () => {
    assert.equal(isCronRequestAuthorized(null, undefined), false);
  });

  test('an unset secret refuses even a well-formed Bearer header', () => {
    assert.equal(isCronRequestAuthorized(VALID_HEADER, undefined), false);
    assert.equal(isCronRequestAuthorized('Bearer anything', undefined), false);
  });

  test('an empty or whitespace-only secret is treated as unset', () => {
    for (const secret of ['', '   ', '\t\n']) {
      assert.equal(isCronRequestAuthorized(VALID_HEADER, secret), false, JSON.stringify(secret));
      assert.equal(isCronRequestAuthorized(`Bearer ${secret}`, secret), false, JSON.stringify(secret));
    }
  });
});

describe('cron auth — with a secret configured', () => {
  test('the exact Bearer header is accepted, so Vercel cron still runs', () => {
    assert.equal(isCronRequestAuthorized(VALID_HEADER, SECRET), true);
  });

  test('a missing header is refused', () => {
    assert.equal(isCronRequestAuthorized(null, SECRET), false);
    assert.equal(isCronRequestAuthorized(undefined, SECRET), false);
    assert.equal(isCronRequestAuthorized('', SECRET), false);
  });

  test('a wrong secret is refused', () => {
    assert.equal(isCronRequestAuthorized('Bearer wrong', SECRET), false);
  });

  test('a near-miss secret is refused — no prefix match', () => {
    assert.equal(isCronRequestAuthorized(`Bearer ${SECRET.slice(0, -1)}`, SECRET), false);
    assert.equal(isCronRequestAuthorized(`Bearer ${SECRET}x`, SECRET), false);
    assert.equal(isCronRequestAuthorized(`Bearer ${SECRET.toUpperCase()}`, SECRET), false);
  });

  test('the bare secret without the Bearer prefix is refused', () => {
    assert.equal(isCronRequestAuthorized(SECRET, SECRET), false);
  });

  test('the scheme is not case-normalised away', () => {
    assert.equal(isCronRequestAuthorized(`bearer ${SECRET}`, SECRET), false);
  });
});

describe('cron auth — constant-time comparison', () => {
  test('length mismatches are handled rather than thrown', () => {
    // timingSafeEqual throws on unequal buffer lengths; hashing first is what stops that
    // (and a length pre-check would itself leak the secret's length).
    for (const header of ['B', 'Bearer', `Bearer ${'x'.repeat(4096)}`]) {
      assert.doesNotThrow(() => isCronRequestAuthorized(header, SECRET));
      assert.equal(isCronRequestAuthorized(header, SECRET), false);
    }
  });

  test('multi-byte input does not throw', () => {
    assert.doesNotThrow(() => isCronRequestAuthorized('Bearer 🔑🔑🔑', SECRET));
    assert.equal(isCronRequestAuthorized('Bearer 🔑🔑🔑', SECRET), false);
  });
});
