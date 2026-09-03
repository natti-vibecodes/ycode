/**
 * Guard for the first-run setup routes.
 *
 * `/ycode/api/setup/` is a PUBLIC prefix in proxy.ts, and it has to be: the setup wizard runs
 * before any user, any session, or any database exists, so nothing is available to authenticate
 * against. The mistake was leaving it public *forever*. On a workspace that has already been
 * claimed, the setup routes stayed anonymous and fully functional:
 *
 *   - `setup/connect` accepted attacker-supplied Supabase credentials, made outbound
 *     connections to whatever host they named (an unauthenticated SSRF and port scanner, with
 *     the driver's own error text returned verbatim as the oracle), and on non-Vercel hosts
 *     SAVED them via `credentials.set` — repointing the entire app at an attacker's database
 *     and rewriting `.env`.
 *   - `setup/migrate` ran migrations and seeds anonymously.
 *
 * So the rule is: setup mutations are legal exactly once, while the workspace is genuinely
 * unclaimed. After that every setup mutation route returns 403.
 *
 * `isSetupLocked` only ever locks on a POSITIVE confirmation that the workspace is claimed.
 * A configured-but-unreachable or not-yet-migrated database leaves setup OPEN, because that is
 * a real mid-setup state — and it is a state in which no user can exist to be protected.
 */

import { credentials } from '@/lib/credentials';
import { getSupabaseAdmin } from '@/lib/supabase-server';
import { isUnclaimedWorkspace } from '@/lib/roles-server';
import { noCache } from '@/lib/api-response';
import type { SupabaseConfig } from '@/types';

/**
 * Check if at least one auth user exists (setup fully complete).
 *
 * Lived privately in `setup/status/route.ts`; moved here so the status route and the guard
 * share one definition rather than drifting apart.
 */
export async function hasAuthUsers(): Promise<boolean> {
  try {
    const client = await getSupabaseAdmin();
    if (!client) return false;

    const { data, error } = await client.auth.admin.listUsers({ page: 1, perPage: 1 });

    if (error) return false;
    return (data.users?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * True when the workspace has been claimed and setup must no longer be re-runnable.
 */
export async function isSetupLocked(): Promise<boolean> {
  const config = await credentials.get<SupabaseConfig>('supabase_config');
  // Nothing configured at all — genuinely pre-setup. This is the one state the setup
  // wizard exists for.
  if (!config) return false;

  // A real auth user exists: claimed.
  if (await hasAuthUsers()) return true;

  // Or someone holds an explicitly assigned role. Covers the window where a role was
  // assigned but listUsers is unavailable.
  try {
    if (!(await isUnclaimedWorkspace())) return true;
  } catch {
    // Database unreachable or un-migrated: mid-setup, and no user can exist yet.
  }

  return false;
}

/**
 * Returns a 403 response when setup is closed, or null to let the handler continue.
 * Call as the first statement of every setup MUTATION route.
 */
export async function requireSetupOpen() {
  if (await isSetupLocked()) {
    return noCache(
      { error: 'Setup has already been completed for this workspace.' },
      403,
    );
  }
  return null;
}

/** Hostnames that are never a legitimate outbound target for a connection test. */
const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i,
  /\.local$/i,
  /\.internal$/i,
  /^127\./,
  /^0\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
  /^\[?::1\]?$/,
  /^\[?f[cd][0-9a-f]{2}:/i,
];

/** Supabase's own managed domains — always a legitimate target. */
const SUPABASE_HOST_PATTERNS = [
  /(^|\.)supabase\.co$/i,
  /(^|\.)supabase\.com$/i,
  /(^|\.)supabase\.in$/i,
];

export interface ConnectTargetCheck {
  allowed: boolean;
  reason?: string;
}

/**
 * Restrict `setup/connect`'s outbound connection test to plausible Supabase targets.
 *
 * Defence in depth behind `requireSetupOpen`: during the genuinely-unclaimed window the route
 * is still reachable, and without this it will dial any host:port a caller names and report
 * back whether it answered.
 *
 * Managed Supabase hosts are always allowed. A self-hosted instance may name its own host, but
 * the database host must then match the declared `supabase_url` host — so a caller gets one
 * self-consistent target, not a scanner. Private and loopback ranges are refused in production
 * only: a self-hosted Supabase on localhost via docker compose is a normal dev setup.
 */
export function checkConnectTarget(
  dbHost: string,
  supabaseUrl: string | undefined,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): ConnectTargetCheck {
  const host = (dbHost || '').trim().toLowerCase();
  if (!host) return { allowed: false, reason: 'Missing database host' };

  const isProduction = nodeEnv === 'production';

  if (isProduction && BLOCKED_HOST_PATTERNS.some(pattern => pattern.test(host))) {
    return { allowed: false, reason: 'Database host is not a permitted target' };
  }

  if (SUPABASE_HOST_PATTERNS.some(pattern => pattern.test(host))) {
    return { allowed: true };
  }

  // Self-hosted: the database host must match the declared Supabase URL's host.
  if (supabaseUrl) {
    let declaredHost: string;
    try {
      declaredHost = new URL(supabaseUrl).hostname.toLowerCase();
    } catch {
      return { allowed: false, reason: 'Invalid Supabase URL' };
    }

    if (isProduction && BLOCKED_HOST_PATTERNS.some(pattern => pattern.test(declaredHost))) {
      return { allowed: false, reason: 'Supabase URL host is not a permitted target' };
    }

    if (declaredHost === host) return { allowed: true };

    return {
      allowed: false,
      reason: 'Database host must match the Supabase URL host for self-hosted setups',
    };
  }

  return { allowed: false, reason: 'Database host is not a recognised Supabase host' };
}
