/**
 * Asset MIME policy — one place that decides which MIME types may be STORED,
 * and how a stored type is allowed to be SERVED.
 *
 * Written for the stored-XSS hole in `/ycode/api/files/register` (audit H3).
 * `register` took the client's `mimeType` verbatim, and `/a/{hash}/{name}`
 * echoes the stored value back as `Content-Type`. `/a/` shares the builder's
 * origin, so a member — or a stolen member session — could register an asset
 * as `text/html` and get a same-origin URL that executes.
 *
 * Two rules, deliberately separate:
 *
 *   STORE  `isAllowedAssetMimeType` — an unconditional allowlist. The category
 *          check (`validateCategoryMimeType`) is NOT a substitute: it returns
 *          null whenever `category` is null, and the file manager uploads with
 *          `category: null`, so on the real upload path it decides nothing.
 *
 *   SERVE  `resolveAssetResponseSecurity` — the serve path re-derives its
 *          headers from the stored value instead of trusting it. Rows written
 *          before this policy existed still hold whatever they were given, and
 *          the store rule cannot retroactively clean them.
 *
 * SVG survives the store rule on purpose: `image/svg+xml` is legitimately
 * allowed for the icons category (lib/asset-constants.ts). An SVG is an active
 * document — it runs script when a browser NAVIGATES to it — so the store rule
 * cannot be the only defense, which is what the serve rule is for.
 */

import { ALLOWED_MIME_TYPES } from './asset-constants';
import { ALLOWED_FONT_MIME_TYPES } from './font-utils';

/**
 * UPLOAD rule input: every MIME type a file-manager category accepts.
 * This is what `files/upload` and `files/presign` already police.
 */
const ALLOWED_ASSET_MIME_TYPES: ReadonlySet<string> = new Set(
  Object.values(ALLOWED_MIME_TYPES).flat().map((type) => type.toLowerCase())
);

/**
 * Site code assets. Fonts, stylesheets and scripts are uploaded through the
 * MCP publishing path into `website/`, not through a file-manager category, so
 * they are absent from ALLOWED_MIME_TYPES yet are served through `/a/` in
 * quantity.
 *
 * Counted in this project's `assets` table on 2026-09-03, rows WITH a
 * storage_path (i.e. actually reachable at /a/):
 *
 *   image/webp      595      video/mp4    22      font/woff2    8
 *   text/css        132      video/webm    4
 *   text/javascript 112      image/svg+xml 0  (icons are stored inline)
 *
 * That measurement is the reason this set exists. Deriving the serve rule from
 * ALLOWED_MIME_TYPES alone downgraded 252 live assets — every stylesheet,
 * script and font on the site — to `application/octet-stream`, which `nosniff`
 * then makes the browser REFUSE for `<link rel=stylesheet>` and `<script src>`.
 * The upload allowlist was never the set of things this route serves.
 */
const SITE_CODE_MIME_TYPES: ReadonlySet<string> = new Set([
  'text/css',
  'text/javascript',
  'application/javascript',
  'application/x-javascript',
]);

/**
 * SERVE rule input: everything legitimately reachable at `/a/`. Broader than
 * the upload allowlist by design — see SITE_CODE_MIME_TYPES.
 */
const SERVEABLE_MIME_TYPES: ReadonlySet<string> = new Set([
  ...ALLOWED_ASSET_MIME_TYPES,
  ...ALLOWED_FONT_MIME_TYPES.map((type) => type.toLowerCase()),
  ...SITE_CODE_MIME_TYPES,
]);

/**
 * MIME types a browser parses as an ACTIVE document — one that runs script in
 * the response's own origin when navigated to. This, not "unfamiliar", is what
 * the hole actually turned on.
 *
 * `text/xml` and `application/xml` are here because XSLT can transform an XML
 * document into HTML. `text/css` and `text/javascript` are NOT: they are only
 * code when something already trusted includes them, and navigating to one
 * renders inert text.
 */
const ACTIVE_DOCUMENT_MIME_TYPES: ReadonlySet<string> = new Set([
  'image/svg+xml',
  'text/html',
  'application/xhtml+xml',
  'text/xml',
  'application/xml',
  'application/xslt+xml',
]);

/** Served when the stored type is missing or not on the allowlist. */
export const FALLBACK_MIME_TYPE = 'application/octet-stream';

/**
 * Reduce a MIME type to its bare, comparable form: lowercased, parameters
 * (`; charset=utf-8`) dropped, whitespace trimmed.
 *
 * Without this, `IMAGE/SVG+XML` and `text/html; charset=utf-8` would both miss
 * every set lookup below — failing open on the store rule and failing to
 * harden on the serve rule.
 */
