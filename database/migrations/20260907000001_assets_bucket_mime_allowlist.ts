import type { Knex } from 'knex';
import { ALLOWED_MIME_TYPES } from '../../lib/asset-constants';
import { ALLOWED_FONT_MIME_TYPES } from '../../lib/font-utils';

/**
 * Migration: pin `storage.buckets.assets.allowed_mime_types` (SCA-1470, security-plan #8).
 *
 * WRITTEN AFTER THE FACT. The allowlist was applied straight to the live bucket on
 * 2026-09-06 and never had a repository migration, so a rebuild from this checkout would
 * have produced a bucket with `allowed_mime_types = NULL` — every type accepted, including
 * the `text/html` and `image/svg+xml` this deliberately excludes. Codex's round-3 review
 * called that out as provenance drift (`audits/2026-09-06/codex-round3.md`, residual #1).
 * This file closes the gap; the accompanying `public.migrations` row records it as applied,
 * because it already is.
 *
 * DERIVED, NOT RETYPED. The 41 entries are assembled from the fork's own constants — the
 * same derivation SCA-1470 used — so a future asset-type change is a one-place edit:
 *
 *   ALLOWED_MIME_TYPES         images 8 + videos 6 + audio 6 + documents 9   = 29
 *     ...minus `icons` (image/svg+xml)                                        −0 (excluded below)
 *   ALLOWED_FONT_MIME_TYPES    8, minus application/octet-stream              =  8
 *   CHROME_MIME_TYPES          the site's own css/js                          =  4
 *                                                                             ---
 *                                                                              41
 *
 * THREE DELIBERATE EXCLUSIONS, each of which is the point of the allowlist:
 *   - `text/html`               — an uploaded page served same-origin off a public bucket
 *   - `image/svg+xml`           — SVG is a script carrier; the fork's icons are INLINE svg
 *                                 markup in `assets.value`, not storage objects, so the
 *                                 real path loses nothing (census: 489 objects, 6 mimetypes,
 *                                 zero SVG)
 *   - `application/octet-stream`— the font-constant fallback, and a bypass for everything
 *                                 above if left in
 *
 * The assertion below is load-bearing: it fails the migration rather than silently WIDENING
 * a security control if those constants drift. A migration that quietly re-opens the bucket
 * would be worse than no migration.
 *
 * `public` and `file_size_limit` are deliberately NOT touched — the bucket is public by
 * design (every published page reads its images, CSS and JS anonymously) and the 50MB limit
 * predates this work. Rollback restores `NULL`, the pre-2026-09-06 state, which accepts
 * everything.
 */

/** The site's own chrome, uploaded by `sync-chrome.py` — not an "asset" in the builder sense. */
const CHROME_MIME_TYPES = [
  'text/css',
  'text/javascript',
  'application/javascript',
  'application/x-javascript',
];

/** Types that must never be accepted, whatever the constants say. */
const EXCLUDED = new Set(['image/svg+xml', 'application/octet-stream', 'text/html']);

export function buildAssetsBucketMimeAllowlist(): string[] {
  const list = [
    ...ALLOWED_MIME_TYPES.images,
    ...ALLOWED_MIME_TYPES.videos,
    ...ALLOWED_MIME_TYPES.audio,
    ...ALLOWED_MIME_TYPES.documents,
    ...ALLOWED_MIME_TYPES.icons,
    ...ALLOWED_FONT_MIME_TYPES,
    ...CHROME_MIME_TYPES,
  ].filter((m) => !EXCLUDED.has(m));

  const deduped = [...new Set(list)];

  if (deduped.length !== 41) {
    throw new Error(
      `[20260907000001] Expected 41 allowed MIME types for bucket 'assets', derived ${deduped.length}. `
        + 'The asset/font constants changed. Re-measure the live bucket and update this migration '
        + 'deliberately — do not relax the count to make it pass.',
    );
  }

  return deduped;
}

export async function up(knex: Knex): Promise<void> {
  // Idempotent by construction: an UPDATE to the same value is a no-op, and the row is
  // created by 20250101000006_create_storage_bucket.
  await knex.raw('update storage.buckets set allowed_mime_types = ?::text[] where id = ?', [
    `{${buildAssetsBucketMimeAllowlist().map((m) => `"${m}"`).join(',')}}`,
    'assets',
  ]);
}

export async function down(knex: Knex): Promise<void> {
  // NULL = accept anything, which is exactly the pre-SCA-1470 state.
  await knex.raw('update storage.buckets set allowed_mime_types = null where id = ?', ['assets']);
}
