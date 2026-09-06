/**
 * Audit #10 — a transient backend failure must never be cached as a permanent 404.
 *
 * `app/(site)/[...slug]/page.tsx` wraps every page read in
 * `unstable_cache(..., { revalidate: false })`, so whatever the fetcher RETURNS is stored until
 * the next publish. The fetchers converted every failure into `null`, and the route cannot tell
 * that apart from "this page does not exist" — so one Supabase blip pinned live URLs (including
 * `/services/startup-consulting`, a never-destroy asset) to a hard 404 and to a
 * `Page Not Found` + `noindex` title until someone published again.
 *
 * These drive the REAL `fetchPageByPath` / `fetchPageByPathForMetadata` / `fetchErrorPage` /
 * `fetchFoldersForAuth` against a recording Supabase fake. The load-bearing distinction is
 * THROW (never cached, retried on the next request) vs `null` (a genuine 404, cacheable).
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/* eslint-disable @typescript-eslint/no-require-imports */
// require(), not import: these modules are stubbed in require.cache before the code under test
// loads, and hoisted imports cannot express that ordering.

const serverOnlyPath = require.resolve('server-only');
require.cache[serverOnlyPath] = {
  id: serverOnlyPath,
  filename: serverOnlyPath,
  loaded: true,
  exports: {},
} as unknown as NodeModule;

/** What the fake should do on the next call. */
let mode: 'ok' | 'error' | 'no-client' = 'ok';
/** Rows returned per table while `mode === 'ok'`. */
let tables: Record<string, unknown[]> = {};
/** How many times the fetcher reached the database. */
let queryCount = 0;

const QUERY_ERROR = { message: 'connection reset by peer', code: '08006' };

function makeQueryBuilder(table: string) {
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  for (const method of [
    'select', 'is', 'order', 'range', 'in', 'ilike', 'like', 'not', 'or', 'eq',
    'gt', 'gte', 'lt', 'lte', 'neq', 'filter', 'limit', 'contains', 'overlaps',
  ]) {
    builder[method] = chain;
  }
  const settle = () => {
    queryCount++;
    if (mode === 'error') return { data: null, error: QUERY_ERROR };
    return { data: tables[table] ?? [], error: null };
  };
  builder.single = async () => {
    const r = settle();
    if (r.error) return r;
    const rows = (r.data as unknown[]) || [];
    // PostgREST's `.single()` reports "no rows" as PGRST116 — an ANSWER, not a failure.
    return rows.length > 0 ? { data: rows[0], error: null } : { data: null, error: { code: 'PGRST116', message: 'no rows' } };
  };
  builder.then = (resolve: (r: unknown) => unknown) => resolve(settle());
  return builder;
}

const supabaseServer = require('@/lib/supabase-server');
supabaseServer.getSupabaseAdmin = async () => {
  if (mode === 'no-client') return null;
  return { from: (table: string) => makeQueryBuilder(table) };
};

const settingsRepo = require('@/lib/repositories/settingsRepository');
settingsRepo.getSettingByKey = async () => 'UTC';

const { fetchPageByPath, fetchPageByPathForMetadata, fetchErrorPage, fetchHomepage } = require('@/lib/page-fetcher');
const { fetchFoldersForAuth } = require('@/lib/page-auth');
const { PageFetchError, fetchWithOneRetry } = require('@/lib/page-fetch-error');

/**
 * The route's cache wrapper, modelled exactly: `unstable_cache` STORES a returned value and
 * stores NOTHING when the promise rejects. This is the property the whole fix rests on.
 */
function cachingRoute() {
  const store = new Map<string, unknown>();
  return {
    store,
    async get(key: string, producer: () => Promise<unknown>) {
      if (store.has(key)) return store.get(key);
      const value = await producer(); // a throw here propagates and nothing is written
      store.set(key, value);
      return value;
    },
  };
}

beforeEach(() => {
  mode = 'ok';
  queryCount = 0;
  tables = { locales: [], pages: [], page_folders: [], components: [], page_layers: [] };
});

