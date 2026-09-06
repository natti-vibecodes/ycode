import type { Knex } from 'knex';

/**
 * Migration: membership-based write policies on `storage.objects`, bucket `assets`.
 *
 * The last piece of security-plan #2, and the statement that actually CLOSES #1's
 * overwrite vector. `20260906000005` deliberately stopped at the `public` schema;
 * storage went last because chrome sync and asset upload both depend on it.
 *
 * Before this, all three write policies were
 * `bucket_id = 'assets' AND ((SELECT auth.uid()) IS NOT NULL)` — ANY authenticated
 * Supabase user of this project, not any workspace member. Combined with the
 * publishable key the app serves anonymously at `/ycode/api/supabase/config`, one
 * over-privileged or compromised account could swap `site.js` for every page, cached
 * `immutable` for a year.
 *
 * ⚠️ SRI (SCA-1469) does NOT close this. It makes a swap fail LOUDLY — the browser
 * refuses the file — it does not prevent the write. This does.
 *
 * MEASURED before this migration, with a throwaway role-less auth user holding a real
 * session JWT and the publicly-served publishable key:
 *   POST   /storage/v1/object/assets/rls-probe/before-insert.css  → 200, row created
 *   PUT    /storage/v1/object/assets/rls-probe/before-victim.css  → 200, and the
 *          PUBLIC URL then served `/* TAMPERED *​/` in place of `/* ORIGINAL *​/`
 *   DELETE /storage/v1/object/assets/rls-probe/before-delete.css  → 200, row gone
 * The discriminating assertion is the served bytes and the row, not the status code.
 *
 * SELECT is deliberately UNTOUCHED — `assets` is a public bucket by design and every
 * published page reads its images, CSS and JS through it anonymously.
 *
 * Dropped by ENUMERATION rather than by name so a rename cannot desync the migration
 * from reality, and scoped to policies that actually mention bucket `assets` so a
 * future policy for a different bucket is not collateral. The original names, pinned
 * from the pg_policies census (4 policies total on storage.objects, all bucket
 * `assets`: 3 writes + the public SELECT):
 *   "Authenticated users can upload assets"  INSERT  TO public
 *   "Authenticated users can update assets"  UPDATE  TO public
 *   "Authenticated users can delete assets"  DELETE  TO public
 *   "Assets are publicly accessible"         SELECT  TO public   ← not touched
 *
 * As in 20260906000004/5, the replacements are `TO authenticated`, which is strictly
 * narrower: `anon` failed the old predicate anyway and now has no write policy at all.
 * `(select public.is_workspace_member())` is wrapped in a subselect so Postgres hoists
 * it to an InitPlan and evaluates it once per statement rather than once per row.
 */

const CLAUSES: Record<string, string> = {
  INSERT: "with check (bucket_id = 'assets' and (select public.is_workspace_member()))",
  UPDATE: "using (bucket_id = 'assets' and (select public.is_workspace_member())) "
    + "with check (bucket_id = 'assets' and (select public.is_workspace_member()))",
  DELETE: "using (bucket_id = 'assets' and (select public.is_workspace_member()))",
};

export async function up(knex: Knex): Promise<void> {
  for (const [cmd, clause] of Object.entries(CLAUSES)) {
    await knex.raw(
      `do $$
       declare p record;
       begin
         for p in select policyname from pg_policies
                   where schemaname = 'storage' and tablename = 'objects' and cmd = ?
                     and coalesce(qual, '') || coalesce(with_check, '') like '%assets%'
         loop
           execute format('drop policy %I on storage.objects', p.policyname);
         end loop;
       end $$;`,
      [cmd],
    );

    await knex.raw(
      `create policy "assets_${cmd.toLowerCase()}_members"
         on storage.objects for ${cmd.toLowerCase()} to authenticated ${clause};`,
    );
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const cmd of Object.keys(CLAUSES)) {
    await knex.raw(
      `drop policy if exists "assets_${cmd.toLowerCase()}_members" on storage.objects;`,
    );
  }
  // Behaviour AND names restored verbatim from the pre-migration census.
  await knex.raw(`
    create policy "Authenticated users can upload assets" on storage.objects
      for insert to public
      with check (bucket_id = 'assets' and (select auth.uid()) is not null);
    create policy "Authenticated users can update assets" on storage.objects
      for update to public
      using (bucket_id = 'assets' and (select auth.uid()) is not null)
      with check (bucket_id = 'assets' and (select auth.uid()) is not null);
    create policy "Authenticated users can delete assets" on storage.objects
      for delete to public
      using (bucket_id = 'assets' and (select auth.uid()) is not null);
  `);
  // `public.is_workspace_member()` is left in place — 20260906000004/5 still depend
  // on it, and a function nothing references is inert.
}
