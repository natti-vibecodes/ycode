/**
 * SCA-1476 item 3 — the page-layers save has the identical shape, so it had the identical bug.
 *
 * `usePagesStore.saveDraft` PUTs the whole `draftsByPageId[pageId].layers` tree the browser is
 * holding; `upsertDraftLayers` replaced the stored row with it and re-stamped `content_hash` from
 * the incoming payload. An MCP `add_layer` landing between the browser's load and its debounced
 * save was erased exactly the way the component honeypot was — the component case is simply the
 * one that got caught, because a security fix went missing.
 *
 * Tests drive the REAL repository against a recording Supabase fake and assert on the STORED
 * tree, including the case that the cheap pre-read cannot catch: a writer landing inside the
 * read-then-update window.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/* eslint-disable @typescript-eslint/no-require-imports */
const serverOnlyPath = require.resolve('server-only');
require.cache[serverOnlyPath] = {
  id: serverOnlyPath, filename: serverOnlyPath, loaded: true, exports: {},
} as unknown as NodeModule;

const PAGE_ID = 'page-contact';
const MCP_ADDED_ID = 'lyr-mcp-added';

function layer(id: string) {
  return { id, name: 'Div', type: 'div', classes: '', children: [], is_published: false };
}

const BROWSER_CACHED_LAYERS = [layer('lyr-a'), layer('lyr-b')];
const MCP_LAYERS = [layer('lyr-a'), layer('lyr-b'), layer(MCP_ADDED_ID)];

interface Row {
  id: string;
  page_id: string;
  is_published: boolean;
  deleted_at: null;
  layers: any[];
  generated_css: string | null;
  content_hash: string;
  created_at: string;
  updated_at: string;
}

let row: Row | null;
let updates: Array<{ eq: Array<[string, unknown]>; matched: boolean }>;
let inserts: number;
/** Fires once right after the repository's pre-read — used to simulate the real race window. */
let afterRead: (() => void) | null;

const NOT_FOUND = { code: 'PGRST116', message: 'no rows' };

function makeQueryBuilder(table: string) {
  const eq: Array<[string, unknown]> = [];
  let op: 'update' | 'insert' | null = null;
  let payload: any = null;
  let wantSingle = false;

  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  for (const m of ['select', 'in', 'is', 'order', 'limit', 'delete', 'upsert']) builder[m] = chain;
  builder.eq = (column: string, value: unknown) => { eq.push([column, value]); return builder; };
  builder.single = () => { wantSingle = true; return builder; };
  builder.update = (rec: any) => { op = 'update'; payload = rec; return builder; };
  builder.insert = (rec: any) => { op = 'insert'; payload = rec; return builder; };

  builder.then = (resolve: (r: unknown) => unknown) => {
    if (table !== 'page_layers') return resolve({ data: [], error: null });

    if (op === null) {
      const hit = row && eq.find(([c]) => c === 'page_id')?.[1] === row.page_id ? { ...row } : null;
      const hook = afterRead;
      afterRead = null;
      hook?.();
      if (wantSingle) return resolve(hit ? { data: hit, error: null } : { data: null, error: NOT_FOUND });
      return resolve({ data: hit ? [hit] : [], error: null });
    }

    if (op === 'insert') {
      inserts++;
      row = { ...(payload as Row), created_at: 'now', updated_at: 'now' };
      return resolve({ data: wantSingle ? { ...row } : [{ ...row }], error: null });
    }

    const matched = !!row && eq.every(([column, value]) => (row as any)[column] === value);
    updates.push({ eq: [...eq], matched });
    if (!matched) {
      return resolve({ data: wantSingle ? null : [], error: wantSingle ? NOT_FOUND : null });
    }
    row = { ...row!, ...payload };
    return resolve({ data: wantSingle ? { ...row } : [{ ...row }], error: null });
  };

  return builder;
}

const supabaseServer = require('@/lib/supabase-server');
supabaseServer.getSupabaseAdmin = async () => ({ from: (table: string) => makeQueryBuilder(table) });

