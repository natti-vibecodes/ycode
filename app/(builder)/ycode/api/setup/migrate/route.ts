import { runMigrations } from '@/lib/services/migrationService';
import { runSeeds } from '@/lib/services/seedService';
import { noCache } from '@/lib/api-response';
import { requireSetupOpen } from '@/lib/setup-guard';

/**
 * POST /ycode/api/setup/migrate
 *
 * Automatically runs pending Supabase migrations using Knex, if any
 * Then runs seed data.
 *
 * Only callable while the workspace is unclaimed — see lib/setup-guard.ts. This route ran
 * migrations and seeds for anyone who could reach it, and returned the raw migration error
 * (schema names, driver text) on failure.
 */
export async function POST() {
  try {
    const locked = await requireSetupOpen();
    if (locked) return locked;

    const result = await runMigrations();

    if (!result.success) {
      console.error('[setup/migrate] Migration failed:', result.error);
      return noCache(
        {
          error: result.error || 'Migration failed',
          executed: result.executed,
          failed: result.failed,
        },
        500
      );
    }

    // Run seeds after migrations
    const seedResult = await runSeeds();
    
    if (!seedResult.success) {
      console.warn('[setup/migrate] Some seeds failed:', seedResult.results);
    }

    return noCache({
      success: true,
      executed: result.executed,
      seeds: seedResult.results,
      message: result.executed.length > 0
        ? `Successfully executed ${result.executed.length} migration(s)`
        : 'All migrations already up to date',
    });
  } catch (error) {
    console.error('[setup/migrate] Migration error:', error);

    return noCache({ error: 'Migration failed' }, 500);
  }
}
