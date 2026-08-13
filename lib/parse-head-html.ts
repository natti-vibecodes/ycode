import React from 'react';
import { INERT_TYPE, ORIGINAL_TYPE_ATTR, isExecutableScriptType } from '@/lib/deferred-scripts';

/**
 * Maps lowercase HTML attribute names to their React/JSX camelCase equivalents.
 * Shared by head-HTML parsing and the layer renderers so imported markup never
 * leaks invalid DOM props (e.g. `fetchpriority`) onto React elements.
 */
export const HTML_TO_REACT_ATTRS: Record<string, string> = {
  'class': 'className',
  'for': 'htmlFor',
  'autofocus': 'autoFocus',
  'crossorigin': 'crossOrigin',
  'charset': 'charSet',
  'http-equiv': 'httpEquiv',
  'tabindex': 'tabIndex',
  'nomodule': 'noModule',
  'referrerpolicy': 'referrerPolicy',
  'fetchpriority': 'fetchPriority',
  'playsinline': 'playsInline',
  // Form attributes: case-only renames React wants in camelCase. Given the HTML spelling it
  // logs "Invalid DOM property" per occurrence — but it still passes the attribute through, so
  // the rendered markup was CORRECT all along (verified on the served page: the input carried
  // `autocomplete="email"` both before and after this map entry). The value here is therefore
  // the console staying readable, plus React handling these as the props it knows rather than
  // as unrecognised pass-throughs — not a rescued attribute (SCA-1309).
  'autocomplete': 'autoComplete',
  'novalidate': 'noValidate',
  'formnovalidate': 'formNoValidate',
  'formaction': 'formAction',
  'formmethod': 'formMethod',
  'formtarget': 'formTarget',
  'formenctype': 'formEncType',
  'enctype': 'encType',
  'acceptcharset': 'acceptCharset',
  'maxlength': 'maxLength',
  'minlength': 'minLength',
  'readonly': 'readOnly',
  'inputmode': 'inputMode',
  'enterkeyhint': 'enterKeyHint',
  'autocapitalize': 'autoCapitalize',
  'spellcheck': 'spellCheck',
  'autocorrect': 'autoCorrect',
  // General HTML attributes with the same problem.
  'accesskey': 'accessKey',
  'contenteditable': 'contentEditable',
  'datetime': 'dateTime',
  'srcset': 'srcSet',
  'usemap': 'useMap',
  'colspan': 'colSpan',
  'rowspan': 'rowSpan',
  // SVG presentation attributes. Imported markup (custom code, pasted icon sets)
  // carries these hyphenated; React wants camelCase and warns loudly for each
  // occurrence — one console error per icon on the page.
  'stroke-width': 'strokeWidth',
  'stroke-linecap': 'strokeLinecap',
  'stroke-linejoin': 'strokeLinejoin',
  'stroke-dasharray': 'strokeDasharray',
  'stroke-dashoffset': 'strokeDashoffset',
  'stroke-miterlimit': 'strokeMiterlimit',
  'stroke-opacity': 'strokeOpacity',
  'fill-rule': 'fillRule',
  'fill-opacity': 'fillOpacity',
  'clip-rule': 'clipRule',
  'clip-path': 'clipPath',
  'stop-color': 'stopColor',
  'stop-opacity': 'stopOpacity',
  'vector-effect': 'vectorEffect',
  'shape-rendering': 'shapeRendering',
  'text-anchor': 'textAnchor',
  'dominant-baseline': 'dominantBaseline',
  'paint-order': 'paintOrder',
};