export function normalizeMimeType(mimeType: string | null | undefined): string {
  if (!mimeType) return '';
  return mimeType.split(';')[0].trim().toLowerCase();
}

/** Is this MIME type one a file-manager upload category accepts? (STORE rule) */
export function isAllowedAssetMimeType(mimeType: string | null | undefined): boolean {
  return ALLOWED_ASSET_MIME_TYPES.has(normalizeMimeType(mimeType));
}

/** Is this MIME type one the asset proxy legitimately serves? (SERVE rule) */
export function isServeableMimeType(mimeType: string | null | undefined): boolean {
  return SERVEABLE_MIME_TYPES.has(normalizeMimeType(mimeType));
}

/** Would a browser run script in this type when navigated to directly? */
export function isActiveDocumentMimeType(mimeType: string | null | undefined): boolean {
  return ACTIVE_DOCUMENT_MIME_TYPES.has(normalizeMimeType(mimeType));
}

/**
 * The store rule. Returns an error message for a MIME type that may not be
 * stored, or null when it may.
 *
 * Phrased like the sibling routes' errors (`presign`, `upload`) so the file
 * manager surfaces one voice regardless of which upload path ran.
 */
export function validateStorableMimeType(mimeType: string | null | undefined): string | null {
  if (!isAllowedAssetMimeType(mimeType)) {
    return 'File type is not allowed';
  }
  return null;
}

export interface AssetResponseSecurity {
  /** The Content-Type to actually send — derived, never the raw stored value. */
  contentType: string;
  /** Security headers to merge into the response. */
  headers: Record<string, string>;
}

/**
 * The serve rule. Given whatever is stored on the row, decide the headers the
 * asset proxy sends.
 *
 * - The Content-Type is re-derived from the stored value against
 *   SERVEABLE_MIME_TYPES, never guessed from the filename or the URL extension
 *   (the `/a/` name segment is cosmetic and attacker-influenced, so sniffing it
 *   would just reintroduce the hole through a different door).
 * - `X-Content-Type-Options: nosniff` on everything.
 * - Active-document types get BOTH `Content-Disposition: attachment` and
 *   `Content-Security-Policy: sandbox` (see the measurement note below). SVG
 *   keeps its honest `image/svg+xml` — the guards, not a type downgrade, are
 *   what make it safe, and downgrading would break every icon.
 * - A stored type that is not serveable at all is downgraded to
 *   `application/octet-stream` and served as an attachment. This is what
 *   protects rows registered before the store rule existed.
 *
 * Measured in Chrome, four header regimes over one byte-identical scripted SVG
 * (2026-09-03):
 *
 *   regime                     <img>   CSS bg   script on navigate/iframe
 *   Content-Type only          renders renders  EXECUTES
 *   + nosniff                  renders renders  EXECUTES
 *   + Content-Disposition      renders renders  blocked
 *   + CSP: sandbox             renders renders  blocked
 *
 * Two results drove the choice. First, `nosniff` alone does NOT stop an SVG —
 * it prevents type SNIFFING, and `image/svg+xml` needs no sniffing to be
 * treated as a document. It closes the `text/html` mislabeling door and
 * nothing else, so it could not have been the whole fix. Second, neither
 * `Content-Disposition: attachment` nor `CSP: sandbox` breaks any way this
 * codebase actually consumes an SVG: both still render in `<img>` (123x45
 * naturalWidth, same as the control) and as a CSS `background-image`. Content-
 * Disposition governs NAVIGATION, not subresource loading, which is why the
 * `<img>` path is untouched.
 *
 * Since both were free, both ship. They fail differently and so cover
 * different consumers: `Content-Disposition` stops a document being created at
 * all, and `CSP: sandbox` blocks script and same-origin access for anything
 * that ignores Content-Disposition.
 */
export function resolveAssetResponseSecurity(
  storedMimeType: string | null | undefined
): AssetResponseSecurity {
  const normalized = normalizeMimeType(storedMimeType);
  const isServeable = isServeableMimeType(normalized);
  const isActiveDocument = isActiveDocumentMimeType(normalized);

  // A serveable type keeps its honest value (SVG included — see above). Anything
  // else is not a type we are willing to assert, so it becomes opaque bytes.
  const contentType = isServeable ? normalized : FALLBACK_MIME_TYPE;

  const headers: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
  };

  // Anything scriptable, plus anything we no longer recognise, is served in a
  // form that cannot become an executing same-origin document.
  if (!isServeable || isActiveDocument) {
    headers['Content-Disposition'] = 'attachment';
    headers['Content-Security-Policy'] = 'sandbox';
  }

  return { contentType, headers };
}
