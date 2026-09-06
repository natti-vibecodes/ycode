import type { Knex } from 'knex';

/**
 * Migration: membership-based write policies — `settings` FIRST.
 *
 * Every write policy in `public` was `((SELECT auth.uid()) IS NOT NULL)` —
 * authenticated, not member. The owner/admin/designer model existed only in the
 * Next layer (`lib/roles.ts`, `proxy.ts`), which PostgREST bypasses using the
 * publishable key the app serves anonymously at `/ycode/api/supabase/config`.
 *
 * MEASURED before this migration, with a throwaway role-less auth user:
 *   PATCH /rest/v1/settings?key=eq.<probe>  →  204, and the value changed.
 * After: 403. That before/after is the whole point; a probe that would have
 * passed either way proves nothing (CLAUDE.md, SCA-1431).
 *
 * `settings` goes first on purpose: one table, immediately observable (chrome
 * sync writes it), trivially revertible. The remaining tables follow in
 * 20260906000005 once this proves out.
 *
 * SELECT policies are deliberately untouched — anonymous reads of published
 * rows are how the public site works, and the builder's realtime subscriptions
 * read through the browser client.
 *
 * Dropped by ENUMERATION rather than by name so a rename cannot desync the
 * migration from reality. The original names, pinned from the pg_policies
 * census and reproduced in down():
 *   "Authenticated users can modify settings"  INSERT
 *   "Authenticated users can update settings"  UPDATE
 *   "Authenticated users can delete settings"  DELETE
 */

const CLAUSES: Record<string, string> = {
  INSERT: 'with check ((select public.is_workspace_member()))',
  UPDATE: 'using ((select public.is_workspace_member())) '
    + 'with check ((select public.is_workspace_member()))',
  DELETE: 'using ((select public.is_workspace_member()))',
};

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    create or replace function public.is_workspace_member()
    returns boolean language sql stable security definer set search_path = '' as $fn$
      select coalesce((select (u.raw_app_meta_data ->> 'role') is not null
                         from auth.users u where u.id = (select auth.uid())), false);
    $fn$;
    revoke execute on function public.is_workspace_member() from public, anon;
    grant execute on function public.is_workspace_member() to authenticated;
  `);

  for (const [cmd, clause] of Object.entries(CLAUSES)) {
    await knex.raw(
      `do $$
       declare p record;
       begin
         for p in select policyname from pg_policies
                   where schemaname = 'public' and tablename = 'settings' and cmd = ?
         loop
           execute format('drop policy %I on public.settings', p.policyname);
         end loop;
       end $$;`,
      [cmd],
    );

    // `(select public.is_workspace_member())` — the subselect makes Postgres
    // hoist it to an InitPlan, so it runs once per statement, not once per row.
    await knex.raw(
      `create policy "settings_${cmd.toLowerCase()}_members"
         on public.settings for ${cmd.toLowerCase()} to authenticated ${clause};`,
    );
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const cmd of Object.keys(CLAUSES)) {
    await knex.raw(
      `drop policy if exists "settings_${cmd.toLowerCase()}_members" on public.settings;`,
    );
  }
  await knex.raw(`
    create policy "Authenticated users can modify settings" on public.settings
      for insert to public with check ((select auth.uid()) is not null);
    create policy "Authenticated users can update settings" on public.settings
      for update to public using ((select auth.uid()) is not null);
    create policy "Authenticated users can delete settings" on public.settings
      for delete to public using ((select auth.uid()) is not null);
  `);
  // The helper is left in place: 20260906000005 may still depend on it, and a
  // function nothing references is inert.
}
