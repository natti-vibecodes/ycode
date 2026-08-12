/**
 * The one contract for parking a `<script>` so the HTML parser skips it and client code
 * activates it later (SCA-1297).
 *
 * These constants used to live privately inside `CustomCodeInjector`. Head custom code needs the
 * exact same contract, and two copies of a marker string is precisely the kind of thing that
 * looks identical the day it is written and silently diverges the first time one side is edited —
 * at which point scripts park and never un-park, with no error anywhere.
 *
 * ── Why parking also fixes the React warning, and why that is not suppression ──
 *
 * React refuses to render an *executable* script element on the client. In
 * `react-dom-client.development.js` the script branch does
 * `nextResource.createElement("div")` — it substitutes a DIV — and logs "Encountered a script tag
 * while rendering React component…" unless `isScriptDataBlock(props)` is true. That helper reads
 * `props.type`: absent, empty, any JavaScript mime type, `module`, `importmap` or
 * `speculationrules` are executable (→ warn + become a div); ANY other non-empty type is a data
 * block (→ rendered untouched, no warning).
 *
 * So `application/ld+json` was never the problem and stays exactly as it is: it is data, React
 * leaves it alone, and it must remain in the served HTML for crawlers. It is the bare `<script>`
 * tags that were being warned about — and, on a client render, quietly turned into `<div>`s.
 *
 * Giving those the inert type below makes them data blocks by the same rule React already
 * applies, so the warning disappears *because the hazard it describes is gone*, not because it
 * was silenced. The genuine SCA-1253 signal — a real script tag reaching a client render —
 * still warns, which is the whole point of not muting it globally.
 */

/** Marker type that makes the parser skip a script — and makes React treat it as a data block. */
export const INERT_TYPE = 'text/ycode-deferred';

/** Attribute holding the original `type` while a script is parked, so activation can restore it. */
export const ORIGINAL_TYPE_ATTR = 'data-ycode-type';

/**
 * Executable per the HTML spec's classic-script rules — the same set React checks.
 * Absent or empty type means classic JavaScript, i.e. executable.
 */
const NON_EXECUTABLE_EXCEPTIONS = new Set(['module', 'importmap', 'speculationrules']);

const JS_MIME_TYPES = new Set([
  'application/ecmascript', 'application/javascript', 'application/x-ecmascript',
  'application/x-javascript', 'text/ecmascript', 'text/javascript', 'text/javascript1.0',
  'text/javascript1.1', 'text/javascript1.2', 'text/javascript1.3', 'text/javascript1.4',
  'text/javascript1.5', 'text/jscript', 'text/livescript', 'text/x-ecmascript',
  'text/x-javascript',
]);

/**
 * Does this `type` denote a script the browser would RUN?
 *
 * `application/ld+json`, `text/template`, and our own inert marker are not executable — they are
 * data, and must be left alone.
 */
export function isExecutableScriptType(type: string | null | undefined): boolean {
  if (type == null) return true;
  const normalised = type.trim().toLowerCase();
  if (normalised === '') return true;
  if (NON_EXECUTABLE_EXCEPTIONS.has(normalised)) return true; // module/importmap DO execute
  return JS_MIME_TYPES.has(normalised);
}
