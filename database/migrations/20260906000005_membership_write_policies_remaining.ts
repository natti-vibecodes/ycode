import type { Knex } from 'knex';

/**
 * Migration: membership-based write policies — the remaining `public` tables.
 *
 * Runs after 20260906000004 proved the predicate on `settings` alone.
 *
 * 🔴 SHAPE-PRESERVING BY CONSTRUCTION. The policy set is derived from
 * `pg_policies` at run time rather than from a hardcoded table list, because a
 * census of the live database contradicted the plan's draft in three ways that
 * would each have shipped a silent defect:
 *
 *  1. FOUR tables — `api_keys`, `app_settings`, `webhooks`, `webhook_deliveries`
 *     — carry a single `FOR ALL` policy, not three per-command ones. A drop
 *     enumerated by `cmd IN ('INSERT','UPDATE','DELETE')` does not match a row
 *     whose `cmd` is `ALL`, so the old permissive policy would have survived;
 *     policies are OR-ed, so the new restrictive one would have been a NO-OP on
 *     exactly the four most sensitive tables, `api_keys` included. They are
 *     replaced with an `ALL` membership policy so the SELECT half those policies
 *     also govern is preserved.
 *  2. `versions` has INSERT and UPDATE but NO DELETE policy, and
 *     `mcp_oauth_clients` / `mcp_oauth_codes` / `migrations` have no write
 *     policy at all. Creating one where none existed would WIDEN access, so
 *     nothing is created for a (table, cmd) pair that had no policy.
 *  3. Existing policies are `TO public`, not `TO authenticated`. The
 *     replacements are `TO authenticated`, which is strictly narrower: `anon`
 *     previously failed the predicate anyway, and now has no policy at all.
 *
 * `form_submissions` is deliberately excluded — its anonymous INSERT is removed
 * by 20260906000003 so the two revert independently. ⚠️ Its UPDATE and DELETE
 * policies therefore REMAIN at `auth.uid() IS NOT NULL`; that residual is
 * recorded on SCA-1456 rather than silently folded in here.
 *
 * `storage.objects` is NOT touched — that belongs to the lane that owns #1/#8.
 *
 * SELECT policies are untouched: anonymous reads of published rows are how the
 * public site works, and the builder's realtime subscriptions read through the
 * browser client.
 */

const REPLACE = `
-- Snapshot the policy set into a temp table FIRST: a loop reading pg_policies
-- while creating policies could otherwise observe its own writes.
create temp table _mem_rls_todo on commit drop as
  select tablename, cmd, policyname
    from pg_policies
   where schemaname = 'public'
     and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
     and tablename not in ('settings', 'form_submissions');

do $$
declare p record; new_name text;
begin
  for p in select * from _mem_rls_todo loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
    new_name := p.tablename || '_' || lower(p.cmd) || '_members';

    if p.cmd = 'INSERT' then
      execute format(
        'create policy %I on public.%I for insert to authenticated '
        'with check ((select public.is_workspace_member()))', new_name, p.tablename);
    elsif p.cmd = 'UPDATE' then
      execute format(
        'create policy %I on public.%I for update to authenticated '
        'using ((select public.is_workspace_member())) '
        'with check ((select public.is_workspace_member()))', new_name, p.tablename);
    elsif p.cmd = 'DELETE' then
      execute format(
        'create policy %I on public.%I for delete to authenticated '
        'using ((select public.is_workspace_member()))', new_name, p.tablename);
    elsif p.cmd = 'ALL' then
      execute format(
        'create policy %I on public.%I for all to authenticated '
        'using ((select public.is_workspace_member())) '
        'with check ((select public.is_workspace_member()))', new_name, p.tablename);
    end if;
  end loop;
end $$;
`;

export async function up(knex: Knex): Promise<void> {
  await knex.raw(REPLACE);
}

export async function down(knex: Knex): Promise<void> {
  // Drop the membership policies, then recreate the originals verbatim from the
  // pg_policies census taken before 20260906000004. Behaviour AND names are
  // restored; the census is reproduced on SCA-1456.
  const PER_CMD: Array<[string, string[]]> = [
    ['DELETE+INSERT+UPDATE', [
      'ai_chats', 'asset_folders', 'assets', 'collection_fields', 'collection_imports',
      'collection_item_values', 'collection_items', 'collections', 'color_variables',
      'components', 'fonts', 'global_variables', 'layer_styles', 'locales', 'mcp_tokens',
      'page_folders', 'page_layers', 'pages', 'translations',
    ]],
    ['INSERT+UPDATE', ['versions']],
    ['ALL', ['api_keys', 'app_settings', 'webhooks', 'webhook_deliveries']],
  ];

  for (const [shape, tables] of PER_CMD) {
    for (const table of tables) {
      for (const cmd of ['insert', 'update', 'delete', 'all']) {
        await knex.raw(`drop policy if exists "${table}_${cmd}_members" on public.${table};`);
      }
      if (shape === 'ALL') {
        await knex.raw(
          `create policy "Authenticated users can manage ${table}" on public.${table}
             for all to public using ((select auth.uid()) is not null);`,
        );
        continue;
      }
      await knex.raw(
        `create policy "${table}_insert_auth" on public.${table}
           for insert to public with check ((select auth.uid()) is not null);
         create policy "${table}_update_auth" on public.${table}
           for update to public using ((select auth.uid()) is not null);`,
      );
      if (shape.includes('DELETE')) {
        await knex.raw(
          `create policy "${table}_delete_auth" on public.${table}
             for delete to public using ((select auth.uid()) is not null);`,
        );
      }
    }
  }
}
