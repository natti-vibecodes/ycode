import type { Metadata } from 'next';
import SiteNotFound, { siteNotFoundMetadata } from '@/components/SiteNotFound';

/**
 * Next's `notFound()` boundary for public pages.
 *
 * 🔴 In Next 16.3 this boundary is only ever rendered on the CLIENT when `notFound()`
 * is thrown from a matched page (SCA-1465). The RSC render aborts, Next recovers with a
 * hardcoded `<html id="__next_error__">` shell (`getErrorRSCPayload`, app-render.js), and the
 * real 404 UI is replayed from the inlined flight payload after hydration — so the SERVER
 * HTML a crawler receives is an empty document. That is why missing URLs are routed to
 * `/404` in `proxy.ts` instead. This file stays as the fallback for anything that still
 * throws `notFound()`, and shares its markup with the `/404` route.
 */
export async function generateMetadata(): Promise<Metadata> {
  return siteNotFoundMetadata();
}

export default async function NotFound() {
  return <SiteNotFound />;
}
