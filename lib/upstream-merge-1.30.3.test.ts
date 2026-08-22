import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildTiptapDoc } from './mcp/utils';

/**
 * Pins the two judgement calls made when merging upstream 1.29.6 -> 1.30.3.
 *
 * Both are places where upstream and the fork fixed overlapping ground and the merge
 * kept a HYBRID. A future `git merge upstream/main` will re-offer upstream's version of
 * each; these tests are what makes that re-offer loud instead of silent.
 */

// ---------------------------------------------------------------------------
// 1. MCP markdown links: canonical shape, but NO blanket target/rel.
// ---------------------------------------------------------------------------

/** Pull the richTextLink mark off the first link in a built doc. */
function linkMarkFor(markdown: string): Record<string, unknown> | undefined {
  const doc = buildTiptapDoc([{ type: 'paragraph', text: markdown }]);
  const marks: Array<{ type?: string; attrs?: Record<string, unknown> }> = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as { marks?: typeof marks; content?: unknown[] };
    if (Array.isArray(n.marks)) marks.push(...n.marks);
    if (Array.isArray(n.content)) n.content.forEach(walk);
  };
  walk(doc);
  return marks.find((m) => m.type === 'richTextLink')?.attrs;
}

describe('MCP markdown links after the 1.30.3 merge', () => {
  test('the fixture actually produces a link mark at all', () => {
    // Population check: every assertion below passes vacuously if the parser stopped
    // emitting the mark, which is the failure mode that would matter most.
    assert.ok(linkMarkFor('see [our pricing](/pricing) here'),
      'expected a richTextLink mark — without one the rest of this suite tests nothing');
  });

  test('REGRESSION: the mark carries the canonical LinkSettings shape', () => {
    // The original bug (ddbfead, and upstream d7b770b independently): a bare
    // `{ href, linkType }` is ignored by generateLinkHref, so every MCP-authored
    // markdown link rendered as `#`.
    const attrs = linkMarkFor('see [our pricing](/pricing) here')!;
    assert.equal(attrs.type, 'url');
    assert.deepEqual(attrs.url, { type: 'dynamic_text', data: { content: '/pricing' } });
    assert.equal(attrs.href, undefined, 'the legacy flat href shape must not come back');
  });

  test('REGRESSION: links are NOT stamped nofollow / _blank wholesale', () => {
    // Upstream d7b770b adds target="_blank" rel="noopener noreferrer nofollow" to
    // EVERY markdown link. Deliberately not taken: our rich text is mostly internal
    // article links, and blanket nofollow discards internal link equity on a site
    // whose organic search is the point. Re-taking upstream's version fails here.
    const attrs = linkMarkFor('see [our pricing](/pricing) here')!;
    assert.equal(attrs.rel, undefined, 'blanket rel="…nofollow" would deoptimise internal links');
    assert.equal(attrs.target, undefined, 'blanket target="_blank" is a design decision, not a default');
  });
});

// ---------------------------------------------------------------------------
// 2. Image loading: upstream's lazy default AND the fork's attribute resolution.
// ---------------------------------------------------------------------------

const RENDERERS = [
  'components/LayerRendererPublic.tsx',
  'components/LayerRenderer.tsx',
] as const;

const sourceOf = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

describe('image loading after the 1.30.3 merge', () => {
  test('the scan finds an effectiveLoading site in both renderers', () => {
    // Population check first — a renamed variable would otherwise make every
    // assertion below pass against zero matches.
    for (const rel of RENDERERS) {
      assert.match(sourceOf(rel), /const effectiveLoading =/,
        `${rel} must still compute effectiveLoading`);
    }
  });

  test('upstream 1d6a175: a non-LCP image with no explicit value defaults to lazy', () => {
    // React 19 auto-emits <link rel="preload" as="image"> for any non-lazy <img>,
    // so an unset attribute would preload below-the-fold images.
    for (const rel of RENDERERS) {
      assert.match(sourceOf(rel), /isLcpCandidate \? 'eager' : \(imgLoadingAttr \?\? 'lazy'\)/,
        `${rel} must fall back to lazy for non-LCP images`);
    }
  });

  test('REGRESSION (SCA-1348): the served renderer still resolves via customAttributes', () => {
    // Upstream's version of this hunk reads `layer.attributes?.loading` only, which is
    // exactly what made a customAttributes `loading` write silently inert. Taking
    // upstream's line wholesale here would re-break SCA-1348 while looking like a
    // clean perf merge.
    assert.match(sourceOf('components/LayerRendererPublic.tsx'),
      /const imgLoadingAttr = resolveLayerAttribute\(layer, 'loading'\)/,
      'the served renderer must resolve loading from customAttributes OR attributes');
  });

  test('the LCP candidate is still forced eager', () => {
    for (const rel of RENDERERS) {
      assert.match(sourceOf(rel), /isLcpCandidate \? 'eager'/,
        `${rel} must keep forcing the LCP candidate eager`);
    }
  });
});
