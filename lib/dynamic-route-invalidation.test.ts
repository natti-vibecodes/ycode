/**
 * SCA-1486. Publishing a dynamic template left every one of its item routes cached.
 *
 * Measured by Natalia on 2026-09-07: she pressed Publish with the `insight-article` template
 * queued, and all 113 `/insight/<slug>` pages kept serving the OLD template while
 * `/dynamic/insight/<slug>` (uncached) showed the new one. A global settings write — which runs
 * `clearAllCache` — fixed every page at once. So the publish itself was fine; the selective purge
 * was EMPTY.
 *
 * Cause: `resolveDynamicPageRoutes` found the collection's slug field with
 * `.eq('key', 'slug')`, and `collection_fields.key` is NULL on every field in this workspace —
 * 70 of 70 on Insights, 36 of 36 on Case Studies, measured against the live database the same
 * day. The lookup matched nothing, the loop hit `continue`, and a dynamic page expanded to ZERO
 * routes. Same empty-population failure as llms.txt shipping a description on 0 of 109 articles
 * (CLAUDE.md: "CMS field `key` is NULL on every field in this workspace — match fields by
 * `name`").
 *
 * These tests drive the REAL `getRoutePathsForPages` / `selectiveInvalidation` /
 * `invalidateForCollectionChange` against a filtering in-memory Supabase fake whose fixture has
 * the workspace's actual shape: `key` NULL on every field, `name` "Slug", and the page carrying
 * `settings.cms.slug_field_id`. The assertions are on the ROUTES that came out, with the expected
 * population stated first — a route list that silently shrinks to zero is exactly what shipped.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/* eslint-disable @typescript-eslint/no-require-imports */
// require(), not import: these modules are stubbed in require.cache before the code under test
// loads, and hoisted imports cannot express that ordering.

function stub(specifier: string, exports: Record<string, unknown>) {
  const path = require.resolve(specifier);
  require.cache[path] = {
    id: path, filename: path, loaded: true, exports,
  } as unknown as NodeModule;
}

stub('server-only', {});

/** Every tag handed to the cache layer during a test. */
let purgedTags: string[] = [];
stub('next/cache', {
  revalidateTag: (tag: string) => { purgedTags.push(tag); },
  revalidatePath: () => {},
  unstable_cache: (fn: unknown) => fn,
});
stub('@vercel/functions', {
  invalidateByTag: async (tag: string) => { purgedTags.push(tag); },
});

// ---------------------------------------------------------------------------
// Fixture: one static page, one dynamic template bound to a 3-item collection.
// `key` is NULL on every field, exactly as in the live workspace.
// ---------------------------------------------------------------------------

const COLLECTION_ID = 'col-insights';
const SLUG_FIELD_ID = 'field-slug';
const TEMPLATE_PAGE_ID = 'page-insight-article';
const STATIC_PAGE_ID = 'page-about';

/** The published items. Stated as the expected population before anything is measured. */
const PUBLISHED_SLUGS = ['ai-in-diligence', 'design-debt', 'pricing-pages'];
const EXPECTED_ITEM_ROUTES = PUBLISHED_SLUGS.map((s) => `insight/${s}`);

function fixture() {
  return {
    pages: [
      {
        id: STATIC_PAGE_ID, slug: 'about', name: 'About', is_dynamic: false, is_index: false,
        is_published: true, page_folder_id: null, deleted_at: null, error_page: null, settings: {},
      },
      {
        id: TEMPLATE_PAGE_ID, slug: 'insight-article', name: 'Insight Article', is_dynamic: true,
        is_index: false, is_published: true, page_folder_id: 'folder-insight', deleted_at: null,
        error_page: null,
        settings: { cms: { collection_id: COLLECTION_ID, slug_field_id: SLUG_FIELD_ID } },
      },
    ],
    page_folders: [
      { id: 'folder-insight', slug: 'insight', page_folder_id: null, is_published: true, deleted_at: null },
    ],
    locales: [{ id: 'loc-en', code: 'en', is_default: true, is_published: true, deleted_at: null }],
    translations: [],
    // Draft and published rows share an id, as they do in the real table.
    collection_fields: [true, false].flatMap((is_published) => [
      { id: 'field-title', collection_id: COLLECTION_ID, key: null, name: 'Title', is_published, deleted_at: null },
      { id: SLUG_FIELD_ID, collection_id: COLLECTION_ID, key: null, name: 'Slug', is_published, deleted_at: null },
    ]),
    collection_items: [
      ...PUBLISHED_SLUGS.map((s, i) => ({
        id: `item-${i}`, collection_id: COLLECTION_ID, is_published: true, deleted_at: null,
      })),
      // A draft-only item: it must NOT produce a route.
      { id: 'item-draft', collection_id: COLLECTION_ID, is_published: false, deleted_at: null },
    ],
    collection_item_values: [
      ...PUBLISHED_SLUGS.map((s, i) => ({
        item_id: `item-${i}`, field_id: SLUG_FIELD_ID, value: s, is_published: true, deleted_at: null,
      })),
      { item_id: 'item-draft', field_id: SLUG_FIELD_ID, value: 'not-live', is_published: false, deleted_at: null },
    ],
    page_layers: [
      // The template's layers reference the collection id, which is how a collection publish
      // reaches the template through findAffectedPages.
      {
        page_id: TEMPLATE_PAGE_ID, is_published: false, deleted_at: null,
        layers: [{ id: 'l1', settings: { collectionId: COLLECTION_ID } }],
      },
      { page_id: STATIC_PAGE_ID, is_published: false, deleted_at: null, layers: [{ id: 'l2' }] },
    ],
    components: [],
  } as Record<string, Record<string, unknown>[]>;
}