const TAG_REGEX =
  /<(meta|link|base)(\s(?:[^>"']|"[^"]*"|'[^']*')*)?\s*\/?>|<(style|script|title|noscript)(\s[^>]*)?>[\s\S]*?<\/\3\s*>/gi;

function parseAttributes(attrString: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const regex = /([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+)))?/g;
  let match;
  while ((match = regex.exec(attrString)) !== null) {
    attrs[match[1]] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return attrs;
}

function toReactAttrs(attrs: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(attrs)) {
    result[HTML_TO_REACT_ATTRS[key.toLowerCase()] || key] = value;
  }
  return result;
}

function extractInnerHtml(full: string, tag: string): string {
  const m = full.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*)<\\/${tag}\\s*>`, 'i'));
  return m ? m[1] : '';
}

const STYLE_BLOCK_REGEX = /<style[^>]*>([\s\S]*?)<\/style\s*>/gi;
const LINK_TAG_REGEX = /<link(\s(?:[^>"']|"[^"]*"|'[^']*')*)?\s*\/?>/gi;

/**
 * Collects the `href` of every `<link rel="stylesheet">` in an HTML string.
 *
 * The builder canvas used to inject only `<style>` block contents, which meant a site whose
 * design system lives in an EXTERNAL stylesheet rendered unstyled in the editor while being
 * perfectly styled when published (SCA-1337). Here that is the whole hand-written layer —
 * `.nl-sec`, `.kick`, `.ins-row` and the rest — so every canvas edit was made against a
 * different set of rules than the page it was editing.
 *
 * Only `rel="stylesheet"` is admitted, matching the existing canvas rule that scripts and other
 * head HTML stay out of the sandbox. A stylesheet cannot execute JavaScript, so it does not widen
 * that boundary. `rel="preload" as="font"` is deliberately NOT admitted: the fonts already reach
 * the canvas through the `@font-face` rules in the injected `<style>` block, and a preload is a
 * fetch-priority hint with no rendering effect — admitting it would add network traffic to the
 * editor and change nothing on screen.
 */
export function extractStylesheetHrefs(html: string | null | undefined): string[] {
  if (!html) return [];
  const hrefs: string[] = [];
  LINK_TAG_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = LINK_TAG_REGEX.exec(html)) !== null) {
    const attrs = parseAttributes(match[1] || '');
    // `rel` is a space-separated token list, so compare tokens rather than the whole value.
    const rels = (attrs.rel || '').toLowerCase().split(/\s+/);
    if (!rels.includes('stylesheet')) continue;
    const href = attrs.href?.trim();
    if (href && !hrefs.includes(href)) hrefs.push(href);
  }
  return hrefs;
}

/**
 * Concatenates the inner CSS of every `<style>` block in an HTML string.
 * Used by the builder canvas to live-preview user-defined CSS variables
 * declared in custom head code, without executing any `<script>` tags.
 */
export function extractStyleBlockContents(html: string | null | undefined): string {
  if (!html) return '';
  const parts: string[] = [];
  STYLE_BLOCK_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = STYLE_BLOCK_REGEX.exec(html)) !== null) {
    const inner = match[1].trim();
    if (inner) parts.push(inner);
  }
  return parts.join('\n');
}

/**
 * Renders global head HTML as React elements for direct placement inside
 * the root layout's <head>. Bypasses next/script to avoid self.__next_s
 * serialization — the browser executes scripts during head parsing.
 */
export function renderRootLayoutHeadCode(html: string, prefix = 'global-head'): React.ReactNode[] {
  const elements: React.ReactNode[] = [];
  TAG_REGEX.lastIndex = 0;

  let match;
  let idx = 0;

  while ((match = TAG_REGEX.exec(html)) !== null) {
    const voidTag = match[1]?.toLowerCase();
    const voidAttrStr = match[2] || '';
    const pairedTag = match[3]?.toLowerCase();
    const pairedAttrStr = match[4] || '';

    // Third-party scripts (AdSense, GTM, etc.) mutate their own head tags at
    // runtime (e.g. adding `data-checked-head`), so the live DOM diverges from
    // the SSR markup. suppressHydrationWarning silences these expected diffs.
    if (voidTag) {
      const attrs = toReactAttrs(parseAttributes(voidAttrStr.trim()));
      elements.push(React.createElement(voidTag, { key: `${prefix}-${idx++}`, suppressHydrationWarning: true, ...attrs }));
    } else if (pairedTag === 'script') {
      const attrs = parseAttributes(pairedAttrStr.trim());
      const inner = extractInnerHtml(match[0], 'script');
      const reactAttrs = toReactAttrs(attrs);
      const props: Record<string, unknown> = {
        key: `${prefix}-${idx++}`,
        suppressHydrationWarning: true,
        ...reactAttrs,
      };

      // An EXECUTABLE script cannot survive a client render: React substitutes a <div> for it
      // and warns (see lib/deferred-scripts.ts for the exact rule it applies). Park it with the
      // inert marker instead — the parser skips it, React treats it as a data block and leaves
      // it alone, and HeadScriptActivator clones it into a live script after hydration.
      //
      // Data scripts — `application/ld+json` above all — are deliberately untouched: React
      // already renders them correctly, and they must stay in the served HTML for crawlers.
      if (isExecutableScriptType(attrs.type)) {
        if (attrs.type) props[ORIGINAL_TYPE_ATTR] = attrs.type;
        props.type = INERT_TYPE;
      }

      if (inner) {
        props.dangerouslySetInnerHTML = { __html: inner };
      }
      elements.push(React.createElement('script', props));
    } else if (pairedTag === 'style') {
      const attrs = toReactAttrs(parseAttributes(pairedAttrStr.trim()));
      const inner = extractInnerHtml(match[0], 'style');
      elements.push(
        React.createElement('style', {
          key: `${prefix}-${idx++}`,
          suppressHydrationWarning: true,
          ...attrs,
          dangerouslySetInnerHTML: { __html: inner },
        }),
      );
    } else if (pairedTag === 'title') {
      const inner = extractInnerHtml(match[0], 'title');
      elements.push(React.createElement('title', { key: `${prefix}-${idx++}`, suppressHydrationWarning: true }, inner));
    } else if (pairedTag) {
      const attrs = toReactAttrs(parseAttributes(pairedAttrStr.trim()));
      const inner = extractInnerHtml(match[0], pairedTag);
      elements.push(
        React.createElement(pairedTag, {
          key: `${prefix}-${idx++}`,
          suppressHydrationWarning: true,
          ...attrs,
          dangerouslySetInnerHTML: { __html: inner },
        }),
      );
    }
  }

  return elements;
}

/**
 * Attributes a site wants rendered on `<html>` by the server.
 *
 * Declared in global custom head code next to the pre-paint script it complements:
 *
 *   <meta name="ycode:html-attributes" content='{"data-theme":"light"}'>
 *
 * Why this exists: a script in custom head code CANNOT durably set attributes on `<html>`.
 * It executes at parse time as expected, but React strips attributes it does not know about
 * when it hydrates `<html>`, so a pre-paint theme stamp is applied and then silently removed
 * — taking every `[data-theme=…]` rule with it and leaving the site unstyled. Declaring them
 * here renders them into the served markup instead, which both survives hydration and removes
 * the flash of unthemed content the pre-paint script was there to prevent.
 *
 * Only `data-*`, `class`, `lang` and `dir` are allowed: enough for theming and locale, while
 * keeping arbitrary attributes (and anything event-handler shaped) off the root element.
 */
const ALLOWED_HTML_ATTR = /^(data-[a-z0-9-]+|class|lang|dir)$/i;

export function extractHtmlAttributes(html: string | null | undefined): Record<string, string> {
  if (!html) return {};

  const meta = /<meta\b[^>]*\bname\s*=\s*["']ycode:html-attributes["'][^>]*>/i.exec(html);
  if (!meta) return {};

  const content = /\bcontent\s*=\s*("([^"]*)"|'([^']*)')/i.exec(meta[0]);
  const raw = content?.[2] ?? content?.[3];
  if (!raw) return {};

  let parsed: unknown;
  try {
    // Custom code is authored by hand, so a stray quote must not take the page down —
    // an unparseable declaration degrades to "no attributes", not a 500.
    parsed = JSON.parse(raw.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&'));
  } catch {
    return {};
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!ALLOWED_HTML_ATTR.test(key)) continue;
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    out[key === 'class' ? 'className' : key] = String(value);
  }
  return out;
}
