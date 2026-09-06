/**
 * "Does this public URL resolve to anything?" — answered early enough to give a missing
 * page a real, fully server-rendered 404 (SCA-1465).
 *
 * WHY THIS EXISTS AT ALL
 * ----------------------
 * `notFound()` from the matched catch-all page sets a 404 status but cannot render a
 * document: Next 16.3 aborts the RSC render and recovers with a hardcoded
 * `<html id="__next_error__">` shell whose `<body>` is empty (see `app/(site)/404/page.tsx`).
 * The only route that Next will render as a complete document *and* answer 404 for is the
 * one whose route path is exactly `/404`. Reaching it means deciding "missing" BEFORE the
 * page renders — which is why the decision lives here, called from `proxy.ts`.
 *
 * THE SAFETY PROPERTY
 * -------------------
 * A wrong 404 on a real page is far worse than an ugly 404 on a missing one, so this module
 * is deliberately one-sided: it returns `true` only when the SAME resolver the page itself
 * uses said "no such page". Anything else — an infrastructure failure, an unparseable path,
 * a redirect match, a path shape we do not own — returns `false` and the request continues
 * exactly as it did before. `fetchPageByPathForMetadata` already separates the two cases for
 * us: it THROWS `PageFetchError` on a backend failure and returns `null` only for a genuine
 * absence, so a Supabase blip can never be read as "this page does not exist".
 *
 * NO SECOND SOURCE OF TRUTH
 * -------------------------
 * This does not re-implement routing. `fetchPageByPathForMetadata` is
 * `fetchPageByPathInternal` with `resolveLayers: false` — the identical resolution the page
 * performs, minus the layer tree. So "exists" here means exactly what "exists" means in
 * `app/(site)/[...slug]/page.tsx`, by construction rather than by agreement. Redirects are
 * matched with the page's own `matchRedirect` for the same reason.
 *
 * COST
 * ----
 * `unstable_cache` does NOT cache inside proxy/middleware — measured on Next 16.3: two
 * consecutive calls to the same cached function from `proxy.ts` both hit the database
 * (~200ms each). So this module carries its own small in-process cache. A resolvable path
 * costs one lookup per TTL window; after that the answer is a Map hit. Misses are cached
 * too (a genuine absence may be cached as a 404), which is what keeps a crawler walking
 * dead URLs from re-querying on every request.
 */

import { matchRedirect } from '@/lib/redirect-utils';
import type { Redirect } from '@/types';

/** How long a resolved answer is trusted. Short enough that a freshly published page is
 *  reachable within a minute even if something requested it while it was still absent. */
const TTL_MS = 60_000;

/** Bounded so a crawler walking generated URLs cannot grow this without limit. */
const MAX_ENTRIES = 2_000;

type Answer = { missing: boolean; at: number };

const answers = new Map<string, Answer>();

/** Redirect list, cached separately — one settings read serves every path. */
let redirectsCache: { value: Redirect[]; at: number } | null = null;

/** Path prefixes this check never owns. */
const SKIPPED_PREFIXES = [
  '/_next',
  '/api',
  '/ycode',
  '/dynamic',
  '/a/',
  '/404',
];

/** Exact paths served by their own route handlers rather than the page tree. */
const SKIPPED_EXACT = new Set([
  '/',
  '/sitemap.xml',
  '/robots.txt',
  '/llms.txt',
  '/favicon.ico',
  '/icon.svg',
]);

/**
 * Paths this module is allowed to have an opinion about.
 *
 * The homepage is excluded on purpose: it is served by `app/(site)/page.tsx`, not the
 * catch-all, and the path resolver returns null for the empty slug — checking it would 404
 * the front page. Anything with a file extension in its last segment is excluded because
 * `public/` assets are served after the proxy runs, and a rewrite would make them
 * unreachable.
 */
export function isCheckableSitePath(pathname: string): boolean {
  if (SKIPPED_EXACT.has(pathname)) return false;
  if (SKIPPED_PREFIXES.some((p) => pathname === p || pathname.startsWith(p.endsWith('/') ? p : `${p}/`))) {
    return false;
  }
  if (!pathname.startsWith('/')) return false;

  const lastSegment = pathname.split('/').filter(Boolean).pop() ?? '';
  if (lastSegment.includes('.')) return false;

  return true;
}

function readCached(path: string): boolean | null {
  const hit = answers.get(path);
  if (!hit) return null;
  if (Date.now() - hit.at > TTL_MS) {
    answers.delete(path);
    return null;
  }
  return hit.missing;
}

function writeCached(path: string, missing: boolean): void {
  if (answers.size >= MAX_ENTRIES) {
    // Cheapest bounded eviction: drop the oldest inserted key. Map preserves insertion order.
    const oldest = answers.keys().next();
    if (!oldest.done) answers.delete(oldest.value);
  }
  answers.set(path, { missing, at: Date.now() });
}

/** Test seam — the proxy never passes these. */
export interface RouteExistenceDeps {
  fetchPageForPath: (slugPath: string) => Promise<unknown | null>;
  fetchRedirects: () => Promise<Redirect[] | null>;
}

async function defaultDeps(): Promise<RouteExistenceDeps> {
  const [{ fetchPageByPathForMetadata }, { getSettingByKey }] = await Promise.all([
    import('@/lib/page-fetcher'),
    import('@/lib/repositories/settingsRepository'),
  ]);
  return {
    fetchPageForPath: (slugPath: string) => fetchPageByPathForMetadata(slugPath, true),
    fetchRedirects: () => getSettingByKey('redirects') as Promise<Redirect[] | null>,
  };
}

async function getRedirects(deps: RouteExistenceDeps): Promise<Redirect[] | null> {
  if (redirectsCache && Date.now() - redirectsCache.at <= TTL_MS) {
    return redirectsCache.value;
  }
  const value = await deps.fetchRedirects();
  if (Array.isArray(value)) {
    redirectsCache = { value, at: Date.now() };
    return value;
  }
  return null;
}

/**
 * `true` only when the published site has nothing at this path — no page, no collection
 * item, no redirect. Every other outcome, including any failure, is `false`.
 */
export async function isMissingSiteRoute(
  pathname: string,
  injected?: RouteExistenceDeps,
): Promise<boolean> {
  if (!isCheckableSitePath(pathname)) return false;

  const cached = readCached(pathname);
  if (cached !== null) return cached;

  try {
    const deps = injected ?? (await defaultDeps());

    // A path that redirects is not missing — and the redirect is issued by the page, so it
    // must be allowed to render. Skipping this check would silently swap every 301 on the
    // site for a 404.
    const redirects = await getRedirects(deps);
    if (redirects && matchRedirect(pathname, redirects)) {
      writeCached(pathname, false);
      return false;
    }

    const slugPath = pathname.replace(/^\/+/, '').replace(/\/+$/, '');
    if (slugPath === '') return false;

    const page = await deps.fetchPageForPath(slugPath);
    const missing = page == null;
    writeCached(pathname, missing);
    return missing;
  } catch {
    // Infrastructure failure — say nothing and let the page render as it always did.
    // Deliberately NOT cached: a cached failure is how a blip becomes a permanent 404.
    return false;
  }
}

/** Test-only: drop every cached answer. */
export function __resetRouteExistenceCache(): void {
  answers.clear();
  redirectsCache = null;
}
