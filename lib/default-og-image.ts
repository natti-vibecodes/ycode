/**
 * Site-level default social image (SCA-1111).
 *
 * A page that sets no SEO image of its own used to ship no `og:image` and no
 * `twitter:image` at all, and its Twitter card was downgraded to `summary`.
 * On a site with 161 pages the per-page alternative is 161 writes; the engine
 * is the right place for a default, so `generate-page-metadata` reads the
 * `default_og_image` setting and falls back to it.
 *
 * Deliberately dependency-free so the decisions below are testable without
 * `server-only`, Supabase, or React cache. `generate-page-metadata` imports
 * these functions rather than re-implementing them — a copy in a test would
 * prove nothing about what actually renders.
 */

/** How a `default_og_image` setting value should be resolved. */
export type DefaultOgImageSource =
  | { kind: 'url'; url: string }
  | { kind: 'asset'; assetId: string };

/**
 * Classify a `default_og_image` setting value.
 *
 * Two shapes are accepted so the setting can be pointed at an uploaded asset
 * (same resolution path as a per-page SEO image, so it survives re-uploads and
 * goes through the `/a/` proxy) or at a literal URL. A value that is neither an
 * absolute URL nor a root-relative path is treated as an asset ID.
 */
export function classifyDefaultOgImage(value: unknown): DefaultOgImageSource | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw) || raw.startsWith('/')) return { kind: 'url', url: raw };
  return { kind: 'asset', assetId: raw };
}

/**
 * Pick the social image for a page: its own SEO image when it has one, the site
 * default otherwise. Root-relative URLs are made absolute against the site base
 * URL — social crawlers reject relative `og:image` values.
 */
export function pickSocialImageUrl(
  pageImageUrl: string | null | undefined,
  defaultImageUrl: string | null | undefined,
  siteBaseUrl: string | null | undefined,
): string | null {
  const chosen = pageImageUrl || defaultImageUrl || null;
  if (!chosen) return null;
  if (chosen.startsWith('/') && siteBaseUrl) return `${siteBaseUrl}${chosen}`;
  return chosen;
}

/**
 * Twitter card type. A card with an image is `summary_large_image`; without
 * one Twitter renders the small `summary` card.
 */
export function twitterCardFor(imageUrl: string | null | undefined): 'summary_large_image' | 'summary' {
  return imageUrl ? 'summary_large_image' : 'summary';
}
