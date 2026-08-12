/**
 * Declarative mount points for global custom code (SCA-1253 / SCA-1251).
 *
 * Sites keep their nav in custom code, which renders at the END of the page. A sticky nav has
 * to be at the START of the body, so the convention has been a script that moves it there on
 * load. That move is the problem: custom-code scripts run from an effect, and an effect can
 * fire before React has finished hydrating the rest of the tree — so the DOM changes underneath
 * hydration, hydration fails, and React re-renders on the client, where it does NOT execute
 * scripts inside dangerouslySetInnerHTML. Every custom-code behaviour dies at once, silently.
 *
 * The fix is to stop moving anything: an element declares where it belongs and the server
 * renders it there.
 *
 *   <div class="navwrap" data-ycode-mount="body-start"> … </div>
 *
 * Same shape as the `ycode:html-attributes` meta — a declaration the server honours, rather
 * than the renderer special-casing one site's class name.
 *
 * The marker must sit on a TOP-LEVEL element of the custom-code block. Nested markers are
 * ignored: moving an element out of its parent is exactly the DOM surgery this removes.
 */

export const MOUNT_ATTR = 'data-ycode-mount';
export type MountPoint = 'body-start';

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

export interface SplitCustomCode {
  /** Chunks declaring body-start, in document order, to render before page content. */
  bodyStart: string;
  /** Everything else, rendered where custom code has always gone. */
  rest: string;
}

/**
 * Find the end index of the element starting at `openStart`, by counting same-name tags.
 * Returns -1 when the element is never closed, in which case the caller leaves it alone —
 * malformed custom code should render exactly as before, not silently lose a chunk.
 */
function findElementEnd(html: string, openStart: number, tag: string): number {
  if (VOID_TAGS.has(tag)) {
    const gt = html.indexOf('>', openStart);
    return gt === -1 ? -1 : gt + 1;
  }
  const open = new RegExp(`<${tag}\\b`, 'gi');
  const close = new RegExp(`</${tag}\\s*>`, 'gi');
  let depth = 0;
  let cursor = openStart;
  for (;;) {
    open.lastIndex = cursor;
    close.lastIndex = cursor;
    const nextOpen = open.exec(html);
    const nextClose = close.exec(html);
    if (!nextClose) return -1;
    if (nextOpen && nextOpen.index < nextClose.index) {
      depth++;
      cursor = nextOpen.index + nextOpen[0].length;
      continue;
    }
    depth--;
    cursor = nextClose.index + nextClose[0].length;
    if (depth === 0) return cursor;
  }
}

/**
 * Split custom-code HTML into declared-mount chunks and the remainder.
 *
 * Returns the input untouched as `rest` when nothing is declared, so sites that never opt in
 * are byte-for-byte unaffected.
 */
export function splitCustomCodeByMount(html: string | null | undefined): SplitCustomCode {
  if (!html || !html.includes(MOUNT_ATTR)) return { bodyStart: '', rest: html ?? '' };

  const marker = new RegExp(`<([a-zA-Z][\\w-]*)\\b[^>]*\\b${MOUNT_ATTR}\\s*=\\s*["']body-start["'][^>]*>`, 'gi');
  const picked: string[] = [];
  let rest = '';
  let cursor = 0;

  for (;;) {
    marker.lastIndex = cursor;
    const hit = marker.exec(html);
    if (!hit) break;

    // Only top-level elements may declare a mount point. Anything nested is left in place.
    const before = html.slice(cursor, hit.index);
    const end = findElementEnd(html, hit.index, hit[1]);
    if (end === -1) break;

    rest += before;
    picked.push(html.slice(hit.index, end));
    cursor = end;
  }

  rest += html.slice(cursor);
  return { bodyStart: picked.join('\n'), rest };
}
