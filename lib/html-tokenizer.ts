/**
 * A small, spec-shaped tokenizer for hand-authored HTML fragments (SCA-1458).
 *
 * Why this exists: every place in the fork that reads authored HTML with a regex has eventually
 * parsed prose out of an HTML COMMENT as if it were markup. The head parser did it on 2026-09-06
 * and took the whole site down twice from one paragraph of explanatory text:
 *
 *   - a comment containing the word "link" in angle brackets produced a phantom `<link>` element
 *     in `<head>` and a sitewide "Hydration failed" on every page;
 *   - a comment containing "script" in angle brackets matched the paired branch of the same
 *     regex, whose non-greedy body ran forward to the next REAL `</script>` and swallowed the
 *     font preloads, both stylesheet links and the token `<style>` block into one phantom
 *     script — i.e. it silently removed the site's CSS.
 *
 * The mount-marker walker had the same class of bug a week earlier (a comment containing
 * `<body>` aborted its scan on the first iteration and made every declared mount inert).
 * So the fix is not "strip comments at each call site" — it is one tokenizer that understands
 * comments, quoted attribute values and raw-text elements, and which every reader shares.
 *
 * Deliberately NOT a DOM parser: head custom code is a flat fragment, and the readers built on
 * this want a linear stream of tags in source order, exactly as the old regex produced. No tree
 * is built and no nesting is implied.
 */

/**
 * Elements whose content is raw text, not markup. A `<`, a comment, or a tag name inside one of
 * these is content and must never be tokenized — which is what makes a commented-out line inside
 * a `<script>` block, and a CSS `content: "</style>"` string, behave.
 */
const RAW_TEXT_TAGS = new Set(['script', 'style', 'title', 'textarea', 'noscript', 'xmp', 'iframe']);

/** Elements that never have content, so a missing `/>` is not malformed input. */
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

export interface HtmlTag {
  /** Tag name, lowercased. */
  name: string;
  /**
   * Attributes, keyed by the name as AUTHORED (case preserved, matching the parser this
   * replaces). Values are the raw source text between the quotes; entities are not decoded,
   * because every current consumer either re-emits the value verbatim or decodes it itself.
   * A valueless attribute maps to `''`.
   */
  attrs: Record<string, string>;
  /** Index of the `<` that opens the element. */
  start: number;
  /** Index one past the end of the element — past `>` for a void/self-closing tag, past the
   *  closing `</name>` for a raw-text element. */
  end: number;
  /** Index one past the `>` of the OPENING tag. */
  openEnd: number;
  /** Raw text content for raw-text elements; `''` for everything else. */
  content: string;
  /** The opening tag ended in `/>`. */
  selfClosing: boolean;
}

/** Half-open `[start, end)` source ranges covered by HTML comments. */
export type CommentRange = readonly [number, number];

/**
 * Every `<!-- … -->` range in the string, in source order.
 *
 * An unterminated comment runs to the end of the input, which is what the HTML parser does and
 * what makes "half a comment" fail safe rather than turning the rest of the document into markup.
 */
export function commentRanges(html: string): CommentRange[] {
  const ranges: CommentRange[] = [];
  let i = 0;
  for (;;) {
    const open = html.indexOf('<!--', i);
    if (open === -1) return ranges;
    const close = html.indexOf('-->', open + 4);
    if (close === -1) {
      ranges.push([open, html.length]);
      return ranges;
    }
    ranges.push([open, close + 3]);
    i = close + 3;
  }
}

/** True when `index` falls inside one of `ranges` (which must be sorted, as `commentRanges` returns). */
export function isInsideComment(ranges: readonly CommentRange[], index: number): boolean {
  for (const [start, end] of ranges) {
    if (index < start) return false;
    if (index < end) return true;
  }
  return false;
}

/** Attribute-name characters, per the HTML tokenizer's attribute-name state. */
function isAttrNameChar(ch: string): boolean {
  return !/[\s/>=]/.test(ch);
}

/**
 * Read the opening tag starting at `start` (the index of `<`).
 * Returns null when it is not a tag opening — a stray `<`, a comment, a doctype, a close tag.
 */
