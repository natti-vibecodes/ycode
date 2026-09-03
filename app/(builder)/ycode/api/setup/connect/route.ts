import { NextRequest } from 'next/server';
import { credentials } from '@/lib/credentials';
import { testSupabaseConnection } from '@/lib/supabase-server';
import { testSupabaseDirectConnection } from '@/lib/knex-client';
import { parseSupabaseConfig } from '@/lib/supabase-config-parser';
import { noCache } from '@/lib/api-response';
import { requireSetupOpen, checkConnectTarget } from '@/lib/setup-guard';
import type { SupabaseConfig } from '@/types';

/**
 * POST /ycode/api/setup/connect
 *
 * Test and store Supabase credentials (4 fields).
 *
 * Only callable while the workspace is unclaimed — see lib/setup-guard.ts. Anonymous on a
 * claimed workspace this route tested attacker-supplied credentials against an
 * attacker-supplied host (unauthenticated SSRF and port scan, with the driver's error text
 * returned verbatim as the oracle) and then, off Vercel, SAVED them — repointing the whole
 * app at another database and rewriting .env.
 */
export async function POST(request: NextRequest) {
  try {
    const locked = await requireSetupOpen();
    if (locked) return locked;

    const body = await request.json();
    const { anon_key, service_role_key, connection_url, db_password, supabase_url } = body;

    // Validate required fields
    if (!anon_key || !service_role_key || !connection_url || !db_password) {
      return noCache(
        { error: 'Missing required fields: anon_key, service_role_key, connection_url, db_password' },
        400
      );
    }

    // Create config object
    const config: SupabaseConfig = {
      anonKey: anon_key,
      serviceRoleKey: service_role_key,
      connectionUrl: connection_url,
      dbPassword: db_password,
      ...(supabase_url ? { supabaseUrl: supabase_url } : {}),
    };

    let parsed;
    try {
      parsed = parseSupabaseConfig(config);
    } catch (error) {
      // Format errors are the caller's own input, so they stay specific — they name nothing
      // about this host or its network.
      return noCache(
        { error: error instanceof Error ? error.message : 'Invalid connection URL format' },
        400
      );
    }

    // Only dial plausible Supabase targets. Without this the route is a port scanner:
    // it connects to any host:port named here and reports whether it answered.
    const targetCheck = checkConnectTarget(parsed.dbHost, supabase_url);
    if (!targetCheck.allowed) {
      return noCache({ error: targetCheck.reason || 'Database host is not a permitted target' }, 400);
    }

    // Test Supabase API connection
    const supabaseTestResult = await testSupabaseConnection(config);
    if (!supabaseTestResult.success) {
      // Generic by design. This used to return the raw driver/HTTP error verbatim, which made
      // the route an oracle: the exact text distinguished "refused", "timed out", "TLS
      // handshake failed" and "401", i.e. exactly what a port scan needs. The specifics go to
      // the server log, where the operator running setup can read them.
      console.error('[Setup API] Supabase API connection test failed:', supabaseTestResult.error);

      const isSelfHosted = !!supabase_url;
      const isAuthError = /unauthorized|invalid.*key|forbidden/i.test(
        supabaseTestResult.error || ''
      );

      let error = 'Could not connect to Supabase with these credentials.';
      if (isSelfHosted && isAuthError) {
        error =
          'Could not authenticate against Supabase. For self-hosted setups, verify that ' +
          'SERVICE_ROLE_KEY and ANON_KEY in your .env were generated with the same JWT_SECRET. ' +
          'If you changed any of these values, restart your Docker containers with ' +
          '"docker compose down && docker compose up -d".';
      }

      return noCache({ error }, 400);
    }

    // Test database connection
    const dbTestResult = await testSupabaseDirectConnection({
      dbHost: parsed.dbHost,
      dbPort: parsed.dbPort,
      dbName: parsed.dbName,
      dbUser: parsed.dbUser,
      dbPassword: parsed.dbPassword,
      ssl: !supabase_url,
    });
    if (!dbTestResult.success) {
      // Generic for the same reason as above — the driver's message is the port-scan oracle.
      console.error('[Setup API] Database connection test failed:', dbTestResult.error);
      return noCache({ error: 'Database connection failed.' }, 400);
    }

    // Store credentials
    await credentials.set('supabase_config', config);

    return noCache({
      success: true,
      message: 'Supabase connected successfully',
    });
  } catch (error) {
    console.error('[Setup API] Connection failed:', error);
    return noCache({ error: 'Connection failed' }, 500);
  }
}
