import { hashMcpToken } from '@/lib/mcp/token-hash';

/**
 * In-memory cache for MCP token validation results.
 *
 * AI agents make many requests per minute and each was previously hitting
 * Supabase to revalidate the same token. Cache hits live for 10s (see the TTL
 * note below). Misses cache for 5s so a token flip from invalid→valid recovers
 * quickly.
 *
 * The cache lives in its own module so both `lib/mcp/handler.ts` and the
 * repository can read/invalidate it without creating a circular import.
 * Rotated/deleted tokens are explicitly invalidated so the old access token
 * stops working immediately, not after the cache TTL expires.
 *
 * 🔴 Entries are keyed on the SHA-256 of the presented token, never on the
 * token string itself (security-plan 2026-09-06, C3). Two reasons:
 *   1. `/ycode/mcp/<token>` is anonymous, so a flood of unique invalid tokens
 *      would otherwise park attacker-controlled strings in process memory.
 *   2. The plaintext no longer exists in the database after
 *      20260906000002_drop_mcp_token_plaintext, so deletion/rotation can only
 *      invalidate by hash — which is what `invalidateTokenHash` is for.
 * The map is also capped and swept, so it can no longer grow without bound.
 */

export interface TokenCacheEntry {
  valid: boolean;
  /** The validated token row — carries scopes and identity. Null when invalid. */
  record: unknown | null;
  expires: number;
}

const cache = new Map<string, TokenCacheEntry>();

// 60s was chosen when this cached a yes/no. It now caches SCOPES too, so the same window also
// delays a re-scoping — and, more importantly, a revoked token kept working for up to a minute.
// A token is a credential; a minute of post-revocation access is the wrong trade for saving a
// round trip. Cutting to 10s keeps the hot-path benefit (agents make many calls per minute)
// while bounding the blast radius of a revoke or a scope change (SCA-1233).
export const TOKEN_CACHE_TTL_VALID_MS = 10_000;
export const TOKEN_CACHE_TTL_INVALID_MS = 5_000;

/**
 * Hard cap on entries. Well above any real agent population (one row exists
 * today; a busy workspace might hold tens), and far below anything that costs
 * memory: each entry is a 64-char key plus a small row.
 */
export const TOKEN_CACHE_MAX_ENTRIES = 1_000;

/** How often expired entries are swept out even if nobody looks them up again. */
export const TOKEN_CACHE_SWEEP_INTERVAL_MS = 60_000;

let lastSweep = Date.now();

/**
 * Drop every expired entry.
 *
 * Before this existed, a TTL was only checked when that same key was queried
 * again — so entries created by one-shot invalid tokens were never checked
 * again and never left. Exported for the test; also called opportunistically
 * on write, so no timer is held (a `setInterval` would keep a serverless
 * instance alive and would need teardown in tests).
 */
export function sweepExpiredTokens(now: number = Date.now()): number {
  let removed = 0;
  for (const [key, entry] of cache) {
    if (entry.expires <= now) {
      cache.delete(key);
      removed += 1;
    }
  }
  lastSweep = now;
  return removed;
}

export function getCachedToken(token: string): TokenCacheEntry | undefined {
  const key = hashMcpToken(token);
  const entry = cache.get(key);
  if (entry && entry.expires > Date.now()) {
    return entry;
  }
  if (entry) {
    cache.delete(key);
  }
  return undefined;
}

export function setCachedToken(token: string, valid: boolean, record: unknown | null = null): void {
  const now = Date.now();

  if (now - lastSweep >= TOKEN_CACHE_SWEEP_INTERVAL_MS) {
    sweepExpiredTokens(now);
  }

  const key = hashMcpToken(token);

  if (!cache.has(key) && cache.size >= TOKEN_CACHE_MAX_ENTRIES) {
    // A sweep may already free room; only evict if it did not.
    sweepExpiredTokens(now);
    // Map preserves insertion order — evict oldest first until there is room
    // for exactly one more entry.
    for (const oldest of cache.keys()) {
      if (cache.size < TOKEN_CACHE_MAX_ENTRIES) break;
      cache.delete(oldest);
    }
  }

  const ttl = valid ? TOKEN_CACHE_TTL_VALID_MS : TOKEN_CACHE_TTL_INVALID_MS;
  cache.set(key, { valid, record, expires: now + ttl });
}

/** Invalidate by plaintext token (callers that still hold one). */
export function invalidateToken(token: string): void {
  cache.delete(hashMcpToken(token));
}

/**
 * Invalidate by stored hash — the only form available to the repository once
 * the plaintext column is gone.
 */
export function invalidateTokenHash(tokenHash: string): void {
  cache.delete(tokenHash);
}

/** Test-only: current entry count. */
export function tokenCacheSize(): number {
  return cache.size;
}

/** Test-only: drop everything, so one test cannot leak state into the next. */
export function clearTokenCache(): void {
  cache.clear();
  lastSweep = Date.now();
}
