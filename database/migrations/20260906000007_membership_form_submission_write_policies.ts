import type { Knex } from 'knex';

/**
 * Migration: membership-gate the residual `form_submissions` UPDATE and DELETE.
 *
 * `20260906000003` dropped only the anonymous INSERT (security-plan #4), and
 * `20260906000005` deliberately excluded this table so the two revert independently.
 * That left UPDATE and DELETE at `((SELECT auth.uid()) IS NOT NULL)` — the last two
 * write policies in `public` that were not membership-gated (recorded as a residual
 * on SCA-1473 / SCA-1456). This closes them.
 *
 * MEASURED before this migration, with a throwaway role-less auth user holding a real
 * session JWT and the publishable key the app serves anonymously, against a row
 * planted by the service role:
 *   PATCH  /rest/v1/form_submissions?id=eq.<id>  → 1 row affected, status went
 *          'new' → 'read' — the value ACTUALLY CHANGED
 *   DELETE /rest/v1/form_submissions?id=eq.<id>  → 1 row affected, the row was GONE
 *
 * ⚠️ Status codes do not discriminate here. PostgREST answers an UPDATE or DELETE that
 * RLS filtered to zero rows with 204 — the USING clause filters silently rather than
 * erroring. The assertion is the row count and the value, never the code (CLAUDE.md
 * measurement doctrine; SCA-1474 recorded the same trap).
 *
 * Free on the real path: every one of the ten client acquisitions in
 * `lib/repositories/formSubmissionRepository.ts` is `getSupabaseAdmin()` — the
 * service-role client, which bypasses RLS. The builder's submissions list, its status
 * PUT and its delete (`app/(builder)/ycode/api/form-submissions/…`) and the MCP's
 * `update_form_submission` / `delete_form_submission` (`lib/mcp/tools/forms.ts`) all
 * route through that repository, and there are ZERO browser-client
 * `from('form_submissions')` calls anywhere in the tree.
 *
 * SELECT is left untouched, matching 20260906000004/5.
 *
 * Dropped by ENUMERATION, not by name. Original names pinned from the census:
 *   "Authenticated users can update form submissions"  UPDATE TO public
 *   "Authenticated users can delete form submissions"  DELETE TO public
 *   "Authenticated users can view form submissions"    SELECT TO public  ← not touched
 */

const CLAUSES: Record<string, string> = {
  UPDATE: 'using ((select public.is_workspace_member())) '
    + 'with check ((select public.is_workspace_member()))',
  DELETE: 'using ((select public.is_workspace_member()))',
};

export async function up(knex: Knex): Promise<void> {
  for (const [cmd, clause] of Object.entries(CLAUSES)) {
    await knex.raw(
      `do $$
       declare p record;
       begin
         for p in select policyname from pg_policies
                   where schemaname = 'public' and tablename = 'form_submissions' and cmd = ?
         loop
           execute format('drop policy %I on public.form_submissions', p.policyname);
         end loop;
       end $$;`,
      [cmd],
    );

    await knex.raw(
      `create policy "form_submissions_${cmd.toLowerCase()}_members"
         on public.form_submissions for ${cmd.toLowerCase()} to authenticated ${clause};`,
    );
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const cmd of Object.keys(CLAUSES)) {
    await knex.raw(
      `drop policy if exists "form_submissions_${cmd.toLowerCase()}_members"
         on public.form_submissions;`,
    );
  }
  // Behaviour AND names restored verbatim from the pre-migration census.
  await knex.raw(`
    create policy "Authenticated users can update form submissions"
      on public.form_submissions for update to public
      using ((select auth.uid()) is not null);
    create policy "Authenticated users can delete form submissions"
      on public.form_submissions for delete to public
      using ((select auth.uid()) is not null);
  `);
}
