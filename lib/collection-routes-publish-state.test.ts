/**
 * Regression cover for the anonymous draft-CMS leak (security audit, 2026-09-02).
 *
 * proxy.ts deliberately exempts `POST .../items/filter` and `POST .../items/load-more` from
 * auth so published pages can filter and paginate. Both routes then read `published` straight
 * out of the request body. It defaulted to `true`, which is why nobody noticed — but a posted
 * `published: false` was honoured, and it flowed into every repository call AND flipped off the
 * `is_publishable` gate (filter route ~108, load-more ~56, both `if (isPublished) q = q.eq(...)`).
 * So an anonymous POST with one extra JSON key rendered and returned the entire draft CMS.
 *
 * load-more additionally returned the raw `items` rows — every field value of every row it
 * rendered, including fields the layer template never draws — making a paginator into a full
 * CMS read API.
 *
 * These tests drive the REAL handlers with a recording Supabase fake and faked repositories.
 * The load-bearing assertions are on the values that actually reached the query layer, not on
 * the routes' source text: post `published: false` and every recorded `is_published` must still
 * be `true`, and the `is_publishable` gate must still be applied.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';

// `server-only` throws on import; pre-seed require.cache so the routes' graphs load.
const serverOnlyPath = require.resolve('server-only');
require.cache[serverOnlyPath] = {
  id: serverOnlyPath,
  filename: serverOnlyPath,
  loaded: true,
  exports: {},
} as unknown as NodeModule;

/** A value that exists ONLY on draft rows — if it reaches a response, the leak is open. */
const DRAFT_ONLY_VALUE = 'UNPUBLISHED-DRAFT-SECRET-a9f3';
const ITEM_ID = 'item_1';

/** Every (column, value) pair handed to `.eq()` anywhere in a request. */
let eqCalls: Array<[string, unknown]> = [];
/** Publish-state flags recorded from each faked repository call. */
let publishFlags: Array<{ where: string; value: unknown }> = [];

function record(where: string, value: unknown) {
  publishFlags.push({ where, value });
}

/** Chainable, thenable Supabase query-builder fake that records every `.eq()`. */
function makeQueryBuilder(rows: unknown[]) {
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  for (const method of [
    'select', 'is', 'order', 'range', 'in', 'ilike', 'like', 'not', 'or',
    'gt', 'gte', 'lt', 'lte', 'neq', 'filter', 'limit', 'contains', 'overlaps',
  ]) {
    builder[method] = chain;
  }
  builder.eq = (column: string, value: unknown) => {
    eqCalls.push([column, value]);
    return builder;
  };
  builder.then = (resolve: (r: { data: unknown[]; error: null }) => unknown) =>
    resolve({ data: rows, error: null });
  return builder;
}

const supabaseServer = require('@/lib/supabase-server');
supabaseServer.getSupabaseAdmin = async () => ({
  from: (table: string) =>
    makeQueryBuilder(
      table === 'collection_items'
        ? [{ id: ITEM_ID }]
        : [{ item_id: ITEM_ID, value: DRAFT_ONLY_VALUE }],
    ),
});

const itemRepo = require('@/lib/repositories/collectionItemRepository');
itemRepo.getItemsByCollectionId = async (_collectionId: string, isPublished: boolean) => {
  record('getItemsByCollectionId', isPublished);
  return { items: [{ id: ITEM_ID, collection_id: 'c1', manual_order: 0 }] };
};

const valueRepo = require('@/lib/repositories/collectionItemValueRepository');
valueRepo.getValuesByItemIds = async (_ids: string[], isPublished: boolean) => {
  record('getValuesByItemIds', isPublished);
  return { [ITEM_ID]: { field_secret: DRAFT_ONLY_VALUE } };
};

const fieldRepo = require('@/lib/repositories/collectionFieldRepository');
fieldRepo.getFieldsByCollectionId = async (_collectionId: string, isPublished: boolean) => {
  record('getFieldsByCollectionId', isPublished);
  return [{ id: 'field_secret', key: 'secret', name: 'Secret', type: 'text' }];
};

const countRepo = require('@/lib/repositories/collectionCountRepository');
countRepo.enrichItemsWithCountValues = async (
  _items: unknown[],
  _collectionId: string,
  isPublished: boolean,
) => {
  record('enrichItemsWithCountValues', isPublished);
};

const pageRepo = require('@/lib/repositories/pageRepository');
pageRepo.getAllPages = async () => [];
const folderRepo = require('@/lib/repositories/pageFolderRepository');
folderRepo.getAllPageFolders = async () => [];

const settingsRepo = require('@/lib/repositories/settingsRepository');
settingsRepo.getSettingByKey = async () => 'UTC';

const pageFetcher = require('@/lib/page-fetcher');
pageFetcher.loadTranslationsForLocale = async (_locale: string, isPublished: boolean) => {
  record('loadTranslationsForLocale', isPublished);
  return { locale: null, translations: undefined };
};
pageFetcher.renderCollectionItemsToHtml = async (...args: unknown[]) => {
  record('renderCollectionItemsToHtml', args[4]);
  const options = args[13] as { isPreview?: boolean } | undefined;
  record('renderCollectionItemsToHtml.isPreview', options?.isPreview);
  return '<div>rendered</div>';
};

