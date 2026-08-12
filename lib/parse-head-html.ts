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
  // Form attributes. Every one of these is a case-only rename React refuses to accept in its
  // HTML spelling: it logs "Invalid DOM property" and DROPS the prop, so `autocomplete="email"`
  // authored on a layer silently never reached the input. Console noise was the visible half;
  // the attribute quietly not applying was the real cost (SCA-1309).
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
