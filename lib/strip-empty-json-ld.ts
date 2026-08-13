/**
 * Drop `application/ld+json` blocks whose RESOLVED content is empty (SCA-1290).
 *
 * CMS-driven schema is authored as a template — `<script type="application/ld+json">{{FAQ
 * Schema}}</script>` — and the placeholder resolves to nothing for any item that does not carry
 * that field. The tag itself was emitted unconditionally, so 85 of 113 /insight/* pages shipped an
 * empty schema block: the ones with no FAQPage data.
 *
 * Empty schema blocks are not merely untidy. They are noise for crawlers, and they are a
 * false-positive magnet for exactly the kind of grep-based audit that found them — every future
 * "does this page have schema?" check has to special-case them or be wrong.
 *
 * Deliberately general rather than a template-level conditional on the FAQ field: this protects
 * every CMS-driven schema block, including ones nobody has written yet. A per-field `{{#if}}`
 * would fix this instance and leave the next one to be discovered the same way.
 *
 * Whitespace-only counts as empty, since a template that renders to a newline is the same nothing.
 * Only ld+json is touched — other script types may legitimately be empty placeholders that
 * something later fills in.
 */

const EMPTY_JSON_LD = /[ \t]*<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>\s*<\/script>\s*\n?/gi;

export function stripEmptyJsonLd(html: string): string {
  if (!html || !html.includes('ld+json')) return html;
  return html.replace(EMPTY_JSON_LD, '');
}