const loadMoreRoute = require('@/app/(builder)/ycode/api/collections/[id]/items/load-more/route');
const filterRoute = require('@/app/(builder)/ycode/api/collections/[id]/items/filter/route');

const BASE_BODY = {
  layerTemplate: [{ id: 'tpl', name: 'div', children: [] }],
  collectionLayerId: 'layer_1',
  localeCode: 'en',
};

function post(body: Record<string, unknown>) {
  return new NextRequest('http://localhost:3002/ycode/api/collections/c1/items/x', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...BASE_BODY, ...body }),
  });
}

const params = Promise.resolve({ id: 'c1' });

function callLoadMore(body: Record<string, unknown> = {}) {
  return loadMoreRoute.POST(post({ itemIds: [ITEM_ID], ...body }), { params });
}

function callFilter(body: Record<string, unknown> = {}) {
  return filterRoute.POST(post({ filterGroups: [], ...body }), { params });
}

beforeEach(() => {
  eqCalls = [];
  publishFlags = [];
});

function publishedEqValues() {
  return eqCalls.filter(([column]) => column === 'is_published').map(([, value]) => value);
}

describe('collection routes — fixture sanity (population law)', () => {
  test('load-more actually exercises the publish-state path', async () => {
    await callLoadMore();
    assert.ok(
      publishFlags.length >= 4,
      `expected several publish-state call sites, saw ${publishFlags.length}`,
    );
  });

  test('filter actually reaches the query layer and records is_published', async () => {
    await callFilter();
    assert.ok(
      publishedEqValues().length > 0,
      'no is_published filter was recorded — the assertions below would be vacuous',
    );
  });
});

describe('load-more — publish state is a server fact', () => {
  test('a posted published:false does not reach any repository call', async () => {
    await callLoadMore({ published: false });

    const dissenting = publishFlags.filter(f => f.value !== true && !f.where.endsWith('isPreview'));
    assert.deepEqual(
      dissenting,
      [],
      'every repository/render call must receive published=true regardless of the body',
    );
  });

  test('a posted published:false does not reach the query layer', async () => {
    await callLoadMore({ published: false, itemIds: undefined });

    for (const value of publishedEqValues()) {
      assert.equal(value, true, 'is_published must be true for every query');
    }
  });

  test('the is_publishable gate still applies when published:false is posted', async () => {
    await callLoadMore({ published: false, itemIds: undefined });

    const publishableGate = eqCalls.filter(([column]) => column === 'is_publishable');
    assert.ok(
      publishableGate.length > 0,
      'the is_publishable gate must be applied — posting published:false used to skip it entirely',
    );
    for (const [, value] of publishableGate) assert.equal(value, true);
  });

  test('a posted isPreview:true does not reach the renderer', async () => {
    await callLoadMore({ isPreview: true });

    const previewFlags = publishFlags.filter(f => f.where.endsWith('isPreview'));
    assert.ok(previewFlags.length > 0, 'the renderer must have been called');
    for (const flag of previewFlags) assert.equal(flag.value, false);
  });
});

describe('load-more — the response is only what the public renderer needs', () => {
  test('raw item rows are not returned', async () => {
    const body = await (await callLoadMore()).json();

    assert.equal(body.data.items, undefined, 'the raw `items` array must not be returned');
    assert.ok(!JSON.stringify(body).includes(DRAFT_ONLY_VALUE),
      'no stored field value may appear in the response — the layer template decides what renders');
  });

  test('the pagination metadata the client needs is still there', async () => {
    const body = await (await callLoadMore()).json();

    assert.deepEqual(body.data.itemIds, [ITEM_ID]);
    assert.equal(body.data.count, 1);
    assert.equal(typeof body.data.total, 'number');
    assert.equal(typeof body.data.hasMore, 'boolean');
    assert.equal(body.data.html, '<div>rendered</div>');
  });
});

describe('filter — publish state is a server fact', () => {
  test('a posted published:false does not reach any repository call', async () => {
    await callFilter({ published: false });

    const dissenting = publishFlags.filter(f => f.value !== true && !f.where.endsWith('isPreview'));
    assert.deepEqual(
      dissenting,
      [],
      'every repository/render call must receive published=true regardless of the body',
    );
  });

  test('a posted published:false does not reach the query layer', async () => {
    await callFilter({ published: false });

    for (const value of publishedEqValues()) {
      assert.equal(value, true, 'is_published must be true for every query');
    }
  });

  test('the is_publishable gate still applies when published:false is posted', async () => {
    await callFilter({ published: false });

    const publishableGate = eqCalls.filter(([column]) => column === 'is_publishable');
    assert.ok(
      publishableGate.length > 0,
      'the is_publishable gate must be applied — posting published:false used to skip it entirely',
    );
    for (const [, value] of publishableGate) assert.equal(value, true);
  });

  test('a posted isPreview:true does not reach the renderer', async () => {
    await callFilter({ isPreview: true });

    const previewFlags = publishFlags.filter(f => f.where.endsWith('isPreview'));
    for (const flag of previewFlags) assert.equal(flag.value, false);
  });
});
