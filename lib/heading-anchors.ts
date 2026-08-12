import type { Layer } from '@/types';
import { getLayerHtmlTag } from '@/lib/layer-utils';

/**
 * Heading anchor ids — ONE definition, used by every renderer (SCA-1313).
 *
 * Anchors let an answer engine cite a passage rather than a whole page, and table-of-contents
 * deep links target them directly. That makes the slug format a compatibility surface: change it
 * in one renderer and every existing link into a page rendered by that path breaks, silently,
 * with the page still returning 200.
 *
 * `0eeb9ee` introduced this logic twice on purpose — SSR (`page-fetcher`) and client
 * (`text-format-utils`) — mirrored by hand so hydration keeps the ids. Adding a third copy for
 * page-builder heading layers would have made three hand-synchronised copies of a compatibility
 * surface. They are all this module now.
 *
 * The format deliberately matches `tools/gen_article.py`'s `slugify` in the static generator, so
 * deep links minted before the Ycode migration still resolve.
 */

const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

/** Is this rendered tag a heading that should carry an anchor? */
export function isHeadingTag(tag: string | null | undefined): boolean {
  return !!tag && HEADING_TAGS.has(tag.toLowerCase());
}

/** Flatten a Tiptap node to its visible text. */
export function tiptapPlainText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const n = node as { type?: string; text?: string; content?: unknown[] };
  if (n.type === 'text') return n.text || '';
  if (!Array.isArray(n.content)) return '';
  return n.content.map(tiptapPlainText).join('');
}

interface HeadingTextLayer {
  variables?: { text?: { type?: string; data?: { content?: unknown } } | null } | null;
  children?: HeadingTextLayer[] | null;
}

/**
 * Visible text of a heading LAYER, for deriving its anchor.
 *
 * Three shapes occur in real pages and all three matter:
 *  - `static_text` / `dynamic_text` — plain string content.
 *  - `dynamic_rich_text` — a Tiptap doc. This is what the page builder actually produces for
 *    headings; a first version of this function skipped it and derived anchors for exactly zero
 *    of 155 headings while every unit test passed.
 *  - a container heading (`<h2>` wrapping child text layers) — text lives in descendants.
 *
 * Returns '' when the text genuinely cannot be determined, and callers must then skip the
 * heading: no id is a missing feature, whereas a WRONG id is a broken deep link that still
 * returns 200.
 */
export function headingLayerText(layer: HeadingTextLayer, depth = 0): string {
  const variable = layer.variables?.text;
  const content = variable?.data?.content;

  if (typeof content === 'string'
    && (variable?.type === 'static_text' || variable?.type === 'dynamic_text')) {
    return content;
  }
  if (variable?.type === 'dynamic_rich_text' && content) {
    return tiptapPlainText(content);
  }

  // Container heading: concatenate descendant text. Bounded so a pathological tree cannot
  // turn anchor derivation into a deep walk on every render.
  if (depth < 4 && Array.isArray(layer.children)) {
    return layer.children.map((child) => headingLayerText(child, depth + 1)).join(' ').trim();
  }
  return '';
}

/** Slugify heading text into an anchor id. Empty/symbol-only text falls back to `section`. */
export function headingAnchorSlug(text: string): string {
  const base = text
    .replace(/<[^>]+>/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s-]+/g, '-')
    .slice(0, 60);
  return base || 'section';
}

/**
 * Per-document registry that makes repeated heading text deterministic: the first "Overview" is
 * `overview`, the next `overview-2`, then `overview-3`.
 *
 * First occurrence is deliberately unsuffixed so anchors minted before duplicates existed keep
 * working — the common case is a page gaining a second "FAQ" heading later, and suffixing the
 * original then would break every link already pointing at it.
 */
export function createHeadingAnchorRegistry(): (text: string) => string {
  const seen = new Map<string, number>();
  return (text: string): string => {
    const base = headingAnchorSlug(text);
    const nth = (seen.get(base) || 0) + 1;
    seen.set(base, nth);
    return nth > 1 ? `${base}-${nth}` : base;
  };
}

/**
 * layerId → anchor id, for O(1) anchor resolution and for emitting heading ids.
 *
 * There were FOUR copies of this walk — page-fetcher, the static exporter, and one private to
 * each of the two renderers — and the two private ones are what the live pages actually use.
 * Extending only the shared-looking one produced a fix that passed every unit test and changed
 * nothing on the page (SCA-1313). One implementation now, imported everywhere.
 *
 * An author-set id always wins; derived anchors fill only headings that have none.
 */
export function buildAnchorMap(layers: Layer[]): Record<string, string> {
  const map: Record<string, string> = {};
  const nextAnchor = createHeadingAnchorRegistry();

  const traverse = (layerList: Layer[]) => {
    for (const layer of layerList) {
      const explicitId = layer.settings?.id || layer.attributes?.id;
      if (explicitId) {
        map[layer.id] = explicitId;
      } else if (isHeadingTag(getLayerHtmlTag(layer))) {
        const text = headingLayerText(layer as never);
        if (text.trim()) map[layer.id] = nextAnchor(text);
      }
      if (layer.children) traverse(layer.children);
    }
  };

  traverse(layers);
  return map;
}
