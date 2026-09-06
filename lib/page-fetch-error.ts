/**
 * SCA: a transient backend failure must never be cached as a permanent 404.
 *
 * `app/(site)/[...slug]/page.tsx` wraps every page read in `unstable_cache(..., { revalidate: false })`,
 * so whatever the fetcher RETURNS is stored until the next publish invalidates it. The fetchers used
 * to convert every failure — Supabase unconfigured, a query error, a thrown exception — into `null`,
 * and `null` is indistinguishable from "this page genuinely does not exist". One Supabase blip
 * therefore pinned a live URL to a hard 404 (and to a `Page Not Found` + `noindex` title) until
 * someone published again.
 *
 * The rule this class enforces: **backend failure THROWS, absence returns `null`.**
 * `unstable_cache` does not store a rejected promise, so a throw leaves the entry empty and the
 * next request retries. `null` still means "no such page" and is still cacheable as a 404.
 */
export class PageFetchError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'PageFetchError';
    this.cause = cause;
  }
}

/** Wrap an unknown thrown value so callers always see a `PageFetchError`. */
export function asPageFetchError(context: string, error: unknown): PageFetchError {
  if (error instanceof PageFetchError) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return new PageFetchError(`${context}: ${detail}`, error);
}

/**
 * Run a page read, retrying ONCE on a backend failure before giving up.
 *
 * A single Supabase blip is the common case and it should cost the visitor a few hundred
 * milliseconds, not a 500 — and never a cached 404. If the retry fails too, the error is
 * rethrown so `unstable_cache` stores nothing and the next request tries again.
 *
 * 🔴 `fn` MUST NOT be memoised. React's `cache()` stores the returned promise for the whole
 * request, rejections included, so `fetchWithOneRetry(() => aCachedFetcher(...))` awaits the
 * SAME rejected promise twice and performs exactly one database read — a retry that exists on
 * paper only. Wrap the un-memoised function (see `fetchPageByPath` / `fetchHomepage`, which
 * call this INSIDE their `cache()` boundary, around the `…Internal` implementation).
 */
export async function fetchWithOneRetry<T>(fn: () => Promise<T>, delayMs = 150): Promise<T> {
  try {
    return await fn();
  } catch (first) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    try {
      return await fn();
    } catch {
      throw first;
    }
  }
}
