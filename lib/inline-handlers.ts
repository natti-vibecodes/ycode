/**
 * Inline `on*` handlers from custom attributes (SCA-1380).
 *
 * React does not render a lowercase `onclick` prop — it drops it and warns "Invalid event handler
 * property `onclick`. Did you mean `onClick`?". Passing a STRING to `onClick` would not work
 * either; React expects a function. So an inline handler authored in custom attributes silently
 * never reaches the DOM.
 *
 * That was not cosmetic. The carousel prev/next buttons on ~10 pages carry
 *   onclick="this.closest('section').querySelector('.rail3').scrollBy({left:-380,…})"
 * and the served markup had the buttons, had `.rail3`, and had ZERO onclick attributes. The arrows
 * rendered and did nothing, with only a console warning to say so.
 *
 * Applied with setAttribute rather than addEventListener, deliberately: the authored code relies on
 * inline-handler semantics, where `this` is the element. `this.closest('section')` is the whole
 * mechanism — an addEventListener wrapper would bind `this` differently and break exactly the
 * pattern this exists to support.
 */

/**
 * Standard HTML event-handler content attributes.
 *
 * A regex like /^on[a-z]+$/ looks equivalent and is not: it also matches `once` and `only`, which
 * are ordinary attributes. Stripping those would quietly remove real attributes from the DOM to
 * fix a different bug — so this is an explicit list rather than a pattern. My own test caught it.
 */
const INLINE_HANDLER_NAMES = new Set([
  'onclick', 'ondblclick', 'onmousedown', 'onmouseup', 'onmouseover', 'onmousemove',
  'onmouseout', 'onmouseenter', 'onmouseleave', 'onwheel', 'oncontextmenu',
  'onkeydown', 'onkeypress', 'onkeyup',
  'onfocus', 'onblur', 'onchange', 'oninput', 'onsubmit', 'onreset', 'onselect', 'oninvalid',
  'onload', 'onerror', 'onscroll', 'onresize',
  'ontouchstart', 'ontouchend', 'ontouchmove', 'ontouchcancel',
  'onpointerdown', 'onpointerup', 'onpointermove', 'onpointerenter', 'onpointerleave',
  'ondragstart', 'ondrag', 'ondragend', 'ondragenter', 'ondragover', 'ondragleave', 'ondrop',
  'onplay', 'onpause', 'onended', 'ontimeupdate', 'oncanplay', 'onanimationend',
  'ontransitionend', 'ontoggle', 'oncopy', 'oncut', 'onpaste',
]);

export interface SplitAttributes {
  /** `on*` attributes, to be applied to the DOM node after mount. */
  handlers: Record<string, string>;
  /** Everything else, safe to hand to React as props. */
  attributes: Record<string, string>;
}

/**
 * Separate inline event handlers from ordinary attributes.
 *
 * TAKES AN AUTHOR-WRITTEN ATTRIBUTE MAP (`settings.customAttributes`) — always strings, never
 * React props. Matching is therefore case-insensitive: React drops a STRING `onClick` exactly as
 * it drops `onclick`, so both need rescuing. Do not point this at a React props object.
 *
 * Only names on the explicit event list are treated as handlers. React's own camelCase props
 * (`onClick`) are left alone — those are real function props and must not be stripped — and so are
 * ordinary attributes that merely begin with "on", like `once`.
 */
export function splitInlineHandlers(attrs: Record<string, string> | undefined | null): SplitAttributes {
  const handlers: Record<string, string> = {};
  const attributes: Record<string, string> = {};
  for (const [name, value] of Object.entries(attrs ?? {})) {
    if (INLINE_HANDLER_NAMES.has(name.toLowerCase()) && typeof value === 'string') handlers[name] = value;
    else attributes[name] = value;
  }
  return { handlers, attributes };
}

/**
 * Apply inline handlers to a mounted node.
 *
 * Idempotent: re-applying the same code is a no-op, so a re-render cannot stack duplicates.
 */
export function applyInlineHandlers(el: Element | null, handlers: Record<string, string>): void {
  if (!el) return;
  for (const [name, code] of Object.entries(handlers)) {
    if (el.getAttribute(name) === code) continue;
    el.setAttribute(name, code);
  }
}