describe('audit #10 — backend failure vs genuine absence', () => {
  test('REGRESSION: a query error THROWS instead of returning null', async () => {
    mode = 'error';
    await assert.rejects(
      () => fetchPageByPath('services/startup-consulting', true),
      (err: unknown) => {
        assert.ok(err instanceof PageFetchError, `expected PageFetchError, got ${String(err)}`);
        return true;
      },
      'a Supabase error used to become null, and null is cached as a 404 forever',
    );
  });

  test('REGRESSION: an unconfigured Supabase client THROWS instead of returning null', async () => {
    mode = 'no-client';
    await assert.rejects(() => fetchPageByPath('anything', true), PageFetchError);
  });

  test('a genuinely missing page still returns null — 404s stay cacheable', async () => {
    // Population check: the lookup DID run and found an empty page set.
    const result = await fetchPageByPath('no-such-page', true);
    assert.equal(result, null);
    assert.ok(queryCount > 0, 'the fetcher must have actually queried; a zero-query null proves nothing');
  });

  test('the metadata fetcher obeys the same contract (the poisoned "Page Not Found" title)', async () => {
    mode = 'error';
    await assert.rejects(() => fetchPageByPathForMetadata('services/digital-marketing', true), PageFetchError);
    mode = 'ok';
    assert.equal(await fetchPageByPathForMetadata('no-such-page', true), null);
  });

  test('the error-page fetcher throws on failure and returns null when no custom 404 exists', async () => {
    mode = 'error';
    await assert.rejects(() => fetchErrorPage(404, true), PageFetchError);
    mode = 'ok';
    assert.equal(await fetchErrorPage(404, true), null, 'no error_page row is an answer, not a failure');
  });

  test('the homepage fetcher throws on failure', async () => {
    mode = 'error';
    await assert.rejects(() => fetchHomepage(true), PageFetchError);
  });

  test('REGRESSION: fetchFoldersForAuth throws instead of returning [] — an empty cached folder list unlocks protected pages', async () => {
    mode = 'error';
    await assert.rejects(() => fetchFoldersForAuth(true), PageFetchError);
    mode = 'ok';
    assert.deepEqual(await fetchFoldersForAuth(true), []);
  });
});

describe('audit #10 — "no rows" from .single() is an ANSWER, not a failure', () => {
  test('a page with no layers row still returns null (a cacheable 404), not a 500', async () => {
    // PostgREST reports "no rows" from .single() as PGRST116. Treating that as a backend failure
    // would turn every genuinely empty page into a 500 and defeat the 404 cache entirely.
    mode = 'ok';
    tables = { ...tables, pages: [], page_layers: [] };
    assert.equal(await fetchPageByPath('empty-page', true), null);
    assert.equal(await fetchHomepage(true), null, 'no homepage row is an answer too');
    assert.equal(await fetchErrorPage(404, true), null);
  });
});

describe('audit #10 — what the cache ends up holding', () => {
  test('REGRESSION: a transient failure leaves the cache EMPTY, and the next request serves 200', async () => {
    const route = cachingRoute();

    mode = 'error';
    await assert.rejects(() => route.get('core-/services/startup-consulting', () => fetchPageByPath('services/startup-consulting', true)));
    assert.equal(route.store.size, 0, 'the failed read must not have been written to the cache');

    // Backend recovers; the page exists again. Under the old code this request served the
    // cached null — a 404 on a live page until the next publish.
    mode = 'ok';
    const value = await route.get('core-/services/startup-consulting', async () => 'PAGE-DATA');
    assert.equal(value, 'PAGE-DATA');
  });

  test('a genuine 404 IS cached — the fix must not make every miss a database round trip', async () => {
    const route = cachingRoute();
    const first = await route.get('core-/no-such-page', () => fetchPageByPath('no-such-page', true));
    assert.equal(first, null);
    assert.equal(route.store.size, 1);
    assert.ok(route.store.has('core-/no-such-page'));
  });
});

describe('fetchWithOneRetry', () => {
  test('a single transient failure is absorbed', async () => {
    let calls = 0;
    const value = await fetchWithOneRetry(async () => {
      calls++;
      if (calls === 1) throw new PageFetchError('blip');
      return 'ok';
    }, 0);
    assert.equal(value, 'ok');
    assert.equal(calls, 2);
  });

  test('two failures rethrow the FIRST error — nothing is returned that could be cached', async () => {
    let calls = 0;
    await assert.rejects(
      () => fetchWithOneRetry(async () => { calls++; throw new PageFetchError(`fail-${calls}`); }, 0),
      (err: Error) => err.message === 'fail-1',
    );
    assert.equal(calls, 2);
  });

  test('a success is not retried', async () => {
    let calls = 0;
    assert.equal(await fetchWithOneRetry(async () => { calls++; return 'v'; }, 0), 'v');
    assert.equal(calls, 1);
  });
});
