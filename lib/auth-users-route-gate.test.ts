/**
 * Regression cover for the anonymous user-roster leak (security audit, 2026-09-02).
 *
 * `GET /ycode/api/auth/users` shipped with NO authorization at all. `/ycode/api/auth/` is a
 * PUBLIC prefix in proxy.ts — it has to be, because auth callbacks run before a session
 * exists — so the handler was the only thing standing between an anonymous POST-less GET and
 * the full member list: every email, user UUID, role, and last-sign-in timestamp. The
 * `getCallerInfo()` call in the handler read like authentication and was decorative: its
 * result was only stamped into the response as `callerRole`, and `null` was an accepted value.
 *
 * These tests drive the REAL route handler, faking only the role gate and the Supabase admin
 * client. The load-bearing assertion is not merely "status is 401" — it is that the roster
 * fixture's email never appears in the response body AND that `listUsers` is never reached, so
 * the test still bites if someone returns 401 after already doing the privileged read.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';

/* eslint-disable @typescript-eslint/no-require-imports */
// require(), not import: these modules are stubbed in require.cache before the code under test
// loads, and hoisted imports cannot express that ordering.

// `server-only` throws on import; pre-seed require.cache so the route's dependency graph loads.
const serverOnlyPath = require.resolve('server-only');
require.cache[serverOnlyPath] = {
  id: serverOnlyPath,
  filename: serverOnlyPath,
  loaded: true,
  exports: {},
} as unknown as NodeModule;

const ROSTER_EMAIL = 'nataliya.odrinskaya@gmail.com';
const ROSTER_UUID = '11111111-2222-3333-4444-555555555555';

const rolesServer = require('@/lib/roles-server');
const supabaseServer = require('@/lib/supabase-server');
const { noCache } = require('@/lib/api-response');

/** Records whether the privileged read was reached at all. */
let listUsersCalls = 0;

/** What the (faked) gate should answer for the test at hand. */
let gateAnswer: () => unknown;

supabaseServer.getSupabaseAdmin = async () => ({
  auth: {
    admin: {
      listUsers: async () => {
        listUsersCalls += 1;
        return {
          data: {
            users: [
              {
                id: ROSTER_UUID,
                email: ROSTER_EMAIL,
                created_at: '2026-01-01T00:00:00Z',
                last_sign_in_at: '2026-09-01T12:00:00Z',
                email_confirmed_at: '2026-01-01T00:00:00Z',
                identities: [{ provider: 'email' }],
                user_metadata: { display_name: 'Natalia' },
                app_metadata: { role: 'owner' },
              },
            ],
          },
          error: null,
        };
      },
    },
  },
});

rolesServer.requireManageMembers = async () => gateAnswer();

const route = require('@/app/(builder)/ycode/api/auth/users/route');

function getUsers() {
  return route.GET(new NextRequest('http://localhost:3002/ycode/api/auth/users'));
}

beforeEach(() => {
  listUsersCalls = 0;
  gateAnswer = () => ({ userId: ROSTER_UUID, role: 'owner' });
});

describe('auth/users GET — fixture sanity (population law)', () => {
  test('the fixture roster is non-empty and carries a real email', async () => {
    const body = await (await getUsers()).json();
    assert.equal(body.data.activeUsers.length, 1);
    assert.equal(body.data.activeUsers[0].email, ROSTER_EMAIL);
  });

  test('so an "email is absent" assertion is not vacuous — it is present when allowed', async () => {
    const raw = JSON.stringify(await (await getUsers()).json());
    assert.ok(raw.includes(ROSTER_EMAIL), 'the allowed path must leak the email into the body');
    assert.ok(raw.includes(ROSTER_UUID), 'the allowed path must leak the uuid into the body');
  });
});

describe('auth/users GET — the gate refuses', () => {
  test('an anonymous caller gets 401 and no roster', async () => {
    gateAnswer = () => noCache({ error: 'Not authenticated' }, 401);

    const response = await getUsers();
    const raw = JSON.stringify(await response.json());

    assert.equal(response.status, 401);
    assert.ok(!raw.includes(ROSTER_EMAIL), 'email must not appear in a refused response');
    assert.ok(!raw.includes(ROSTER_UUID), 'uuid must not appear in a refused response');
  });

  test('a caller without manage-members rights gets 403 and no roster', async () => {
    gateAnswer = () => noCache({ error: 'Insufficient permissions' }, 403);

    const response = await getUsers();
    const raw = JSON.stringify(await response.json());

    assert.equal(response.status, 403);
    assert.ok(!raw.includes(ROSTER_EMAIL), 'email must not appear in a refused response');
  });

  test('the refusal happens BEFORE the privileged read, not after it', async () => {
    gateAnswer = () => noCache({ error: 'Not authenticated' }, 401);

    await getUsers();

    assert.equal(
      listUsersCalls,
      0,
      'listUsers must never be reached for a refused caller — a 401 returned after the read still ' +
        'billed the admin query and would leak through logs/timing',
    );
  });
});

describe('auth/users GET — the legitimate path still works', () => {
  test('an owner gets the roster and their own role back', async () => {
    const response = await getUsers();
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(listUsersCalls, 1);
    assert.equal(body.data.callerRole, 'owner');
    assert.equal(body.data.activeUsers[0].email, ROSTER_EMAIL);
  });
});
