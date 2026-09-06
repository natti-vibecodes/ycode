import Link from 'next/link';
import type { Metadata } from 'next';
import { unstable_cache } from 'next/cache';
import { fetchErrorPage, slimPageData } from '@/lib/page-fetcher';
import { fetchGlobalPageSettings, generatePageMetadata } from '@/lib/generate-page-metadata';
import { getSettingByKey } from '@/lib/repositories/settingsRepository';
import { tenantStore } from '@/lib/supabase-server';
import PageRenderer from '@/components/PageRenderer';
import YcodeBadge from '@/components/YcodeBadge';

/**
 * The site's 404 document, rendered from ONE implementation for both places that
 * can serve it (SCA-1465):
 *
 *   - `app/(site)/404/page.tsx` — the route `proxy.ts` rewrites a missing URL to.
 *     This is the one visitors and crawlers actually reach, and the only one whose
 *     HTML is produced on the SERVER.
 *   - `app/(site)/not-found.tsx` — Next's `notFound()` boundary. Still wired up as a
 *     safety net for any `notFound()` that is thrown outside the rewrite's reach, but
 *     Next 16.3 only renders it on the client (see the route file for why).
 *
 * Two copies of this markup is exactly how a fix reaches one surface and not the
 * other, so they share this component instead.
 */

/** Cached lookup of the user's custom 404 page, invalidated on publish. */
export function fetchCachedCustom404(tenantId?: string) {
  return unstable_cache(
    async () => {
      const data = await fetchErrorPage(404, true, tenantId);
      return data ? slimPageData(data) : null;
    },
    ['error-404'],
    { tags: ['all-pages'], revalidate: false }
  )();
}

/**
 * Metadata for a 404 response.
 *
 * 🔴 Do NOT emit our own robots meta here (audit #22). Next renders
 * `<meta name="robots" content="noindex">` for any response whose status is > 400
 * (`NonIndex` in next/dist/server/app-render/app-render.js), so anything we add is a SECOND,
 * conflicting robots tag on the same document — the served 404 carried both `noindex` and
 * `noindex, nofollow`. One directive, emitted by the layer that knows the status code.
 */
export async function siteNotFoundMetadata(): Promise<Metadata> {
  const tenantId = tenantStore.getStore();
  const errorPageData = await fetchCachedCustom404(tenantId).catch(() => null);
  const metadata: Metadata = errorPageData
    ? await generatePageMetadata(errorPageData.page)
    : { title: 'Page not found' };

  delete metadata.robots;
  return metadata;
}

/**
 * Renders the user's custom 404 page when one exists, otherwise a default fallback.
 */
export default async function SiteNotFound() {
  const tenantId = tenantStore.getStore();

  const errorPageData = await fetchCachedCustom404(tenantId).catch(() => null);

  if (errorPageData) {
    const globalSettings = await fetchGlobalPageSettings().catch(() => null);
    const { page, pageLayers, components } = errorPageData;

    return (
      <PageRenderer
        page={page}
        layers={pageLayers.layers || []}
        components={components}
        generatedCss={globalSettings?.publishedCss || undefined}
        colorVariablesCss={globalSettings?.colorVariablesCss || undefined}
        globalCustomCodeHead={globalSettings?.globalCustomCodeHead}
        globalCustomCodeBody={globalSettings?.globalCustomCodeBody}
        ycodeBadge={globalSettings?.ycodeBadge ?? true}
      />
    );
  }

  let showBadge = true;
  try {
    const setting = await getSettingByKey('ycode_badge');
    showBadge = setting ?? true;
  } catch {
    // Supabase not configured
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-white">
      <div className="text-center max-w-md px-4">
        <h1 className="text-6xl font-bold text-gray-900 mb-4">404</h1>
        <h2 className="text-2xl font-semibold text-gray-800 mb-4">Page Not Found</h2>
        <p className="text-gray-600 mb-8">
          The page you&apos;re looking for doesn&apos;t exist or has been moved.
        </p>
        <Link
          href="/"
          className="inline-block px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
        >
          Go Home
        </Link>
      </div>
      {showBadge && <YcodeBadge />}
    </div>
  );
}
