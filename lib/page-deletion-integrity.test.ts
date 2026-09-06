/**
 * Audit C1 / #37 — a failed page deletion must not erase its own retry marker.
 *
 * `hardDeleteSoftDeletedPages()` deleted the PUBLISHED rows, logged-and-swallowed any failure,
 * then deleted the soft-deleted DRAFT rows — the only record that a deletion is pending — and
 * returned success. The publish route swallowed the whole call a second time. So a transient
 * failure on the published delete left the page LIVE with nothing left to replay from: the
 * queue read clean, the builder showed the page gone, and no publish could ever finish the job.
 *
 * The two deletes are not one transaction, so ORDER is the guarantee: the marker is removed only
 * once the published row is provably gone. These tests drive the REAL repository function with a
 * recording Supabase fake and assert on the deletes that actually reached the client.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/* eslint-disable @typescript-eslint/no-require-imports */
const serverOnlyPath = require.resolve('server-only');
require.cache[serverOnlyPath] = {
  id: serverOnlyPath, filename: serverOnlyPath, loaded: true, exports: {},
} as unknown as NodeModule;

const DELETED_PAGE_ID = 'page-nyc';

/** Every delete that reached the database, in order. */
let deletes: Array<{ table: string; eq: Array<[string, unknown]> }> = [];
/** When true, the published-row delete fails the way a network blip does. */
let publishedDeleteFails = false;

const DELETE_ERROR = { message: 'connection reset by peer', code: '08006' };

function makeQueryBuilder(table: string) {
  const eq: Array<[string, unknown]> = [];
  let isDelete = false;
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  for (const m of ['select', 'is', 'not', 'in', 'order', 'limit', 'single']) builder[m] = chain;
  builder.eq = (column: string, value: unknown) => { eq.push([column, value]); return builder; };
  builder.delete = () => { isDelete = true; return builder; };
  builder.then = (resolve: (r: unknown) => unknown) => {
    if (!isDelete) {
      // The lookup of soft-deleted draft rows.
      return resolve({ data: [{ id: DELETED_PAGE_ID, name: 'NYC' }], error: null });
    }
    deletes.push({ table, eq: [...eq] });
    const isPublishedRow = eq.some(([c, v]) => c === 'is_published' && v === true);
    if (isPublishedRow && publishedDeleteFails) return resolve({ data: null, error: DELETE_ERROR });
    return resolve({ data: null, error: null });
  };
  return builder;
}

const supabaseServer = require('@/lib/supabase-server');
supabaseServer.getSupabaseAdmin = async () => ({ from: (table: string) => makeQueryBuilder(table) });

const { hardDeleteSoftDeletedPages } = require('@/lib/repositories/pageRepository');

/** Did the DRAFT (soft-delete marker) row get deleted? */
function markerWasDeleted() {
  return deletes.some(d => d.table === 'pages' && d.eq.some(([c, v]) => c === 'is_published' && v === false));
}
function publishedWasDeleted() {
  return deletes.some(d => d.table === 'pages' && d.eq.some(([c, v]) => c === 'is_published' && v === true));
}

beforeEach(() => {
  deletes = [];
  publishedDeleteFails = false;
});

describe('audit C1/#37 — page deletion integrity', () => {
  test('REGRESSION: when the PUBLISHED delete fails, the retry marker survives and the call FAILS', async () => {
    publishedDeleteFails = true;

    await assert.rejects(
      () => hardDeleteSoftDeletedPages(),
      /Failed to delete published pages/,
      'the failure used to be console.error()d and swallowed, and success was reported',
    );

    assert.ok(publishedWasDeleted(), 'population check: the published delete must have been attempted');
    assert.equal(
      markerWasDeleted(), false,
      'the soft-delete marker is the ONLY record that a deletion is pending — deleting it after a ' +
      'failed published delete makes the deletion unrecoverable while the page stays live',
    );
  });

  test('on success the published row is deleted BEFORE the marker', async () => {
    const result = await hardDeleteSoftDeletedPages();
    assert.deepEqual(result, { count: 1, deletedPageIds: [DELETED_PAGE_ID] });

    const pubIndex = deletes.findIndex(d => d.eq.some(([c, v]) => c === 'is_published' && v === true));
    const draftIndex = deletes.findIndex(d => d.eq.some(([c, v]) => c === 'is_published' && v === false));
    assert.ok(pubIndex >= 0 && draftIndex >= 0, 'both deletes must run on the happy path');
    assert.ok(pubIndex < draftIndex, 'ordering IS the transaction here');
  });
});

