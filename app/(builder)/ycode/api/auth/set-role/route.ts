import { NextRequest } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase-server';
import { noCache } from '@/lib/api-response';
import { getCallerInfo, isUnclaimedWorkspace } from '@/lib/roles-server';
import { ALL_ROLES, canManageMembers } from '@/lib/roles';

export const dynamic = 'force-dynamic';

/**
 * POST /ycode/api/auth/set-role
 *
 * Set a user's role in app_metadata via the Supabase Admin API.
 * Requires the caller to be owner or admin — except on first run, see below.
 */
export async function POST(request: NextRequest) {
  try {
    // Authorisation depends on WHICH role is being granted and to whom, so the body is
    // parsed and validated before the permission check rather than after.
    const caller = await getCallerInfo();
    if (!caller) return noCache({ error: 'Not authenticated' }, 401);

    const body = await request.json();
    const { userId, role } = body;

    if (!userId || !role) {
      return noCache({ error: 'userId and role are required' }, 400);
    }

    if (!ALL_ROLES.includes(role)) {
      return noCache({ error: `Invalid role. Must be one of: ${ALL_ROLES.join(', ')}` }, 400);
    }

    if (await isUnclaimedWorkspace()) {
      // First run (SCA-1220): nobody holds a role yet, so requiring owner/admin here would
      // make the first owner unassignable and leave the install with no privileged user.
      // Narrow escape hatch — the caller may only make THEMSELVES the owner, and only while
      // the workspace is unclaimed. It closes permanently the moment any role exists.
      // Not transactional: two brand-new users racing this on a fresh install could both
      // become owner. Acceptable — it is a first-run-only window on an install nobody else
      // has reached yet, and both would be legitimate setup users.
      if (userId !== caller.userId || role !== 'owner') {
        return noCache(
          { error: 'While the workspace is unclaimed, the first user may only claim the owner role for themselves' },
          403,
        );
      }
    } else {
      if (!canManageMembers(caller.role)) {
        return noCache({ error: 'Insufficient permissions' }, 403);
      }

      if (role === 'owner' && caller.role !== 'owner') {
        return noCache({ error: 'Only the owner can assign the owner role' }, 403);
      }
    }

    const client = await getSupabaseAdmin();
    if (!client) {
      return noCache({ error: 'Supabase not configured' }, 500);
    }

    const { error } = await client.auth.admin.updateUserById(userId, {
      app_metadata: { role },
    });

    if (error) {
      console.error('[set-role] Error:', error);
      return noCache({ error: error.message }, 400);
    }

    return noCache({ data: { success: true } });
  } catch (error) {
    console.error('[set-role] Unexpected error:', error);
    return noCache({ error: 'Failed to set role' }, 500);
  }
}
