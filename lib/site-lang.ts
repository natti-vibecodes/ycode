import { cache } from 'react';
import { getSupabaseAdmin } from '@/lib/supabase-server';

/**
 * The document language for server-rendered HTML (audit item #16).
 *
 * The fork renders `<html>` only in `components/RootLayoutShell`, and public sites deliberately
 * passed no `lang` — the per-page locale was applied by `PageRenderer` with
 * `document.documentElement.lang = …`, a hydration-time script. So the SERVER response carried no
 * `lang` on 161/161 pages: screen readers choosing a voice, translation tooling, and every
 * non-hydrating consumer (crawlers, `curl`, AI agents) saw an unlabelled document.
 *
 * The layout cannot know the per-page locale without `headers()`, which would force every route
 * dynamic, so `<html lang>` carries the SITE default and `PageRenderer` keeps setting the
 * per-page locale on the `#ybody` wrapper (a nested `lang` legitimately overrides the outer one
 * for a locale-prefixed route).
 */
export const DEFAULT_SITE_LANG = 'en';

/** Reject anything that is not a plausible BCP-47 tag before it reaches an attribute. */
export function normalizeLangCode(code: unknown): string | null {
  if (typeof code !== 'string') return null;
  const trimmed = code.trim();
  if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * The site's default locale code, or `en`.
 *
 * Never throws: a missing or unreachable locales table must degrade to a labelled document,
 * not to a 500 — and must never fall back to *no* `lang`, which is the defect being fixed.
 */
export const fetchSiteLang = cache(async function fetchSiteLang(
  isPublished = true,
  tenantId?: string,
): Promise<string> {
  try {
    const supabase = await getSupabaseAdmin(tenantId);
    if (!supabase) return DEFAULT_SITE_LANG;

    const { data, error } = await supabase
      .from('locales')
      .select('code')
      .eq('is_default', true)
      .eq('is_published', isPublished)
      .is('deleted_at', null)
      .limit(1);

    if (error) return DEFAULT_SITE_LANG;
    return normalizeLangCode(data?.[0]?.code) || DEFAULT_SITE_LANG;
  } catch {
    return DEFAULT_SITE_LANG;
  }
});
