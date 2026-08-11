/**
 * Server-side role helpers for API routes.
 *
 * Authenticates the caller via Supabase session cookies and resolves
 * their role. Provides permission-check wrappers that return early
 * NextResponse errors so route handlers stay concise.
 */

import { getAuthUser } from '@/lib/supabase-auth';
import { getKnexClient } from '@/lib/knex-client';
import { noCache } from '@/lib/api-response';
import { resolveRole, canManageMembers as checkCanManage, type UserRole } from '@/lib/roles';

export interface CallerInfo {
  userId: string;
  role: UserRole;
}

/**
 * Authenticate the caller and resolve their role from app_metadata.
 * Returns null if not authenticated.
 */
export async function getCallerInfo(): Promise<CallerInfo | null> {
  const auth = await getAuthUser();
  if (!auth) return null;

  const role = resolveRole(auth.user.app_metadata?.role as string);
  return { userId: auth.user.id, role };
}

/**
 * True when no user in the project carries an explicitly assigned role — i.e. the workspace
 * has never been claimed.
 *
 * Exists to break a chicken-and-egg in first-run setup (SCA-1220): the welcome flow asks
 * set-role to make the first user `owner`, but set-role required owner/admin, and a
 * brand-new user has neither — so the very first owner could never be assigned and the
 * install silently ended up with zero privileged users. The bootstrap migration was meant
 * to cover this, but migrations run before any user exists, so its backfill matches nothing.
 *
 * Deliberately checks for an EXPLICIT role rather than going through resolveRole, whose
 * `designer` default would make every workspace look claimed.
 */
export async function isUnclaimedWorkspace(): Promise<boolean> {
  const knex = await getKnexClient();
  const result = await knex.raw(
    `SELECT 1 FROM auth.users WHERE raw_app_meta_data->>'role' IS NOT NULL LIMIT 1`
  );
  return (result?.rows?.length ?? 0) === 0;
}

/**
 * Require the caller to be owner or admin.
 * Returns CallerInfo on success, or a 401/403 NextResponse on failure.
 */
export async function requireManageMembers() {
  const caller = await getCallerInfo();
  if (!caller) return noCache({ error: 'Not authenticated' }, 401);
  if (!checkCanManage(caller.role)) return noCache({ error: 'Insufficient permissions' }, 403);
  return caller;
}
