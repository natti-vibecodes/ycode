import { NextResponse } from 'next/server';
import { getKnexClient } from '@/lib/knex-client';
import { getSupabaseAdmin } from '@/lib/supabase-server';
import { STORAGE_BUCKET } from '@/lib/asset-constants';
import { clearAllCache } from '@/lib/services/cacheService';
import { noCache } from '@/lib/api-response';
import { requireManageMembers } from '@/lib/roles-server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /ycode/api/devtools/reset-db
 *
 * DANGEROUS: drops every table in the public schema and deletes the storage bucket.
 *
 * The old header said "Authentication enforced by proxy", and that was true but far too
 * weak: proxy.ts only proves the caller is *a* workspace member, so any designer — the
 * default role for anyone who signs up and gets added — could destroy the entire site and
 * all its assets with one POST. There was also no environment guard, so it was live in
 * production. Now: owner/admin only, and refused outright in production.
 */
export async function POST() {
  try {
    // Refuse in production before anything else — this is not an operation that should be
    // reachable on a live site regardless of who is asking.
    if (process.env.NODE_ENV === 'production') {
      return noCache({ error: 'Database reset is disabled in production' }, 403);
    }

    const result = await requireManageMembers();
    if ('status' in result) return result;

    console.log('[POST /ycode/api/devtools/reset-db] Starting database reset...');

    const knex = await getKnexClient();
    const supabase = await getSupabaseAdmin();

    // Get all tables in the public schema
    const tables = await knex.raw(`
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = 'public'
    `);

    console.log('[POST /ycode/api/devtools/reset-db] Found ' + tables.rows.length + ' tables');

    if (supabase) {
      console.log('[POST /ycode/api/devtools/reset-db] Cleaning up assets storage bucket...');

      try {
        // emptyBucket removes all files recursively (including nested folders)
        const { error: emptyError } = await supabase.storage.emptyBucket(STORAGE_BUCKET);

        if (emptyError) {
          console.log('[POST /ycode/api/devtools/reset-db] Error emptying bucket (may not exist):', emptyError.message);
        } else {
          console.log('[POST /ycode/api/devtools/reset-db] Assets bucket emptied');
        }

        const { error: deleteBucketError } = await supabase.storage.deleteBucket(STORAGE_BUCKET);

        if (deleteBucketError) {
          console.log('[POST /ycode/api/devtools/reset-db] Error deleting bucket (may not exist):', deleteBucketError.message);
        } else {
          console.log('[POST /ycode/api/devtools/reset-db] Assets bucket deleted');
        }
      } catch (storageError) {
        console.log('[POST /ycode/api/devtools/reset-db] Storage cleanup error:', storageError);
      }
    }

    await knex.raw(`
      DO $$
      DECLARE
        r RECORD;
      BEGIN
        FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public')
        LOOP
          EXECUTE 'DROP TABLE IF EXISTS public.' || quote_ident(r.tablename) || ' CASCADE';
        END LOOP;
      END $$;
    `);

    console.log('[POST /ycode/api/devtools/reset-db] All tables dropped successfully');

    // Purge CDN + data caches so the public site stops serving the dropped
    // content. No warming — there's nothing to render after a reset.
    try {
      await clearAllCache();
      console.log('[POST /ycode/api/devtools/reset-db] Cache invalidated');
    } catch (cacheError) {
      console.error('[POST /ycode/api/devtools/reset-db] Cache invalidation failed:', cacheError);
    }

    return NextResponse.json({
      data: { message: 'All public tables and storage buckets have been deleted' }
    });
  } catch (error) {
    console.error('[POST /ycode/api/devtools/reset-db] Unexpected error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to reset database' },
      { status: 500 }
    );
  }
}
