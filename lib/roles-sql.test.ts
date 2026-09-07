import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ALL_ROLES, MEMBERSHIP_ROLE_SQL_LIST, isWorkspaceMember } from './roles';

/**
 * SCA-1474, round 3 residual #2. `public.is_workspace_member()` and `lib/roles.ts` answer the
 * same question — "is this person a workspace member?" — in two languages, and they disagreed:
 * the SQL predicate was `raw_app_meta_data ->> 'role' IS NOT NULL`, which passes the json
 * values `""`, `false` and `0` because `->>` stringifies them, while the app's `role || null`
 * rejects all three on JS falsiness.
 *
 * These tests exist so the two definitions cannot drift apart again. They cover the SOURCE
 * relationship (the SQL list is generated from ALL_ROLES and the migration reads that export);
 * the behavioural proof that the live predicate actually refuses a malformed role is a
 * row-effect measurement against a throwaway auth user, recorded on SCA-1474 — a unit test
 * cannot make that claim.
 */

const MIGRATION = path.join(
  __dirname,
  '..',
  'database',
  'migrations',
  '20260907000002_is_workspace_member_role_parity.ts',
);

const migrationSource = fs.readFileSync(MIGRATION, 'utf-8');

/** The migration file minus its comment blocks — grepping raw source reads prose as code. */
const migrationCode = migrationSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

describe('SQL/TS role parity (is_workspace_member)', () => {
  test('the SQL role list is GENERATED from ALL_ROLES, not a second copy', () => {
    assert.equal(MEMBERSHIP_ROLE_SQL_LIST, ALL_ROLES.map(r => `'${r}'`).join(', '));
    assert.equal(MEMBERSHIP_ROLE_SQL_LIST, "'owner', 'admin', 'designer', 'editor'");
  });

  test('the migration reads that export rather than retyping the roles', () => {
    assert.match(
      migrationCode,
      /import\s*\{\s*MEMBERSHIP_ROLE_SQL_LIST\s*\}\s*from\s*'\.\.\/\.\.\/lib\/roles'/,
      'the parity migration must import the shared list from lib/roles',
    );
    assert.match(migrationCode, /\$\{ROLE_LIST\}/, 'the predicate must interpolate the shared list');

    // The real assertion: no role name appears as a literal anywhere in the executable code.
    // A future hand-typed list is exactly the drift this whole exercise is about.
    for (const role of ALL_ROLES) {
      assert.ok(
        !migrationCode.includes(`'${role}'`),
        `role '${role}' is hard-coded in the migration body — interpolate MEMBERSHIP_ROLE_SQL_LIST instead`,
      );
    }
  });

  test('the predicate is membership by ENUM, and keeps the security-definer hardening', () => {
    assert.match(migrationCode, /raw_app_meta_data ->> 'role'\) in \(\$\{ROLE_LIST\}\)/);
    assert.match(migrationCode, /stable security definer set search_path = ''/);
    assert.match(migrationCode, /revoke execute on function public\.is_workspace_member\(\) from public, anon/);
  });

  test("down() restores 20260906000004's permissive `is not null` form", () => {
    const down = migrationCode.slice(migrationCode.indexOf('export async function down'));
    assert.match(down, /raw_app_meta_data ->> 'role'\) is not null/);
    assert.ok(!down.includes('${ROLE_LIST}'), 'a rollback must not carry the new predicate');
  });
});

/**
 * A mirror of Postgres `raw_app_meta_data ->> 'role' IN (…)` over a jsonb value, so the two
 * predicates can be compared on one case table. PROXY, SAID OUT LOUD: this is JS reasoning
 * about SQL semantics, not SQL. It is here to pin intent and catch a careless edit; the
 * database's real answer was measured live (SCA-1474).
 */
function sqlSaysMember(roleJson: unknown): boolean {
  if (roleJson === undefined || roleJson === null) return false; // `->>` yields SQL NULL
  const asText =
    typeof roleJson === 'string' ? roleJson : JSON.stringify(roleJson); // "" -> '', false -> 'false'
  return (ALL_ROLES as readonly string[]).includes(asText);
}

describe('the four values Codex found, and where the two predicates now stand', () => {
  const MALFORMED: Array<[string, unknown]> = [
    ['empty string', ''],
    ['boolean false', false],
    ['number zero', 0],
    ['json null', null],
  ];

  test('REGRESSION: every malformed role is refused by BOTH predicates', () => {
    for (const [label, value] of MALFORMED) {
      assert.equal(sqlSaysMember(value), false, `SQL admitted ${label}`);
      assert.equal(isWorkspaceMember({ app_metadata: { role: value } }), false, `TS admitted ${label}`);
    }
  });

  test('every real role is admitted by BOTH predicates', () => {
    for (const role of ALL_ROLES) {
      assert.equal(sqlSaysMember(role), true, `SQL refused ${role}`);
      assert.equal(isWorkspaceMember({ app_metadata: { role } }), true, `TS refused ${role}`);
    }
  });

  test('DOCUMENTED asymmetry: an unrecognised role string passes the app gate, writes nothing', () => {
    // Not an oversight. The builder gate stays permissive so a role RENAME cannot lock a real
    // member out mid-migration (see roles.test.ts); the database fails CLOSED instead. Only a
    // direct app_metadata edit can reach this state — api/auth/set-role refuses any value
    // outside ALL_ROLES — and the consequence is refused writes, never an admitted stranger.
    assert.equal(isWorkspaceMember({ app_metadata: { role: 'future-role' } }), true);
    assert.equal(sqlSaysMember('future-role'), false);
  });
});
