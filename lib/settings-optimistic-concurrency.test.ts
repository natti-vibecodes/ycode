/**
 * SCA-1480 — a concurrent writer must not silently clobber a global setting.
 *
 * On 2026-09-06 `sync-chrome.py` reported a clean run and `custom_code_head` stayed at the
 * PREVIOUS 28319 bytes: every page kept serving the old stylesheet link and the old SRI digests
 * while the lane reported the change live. The `custom_code_body`, written later in the same run
 * through the same path, persisted — so it was not transport and not a dead session. It was
 * last-write-wins on a table with no version guard.
 *
 * These tests drive the REAL repository against a recording Supabase fake that behaves like the
 * `settings` table: one row per key, `updated_at` as the version. The assertions are on the
 * writes that actually reached the database — a conflict must leave the STORED value untouched,
 * not merely return an error.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/* eslint-disable @typescript-eslint/no-require-imports */
const serverOnlyPath = require.resolve('server-only');
require.cache[serverOnlyPath] = {
  id: serverOnlyPath, filename: serverOnlyPath, loaded: true, exports: {},
} as unknown as NodeModule;

interface Row { key: string; value: unknown; updated_at: string }

/** The stored `settings` table. */
let rows: Map<string, Row>;
/** Every write the repository actually issued, in order. */
let writes: Array<{ op: 'upsert' | 'update' | 'insert'; key: string; matched: boolean }>;

const NOT_FOUND = { code: 'PGRST116', message: 'no rows' };
const UNIQUE_VIOLATION = { code: '23505', message: 'duplicate key value violates unique constraint' };

function makeQueryBuilder(table: string) {
  const eq: Array<[string, unknown]> = [];
  let op: 'upsert' | 'update' | 'insert' | null = null;
  let payload: any = null;
  let wantSingle = false;

  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  for (const m of ['select', 'in', 'is', 'order', 'limit', 'delete']) builder[m] = chain;
  builder.eq = (column: string, value: unknown) => { eq.push([column, value]); return builder; };
  builder.single = () => { wantSingle = true; return builder; };
  builder.upsert = (rec: any) => { op = 'upsert'; payload = rec; return builder; };
  builder.update = (rec: any) => { op = 'update'; payload = rec; return builder; };
  builder.insert = (rec: any) => { op = 'insert'; payload = rec; return builder; };

  builder.then = (resolve: (r: unknown) => unknown) => {
    if (table !== 'settings') return resolve({ data: [], error: null });
    const keyFilter = eq.find(([c]) => c === 'key')?.[1] as string | undefined;

    // ---- reads ----
    if (op === null) {
      const row = keyFilter ? rows.get(keyFilter) : undefined;
      if (wantSingle) {
        return resolve(row ? { data: { ...row }, error: null } : { data: null, error: NOT_FOUND });
      }
      return resolve({ data: [...rows.values()], error: null });
    }

    // ---- unconditional upsert (the pre-SCA-1480 behaviour) ----
    // `setSetting` upserts one record; `setSettings` upserts an array. Handle both, or a test
    // "passes" while the batch path was never exercised.
    if (op === 'upsert') {
      const records: any[] = Array.isArray(payload) ? payload : [payload];
      const written = records.map((rec) => {
        const row: Row = { key: rec.key, value: rec.value, updated_at: rec.updated_at };
        rows.set(row.key, row);
        writes.push({ op: 'upsert', key: row.key, matched: true });
        return { ...row };
      });
      return resolve({ data: wantSingle ? written[0] : written, error: null });
    }

    // ---- create-only insert ----
    if (op === 'insert') {
      if (rows.has(payload.key)) {
        writes.push({ op: 'insert', key: payload.key, matched: false });
        return resolve({ data: null, error: UNIQUE_VIOLATION });
      }
      const written: Row = { key: payload.key, value: payload.value, updated_at: payload.updated_at };
      rows.set(written.key, written);
      writes.push({ op: 'insert', key: written.key, matched: true });
      return resolve({ data: wantSingle ? { ...written } : [{ ...written }], error: null });
    }

    // ---- conditional update: the precondition IS the WHERE clause ----
    const expected = eq.find(([c]) => c === 'updated_at')?.[1] as string | undefined;
    const current = keyFilter ? rows.get(keyFilter) : undefined;
    const matched = !!current && (expected === undefined || current.updated_at === expected);
    writes.push({ op: 'update', key: keyFilter!, matched });
    if (!matched) {
      // Zero rows matched — Postgres wrote nothing, exactly as the real table would.
      return resolve({ data: [], error: null });
    }
    const written: Row = { key: current!.key, value: payload.value, updated_at: payload.updated_at };
    rows.set(written.key, written);
    return resolve({ data: [{ ...written }], error: null });
  };

  return builder;
}

const supabaseServer = require('@/lib/supabase-server');
supabaseServer.getSupabaseAdmin = async () => ({ from: (table: string) => makeQueryBuilder(table) });

const { setSetting, setSettings, getSettingRecordByKey } =
  require('@/lib/repositories/settingsRepository');
const { isConflictError } = require('@/lib/errors/conflict');

const HEAD = 'custom_code_head';
/** The head as the sync read it, standing in for the real 28319-byte version. */
const OLD_HEAD = '<link rel="stylesheet" href="/a/4rINs9t3Jr3trVwMV7gybz/site.css">';
/** What the sync wanted to write — the 28660-byte version that vanished. */
const SYNCED_HEAD = '<link rel="stylesheet" href="/a/4ok5LxUl9zOEvUcCe8OKe1/site.css">';
/** What the concurrent writer (the builder's Settings → General save) put there instead. */
const OTHER_WRITER_HEAD = '<link rel="stylesheet" href="/a/someoneElsesBuild/site.css">';

