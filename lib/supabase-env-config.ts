/**
 * Supabase config read from the environment — and nothing else.
 *
 * Split out of `lib/credentials.ts` (2026-09-07, SCA-1474 round-3 follow-up) because that
 * module carries `import 'server-only'` to protect its `fs` WRITE path, and `knexfile.ts`
 * imported it purely to READ these five variables. `server-only` resolves to a module that
 * throws on any non-`react-server` require, so every `migrate:*` npm script died on
 * "This module cannot be imported from a Client Component module" before it opened a
 * connection — the CLI migration runner has never worked in this fork.
 *
 * That is the root cause of the ledger drift Codex found: with `migrate:latest` unusable,
 * migrations 20260811000002 / 20260906000006 / 20260906000007 were applied out of band and
 * `public.migrations` never learned about them.
 *
 * This module touches no filesystem and imports no Next-only guard, so it is safe from the
 * Next server, the knex CLI and a plain node script alike.
 */

import type { SupabaseConfig } from '@/types';

/**
 * Read Supabase config from environment variables.
 * Supports both new (SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY) and legacy
 * (SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY) variable names.
 *
 * SUPABASE_URL is optional — required for self-hosted Supabase instances.
 * When omitted, the API URL is derived from the project ref in the connection string.
 */
export function getSupabaseConfigFromEnv(): SupabaseConfig | null {
  const anonKey = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;
  const secretKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  const connectionUrl = process.env.SUPABASE_CONNECTION_URL;
  const dbPassword = process.env.SUPABASE_DB_PASSWORD;
  const supabaseUrl = process.env.SUPABASE_URL;

  if (anonKey && secretKey && connectionUrl && dbPassword) {
    return {
      anonKey,
      serviceRoleKey: secretKey,
      connectionUrl,
      dbPassword,
      ...(supabaseUrl ? { supabaseUrl } : {}),
    };
  }

  return null;
}
