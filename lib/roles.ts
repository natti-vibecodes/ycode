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

export function canManageMembers(role: UserRole): boolean {
  return role === 'owner' || role === 'admin';
}

export function canEditStructure(role: UserRole): boolean {
  return role !== 'editor';
}

export function canManageSettings(role: UserRole): boolean {
  return role !== 'editor';
}
