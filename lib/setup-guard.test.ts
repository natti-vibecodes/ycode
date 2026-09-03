/**
 * Regression cover for the unauthenticated setup flow (security audit, 2026-09-02).
 *
 * `/ycode/api/setup/` is a public prefix in proxy.ts and must be — the wizard runs before any
 * user, session or database exists. The bug was that it stayed public forever. On a workspace
 * that had already been claimed:
 *
 *   - `setup/connect` tested attacker-supplied credentials against an attacker-supplied host
 *     (unauthenticated SSRF + port scan, with the driver's error text returned verbatim as the
 *     oracle) and, off Vercel, SAVED them via credentials.set — repointing the app at another
 *     database and rewriting .env.
 *   - `setup/migrate` ran migrations and seeds for anyone.
 *
 * These tests cover the guard's decision logic directly, plus the two mutation routes driven
 * as real handlers, asserting that the dangerous side effects are never reached.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';

const serverOnlyPath = require.resolve('server-only');
require.cache[serverOnlyPath] = {
  id: serverOnlyPath,
  filename: serverOnlyPath,
  loaded: true,
  exports: {},
} as unknown as NodeModule;

// migrations-loader uses webpack's `require.context`, which does not exist under node's
// resolver. The migration service pulls it in transitively; stub it before that happens.
const migrationsLoaderPath = require('path').join(__dirname, 'migrations-loader.ts');
require.cache[migrationsLoaderPath] = {
  id: migrationsLoaderPath,
  filename: migrationsLoaderPath,
  loaded: true,
  exports: { migrations: [] },
} as unknown as NodeModule;

const credentialsModule = require('@/lib/credentials');
const supabaseServer = require('@/lib/supabase-server');
const rolesServer = require('@/lib/roles-server');
const knexClient = require('@/lib/knex-client');
const migrationService = require('@/lib/services/migrationService');
const seedService = require('@/lib/services/seedService');

/** World state the fakes answer from. */
let storedConfig: unknown = null;
let authUserCount = 0;
let workspaceUnclaimed = true;

/** Dangerous side effects — each records that it was reached. */
let credentialsSetCalls = 0;
let supabaseApiTestCalls: unknown[] = [];
let dbConnectionTestCalls: unknown[] = [];
let migrationsRun = 0;
let seedsRun = 0;

credentialsModule.credentials.get = async () => storedConfig;
credentialsModule.credentials.set = async () => {
  credentialsSetCalls += 1;
};

supabaseServer.getSupabaseAdmin = async () => ({
  auth: {
    admin: {
      listUsers: async () => ({
        data: { users: Array.from({ length: authUserCount }, (_, i) => ({ id: `u${i}` })) },
        error: null,
      }),
    },
  },
});
supabaseServer.testSupabaseConnection = async (config: unknown) => {
  supabaseApiTestCalls.push(config);
  return { success: false, error: 'ECONNREFUSED 10.0.0.5:5432 — connection refused by peer' };
};

rolesServer.isUnclaimedWorkspace = async () => workspaceUnclaimed;
knexClient.testSupabaseDirectConnection = async (opts: unknown) => {
  dbConnectionTestCalls.push(opts);
  return { success: false, error: 'FATAL: password authentication failed for user "postgres"' };
};

migrationService.runMigrations = async () => {
  migrationsRun += 1;
  return { success: true, executed: [], failed: [] };
};
seedService.runSeeds = async () => {
  seedsRun += 1;
  return { success: true, results: [] };
};

const { isSetupLocked, checkConnectTarget } = require('@/lib/setup-guard');
const connectRoute = require('@/app/(builder)/ycode/api/setup/connect/route');
const migrateRoute = require('@/app/(builder)/ycode/api/setup/migrate/route');

const VALID_BODY = {
  anon_key: 'anon-key',
  service_role_key: 'service-role-key',
  connection_url: 'postgresql://postgres.abcdefghijklm:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres',
  db_password: 'pw',
};

function connect(body: Record<string, unknown> = {}) {
  return connectRoute.POST(
    new NextRequest('http://localhost:3002/ycode/api/setup/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...VALID_BODY, ...body }),
    }),
  );
}

/** A claimed workspace: credentials stored and a real user present. */
function claimWorkspace() {
  storedConfig = { anonKey: 'a', serviceRoleKey: 's', connectionUrl: 'c', dbPassword: 'p' };
  authUserCount = 1;
  workspaceUnclaimed = false;
}

/** A genuine first run: nothing configured at all. */
function freshInstall() {
  storedConfig = null;
  authUserCount = 0;
  workspaceUnclaimed = true;
}

beforeEach(() => {
  credentialsSetCalls = 0;
  supabaseApiTestCalls = [];
  dbConnectionTestCalls = [];
  migrationsRun = 0;
  seedsRun = 0;
  freshInstall();
});