const T0 = '2026-09-06T17:00:00.000Z';
const T1 = '2026-09-06T17:05:00.000Z';

beforeEach(() => {
  rows = new Map([[HEAD, { key: HEAD, value: OLD_HEAD, updated_at: T0 }]]);
  writes = [];
});

describe('SCA-1480 — settings writes honour an optimistic-concurrency precondition', () => {
  test('REGRESSION: a stale precondition is REFUSED and the other writer\'s value survives', async () => {
    // The sync read the head at T0. Someone else wrote it at T1 before the sync got to its write.
    rows.set(HEAD, { key: HEAD, value: OTHER_WRITER_HEAD, updated_at: T1 });

    await assert.rejects(
      () => setSetting(HEAD, SYNCED_HEAD, { expectedUpdatedAt: T0, caller: 'test:sync' }),
      (error: unknown) => {
        assert.ok(isConflictError(error), 'must be a ConflictError, not a generic failure');
        const conflict = error as { expected: string; current: Row };
        assert.equal(conflict.expected, T0);
        assert.equal(
          conflict.current.value, OTHER_WRITER_HEAD,
          'the conflict must carry the CURRENT value so the caller can print a diff and stop',
        );
        return true;
      },
    );

    assert.equal(
      rows.get(HEAD)!.value, OTHER_WRITER_HEAD,
      'the stored head must be untouched — this is the whole bug: the losing write used to win',
    );
    // Population check: the write was ATTEMPTED, so a passing assertion is not vacuous.
    assert.deepEqual(
      writes.map(w => [w.op, w.matched]), [['update', false]],
      'exactly one conditional UPDATE, matching zero rows',
    );
  });

  test('a matching precondition writes, and mints a NEW version for the next write', async () => {
    const saved = await setSetting(HEAD, SYNCED_HEAD, { expectedUpdatedAt: T0, caller: 'test:sync' });

    assert.equal(rows.get(HEAD)!.value, SYNCED_HEAD);
    assert.notEqual(saved.updated_at, T0, 'a write must move the version, or the guard is a no-op');
    assert.deepEqual(writes.map(w => [w.op, w.matched]), [['update', true]]);
  });

  test('expectedUpdatedAt: null means "this key did not exist" and collides if it now does', async () => {
    await assert.rejects(
      () => setSetting(HEAD, SYNCED_HEAD, { expectedUpdatedAt: null }),
      (error: unknown) => isConflictError(error),
    );
    assert.equal(rows.get(HEAD)!.value, OLD_HEAD, 'nothing written');

    // Same call against a genuinely absent key succeeds.
    const created = await setSetting('brand_new_key', 'hello', { expectedUpdatedAt: null });
    assert.equal(created.value, 'hello');
    assert.equal(rows.get('brand_new_key')!.value, 'hello');
  });

  test('NO precondition keeps the old unconditional upsert — other callers are untouched', async () => {
    // draft_css, publish bookkeeping and page creation all write without a version.
    const saved = await setSetting(HEAD, SYNCED_HEAD);

    assert.equal(rows.get(HEAD)!.value, SYNCED_HEAD);
    assert.equal(saved.value, SYNCED_HEAD);
    assert.deepEqual(writes.map(w => w.op), ['upsert'], 'still one upsert, not a conditional update');
  });

  test('getSettingRecordByKey hands out the version — without it no caller could ever guard', async () => {
    const record = await getSettingRecordByKey(HEAD);
    assert.equal(record!.updated_at, T0);
    assert.equal(await getSettingRecordByKey('nope'), null);
  });
});

describe('SCA-1480 — batch settings writes (the builder\'s Settings → General save)', () => {
  test('REGRESSION: a stale guarded key aborts BEFORE any unguarded key is written', async () => {
    rows.set(HEAD, { key: HEAD, value: OTHER_WRITER_HEAD, updated_at: T1 });

    await assert.rejects(
      () => setSettings(
        { [HEAD]: SYNCED_HEAD, site_name: 'Renamed' },
        { expectedUpdatedAt: { [HEAD]: T0 }, caller: 'test:builder' },
      ),
      (error: unknown) => isConflictError(error),
    );

    assert.equal(rows.get(HEAD)!.value, OTHER_WRITER_HEAD, 'head untouched');
    assert.equal(
      rows.has('site_name'), false,
      'the unguarded key must not be written either — a half-applied save is a worse surprise',
    );
  });

  test('guarded and unguarded keys both land when the precondition holds', async () => {
    const result = await setSettings(
      { [HEAD]: SYNCED_HEAD, site_name: 'Scalability' },
      { expectedUpdatedAt: { [HEAD]: T0 } },
    );

    assert.equal(result.count, 2);
    assert.equal(rows.get(HEAD)!.value, SYNCED_HEAD);
    assert.equal(rows.get('site_name')!.value, 'Scalability');
    assert.ok(
      result.updatedAt[HEAD],
      'the caller needs the new version back, or its NEXT save conflicts with its own write',
    );
  });

  test('a batch with no preconditions behaves exactly as before', async () => {
    const result = await setSettings({ [HEAD]: SYNCED_HEAD, site_name: 'Scalability' });

    assert.equal(result.count, 2);
    assert.equal(rows.get(HEAD)!.value, SYNCED_HEAD);
    assert.deepEqual(
      writes.map(w => w.op), ['upsert', 'upsert'],
      'both keys arrived in ONE batched upsert call, not as per-key conditional updates',
    );
  });
});
