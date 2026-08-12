/**
 * In-memory cache for MCP token validation results.
 *
 * AI agents make many requests per minute and each was previously hitting
 * Supabase to revalidate the same token. Cache hits live for 60s (revocations
 * propagate within a minute, fine for static URL tokens). Misses cache for 5s
 * so a token flip from invalid→valid recovers quickly.
 *
 * The cache lives in its own module so both `lib/mcp/handler.ts` and the
 * repository can read/invalidate it without creating a circular import.
 * Rotated/deleted tokens are explicitly invalidated so the old access token
 * stops working immediately, not after the cache TTL expires.
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

export function getCachedToken(token: string): TokenCacheEntry | undefined {
  const entry = cache.get(token);
  if (entry && entry.expires > Date.now()) {
    return entry;
  }
  if (entry) {
    cache.delete(token);
  }
  return undefined;
}

export function setCachedToken(token: string, valid: boolean, record: unknown | null = null): void {
  const ttl = valid ? TOKEN_CACHE_TTL_VALID_MS : TOKEN_CACHE_TTL_INVALID_MS;
  cache.set(token, { valid, record, expires: Date.now() + ttl });
}

export function invalidateToken(token: string): void {
  cache.delete(token);
}