describe('isSetupLocked — the state machine', () => {
  test('a fresh install is OPEN, so the wizard still works', async () => {
    assert.equal(await isSetupLocked(), false);
  });

  test('configured but no users yet is OPEN — that is mid-setup', async () => {
    storedConfig = { anonKey: 'a' };
    authUserCount = 0;
    workspaceUnclaimed = true;
    assert.equal(await isSetupLocked(), false);
  });

  test('an auth user exists — LOCKED', async () => {
    storedConfig = { anonKey: 'a' };
    authUserCount = 1;
    assert.equal(await isSetupLocked(), true);
  });

  test('a role has been assigned — LOCKED even if listUsers reports nothing', async () => {
    storedConfig = { anonKey: 'a' };
    authUserCount = 0;
    workspaceUnclaimed = false;
    assert.equal(await isSetupLocked(), true);
  });

  test('an unreachable database leaves setup OPEN, not stuck', async () => {
    storedConfig = { anonKey: 'a' };
    authUserCount = 0;
    rolesServer.isUnclaimedWorkspace = async () => {
      throw new Error('ECONNREFUSED');
    };

    assert.equal(await isSetupLocked(), false);

    rolesServer.isUnclaimedWorkspace = async () => workspaceUnclaimed;
  });
});

describe('setup/connect — refused on a claimed workspace', () => {
  test('returns 403', async () => {
    claimWorkspace();
    const response = await connect();
    assert.equal(response.status, 403);
  });

  test('makes NO outbound connection — the SSRF/port-scan primitive is gone', async () => {
    claimWorkspace();
    await connect({
      connection_url: 'postgresql://postgres.evil:pw@10.0.0.5:6379/postgres',
      supabase_url: 'http://10.0.0.5:6379',
    });

    assert.deepEqual(supabaseApiTestCalls, [], 'no Supabase API probe may be made');
    assert.deepEqual(dbConnectionTestCalls, [], 'no database probe may be made');
  });

  test('never saves the posted credentials', async () => {
    claimWorkspace();
    await connect();
    assert.equal(credentialsSetCalls, 0, 'credentials.set must not be reached');
  });
});

describe('setup/migrate — refused on a claimed workspace', () => {
  test('returns 403 and runs neither migrations nor seeds', async () => {
    claimWorkspace();
    const response = await migrateRoute.POST();

    assert.equal(response.status, 403);
    assert.equal(migrationsRun, 0);
    assert.equal(seedsRun, 0);
  });

  test('a fresh install still migrates — the guard is not a brick wall', async () => {
    freshInstall();
    const response = await migrateRoute.POST();

    assert.equal(response.status, 200);
    assert.equal(migrationsRun, 1, 'the real first-run path must still work');
    assert.equal(seedsRun, 1);
  });
});

describe('setup/connect — error responses are not an oracle', () => {
  test('the raw driver text never reaches the client', async () => {
    freshInstall();
    const body = await (await connect()).json();
    const raw = JSON.stringify(body);

    assert.ok(!raw.includes('ECONNREFUSED'), 'driver error class must not be echoed');
    assert.ok(!raw.includes('10.0.0.5'), 'probed host must not be echoed');
    assert.ok(!raw.includes('password authentication failed'), 'auth detail must not be echoed');
  });

  test('the fixture really does produce a raw error, so the check is not vacuous', async () => {
    freshInstall();
    await connect();
    assert.equal(supabaseApiTestCalls.length, 1, 'the probe must have run and failed');
  });
});

describe('checkConnectTarget — outbound targets are restricted', () => {
  test('managed Supabase hosts are allowed', () => {
    for (const host of [
      'aws-0-us-east-1.pooler.supabase.com',
      'db.abcdefghijklm.supabase.co',
      'something.supabase.in',
    ]) {
      assert.equal(checkConnectTarget(host, undefined, 'production').allowed, true, host);
    }
  });

  test('an arbitrary host is refused', () => {
    for (const host of ['evil.test', 'example.com', 'attacker.co.uk']) {
      assert.equal(checkConnectTarget(host, undefined, 'production').allowed, false, host);
    }
  });

  test('a lookalike domain does not slip through the suffix match', () => {
    for (const host of ['supabase.co.evil.test', 'notsupabase.com', 'supabase.com.attacker.net']) {
      assert.equal(checkConnectTarget(host, undefined, 'production').allowed, false, host);
    }
  });

  test('internal and loopback targets are refused in production', () => {
    for (const host of [
      'localhost', '127.0.0.1', '10.0.0.5', '192.168.1.1',
      '169.254.169.254', '172.16.0.9', 'db.internal', 'printer.local',
    ]) {
      assert.equal(checkConnectTarget(host, `http://${host}:8080`, 'production').allowed, false, host);
    }
  });

  test('localhost self-hosting still works in development', () => {
    assert.equal(
      checkConnectTarget('localhost', 'http://localhost:8000', 'development').allowed,
      true,
      'docker-compose self-hosting is a normal dev setup',
    );
  });

  test('a self-hosted host must match its declared Supabase URL', () => {
    assert.equal(
      checkConnectTarget('supabase.mycompany.example', 'https://supabase.mycompany.example', 'production').allowed,
      true,
    );
    assert.equal(
      checkConnectTarget('unrelated.example', 'https://supabase.mycompany.example', 'production').allowed,
      false,
      'a mismatched pair is a scan, not a setup',
    );
  });
});
