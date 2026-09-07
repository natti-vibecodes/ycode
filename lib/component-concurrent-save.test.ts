/**
 * SCA-1476 — a builder component save must not overwrite a concurrent MCP layer write.
 *
 * The measured loss, 2026-09-06, on `Newsletter + Insights` (a184a3a9…):
 *
 *   before MCP write        45 layers, no honeypot
 *   after MCP write         48 layers, honeypot present   ← SCA-1428's spam fix
 *   after her builder save  45 layers, honeypot GONE      ← byte-identical to the PRE-MCP set
 *
 * Not a merge that dropped three layers — a straight replay of the tree the browser had cached
 * before the MCP write. The builder PUT the whole `variants` payload it loaded when the component
 * was opened, `updateComponent` took it wholesale, and `content_hash` was RECOMPUTED from the
 * incoming payload and stamped over the row: the one field that could have caught the conflict
 * was the field that destroyed the evidence.
 *
 * These tests drive the REAL repository against a recording Supabase fake. The load-bearing
 * assertion is on the STORED tree, not on the return value — a version guard that returns an
 * error while still writing would pass a weaker test.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/* eslint-disable @typescript-eslint/no-require-imports */
const serverOnlyPath = require.resolve('server-only');
require.cache[serverOnlyPath] = {
  id: serverOnlyPath, filename: serverOnlyPath, loaded: true, exports: {},
} as unknown as NodeModule;

const COMPONENT_ID = 'cmp-newsletter-insights';
const HONEYPOT_ID = 'lyr-mtq2liq9cb0ezf';

function layer(id: string) {
  return { id, name: 'Div', type: 'div', classes: '', children: [], is_published: false };
}

/** The tree the builder cached when she opened the component: no honeypot. */
const BUILDER_CACHED_LAYERS = [layer('lyr-a'), layer('lyr-b')];
/** The tree after the MCP honeypot write: the extra layer is the fix that got eaten. */
const MCP_LAYERS = [layer('lyr-a'), layer('lyr-b'), layer(HONEYPOT_ID)];

interface Row {
  id: string;
  is_published: boolean;
  deleted_at: null;
  name: string;
  layers: any[];
  variants: Array<{ id: string; name: string; layers: any[] }>;
  variables: any[];
  content_hash: string;
  updated_at: string;
}

let row: Row;
/** Every UPDATE the repository issued against `components`, with the filters it carried. */
let updates: Array<{ eq: Array<[string, unknown]>; matched: boolean }>;
/**
 * Fires once, immediately after the repository's pre-read returns — the exact instant the real
 * race happens. Lets a test land a competing write INSIDE the read-then-update window, which is
 * the only way to exercise the WHERE clause rather than the cheap pre-read check.
 */
let afterRead: (() => void) | null;

const NOT_FOUND = { code: 'PGRST116', message: 'no rows' };

function makeQueryBuilder(table: string) {
  const eq: Array<[string, unknown]> = [];
  let op: 'update' | null = null;
  let payload: any = null;
  let wantSingle = false;

  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  for (const m of ['select', 'in', 'is', 'order', 'limit', 'delete', 'insert', 'upsert']) builder[m] = chain;
  builder.eq = (column: string, value: unknown) => { eq.push([column, value]); return builder; };
  builder.single = () => { wantSingle = true; return builder; };
  builder.update = (rec: any) => { op = 'update'; payload = rec; return builder; };

  builder.then = (resolve: (r: unknown) => unknown) => {
    // Translations and any other table the repository touches: empty, never an error.
    if (table !== 'components') return resolve({ data: [], error: null });

    if (op === null) {
      const wanted = eq.find(([c]) => c === 'id')?.[1];
      const hit = wanted === row.id ? { ...row } : null;
      const hook = afterRead;
      afterRead = null;
      hook?.();
      if (wantSingle) return resolve(hit ? { data: hit, error: null } : { data: null, error: NOT_FOUND });
      return resolve({ data: hit ? [hit] : [], error: null });
    }

    // An UPDATE matches only if EVERY eq filter holds — including `content_hash` when the caller
    // supplied a precondition. That is the real Postgres semantics this guard depends on.
    const matched = eq.every(([column, value]) => (row as any)[column] === value);
    updates.push({ eq: [...eq], matched });
    if (!matched) {
      return resolve({ data: wantSingle ? null : [], error: wantSingle ? NOT_FOUND : null });
    }
    row = { ...row, ...payload };
    return resolve({ data: wantSingle ? { ...row } : [{ ...row }], error: null });
  };

  return builder;
}

