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
export type MountPoint = 'body-start' | 'body-end' | 'before-layers';

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

export interface SplitCustomCode {
  /** Chunks declaring body-start, in document order, to render before page content. */
  bodyStart: string;
  /** Everything else, rendered where custom code has always gone. */
  rest: string;
  /**
   * Chunks declaring body-end, rendered AFTER the page's own custom body code (SCA-1369).
   *
   * The footer needs this. Global body code renders before page custom code, which is correct
   * for a page whose content lives in its LAYER TREE — nav, layers, footer. But the 20 case
   * studies keep ~75 KB of content in page custom code with an empty layer tree, so they served
   * NAV → FOOTER → CONTENT: the footer at the top of the page.
   *
   * Symmetric to body-start rather than reordering the two injectors: swapping global and page
   * body code wholesale would silently change ordering on EVERY page, including page-body scripts
   * written on the assumption that global code has already run.
   */
  bodyEnd: string;
  /**
   * Chunks declaring before-layers, rendered before the page's LAYER TREE (SCA-1371).
   *
   * Page-level only. The 20 case studies keep their whole article in page custom_code.body with
   * an empty layer tree, so their content rendered after everything else on the page. Declaring
   * this moves it ahead of the layer tree while leaving it exactly where it is in the server
   * HTML — inline and crawlable.
   *
   * That last property is the reason this exists rather than an htmlEmbed migration: embeds are
   * a sandboxed iframe or client-side innerHTML, so moving 20 ranking pages into them would pull
   * their content out of the crawlable response.
   */
  beforeLayers: string;
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
  if (!html || !html.includes(MOUNT_ATTR)) return { bodyStart: '', rest: html ?? '', bodyEnd: '', beforeLayers: '' };

  const picked: Record<MountPoint, string[]> = { 'body-start': [], 'body-end': [], 'before-layers': [] };
  let rest = '';
  let cursor = 0;

  // Walk TOP-LEVEL nodes only, checking each one's own opening tag for the marker.
  //
  // The previous implementation regex-scanned the whole string, which lifted NESTED declarations
  // out of their parents — leaving `<div class="wrap"></div>` behind and moving the child
  // elsewhere. That is exactly the DOM surgery this module's header says it removes, and the
  // header claimed nested markers were already ignored. They were not; the comment described an
  // intent the code never had (found while adding body-end, SCA-1369). Nothing in the live
  // chrome relies on the old behaviour — only `<div class="navwrap">` declares a mount, and it is
  // top-level — so the fix is to make the code match the documented, safer rule.
  const openTag = /<([a-zA-Z][\w-]*)\b[^>]*>/g;
  const declares = new RegExp(`\\b${MOUNT_ATTR}\\s*=\\s*["'](body-start|body-end|before-layers)["']`, 'i');

  for (;;) {
    openTag.lastIndex = cursor;
    const hit = openTag.exec(html);
    if (!hit) break;

    // Skip HTML comments before looking at tags. A comment may CONTAIN tag-like text, and this
    // chrome's own DO-NOT-REMOVE comments do: the first one explains that Ycode "server-renders
    // this element at the start of <body>". Matching that `<body>` as an element made the walk
    // hunt for a `</body>` that does not exist, hit the unclosed-element guard, and abandon the
    // scan on its very first iteration — so NOTHING was routed and every mount silently went
    // inert. The nav still appeared first only because `rest` preserves document order and the
    // nav happens to be first in the file, which is what hid it (SCA-1369 regression).
    const commentStart = html.indexOf('<!--', cursor);
    if (commentStart !== -1 && commentStart < hit.index) {
      const commentEnd = html.indexOf('-->', commentStart);
      if (commentEnd === -1) break; // unterminated comment: leave the remainder exactly as authored
      rest += html.slice(cursor, commentEnd + 3);
      cursor = commentEnd + 3;
      continue;
    }

    const end = findElementEnd(html, hit.index, hit[1]);
    // Unclosed element: leave everything from here on exactly as authored rather than guess.
    if (end === -1) break;

    const declared = declares.exec(hit[0]);
    if (declared) {
      rest += html.slice(cursor, hit.index);
      picked[declared[1].toLowerCase() as MountPoint].push(html.slice(hit.index, end));
    } else {
      // Not a mount: keep the element AND anything before it, and do not descend into it.
      rest += html.slice(cursor, end);
    }
    cursor = end;
  }

  rest += html.slice(cursor);
  return {
    bodyStart: picked['body-start'].join('\n'),
    rest,
    bodyEnd: picked['body-end'].join('\n'),
    beforeLayers: picked['before-layers'].join('\n'),
  };
}
