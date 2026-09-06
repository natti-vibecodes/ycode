/**
 * Security plan 2026-09-06, item #3 — MCP URL tokens are hashed at rest.
 *
 * `mcp_tokens.token` used to hold the bearer value itself and `validateToken`
 * looked it up with `.eq('token', token)`. Any account that could read the
 * table read a live credential granting MCP write access to the whole site.
 *
 * These drive the REAL `createToken` / `validateToken` / `deleteToken` against
 * a recording Supabase fake and assert on what was actually SENT to the
 * database, not on what the function returned — the discriminating question is
 * "does a plaintext token ever reach a column", and only the recorded insert
 * payload answers it.
 *
 * Each of these FAILS against the pre-change repository:
 *   - "the plaintext token is never stored"  → the old insert sent `token`
 *   - "lookup is by hash, not by plaintext"  → the old filter was ('token', …)
 * (verified by running this file against the previous revision before landing).
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'crypto';

/* eslint-disable @typescript-eslint/no-require-imports */
// require(), not import: the Supabase module is stubbed before the code under
// test loads, and hoisted imports cannot express that ordering.

const serverOnlyPath = require.resolve('server-only');
require.cache[serverOnlyPath] = {
  id: serverOnlyPath,
  filename: serverOnlyPath,
  loaded: true,
  exports: {},
} as unknown as NodeModule;

interface Row { [key: string]: unknown }

/** Every row the fake "database" holds, keyed by table. */
let rows: Row[] = [];
/** Every payload handed to `.insert()` — this is where a leaked plaintext would show. */
let insertPayloads: Row[] = [];
/** Every filter applied, as `column=value` — this is where the lookup shape shows. */
let filters: string[] = [];

function makeBuilder() {
  const applied: Array<[string, unknown]> = [];
  let pending: Row | null = null;

  const builder: Record<string, unknown> = {};
  builder.select = () => builder;
  builder.update = () => builder;
  builder.delete = () => {
    // Deletes settle without .single(); resolve against the current filters.
    return builder;
  };
  builder.insert = (payload: Row) => {
    insertPayloads.push(payload);
    pending = { id: 'row-' + insertPayloads.length, ...payload };
    rows.push(pending);
    return builder;
  };
  builder.eq = (column: string, value: unknown) => {
    applied.push([column, value]);
    filters.push(`${column}=${String(value)}`);
    return builder;
  };
  builder.single = async () => {
    if (pending) return { data: pending, error: null };
    const match = rows.find((row) => applied.every(([c, v]) => row[c] === v));
    return match
      ? { data: match, error: null }
      : { data: null, error: { code: 'PGRST116', message: 'no rows' } };
  };
  // `await builder` for the non-.single() calls (the last_used_at update, delete).
  builder.then = (resolve: (value: unknown) => unknown) => resolve({ data: null, error: null });
  return builder;
}

const supabaseServer = require('@/lib/supabase-server');
supabaseServer.getSupabaseAdmin = async () => ({ from: () => makeBuilder() });

const repo = require('@/lib/repositories/mcpTokenRepository');
const { clearTokenCache } = require('@/lib/mcp/token-cache');

const sha256Hex = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

describe('MCP URL tokens are hashed at rest (#3)', () => {
  beforeEach(() => {
    rows = [];
    insertPayloads = [];
    filters = [];
    clearTokenCache();
  });

  test('the plaintext token is NEVER written to the database', async () => {
    const created = await repo.createToken('probe');

    assert.equal(insertPayloads.length, 1, 'expected exactly one insert — population check');
    const payload = insertPayloads[0];

    // The plaintext is handed back to the caller exactly once...
    assert.match(created.token, /^ymc_[0-9a-f]{48}$/);
    // ...and appears in NO column of the insert, under any name.
    for (const [column, value] of Object.entries(payload)) {
      assert.notEqual(
        value,
        created.token,
        `column ${column} carries the plaintext token`,
      );
    }
    assert.equal(payload.token, undefined, 'the plaintext `token` column must not be written');
    assert.equal(payload.token_hash, sha256Hex(created.token));
    assert.equal(payload.token_prefix, created.token.substring(0, 12));
  });

  test('the stored hash matches the SQL backfill derivation', () => {
    // encode(sha256(convert_to(token,'UTF8')),'hex') in Postgres must equal this.
    // Pinned vector so a change to the hashing scheme cannot pass silently: a
    // scheme change breaks every existing token and has to be a deliberate act.
    const { hashMcpToken } = require('@/lib/mcp/token-hash');
    assert.equal(
      hashMcpToken('ymc_0123456789abcdef'),
      sha256Hex('ymc_0123456789abcdef'),
    );
    assert.equal(
      hashMcpToken('abc'),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  test('lookup is by hash, and the right token still validates', async () => {
    const created = await repo.createToken('probe');
    rows[0].is_active = true;
    filters = [];

    const record = await repo.validateToken(created.token);

    assert.ok(record, 'the issued token must still authenticate');
    assert.ok(
      filters.includes(`token_hash=${sha256Hex(created.token)}`),
      `expected a token_hash filter, saw: ${filters.join(', ')}`,
    );
    assert.ok(
      !filters.some((f) => f.startsWith('token=')),
      `the plaintext column must never be filtered on, saw: ${filters.join(', ')}`,
    );
  });

  test('a wrong token does not validate', async () => {
    const created = await repo.createToken('probe');
    rows[0].is_active = true;

    assert.equal(await repo.validateToken('ymc_' + 'f'.repeat(48)), null);
    // And a near-miss on the prefix is still refused — the prefix is display-only.
    assert.equal(await repo.validateToken(created.token.slice(0, -1) + '0'), null);
  });

  test('an expired token does not validate even with the right hash', async () => {
    const created = await repo.createToken('probe');
    rows[0].is_active = true;
    rows[0].expires_at = new Date(Date.now() - 1000).toISOString();

    assert.equal(await repo.validateToken(created.token), null);
  });
});