let db = fixture();

/**
 * A Supabase query-builder fake that actually FILTERS. A canned-response fake would pass whether
 * or not the slug lookup matched anything, which is the assertion-that-cannot-fail trap.
 */
function makeQueryBuilder(rows: Record<string, unknown>[]) {
  let current = rows;
  let limited: number | null = null;
  const builder: Record<string, unknown> = {};
  const result = () => ({ data: limited === null ? current : current.slice(0, limited), error: null });

  builder.select = () => builder;
  builder.order = () => builder;
  builder.eq = (col: string, value: unknown) => {
    current = current.filter((r) => r[col] === value);
    return builder;
  };
  builder.neq = (col: string, value: unknown) => {
    current = current.filter((r) => r[col] !== value);
    return builder;
  };
  builder.in = (col: string, values: unknown[]) => {
    current = current.filter((r) => values.includes(r[col]));
    return builder;
  };
  builder.is = (col: string, value: unknown) => {
    current = current.filter((r) => (r[col] ?? null) === value);
    return builder;
  };
  builder.not = (col: string, op: string, value: unknown) => {
    if (op === 'is') current = current.filter((r) => (r[col] ?? null) !== value);
    return builder;
  };
  builder.ilike = () => builder;
  builder.limit = (n: number) => { limited = n; return builder; };
  builder.single = () => Promise.resolve(
    current.length === 1 ? { data: current[0], error: null } : { data: null, error: { message: 'no rows' } },
  );
  builder.then = (resolve: (r: unknown) => unknown) => resolve(result());
  return builder;
}

const supabaseServer = require('@/lib/supabase-server');
supabaseServer.getSupabaseAdmin = async () => ({
  from: (table: string) => makeQueryBuilder([...(db[table] ?? [])]),
});
supabaseServer.getSupabaseConfig = async () => ({ projectUrl: 'https://example.supabase.co' });

const cacheService = require('@/lib/services/cacheService');

beforeEach(() => {
  db = fixture();
  purgedTags = [];
});

