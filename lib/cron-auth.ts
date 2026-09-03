/**
 * Authorization for cron-triggered routes.
 *
 * The airtable-webhooks cron route guarded itself with:
 *
 *   if (cronSecret && authHeader !== `Bearer ${cronSecret}`) return 401;
 *
 * which fails OPEN. With CRON_SECRET unset — as it is in this deployment — the condition is
 * never entered and the route serves 200 to anyone, anonymously. The guard silently disappears
 * in exactly the configuration where it is most likely to be missing.
 *
 * Fail closed instead: no secret configured is a refusal, not a pass. And compare in constant
 * time, since a `!==` on the raw string leaks the secret's prefix byte-by-byte to anyone who
 * can time the endpoint.
 */

import { createHash, timingSafeEqual } from 'crypto';

/**
 * SHA-256 both sides before comparing.
 *
 * timingSafeEqual throws on length mismatch, and guarding that with a length check would
 * itself leak the secret's length. Hashing first makes both operands a fixed 32 bytes
 * whatever the inputs were.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a, 'utf8').digest();
  const digestB = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(digestA, digestB);
}

/**
 * True only when a secret is configured AND the Authorization header presents it exactly.
 *
 * @param authHeader - the request's Authorization header, if any
 * @param cronSecret - process.env.CRON_SECRET, if set
 */
export function isCronRequestAuthorized(
  authHeader: string | null | undefined,
  cronSecret: string | null | undefined,
): boolean {
  // Fail closed: an unset or blank secret refuses every request rather than admitting all of
  // them. Vercel cron sends `Authorization: Bearer $CRON_SECRET`, so the fix for a 401 here is
  // to set CRON_SECRET — not to remove the check.
  if (!cronSecret || cronSecret.trim() === '') return false;
  if (!authHeader) return false;

  return constantTimeEquals(authHeader, `Bearer ${cronSecret}`);
}
