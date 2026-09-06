import type { Knex } from 'knex';

/**
 * Migration: remove the anonymous INSERT policy on `form_submissions`.
 *
 * Live policy was:
 *   "Anyone can create form submissions" INSERT TO public WITH CHECK (status = 'new')
 *
 * The 32 KB body cap, the honeypot and the 5/min + 20/hr rate limits all live
 * in `app/(builder)/ycode/api/form-submissions/route.ts`. A bot POSTing straight
 * to `https://<ref>.supabase.co/rest/v1/form_submissions` with the publishable
 * key — which the app itself serves anonymously at `/ycode/api/supabase/config`
 * — met none of them. Measured before this migration: that POST returned **201**.
 *
 * Nearly free, because `formSubmissionRepository.ts` writes with
 * `getSupabaseAdmin()` — the service-role client, which bypasses RLS entirely.
 * So dropping this policy does not touch the real submission path.
 *
 * Deliberately its own migration, separate from the membership-RLS work, so the
 * two revert independently (security plan 2026-09-06, #4).
 *
 * Dropped by ENUMERATION rather than by name: a rename would silently desync a
 * name-based drop from reality. The name above is recorded for the rollback.
 */

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    do $$
    declare p record;
    begin
      for p in select policyname from pg_policies
                where schemaname = 'public'
                  and tablename = 'form_submissions'
                  and cmd = 'INSERT'
      loop
        execute format('drop policy %I on public.form_submissions', p.policyname);
      end loop;
    end $$;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    create policy "Anyone can create form submissions"
      on public.form_submissions for insert to public
      with check ((status)::text = 'new'::text);
  `);
}
