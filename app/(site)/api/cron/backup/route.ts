import { NextRequest, NextResponse } from 'next/server';
import {
  exportProject,
  packExportToStream,
  sanitizeProjectNameSlug,
} from '@/lib/services/projectService';
import { redactBackupData } from '@/lib/services/backup-redaction';
import { isCronRequestAuthorized } from '@/lib/cron-auth';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 300;

/**
 * GET /api/cron/backup
 *
 * Streams a redacted project archive for the nightly off-machine backup. Same dump the
 * builder's Export produces, minus credentials, minus personal data, minus asset binaries —
 * see lib/services/backup-redaction.ts for what each exclusion is and why.
 *
 * Auth is `Authorization: Bearer $CRON_SECRET`, fail-closed via lib/cron-auth.ts: with no
 * secret configured the route refuses everyone rather than serving the whole project to an
 * anonymous GET. That posture matters more here than on any other cron route — this one's
 * response IS the project.
 *
 * GET rather than POST because the caller is `curl` from a launchd job and there is nothing to
 * send; the route is a pure read.
 */
export async function GET(request: NextRequest) {
  if (!isCronRequestAuthorized(request.headers.get('authorization'), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Asset bytes excluded: the rows describing every asset still travel, but re-downloading
    // and re-committing hundreds of megabytes of binaries every night would bloat the backup
    // repo without adding recoverable state the storage bucket does not already hold.
    const result = await exportProject({ includeAssetFiles: false });

    if (!result.success || !result.export) {
      return NextResponse.json({ error: result.error || 'Export failed' }, { status: 500 });
    }

    const { data, redactions } = redactBackupData(result.export.data);

    const manifest = {
      ...result.export.manifest,
      projectName: sanitizeProjectNameSlug(result.export.manifest.projectName),
      tables: Object.keys(data),
      assetFilesIncluded: false,
      redactions,
    };

    const { stream, size } = packExportToStream({ manifest, data });

    // Date-stamped, not time-stamped: one backup per night, so the name collides with itself
    // rather than accumulating near-duplicates if the job is re-run.
    const filename = `${manifest.projectName}-backup-${manifest.exportedAt.slice(0, 10)}.ycode.gz`;

    return new NextResponse(stream, {
      status: 200,
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(size),
        'Cache-Control': 'no-store',
        // Lets the Mac job assert the census without unpacking, and lets a human read the
        // redaction record straight off the response.
        'X-Backup-Stats': JSON.stringify(manifest.stats),
        'X-Backup-Redacted-Tables': redactions.tables.join(','),
      },
    });
  } catch (error) {
    console.error('[GET /api/cron/backup] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Backup failed' },
      { status: 500 },
    );
  }
}
