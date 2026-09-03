/**
 * Decides whether proxy.ts can authenticate a builder-API request at all.
 *
 * proxy.ts used to do this:
 *
 *   const config = getSupabaseEnvConfig();
 *   // If env vars aren't set (pre-setup or local dev without .env.local), let through
 *   if (!config) return null;
 *
 * `null` meant two very different things and the comment only described one of them.
 * getSupabaseEnvConfig returns null both when NOTHING is configured (genuine pre-setup — the
 * case the comment is about) and when credentials ARE configured but cannot be parsed: an
 * anon key set with no connection URL, or a connection URL whose project-ref regex doesn't
 * match and no SUPABASE_URL to fall back on. In that second case a typo in one env var
 * silently disables authentication for EVERY builder API route, with no error anywhere.
 *
 * So the null is split three ways, and the permissive branch is kept only for the state it
 * was actually written for.
 */

export type ProxyAuthDecision =
  /** Credentials resolved — verify the session. */
  | { mode: 'authenticate'; url: string; anonKey: string }
  /** Nothing configured at all: the setup wizard has not run. Let requests through. */
  | { mode: 'allow-pre-setup' }
  /** Configured but unusable, or unconfigured in production. Refuse. */
  | { mode: 'unavailable'; reason: string };

export interface SupabaseEnvLike {
  SUPABASE_PUBLISHABLE_KEY?: string;
  SUPABASE_ANON_KEY?: string;
  SUPABASE_CONNECTION_URL?: string;
  SUPABASE_URL?: string;
}

function blank(value: string | undefined): boolean {
  return !value || value.trim() === '';
}

/**
 * @param env     - the Supabase-related environment variables
 * @param nodeEnv - process.env.NODE_ENV
 */
export function resolveProxyAuth(
  env: SupabaseEnvLike,
  nodeEnv: string | undefined,
): ProxyAuthDecision {
  const isProduction = nodeEnv === 'production';

  const anonKey = !blank(env.SUPABASE_PUBLISHABLE_KEY)
    ? env.SUPABASE_PUBLISHABLE_KEY!
    : env.SUPABASE_ANON_KEY;
  const connectionUrl = env.SUPABASE_CONNECTION_URL;
  const supabaseUrl = env.SUPABASE_URL;

  const nothingConfigured = blank(anonKey) && blank(connectionUrl) && blank(supabaseUrl);

  if (nothingConfigured) {
    // The one genuine pre-setup state. In production it is still wrong — a deployed
    // instance with no credentials should not be quietly serving unauthenticated builder
    // APIs — so it refuses there rather than opening up.
    return isProduction
      ? { mode: 'unavailable', reason: 'Supabase is not configured' }
      : { mode: 'allow-pre-setup' };
  }

  // Past this point SOMETHING is configured, so any failure to derive a usable config is a
  // misconfiguration, not pre-setup. It never takes the permissive branch, in any environment.
  if (blank(anonKey)) {
    return { mode: 'unavailable', reason: 'Supabase anon/publishable key is not set' };
  }

  if (!blank(supabaseUrl)) {
    return {
      mode: 'authenticate',
      url: supabaseUrl!.replace(/\/+$/, ''),
      anonKey: anonKey!,
    };
  }

  if (blank(connectionUrl)) {
    return { mode: 'unavailable', reason: 'Supabase connection URL is not set' };
  }

  // Hosted Supabase: extract the project ref from the connection URL.
  const match = connectionUrl!.match(/\/\/postgres\.([a-z0-9]+):/);
  if (!match) {
    return {
      mode: 'unavailable',
      reason: 'Could not derive the Supabase project URL from SUPABASE_CONNECTION_URL',
    };
  }

  return {
    mode: 'authenticate',
    url: `https://${match[1]}.supabase.co`,
    anonKey: anonKey!,
  };
}