function readOpenTag(
  html: string,
  start: number,
): { name: string; attrs: Record<string, string>; openEnd: number; selfClosing: boolean } | null {
  if (html[start] !== '<') return null;
  const first = html[start + 1];
  if (!first || !/[a-zA-Z]/.test(first)) return null;

  let i = start + 1;
  while (i < html.length && !/[\s/>]/.test(html[i])) i++;
  const name = html.slice(start + 1, i).toLowerCase();

  const attrs: Record<string, string> = {};
  let selfClosing = false;

  for (;;) {
    while (i < html.length && /\s/.test(html[i])) i++;
    if (i >= html.length) return { name, attrs, openEnd: html.length, selfClosing };

    if (html[i] === '>') return { name, attrs, openEnd: i + 1, selfClosing };
    if (html[i] === '/') {
      // `/` only self-closes immediately before `>`; anywhere else the HTML tokenizer
      // discards it, so do not let a stray slash end the tag early.
      if (html[i + 1] === '>') return { name, attrs, openEnd: i + 2, selfClosing: true };
      i++;
      continue;
    }

    const nameStart = i;
    while (i < html.length && isAttrNameChar(html[i])) i++;
    if (i === nameStart) { i++; continue; } // defensive: never fail to advance
    const attrName = html.slice(nameStart, i);

    while (i < html.length && /\s/.test(html[i])) i++;
    if (html[i] !== '=') { attrs[attrName] = ''; continue; }

    i++; // past '='
    while (i < html.length && /\s/.test(html[i])) i++;
    const quote = html[i];
    if (quote === '"' || quote === "'") {
      const close = html.indexOf(quote, i + 1);
      if (close === -1) { attrs[attrName] = html.slice(i + 1); return { name, attrs, openEnd: html.length, selfClosing }; }
      attrs[attrName] = html.slice(i + 1, close);
      i = close + 1;
    } else {
      const valueStart = i;
      while (i < html.length && !/[\s>]/.test(html[i])) i++;
      attrs[attrName] = html.slice(valueStart, i);
    }
  }
}

/**
 * Yield every tag in a fragment, in source order, skipping comments, doctypes and bogus
 * comments entirely.
 *
 * Flat by design: a tag nested inside another non-raw-text element is yielded too, exactly as
 * the regex this replaces did.
 *
 * A raw-text element with no closing tag is SKIPPED rather than yielded, and scanning resumes
 * after its opening tag. That matches the old regex's effective behaviour (its paired branch
 * simply failed to match, and later tags were still found) and fails safe: one malformed
 * element is lost instead of every tag after it being swallowed as script content.
 */
export function* tokenizeTags(html: string): Generator<HtmlTag> {
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) return;

    if (html.startsWith('<!--', lt)) {
      const close = html.indexOf('-->', lt + 4);
      if (close === -1) return; // unterminated comment: the rest of the input is comment
      i = close + 3;
      continue;
    }

    // Doctype, CDATA, processing instruction, bogus comment, or a closing tag: not an element.
    if (html.startsWith('<!', lt) || html.startsWith('<?', lt) || html.startsWith('</', lt)) {
      const gt = html.indexOf('>', lt);
      if (gt === -1) return;
      i = gt + 1;
      continue;
    }

    const open = readOpenTag(html, lt);
    if (!open) { i = lt + 1; continue; } // a stray '<' in text

    if (!open.selfClosing && RAW_TEXT_TAGS.has(open.name)) {
      const close = new RegExp(`</${open.name}\\s*>`, 'i');
      const rest = html.slice(open.openEnd);
      const hit = close.exec(rest);
      if (!hit) { i = open.openEnd; continue; } // unclosed raw text: skip it, keep scanning
      const contentEnd = open.openEnd + hit.index;
      yield {
        name: open.name,
        attrs: open.attrs,
        start: lt,
        openEnd: open.openEnd,
        end: contentEnd + hit[0].length,
        content: html.slice(open.openEnd, contentEnd),
        selfClosing: false,
      };
      i = contentEnd + hit[0].length;
      continue;
    }

    yield {
      name: open.name,
      attrs: open.attrs,
      start: lt,
      openEnd: open.openEnd,
      end: open.openEnd,
      content: '',
      selfClosing: open.selfClosing || VOID_TAGS.has(open.name),
    };
    i = open.openEnd;
  }
}
