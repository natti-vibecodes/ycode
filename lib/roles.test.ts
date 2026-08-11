import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isWorkspaceMember, extractRoleFromUser, resolveRole, ALL_ROLES } from './roles';

/**
 * SCA-1220. The builder gate used to check authentication only, so with open signup any
 * stranger who registered could reach the builder API. isWorkspaceMember is the
 * authorisation half.
 */
describe('isWorkspaceMember (builder gate authorisation)', () => {
  test('REGRESSION: a user with no assigned role is refused', () => {
    // The whole point of the gate. A self-registered account has no app_metadata.role,
    // and must not be treated as a member.
    assert.equal(isWorkspaceMember({ app_metadata: {} }), false);
    assert.equal(isWorkspaceMember({}), false);
    assert.equal(isWorkspaceMember(null), false);
  });

  test('REGRESSION: resolveRole would have let that same user through — do not swap it in', () => {
    // resolveRole defaults a missing role to `designer`. It is correct for "what may this
    // member do?" and catastrophic for "is this person a member?". Reaching for it here is
    // the natural mistake, and it fails open: the gate would look right and admit everyone.
    const stranger = { app_metadata: {} };
    assert.equal(resolveRole(undefined), 'designer');       // the trap
    assert.equal(extractRoleFromUser(stranger), null);      // what the gate must use
    assert.equal(isWorkspaceMember(stranger), false);
  });

  test('every assignable role is a member', () => {
    for (const role of ALL_ROLES) {
      assert.equal(isWorkspaceMember({ app_metadata: { role } }), true, `role ${role}`);
    }
  });

  test('an unrecognised role string still counts as membership', () => {
    // Membership is "was deliberately given a role by an admin", which is a separate
    // question from whether the role is one we currently recognise. Failing closed on an
    // unknown value would lock out real members after a rename; permission checks
    // downstream still narrow what they can actually do.
    assert.equal(isWorkspaceMember({ app_metadata: { role: 'future-role' } }), true);
  });

  test('a role-shaped value elsewhere in the payload does not grant membership', () => {
    // Only app_metadata counts — it is writable solely via the Admin API or SQL.
    // user_metadata is user-writable, so it must never confer access.
    assert.equal(isWorkspaceMember({ app_metadata: {} } as never), false);
    assert.equal(
      isWorkspaceMember({ user_metadata: { role: 'owner' }, app_metadata: {} } as never),
      false,
    );
  });
});
