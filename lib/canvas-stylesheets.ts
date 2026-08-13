/**
 * Keeps the builder canvas iframe's external stylesheets in sync with head custom code (SCA-1337).
 *
 * Split out of Canvas.tsx so the reconciliation is testable without a browser: the interesting
 * behaviour is not "a link gets added" but what happens on the SECOND run — a naive implementation
 * that clears and re-adds every link refetches the stylesheet on every unrelated edit, and the
 * canvas flashes unstyled each time. That is invisible in code review and obvious to whoever is
 * using the editor all day.
 */

/** Marks the links this module owns, so user/Ycode links in the iframe head are never touched. */
export const CUSTOM_STYLESHEET_MARKER = 'data-ycode-custom-stylesheet';

/**
 * Reconciles the marked `<link rel="stylesheet">` elements in `head` against `hrefs`.
 *
 * Appends new links in the given order and removes ones no longer wanted. Links that are already
 * present are LEFT IN PLACE — re-creating an unchanged `<link>` triggers a fresh network fetch and
 * a repaint, so surviving links must survive untouched.
 */
export function syncCustomStylesheetLinks(head: HTMLHeadElement, hrefs: string[]): void {
  const marked = () =>
    [...head.querySelectorAll(`link[${CUSTOM_STYLESHEET_MARKER}]`)] as HTMLLinkElement[];

  const wanted = new Set(hrefs);
  for (const el of marked()) {
    if (!wanted.has(el.getAttribute('href') || '')) el.remove();
  }

  const present = new Set(marked().map((el) => el.getAttribute('href') || ''));
  for (const href of hrefs) {
    if (present.has(href)) continue;
    const link = head.ownerDocument.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.setAttribute(CUSTOM_STYLESHEET_MARKER, '');
    head.appendChild(link);
  }
}
