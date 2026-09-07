import type { Knex } from 'knex';
import { MEMBERSHIP_ROLE_SQL_LIST } from '../../lib/roles';

/**
 * Migration: make `public.is_workspace_member()` agree with `lib/roles.ts` on what a role IS.
 *
 * Codex round 3, residual #2 (`audits/2026-09-06/codex-round3.md`). The predicate shipped by
 * 20260906000004 was:
 *
 *     (u.raw_app_meta_data ->> 'role') is not null
 *
 * `->>` renders ANY json value as text, so the json values `""`, `false` and `0` all yield a
 * non-null string — `''`, `'false'`, `'0'` — and passed as membership. The app's
 * `extractRoleFromUser` is `(app_metadata.role as UserRole) || null`, which rejects all three
 * on JS falsiness. Same question, two answers, and the database's was the permissive one.
 *
 * MEASURED before this migration, with a throwaway auth user carrying `{"role": ""}` and a
 * real session JWT (SCA-1474 used the same instrument):
 *   PATCH /rest/v1/settings?key=eq.<probe>   → 1 row affected, the value CHANGED
 * After: 0 rows affected, value unchanged; a `{"role": "designer"}` control still reaches 1.
 * Row effects, never status codes — PostgREST answers an RLS-filtered UPDATE with 204 either
 * way (CLAUDE.md measurement doctrine).
 *
 * The list is INTERPOLATED FROM `lib/roles.ts`, not retyped, so the SQL and the TypeScript
 * cannot drift; `lib/roles-sql.test.ts` fails the suite if this file stops reading that export.
 *
 * ASYMMETRY, ON PURPOSE. `isWorkspaceMember` in the app counts any truthy role string —
 * including an unrecognised one — as membership, so a role rename cannot lock a real member
 * out of the builder. This predicate does not: an unknown role fails CLOSED at the database.
 * A value outside ALL_ROLES cannot be produced by the app at all (`api/auth/set-role` rejects
 * it), so the only way to reach the asymmetry is a direct app_metadata edit, and the failure
 * mode there is "writes refused", not "stranger admitted". Recorded on SCA-1474.
 *
 * Everything else about the function is preserved verbatim from 20260906000004: STABLE,
 * SECURITY DEFINER, empty search_path, and execute revoked from public/anon.
 */

/** `'owner', 'admin', 'designer', 'editor'` — generated from ALL_ROLES, never hand-written. */
const ROLE_LIST = MEMBERSHIP_ROLE_SQL_LIST;

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    create or replace function public.is_workspace_member()
    returns boolean language sql stable security definer set search_path = '' as $fn$
      select coalesce((select (u.raw_app_meta_data ->> 'role') in (${ROLE_LIST})
                         from auth.users u where u.id = (select auth.uid())), false);
    $fn$;
    revoke execute on function public.is_workspace_member() from public, anon;
    grant execute on function public.is_workspace_member() to authenticated;
  `);
}

export async function down(knex: Knex): Promise<void> {
  // Restores 20260906000004's definition verbatim — the permissive `is not null` form.
  await knex.raw(`
    create or replace function public.is_workspace_member()
    returns boolean language sql stable security definer set search_path = '' as $fn$
      select coalesce((select (u.raw_app_meta_data ->> 'role') is not null
                         from auth.users u where u.id = (select auth.uid())), false);
    $fn$;
    revoke execute on function public.is_workspace_member() from public, anon;
    grant execute on function public.is_workspace_member() to authenticated;
  `);
}