const { upsertDraftLayers } = require('@/lib/repositories/pageLayersRepository');
const { generatePageLayersHash } = require('@/lib/hash-utils');
const { isConflictError } = require('@/lib/errors/conflict');

function rowFor(layers: any[]): Row {
  return {
    id: 'pl-1',
    page_id: PAGE_ID,
    is_published: false,
    deleted_at: null,
    layers,
    generated_css: null,
    content_hash: generatePageLayersHash({ layers, generated_css: null }),
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
  };
}

const storedLayerIds = () => (row?.layers ?? []).map((l: any) => l.id);

beforeEach(() => {
  row = rowFor(BROWSER_CACHED_LAYERS);
  updates = [];
  inserts = 0;
  afterRead = null;
});

describe('SCA-1476 (page_layers) — draft saves honour a base content hash', () => {
  test('REGRESSION: a stale builder save is REFUSED and the MCP layer survives', async () => {
    const baseTheBrowserLoaded = row!.content_hash;

    await upsertDraftLayers(PAGE_ID, MCP_LAYERS, undefined, undefined, {
      baseContentHash: baseTheBrowserLoaded,
    });
    assert.ok(
      storedLayerIds().includes(MCP_ADDED_ID),
      'population check: the MCP layer must be stored before we test losing it',
    );

    await assert.rejects(
      () => upsertDraftLayers(PAGE_ID, BROWSER_CACHED_LAYERS, undefined, undefined, {
        baseContentHash: baseTheBrowserLoaded,
      }),
      (error: unknown) => {
        assert.ok(isConflictError(error));
        const conflict = error as { current: Row | null };
        assert.ok(
          conflict.current?.layers.some((l: any) => l.id === MCP_ADDED_ID),
          'the 409 body must carry the current tree',
        );
        return true;
      },
    );

    assert.deepEqual(storedLayerIds(), MCP_LAYERS.map(l => l.id), 'nothing was overwritten');
  });

  test('THE REAL RACE: a writer landing between the read and the update still loses', async () => {
    const base = row!.content_hash;
    afterRead = () => { row = rowFor(MCP_LAYERS); };

    await assert.rejects(
      () => upsertDraftLayers(PAGE_ID, BROWSER_CACHED_LAYERS, undefined, undefined, {
        baseContentHash: base,
      }),
      (error: unknown) => isConflictError(error),
    );

    assert.equal(updates.length, 1, 'population check: the UPDATE WAS issued — not a vacuous pass');
    assert.ok(
      updates[0].eq.some(([c, v]) => c === 'content_hash' && v === base),
      'the UPDATE must carry content_hash in its WHERE clause',
    );
    assert.equal(updates[0].matched, false);
    assert.deepEqual(storedLayerIds(), MCP_LAYERS.map(l => l.id));
  });

  test('HAPPY PATH: a current base writes and re-stamps a new hash', async () => {
    const base = row!.content_hash;
    const saved = await upsertDraftLayers(PAGE_ID, MCP_LAYERS, undefined, undefined, {
      baseContentHash: base,
    });

    assert.deepEqual(storedLayerIds(), MCP_LAYERS.map(l => l.id));
    assert.notEqual(saved.content_hash, base);
  });

  test('NO base hash keeps the old unconditional behaviour', async () => {
    await upsertDraftLayers(PAGE_ID, MCP_LAYERS);
    await upsertDraftLayers(PAGE_ID, BROWSER_CACHED_LAYERS);

    assert.deepEqual(
      storedLayerIds(), BROWSER_CACHED_LAYERS.map(l => l.id),
      'unguarded callers (page creation, layouts) are deliberately unchanged',
    );
    for (const update of updates) {
      assert.equal(update.eq.some(([c]) => c === 'content_hash'), false);
    }
  });

  test('creating the FIRST draft still inserts — the guard never blocks a genuine create', async () => {
    row = null;
    const created = await upsertDraftLayers(PAGE_ID, BROWSER_CACHED_LAYERS, undefined, null);

    assert.equal(inserts, 1);
    assert.deepEqual(created.layers.map((l: any) => l.id), BROWSER_CACHED_LAYERS.map(l => l.id));
  });
});
