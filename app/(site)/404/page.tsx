import type { Metadata } from 'next';
import SiteNotFound, { siteNotFoundMetadata } from '@/components/SiteNotFound';

/**
 * The site's 404 document, served with a real HTTP 404 (SCA-1465).
 *
 * WHY A ROUTE AND NOT `notFound()`:
 * `notFound()` thrown from the matched catch-all page produces the right STATUS and the
 * wrong DOCUMENT. Next 16.3 has no server-side not-found boundary for that case — the RSC
 * render aborts and `getErrorRSCPayload` emits a hardcoded `<html id="__next_error__">`
 * with an empty `<body>`, no `lang`, no nav, no heading and no links. The real 404 UI is
 * replayed from the inlined flight payload *after hydration*, so a browser looks fine while
 * Googlebot and every non-hydrating consumer receive an empty page. Verified to be stock
 * Next behaviour, not a fork defect: a vanilla 16.3.0 app with `app/not-found.tsx` and a
 * catch-all that calls `notFound()` serves the same empty shell.
 *
 * WHY THE STATUS IS CORRECT HERE:
 * Next forces `res.statusCode = 404` for the page whose route path is exactly `/404`
 * (`isNotFoundPath` in `renderToHTMLOrFlightImpl`, app-render.js) — the same rule that makes
 * the Pages-router `/404` work. So this route renders as a normal page (root layout, `lang`,
 * global chrome, full SSR) and still answers 404. `proxy.ts` rewrites a missing URL here.
 *
 * `force-dynamic` keeps the document off the build-time prerender — the 404 page's content
 * and the global chrome both come from the database, and a baked build artifact would go
 * stale on the next publish. The data behind it is cached with the `all-pages` tag, so the
 * render is cheap and refreshes when a publish invalidates.
 */
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return siteNotFoundMetadata();
}

export default async function NotFoundRoute() {
  return <SiteNotFound />;
}