const supabaseServer = require('@/lib/supabase-server');
supabaseServer.getSupabaseAdmin = async () => ({ from: (table: string) => makeQueryBuilder(table) });

const { updateComponent } = require('@/lib/repositories/componentRepository');
const { generateComponentContentHash } = require('@/lib/hash-utils');
const { isConflictError } = require('@/lib/errors/conflict');

/** The hash the row would carry for a given tree — the same function the repository stamps with. */
function hashFor(layers: any[]) {
  return generateComponentContentHash({
    name: 'Newsletter + Insights',
    layers,
    variables: [],
    variants: [{ id: 'var-primary', name: 'Default', layers }],
  });
}

function rowFor(layers: any[]): Row {
  return {
    id: COMPONENT_ID,
    is_published: false,
    deleted_at: null,
    name: 'Newsletter + Insights',
    layers,
    variants: [{ id: 'var-primary', name: 'Default', layers }],
    variables: [],
    content_hash: hashFor(layers),
    updated_at: '2026-08-14T14:37:08.554Z',
  };
}

function storedLayerIds() {
  return row.variants[0].layers.map((l: any) => l.id);
}

beforeEach(() => {
  row = rowFor(BUILDER_CACHED_LAYERS);
  updates = [];
  afterRead = null;
});

describe('SCA-1476 — component saves honour a base content hash', () => {
  test('REGRESSION: a stale builder save is REFUSED and the MCP honeypot survives', async () => {
    // 1. She opens the component. The browser caches this tree and its version.
    const baseTheBuilderLoaded = row.content_hash;

    // 2. An MCP lane adds the honeypot — a genuine read-modify-write against the current row.
    await updateComponent(
      COMPONENT_ID,
      { variants: [{ id: 'var-primary', name: 'Default', layers: MCP_LAYERS }] },
      { baseContentHash: baseTheBuilderLoaded },
    );
    assert.ok(
      storedLayerIds().includes(HONEYPOT_ID),
      'population check: the honeypot must actually be in the stored tree before we test losing it',
    );

    // 3. Her debounced autosave fires with the tree from step 1.
    await assert.rejects(
      () => updateComponent(
        COMPONENT_ID,
        { variants: [{ id: 'var-primary', name: 'Default', layers: BUILDER_CACHED_LAYERS }] },
        { baseContentHash: baseTheBuilderLoaded },
      ),
      (error: unknown) => {
        assert.ok(isConflictError(error), 'must be a ConflictError so the route can answer 409');
        const conflict = error as { current: Row | null };
        assert.ok(
          conflict.current?.variants[0].layers.some((l: any) => l.id === HONEYPOT_ID),
          'the 409 body must carry the CURRENT tree so the builder can reload instead of guessing',
        );
        return true;
      },
    );

    assert.ok(
      storedLayerIds().includes(HONEYPOT_ID),
      'the honeypot must still be stored — this exact assertion is what failed in production',
    );
    assert.deepEqual(
      storedLayerIds(), MCP_LAYERS.map(l => l.id),
      'the stored tree is the MCP one, unchanged',
    );
  });

  test('the pre-read guard refuses without issuing any UPDATE at all', async () => {
    const stale = row.content_hash;
    await updateComponent(
      COMPONENT_ID,
      { variants: [{ id: 'var-primary', name: 'Default', layers: MCP_LAYERS }] },
      { baseContentHash: stale },
    );
    updates = [];

    await assert.rejects(
      () => updateComponent(
        COMPONENT_ID,
        { variants: [{ id: 'var-primary', name: 'Default', layers: BUILDER_CACHED_LAYERS }] },
        { baseContentHash: stale },
      ),
      (error: unknown) => isConflictError(error),
    );

    assert.deepEqual(
      updates, [],
      'an already-stale base is caught on the read, so no write and no translation bookkeeping runs',
    );
  });

  test('THE REAL RACE: a writer landing between the read and the update still loses', async () => {
    // The pre-read cannot close this window — only the WHERE clause can. Without this test the
    // guard would be one `if` statement wide and would still lose a fast enough concurrent write.
    const base = row.content_hash;
    afterRead = () => { row = rowFor(MCP_LAYERS); };

    await assert.rejects(
      () => updateComponent(
        COMPONENT_ID,
        { variants: [{ id: 'var-primary', name: 'Default', layers: BUILDER_CACHED_LAYERS }] },
        { baseContentHash: base },
      ),
      (error: unknown) => isConflictError(error),
    );

    assert.equal(updates.length, 1, 'population check: the UPDATE WAS issued — this is not vacuous');
    assert.ok(
      updates[0].eq.some(([c, v]) => c === 'content_hash' && v === base),
      'the UPDATE must carry content_hash in its WHERE clause',
    );
    assert.equal(updates[0].matched, false, 'and it must match zero rows');
    assert.ok(
      storedLayerIds().includes(HONEYPOT_ID),
      'the winner\'s tree is intact — nothing was written by the loser',
    );
  });

  test('HAPPY PATH: a save whose base is current writes, and re-stamps a NEW hash', async () => {
    const base = row.content_hash;

    const saved = await updateComponent(
      COMPONENT_ID,
      { variants: [{ id: 'var-primary', name: 'Default', layers: MCP_LAYERS }] },
      { baseContentHash: base },
    );

    assert.deepEqual(storedLayerIds(), MCP_LAYERS.map(l => l.id));
    assert.notEqual(saved.content_hash, base, 'a landed write must move the version');
    assert.equal(saved.content_hash, row.content_hash);
  });

  test('MCP PATH UNCHANGED: consecutive read-modify-writes chain without conflicting', async () => {
    // Each MCP tool re-reads before writing, so the hash it sends is always the current one.
    for (const extra of ['lyr-c', 'lyr-d', 'lyr-e']) {
      const current = row;
      const nextLayers = [...current.variants[0].layers, layer(extra)];
      await updateComponent(
        COMPONENT_ID,
        { variants: [{ id: 'var-primary', name: 'Default', layers: nextLayers }] },
        { baseContentHash: current.content_hash },
      );
    }
    assert.deepEqual(storedLayerIds(), ['lyr-a', 'lyr-b', 'lyr-c', 'lyr-d', 'lyr-e']);
  });

  test('NO base hash keeps the old unconditional behaviour for callers that pass none', async () => {
    await updateComponent(
      COMPONENT_ID,
      { variants: [{ id: 'var-primary', name: 'Default', layers: MCP_LAYERS }] },
    );
    // Now overwrite with the stale tree and NO precondition: it still wins, as before.
    await updateComponent(
      COMPONENT_ID,
      { variants: [{ id: 'var-primary', name: 'Default', layers: BUILDER_CACHED_LAYERS }] },
    );

    assert.deepEqual(
      storedLayerIds(), BUILDER_CACHED_LAYERS.map(l => l.id),
      'unguarded writers are deliberately untouched — the guard is opt-in per caller',
    );
    for (const update of updates) {
      assert.equal(
        update.eq.some(([c]) => c === 'content_hash'), false,
        'and no content_hash filter is added behind their back',
      );
    }
  });
});