describe('audit #37 — get_unpublished_changes must list pending deletions', () => {
  test('REGRESSION: a queued page DELETION appears in the tool output', async () => {
    // Drive the REAL tool handler. getUnpublishedPages() filters `deleted_at is null`, so it can
    // never report a deletion — the /nyc soft-delete showed an empty queue right before a publish
    // that would have removed a live URL.
    const pageRepo = require('@/lib/repositories/pageRepository');
    pageRepo.getUnpublishedPageChanges = async () => ([
      { id: 'page-home', name: 'Homepage', status: 'modified' },
      { id: 'page-nyc', name: 'NYC', status: 'deleted' },
    ]);
    pageRepo.getUnpublishedPages = async () => ([{ id: 'page-home', name: 'Homepage' }]);

    for (const [mod, fn] of [
      ['@/lib/repositories/layerStyleRepository', 'getUnpublishedLayerStyles'],
      ['@/lib/repositories/componentRepository', 'getUnpublishedComponents'],
      ['@/lib/repositories/collectionRepository', 'getUnpublishedCollections'],
      ['@/lib/repositories/fontRepository', 'getUnpublishedFonts'],
      ['@/lib/repositories/assetRepository', 'getUnpublishedAssets'],
      ['@/lib/repositories/assetFolderRepository', 'getUnpublishedAssetFolders'],
      ['@/lib/repositories/globalVariableRepository', 'getUnpublishedGlobalVariables'],
    ] as const) {
      require(mod)[fn] = async () => [];
    }
    require('@/lib/repositories/translationRepository').getUnpublishedTranslationsCount = async () => 0;
    require('@/lib/repositories/localeRepository').getAllLocales = async () => [];

    const { registerPublishingTools } = require('@/lib/mcp/tools/publishing');
    const handlers: Record<string, (args: unknown) => Promise<{ content: Array<{ text: string }> }>> = {};
    registerPublishingTools({
      tool: (name: string, _d: unknown, _s: unknown, handler: (a: unknown) => Promise<{ content: Array<{ text: string }> }>) => {
        handlers[name] = handler;
      },
    });

    assert.ok(handlers['get_unpublished_changes'], 'population check: the tool registered');
    const out = JSON.parse((await handlers['get_unpublished_changes']({})).content[0].text);

    assert.equal(out.has_unpublished_changes, true);
    assert.deepEqual(
      out.pending_page_deletions,
      [{ id: 'page-nyc', name: 'NYC', status: 'deleted' }],
      'a queued deletion must be named explicitly — it is the one change republishing cannot undo',
    );
    const nyc = out.unpublished_pages.find((p: { id: string }) => p.id === 'page-nyc');
    assert.ok(nyc, 'the deleted page must appear in the page list at all');
    assert.equal(nyc.status, 'deleted');
  });

  test('the reported statuses distinguish a deletion from an edit', () => {
    const { sortUnpublishedChanges } = require('@/lib/publish-changes');
    const changes = sortUnpublishedChanges([
      { id: 'a', name: 'Home', status: 'modified' },
      { id: 'b', name: 'NYC', status: 'deleted' },
    ]);
    const deleted = changes.filter((c: { status: string }) => c.status === 'deleted' || c.status === 'unpublishing');
    assert.equal(deleted.length, 1);
    assert.equal(deleted[0].name, 'NYC');
  });
});
