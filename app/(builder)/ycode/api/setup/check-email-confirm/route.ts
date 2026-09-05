import { noCache } from '@/lib/api-response';
import { getSupabaseConfig } from '@/lib/supabase-server';
import { requireSetupOpen } from '@/lib/setup-guard';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /ycode/api/setup/check-email-confirm
 *
 * Checks whether the Supabase "Confirm email" setting is disabled
 * by querying GoTrue's public /settings endpoint which exposes
 * the mailer autoconfirm flag.
 *
 * Locked once the workspace is claimed (SCA-1433). `/ycode/api/setup/` is a public prefix in
 * proxy.ts, and its two mutation routes were locked in wave 2 — but this read was left open,
 * so on a claimed workspace any anonymous caller could still reach it. It answered with a real
 * configuration fact (whether email confirmation is on, which says whether open signup is
 * self-serve — and signup IS open here, see SCA-1220), and every anonymous hit made this server
 * issue an outbound request to the project's GoTrue endpoint, which is free amplification.
 *
 * Safe to lock: the only caller is the setup wizard's step 4, which runs BEFORE the admin user
 * is created, so the workspace is still unclaimed at call time and the guard lets it through.
 */
export async function GET() {
  try {
    const locked = await requireSetupOpen();
    if (locked) return locked;

    const creds = await getSupabaseConfig();

    if (!creds) {
      return noCache(
        { error: 'Supabase not configured' },
        500
      );
    }

    const settingsResponse = await fetch(
      `${creds.projectUrl}/auth/v1/settings`,
      {
        headers: { 'apikey': creds.anonKey },
      }
    );

    if (!settingsResponse.ok) {
      return noCache(
        { error: 'Failed to fetch auth settings from Supabase' },
        500
      );
    }

    const settings = await settingsResponse.json();
    const isAutoconfirm = settings.mailer_autoconfirm === true;

    return noCache({
      autoconfirm: isAutoconfirm,
    });
  } catch (error) {
    console.error('Check email confirm failed:', error);
    return noCache(
      { error: 'Failed to check email confirmation setting' },
      500
    );
  }
}
