import { NextRequest, NextResponse } from 'next/server';
import { refreshActiveWebhooks } from '@/lib/apps/airtable/sync-service';
import { isCronRequestAuthorized } from '@/lib/cron-auth';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/cron/airtable-webhooks
 * Daily cron to refresh Airtable webhooks before they expire.
 * Secured via CRON_SECRET — Vercel cron sends it as `Authorization: Bearer $CRON_SECRET`.
 *
 * The old guard read `if (cronSecret && authHeader !== ...)`, which fails OPEN: with
 * CRON_SECRET unset the check was skipped entirely and the route served 200 anonymously.
 * See lib/cron-auth.ts — a missing secret is now a refusal, and the comparison is
 * constant-time.
 */
export async function GET(request: NextRequest) {
  if (!isCronRequestAuthorized(request.headers.get('authorization'), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await refreshActiveWebhooks();
    return NextResponse.json({ data: result });
  } catch (error) {
    console.error('[Cron] Airtable webhook refresh error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to refresh webhooks' },
      { status: 500 }
    );
  }
}
