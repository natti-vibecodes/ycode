/**
 * Shared role definitions and permission helpers.
 *
 * Role hierarchy: owner > admin > designer > editor
 */

export const ALL_ROLES = ['owner', 'admin', 'designer', 'editor'] as const;
export type UserRole = (typeof ALL_ROLES)[number];

export const ASSIGNABLE_ROLES = ['admin', 'designer', 'editor'] as const;
export const DEFAULT_ROLE: UserRole = 'designer';

export function resolveRole(raw: string | undefined | null): UserRole {
  if (raw && ALL_ROLES.includes(raw as UserRole)) return raw as UserRole;
  return DEFAULT_ROLE;
}

export function extractRoleFromUser(user: { app_metadata?: Record<string, unknown> } | null): UserRole | null {
  return (user?.app_metadata?.role as UserRole) || null;
}

/**
 * Membership test for the builder gate (SCA-1220).
 *
 * Authentication is not authorisation: with open signup, anyone can hold a valid session
 * without ever having been invited. A user belongs to this workspace only if they carry an
 * EXPLICITLY assigned role in app_metadata — which is writable solely via the Admin API or
 * SQL, never by the user themselves.
 *
 * Deliberately built on extractRoleFromUser rather than resolveRole. resolveRole DEFAULTS a
 * missing role to `designer`, which is right for "what may this member do?" but catastrophic
 * for "is this person a member at all?" — it would hand every self-registered stranger a
 * designer role and wave them through. See the regression test.
 */
export function isWorkspaceMember(user: { app_metadata?: Record<string, unknown> } | null): boolean {
  return extractRoleFromUser(user) !== null;
}

/**
 * The membership predicate as SQL, for `public.is_workspace_member()` (SCA-1474 round 3).
 *
 * ONE SOURCE. `ALL_ROLES` above is the only place the role names are written; this constant
 * is generated from it, and `20260907000002_is_workspace_member_role_parity.ts` interpolates
 * it rather than retyping the list. `lib/roles-sql.test.ts` asserts the migration reads this
 * export and that the two lists cannot drift apart.
 *
 * WHY IT EXISTS. The original SQL predicate was `raw_app_meta_data ->> 'role' IS NOT NULL`,
 * which `->>`-stringifies any JSON value: the JSON values `""`, `false` and `0` all produced
 * a non-null text and therefore PASSED, while the app's `role || null` rejects all three on
 * JS falsiness. Codex found that gap in round 3 (residual #2). Live census at the time:
 * 2 users, 2 valid roles, 0 malformed — latent, not a live bypass, and users cannot edit
 * their own app_metadata.
 *
 * KNOWN, DELIBERATE ASYMMETRY. This is stricter than `isWorkspaceMember`, which counts any
 * truthy role string as membership so a rename cannot lock out real members (see the
 * regression test in roles.test.ts). The database fails CLOSED instead: a role outside
 * ALL_ROLES gets past the builder gate but writes nothing. That direction is safe, and it is
 * reachable only by editing app_metadata directly — `api/auth/set-role` already refuses any
 * value outside ALL_ROLES, so the app cannot mint one. Widening the DB to match the app's
 * truthiness would re-open exactly the hole this closes.
 */
export const MEMBERSHIP_ROLE_SQL_LIST: string = ALL_ROLES.map(role => `'${role}'`).join(', ');

export function canManageMembers(role: UserRole): boolean {
  return role === 'owner' || role === 'admin';
}

export function canEditStructure(role: UserRole): boolean {
  return role !== 'editor';
}

export function canManageSettings(role: UserRole): boolean {
  return role !== 'editor';
}