describe('a dynamic template expands to its item routes (SCA-1486)', () => {
  test('REGRESSION: publishing the template resolves one route per collection item', async () => {
    // Population, stated before measuring: 3 published items → 3 routes. The bug returned 0.
    assert.equal(PUBLISHED_SLUGS.length, 3, 'fixture has three published items');

    const routes = await cacheService.getRoutePathsForPages([TEMPLATE_PAGE_ID]);
    assert.deepEqual(routes.sort(), [...EXPECTED_ITEM_ROUTES].sort());
  });

  test('the template itself contributes no {slug} placeholder route', async () => {
    const routes = await cacheService.getRoutePathsForPages([TEMPLATE_PAGE_ID]);
    assert.equal(routes.some((r: string) => r.includes('{slug}')), false);
    assert.equal(routes.includes('insight/insight-article'), false);
  });

  test('draft items produce no route — only published ones are live URLs', async () => {
    const routes = await cacheService.getRoutePathsForPages([TEMPLATE_PAGE_ID]);
    assert.equal(routes.includes('insight/not-live'), false);
    assert.equal(routes.length, 3);
  });

  test('REGRESSION: resolution works when every field `key` is NULL (this workspace)', async () => {
    // Remove the page's configured binding so only the key/name scan is left. Every `key` is
    // NULL here, so the old `.eq('key','slug')` lookup matched nothing and returned zero routes;
    // matching on `name` is what makes this workspace resolvable at all.
    db.pages = db.pages.map((p) => p.id === TEMPLATE_PAGE_ID
      ? { ...p, settings: { cms: { collection_id: COLLECTION_ID } } }
      : p);
    assert.equal(
      db.collection_fields.every((f) => f.key === null), true,
      'fixture mirrors the live workspace: key is NULL on every field',
    );

    const routes = await cacheService.getRoutePathsForPages([TEMPLATE_PAGE_ID]);
    assert.deepEqual(routes.sort(), [...EXPECTED_ITEM_ROUTES].sort());
  });

  test('a configured slug_field_id wins over a field merely NAMED slug', async () => {
    // Two slug-ish fields: the binding decides, so a renamed or duplicated field cannot hijack
    // the URL scheme.
    db.collection_fields = [
      ...db.collection_fields,
      { id: 'field-legacy-slug', collection_id: COLLECTION_ID, key: 'slug', name: 'Slug', is_published: true, deleted_at: null },
    ];
    db.collection_item_values = [
      ...db.collection_item_values,
      { item_id: 'item-0', field_id: 'field-legacy-slug', value: 'WRONG', is_published: true, deleted_at: null },
    ];
    const routes = await cacheService.getRoutePathsForPages([TEMPLATE_PAGE_ID]);
    assert.equal(routes.includes('insight/WRONG'), false);
    assert.deepEqual(routes.sort(), [...EXPECTED_ITEM_ROUTES].sort());
  });

  test('static pages are unaffected — no over-invalidation', async () => {
    assert.deepEqual(await cacheService.getRoutePathsForPages([STATIC_PAGE_ID]), ['about']);
  });

  test('a page with no bound collection resolves to nothing rather than throwing', async () => {
    db.pages = db.pages.map((p) => p.id === TEMPLATE_PAGE_ID ? { ...p, settings: {} } : p);
    assert.deepEqual(await cacheService.getRoutePathsForPages([TEMPLATE_PAGE_ID]), []);
  });

  test('every published route is enumerated for cache warming', async () => {
    // getAllPublishedRoutes feeds the post-publish warm step. With zero item routes it warmed
    // the static pages only, so a visitor paid the cold-cache cost on all 113 articles.
    const routes = await cacheService.getAllPublishedRoutes();
    assert.deepEqual(routes.sort(), ['about', ...EXPECTED_ITEM_ROUTES].sort());
  });
});

describe('publish invalidates the item routes it should (SCA-1486)', () => {
  test('REGRESSION: a template publish invalidates all N item routes', async () => {
    const result = await cacheService.selectiveInvalidation([TEMPLATE_PAGE_ID], false, []);
    assert.equal(result.strategy, 'selective');
    assert.deepEqual([...result.invalidatedRoutes].sort(), [...EXPECTED_ITEM_ROUTES].sort());
    // And the purge actually reached the cache layer with the route tags.
    assert.deepEqual(
      purgedTags.sort(),
      EXPECTED_ITEM_ROUTES.map((r) => `route-/${r}`).sort(),
    );
  });

  test('publishing one collection item invalidates that item\'s route', async () => {
    const result = await cacheService.invalidateForCollectionChange(COLLECTION_ID);
    assert.ok(
      result.invalidatedRoutes.includes(`insight/${PUBLISHED_SLUGS[0]}`),
      `expected the item's own route; got ${JSON.stringify(result.invalidatedRoutes)}`,
    );
    // A collection change expands through the template, so its siblings go too. That is the
    // existing design (the template page is what changed for the cache), not a new behaviour.
    assert.deepEqual([...result.invalidatedRoutes].sort(), [...EXPECTED_ITEM_ROUTES].sort());
  });

  test('a static-page publish invalidates only that page — dynamic routes are untouched', async () => {
    const result = await cacheService.selectiveInvalidation([STATIC_PAGE_ID], false, []);
    assert.deepEqual(result.invalidatedRoutes, ['about']);
    assert.deepEqual(purgedTags, ['route-/about']);
  });

  test('a deleted item\'s old route is purged so the CDN stops serving it 200', async () => {
    const routes = await cacheService.getRoutePathsForDeletedCollectionItems(
      new Map([[COLLECTION_ID, [PUBLISHED_SLUGS[1]]]]),
    );
    assert.deepEqual(routes, [`insight/${PUBLISHED_SLUGS[1]}`]);
  });
});
