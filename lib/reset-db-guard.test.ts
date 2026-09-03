/**
 * Regression cover for the unguarded database-reset route (security audit, 2026-09-02).
 *
 * POST /ycode/api/devtools/reset-db drops every table in the public schema and deletes the
 * assets storage bucket. Its header comment said "Authentication enforced by proxy" — true,
 * and far too weak. proxy.ts only proves the caller is *a* workspace member, so any designer
 * (the role anyone added to the workspace gets by default) could destroy the entire site and
 * every uploaded asset with one POST. There was no environment guard either, so it was live
 * in production.
 *
 * The assertions that bite are not on the status code but on the destructive calls: knex.raw
 * and the storage deletions must never be reached by a caller who should not have got there.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
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

/** Destructive side effects — each records that it was reached. */
let knexRawCalls: string[] = [];
let emptyBucketCalls = 0;
let deleteBucketCalls = 0;
let cacheClears = 0;

/** What the faked role gate answers. */
let gateAnswer: () => unknown;

const knexClient = require('@/lib/knex-client');
const supabaseServer = require('@/lib/supabase-server');
const rolesServer = require('@/lib/roles-server');
const cacheService = require('@/lib/services/cacheService');
const { noCache } = require('@/lib/api-response');

knexClient.getKnexClient = async () => ({
  raw: async (sql: string) => {
    knexRawCalls.push(sql);
    return { rows: [] };
  },
});

supabaseServer.getSupabaseAdmin = async () => ({
  storage: {
    emptyBucket: async () => {
      emptyBucketCalls += 1;
      return { error: null };
    },
    deleteBucket: async () => {
      deleteBucketCalls += 1;
      return { error: null };
    },
  },
});

rolesServer.requireManageMembers = async () => gateAnswer();
cacheService.clearAllCache = async () => {
  cacheClears += 1;
};

const route = require('@/app/(builder)/ycode/api/devtools/reset-db/route');

const originalNodeEnv = process.env.NODE_ENV;

function setNodeEnv(value: string) {
  // NODE_ENV is typed readonly; process.env itself only accepts plain data descriptors.
  (process.env as Record<string, string>).NODE_ENV = value;
}

function assertNothingDestroyed() {
  assert.deepEqual(knexRawCalls, [], 'no SQL may be executed');
  assert.equal(emptyBucketCalls, 0, 'the storage bucket must not be emptied');
  assert.equal(deleteBucketCalls, 0, 'the storage bucket must not be deleted');
  assert.equal(cacheClears, 0, 'the cache must not be purged');
}

beforeEach(() => {
  knexRawCalls = [];
  emptyBucketCalls = 0;
  deleteBucketCalls = 0;
  cacheClears = 0;
  gateAnswer = () => ({ userId: 'u1', role: 'owner' });
  setNodeEnv('development');
});

afterEach(() => {
  setNodeEnv(originalNodeEnv || 'test');
});

describe('reset-db — fixture sanity (population law)', () => {
  test('an owner in development really does reset, so the refusals below are not vacuous', async () => {
    const response = await route.POST();

    assert.equal(response.status, 200);
    assert.ok(knexRawCalls.length >= 2, 'the destructive path must actually run here');
    assert.ok(
      knexRawCalls.some(sql => sql.includes('DROP TABLE')),
      'the fixture must reach the DROP TABLE statement',
    );
    assert.equal(deleteBucketCalls, 1);
  });
});

describe('reset-db — refused in production', () => {
  test('an owner is refused in production', async () => {
    setNodeEnv('production');
    gateAnswer = () => ({ userId: 'u1', role: 'owner' });

    const response = await route.POST();

    assert.equal(response.status, 403);
    assertNothingDestroyed();
  });

  test('the production check runs before the role check, so it cannot be reached at all', async () => {
    setNodeEnv('production');
    let gateConsulted = false;
    gateAnswer = () => {
      gateConsulted = true;
      return { userId: 'u1', role: 'owner' };
    };

    await route.POST();

    assert.equal(gateConsulted, false, 'production refuses outright, whoever is asking');
  });
});

describe('reset-db — requires owner/admin, not merely a session', () => {
  test('an anonymous caller destroys nothing', async () => {
    gateAnswer = () => noCache({ error: 'Not authenticated' }, 401);

    const response = await route.POST();

    assert.equal(response.status, 401);
    assertNothingDestroyed();
  });

  test('a designer — a real workspace member — destroys nothing', async () => {
    // This is the case the old "authentication enforced by proxy" comment missed entirely:
    // the proxy would have let this caller straight through to the DROP TABLE loop.
    gateAnswer = () => noCache({ error: 'Insufficient permissions' }, 403);

    const response = await route.POST();

    assert.equal(response.status, 403);
    assertNothingDestroyed();
  });
});
