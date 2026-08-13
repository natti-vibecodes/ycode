/**
 * Mirrors the served document's `<html>` attributes onto the builder canvas iframe (SCA-1343).
 *
 * `app/(site)/layout.tsx` stamps the attributes declared in global head custom code — here
 * `data-theme="light"` — onto the root element of every served page. Plenty of CSS is keyed on
 * them, so a canvas that loads the real stylesheets without the root context resolves those rules
 * to the WRONG branch: sections that are light on the site render dark in the editor.
 *
 * That regression arrived with SCA-1337. Before it, the canvas loaded none of this CSS, so the
 * missing root context could not be observed — loading the stylesheets is what made the absent
 * theme marker start mattering. The two belong together.
 *
 * Deliberately driven by `extractHtmlAttributes` over the same global head code the server reads,
 * rather than by copying a served page's root element:
 *
 *   1. Reading the declaration means dark mode (SCA-1302) flips the canvas the day it flips the
 *      site, with no second fix here.
 *   2. A served root also carries `nav-armed reveal-armed lenis`, added by site.js at runtime.
 *      Copying those into a scriptless canvas would be actively harmful — every pre-entrance
 *      animation state is gated on `html.reveal-armed`, so stamping it hides content that no
 *      script will ever reveal. The declaration contains only what the SERVER stamps, which is
 *      exactly the set the canvas wants.
 */

import { extractHtmlAttributes } from '@/lib/parse-head-html';

/** Records which attributes this module stamped, so removing a declaration removes the attribute. */
const STAMPED_LIST_ATTR = 'data-ycode-stamped-attrs';

/**
 * Reads the `ycode:html-attributes` declaration from global head custom code and returns the
 * attributes in DOM form. `extractHtmlAttributes` renames `class` to `className` for React's
 * benefit; `setAttribute` needs the HTML spelling back.
 */
export function canvasRootAttributes(globalCustomCodeHead: string | null | undefined): Record<string, string> {
  const attrs = extractHtmlAttributes(globalCustomCodeHead);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(attrs)) {
    out[key === 'className' ? 'class' : key] = value;
  }
  return out;
}

/**
 * Applies `attrs` to `root`, removing any attribute this module stamped on a previous run that is
 * no longer declared. Attributes set by anyone else are never touched — the canvas iframe's root
 * belongs to the browser and to Ycode, not to us.
 */
export function syncCanvasRootAttributes(root: HTMLElement, attrs: Record<string, string>): void {
  const previous = (root.getAttribute(STAMPED_LIST_ATTR) || '').split(',').filter(Boolean);

  for (const name of previous) {
    if (!(name in attrs)) root.removeAttribute(name);
  }
  for (const [name, value] of Object.entries(attrs)) {
    if (root.getAttribute(name) !== value) root.setAttribute(name, value);
  }

  const names = Object.keys(attrs);
  if (names.length) root.setAttribute(STAMPED_LIST_ATTR, names.join(','));
  else root.removeAttribute(STAMPED_LIST_ATTR);
}
