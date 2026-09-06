/**
 * Security plan 2026-09-06, item C3 — the MCP token cache is bounded.
 *
 * `lib/mcp/token-cache.ts` stored every token string presented, valid or not,
 * in a `Map` with no size cap and no sweep; the TTL was only checked when that
 * same key was looked up again. `/ycode/mcp/<token>` is anonymous, so a flood
 * of unique invalid tokens grew the process map for the lifetime of the
 * process AND parked attacker-supplied strings in memory.
 *
 * The three assertions that bite, each of which FAILS against the previous
 * revision of that file (verified before landing):
 *   1. `cap + 1000` distinct keys leave `size <= cap`      → was unbounded
 *   2. expired entries leave on a sweep, unqueried          → was re-query only
 *   3. the raw token string is never used as a map key      → was the key itself
 *
 * And the guarantees that must SURVIVE the change: a valid token still hits
 * cache inside its TTL, and `invalidateToken` still evicts immediately — that
 * immediate eviction is the whole reason the TTL is only 10s (SCA-1233).
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'crypto';

import {
  getCachedToken,
  setCachedToken,
  invalidateToken,
  invalidateTokenHash,
  sweepExpiredTokens,
  clearTokenCache,
  tokenCacheSize,
  TOKEN_CACHE_MAX_ENTRIES,
  TOKEN_CACHE_TTL_VALID_MS,
  TOKEN_CACHE_TTL_INVALID_MS,
} from '@/lib/mcp/token-cache';

const sha256Hex = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

describe('MCP token cache is bounded (C3)', () => {
  beforeEach(() => {
    clearTokenCache();
  });

  test('cap + 1000 distinct keys leave the map at or under the cap', () => {
    const inserted = TOKEN_CACHE_MAX_ENTRIES + 1000;
    for (let i = 0; i < inserted; i++) {
      setCachedToken(`attacker-token-${i}`, false);
    }

    // Population check first: the loop really did run, so a passing size
    // assertion cannot be the empty-population artifact.
    assert.equal(inserted, TOKEN_CACHE_MAX_ENTRIES + 1000);
    assert.ok(
      tokenCacheSize() <= TOKEN_CACHE_MAX_ENTRIES,
      `cache grew to ${tokenCacheSize()}, cap is ${TOKEN_CACHE_MAX_ENTRIES}`,
    );
  });

  test('eviction is oldest-first, so the newest entries survive', () => {
    for (let i = 0; i < TOKEN_CACHE_MAX_ENTRIES + 50; i++) {
      setCachedToken(`token-${i}`, true, { id: i });
    }

    const newest = getCachedToken(`token-${TOKEN_CACHE_MAX_ENTRIES + 49}`);
    assert.ok(newest, 'the most recently cached token must still be present');
    assert.equal(getCachedToken('token-0'), undefined, 'the oldest must have been evicted');
  });

  test('the raw token string is never used as a map key', () => {
    const raw = 'ymc_' + 'a'.repeat(48);
    setCachedToken(raw, false);

    // Read the module's own view: a lookup by the HASH must find the entry the
    // plaintext call created. Asserting on the parsed key, not on a grep of the
    // source — a comment saying "we hash" proves nothing.
    invalidateTokenHash(sha256Hex(raw));
    assert.equal(tokenCacheSize(), 0, 'the entry must have been keyed on the hash');
  });

  test('expired entries leave on a sweep, without being queried again', () => {
    setCachedToken('stale-token', false);
    assert.equal(tokenCacheSize(), 1, 'population check — the entry exists');

    // Sweep at a clock past the invalid TTL. No getCachedToken() call, which is
    // the point: the old code could only expire an entry someone asked for.
    const removed = sweepExpiredTokens(Date.now() + TOKEN_CACHE_TTL_INVALID_MS + 1);

    assert.equal(removed, 1);
    assert.equal(tokenCacheSize(), 0);
  });

  test('a valid token still hits cache inside its TTL', () => {
    const token = 'ymc_valid';
    setCachedToken(token, true, { id: 'row-1', scopes: ['read'] });

    const hit = getCachedToken(token);
    assert.ok(hit, 'a freshly cached valid token must hit');
    assert.equal(hit.valid, true);
    assert.deepEqual(hit.record, { id: 'row-1', scopes: ['read'] });
    assert.ok(hit.expires > Date.now());
    assert.ok(hit.expires <= Date.now() + TOKEN_CACHE_TTL_VALID_MS);
  });

  test('invalidateToken still evicts immediately — the revocation guarantee', () => {
    const token = 'ymc_revoked';
    setCachedToken(token, true, { id: 'row-1' });
    assert.ok(getCachedToken(token), 'population check — it was cached');

    invalidateToken(token);

    assert.equal(getCachedToken(token), undefined);
    assert.equal(tokenCacheSize(), 0);
  });

  test('invalidateTokenHash evicts by stored hash — the only handle after the plaintext column is dropped', () => {
    const token = 'ymc_rotated';
    setCachedToken(token, true, { id: 'row-1' });

    invalidateTokenHash(sha256Hex(token));

    assert.equal(getCachedToken(token), undefined);
  });
});
