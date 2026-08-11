import type { Knex } from 'knex';

/**
 * Enable RLS on public.migrations (Supabase security advisor; SCA-1227 / SCA-1228).
 *
 * This is knex's own migration-tracking table. It sat in the public schema with RLS
 * disabled, so it was reachable through PostgREST by anything holding the anon key —
 * and the anon key is served publicly by design. Nothing sensitive lives in it, but it
 * leaks the schema's change history and it is the sort of table that should never have
 * been readable from a browser.
 *
 * No policy is created on purpose. With RLS enabled and no permissive policy, `anon`
 * and `authenticated` are denied by default; an explicit DENY policy would add nothing.
 *
 * App behaviour is unchanged, verified before landing:
 *   - every access is server-side through knex (migrationService, projectService,
 *     templateExportService), which connects over the Postgres connection string as the
 *     table OWNER, and owners bypass RLS unless FORCE ROW LEVEL SECURITY is set (it is not);
 *   - the Supabase JS client elsewhere uses the service_role key, which also bypasses RLS;
 *   - nothing client-side reads the table.
 *
 * Idempotent: ENABLE on an already-enabled table is a no-op, so it is safe if this runs
 * again on a project where the DDL was already applied out-of-band.
 */

export async function up(knex: Knex): Promise<void> {
  await knex.schema.raw('ALTER TABLE public.migrations ENABLE ROW LEVEL SECURITY');
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.raw('ALTER TABLE public.migrations DISABLE ROW LEVEL SECURITY');
}
