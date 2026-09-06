/**
 * Upstream 1.30.12 — "perf: trim translation catalog from localized pages".
 *
 * Upstream landed `slimTranslations` on exactly the two functions our fork had already rewritten
 * to carry the one-retry-inside-`cache()` fix (SCA-1460), so the merge had to interleave them.
 * These guards pin the two properties that interleaving must preserve:
 *
 *   1. WHAT SURVIVES the slim — slug rows (page + CMS) and, on the server boundary only, seo
 *      rows. Drop a slug row and every localized link href silently points at the default locale;
 *      drop a seo row and localized <title>/description/OG image silently fall back. Both are
 *      invisible failures, so they get a test rather than a reading.
 *   2. THAT SLIMMING IS A SHAPE NARROWING OF AN ALREADY-RESOLVED VALUE — it must never turn a
 *      rejected read into a returned value, because `unstable_cache` stores what is RETURNED and
 *      a stored `null` is a permanent 404 (the audit #10 rule).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { slimTranslations } from '@/lib/locale-runtime';
import type { Translation } from '@/types';

/** Build a translation row keyed the way `getTranslatableKey` keys them. */
function row(source_type: Translation['source_type'], source_id: string, content_key: string): Translation {
  return {
    id: `${source_type}-${source_id}-${content_key}`,
    locale_id: 'locale-fr',
    source_type,
    source_id,
    content_key,
    content_type: 'text',
    content_value: `value:${content_key}`,
    is_completed: true,
    is_published: true,
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    deleted_at: null,
  };
}

/** A catalog with one of every row shape the fetchers actually produce. */
function catalog(): Record<string, Translation> {
  const rows = [
    row('page', 'page-1', 'slug'),
    row('cms', 'item-1', 'field:key:slug'),
    row('cms', 'item-2', 'field:id:field-slug'),
    row('page', 'page-1', 'seo:title'),
    row('page', 'page-1', 'seo:description'),
    row('page', 'page-1', 'seo:image'),
    row('page', 'page-1', 'layer:layer-1:text'),
    row('page', 'page-1', 'layer:layer-1:image_src'),
    row('page', 'page-1', 'layer:layer-1:image_alt'),
    row('component', 'comp-1', 'layer:layer-9:text'),
    row('page', 'page-1', 'layer:layer-2:override:image_src:var-1'),
  ];
  return Object.fromEntries(rows.map(r => [`${r.source_type}:${r.source_id}:${r.content_key}`, r]));
}

const keysOf = (t: Record<string, Translation> | undefined) => Object.values(t ?? {}).map(r => r.content_key).sort();

describe('1.30.12 slimTranslations — what survives', () => {
  test('the page slug row survives (localized page URLs)', () => {
    const slim = slimTranslations(catalog());
    assert.ok(keysOf(slim).includes('slug'), 'page slug row was dropped — localized URLs would fall back to the default locale');
  });

  test('REGRESSION: the CMS slug row survives — it is `field:key:slug`, not `slug`', () => {
    // The keep-test is `endsWith(':slug')`, not equality. A CMS item slug is `field:key:slug`;
    // an equality-only check would drop every localized article URL.
    const slim = slimTranslations(catalog());
    assert.ok(keysOf(slim).includes('field:key:slug'), 'CMS slug row was dropped — localized /insights/{slug} URLs would break');
  });

  test('text, media and component-override rows are dropped — they are already baked into the tree', () => {
    const dropped = keysOf(slimTranslations(catalog()));
    for (const key of ['layer:layer-1:text', 'layer:layer-1:image_src', 'layer:layer-1:image_alt', 'layer:layer-9:text', 'layer:layer-2:override:image_src:var-1']) {
      assert.ok(!dropped.includes(key), `${key} survived the slim — the payload bloat this change exists to remove is still there`);
    }
  });

  test('seo rows are dropped on the CLIENT boundary (the default)', () => {
    const slim = keysOf(slimTranslations(catalog()));
    for (const key of ['seo:title', 'seo:description', 'seo:image']) {
      assert.ok(!slim.includes(key), `${key} reached the client payload`);
    }
  });

  test('REGRESSION: seo rows survive on the SERVER boundary (includeSeo)', () => {
    // `withSlimTranslations` in page-fetcher passes `includeSeo: true`; generate-page-metadata
    // reads seo:title / seo:description / seo:image off exactly these rows.
    const slim = keysOf(slimTranslations(catalog(), { includeSeo: true }));
    for (const key of ['seo:title', 'seo:description', 'seo:image']) {
      assert.ok(slim.includes(key), `${key} was dropped from the server payload — localized metadata would silently fall back`);
    }
  });

  test('a field:id: slug binding is NOT kept by the endsWith test — documenting the actual contract', () => {
    // Pinning real behaviour rather than a wish: only `field:key:slug` ends with ':slug'.
    const slim = keysOf(slimTranslations(catalog(), { includeSeo: true }));
    assert.ok(!slim.includes('field:id:field-slug'));
  });
});

describe('1.30.12 slimTranslations — it is a narrowing, never a rescue', () => {
  test('null and undefined pass through as undefined, not as an empty catalog', () => {
    assert.equal(slimTranslations(null), undefined);
    assert.equal(slimTranslations(undefined), undefined);
  });

  test('an empty catalog slims to an empty catalog', () => {
    assert.deepEqual(slimTranslations({}), {});
  });

  test('the rows it keeps are the SAME objects, not rebuilt copies', () => {
    const full = catalog();
    const slim = slimTranslations(full, { includeSeo: true })!;
    assert.equal(slim['page:page-1:slug'], full['page:page-1:slug']);
  });

  test('the input catalog is not mutated', () => {
    const full = catalog();
    const before = Object.keys(full).length;
    slimTranslations(full);
    assert.equal(Object.keys(full).length, before, 'slimTranslations mutated its input — the server tree would lose rows too');
  });
});
