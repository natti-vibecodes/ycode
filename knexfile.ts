import type { Knex } from 'knex';
import path from 'path';
import { getSupabaseConfigFromEnv } from './lib/supabase-env-config.ts';
import { parseSupabaseConfig } from './lib/supabase-config-parser.ts';

/**
 * The knex CLI is not Next: nothing has loaded `.env` for us, and `lib/credentials.ts`
 * is `server-only` (it owns the fs WRITE path), so importing it here threw before any
 * connection was attempted and killed every `migrate:*` script. Read the environment
 * through the shared, guard-free reader instead, and load `.env` ourselves.
 *
 * `process.loadEnvFile` exists from Node 20.12; this package requires >= 20.9, so the
 * call is feature-detected rather than assumed. Real env vars (Vercel, CI) already
 * present are not overwritten — loadEnvFile does not clobber existing keys.
 */
if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile(path.join(process.cwd(), '.env'));
  } catch {
    // No .env (Vercel, CI) — the environment is expected to carry the vars directly.
  }
}

/**
 * Knex Configuration for Ycode Supabase Migrations
 *
 * This configuration is used to run migrations programmatically
 * against the user's Supabase PostgreSQL database.
 */

/**
 * Load Supabase credentials from centralized storage
 * Uses environment variables on Vercel, file-based storage locally
 */
async function getSupabaseConnectionParams() {
  const config = getSupabaseConfigFromEnv();

  if (!config?.connectionUrl || !config?.dbPassword) {
    throw new Error('Supabase not configured. Please run setup first.');
  }

  const connectionParams = parseSupabaseConfig(config);
  const isSelfHosted = !!config.supabaseUrl;

  return {
    host: connectionParams.dbHost,
    port: connectionParams.dbPort,
    database: connectionParams.dbName,
    user: connectionParams.dbUser,
    password: connectionParams.dbPassword,
    ssl: isSelfHosted ? false : { rejectUnauthorized: false },
  };
}

const createConfig = (): Knex.Config => {
  const isVercel = process.env.VERCEL === '1';

  return {
    client: 'pg',
    connection: async () => {
      const connectionParams = await getSupabaseConnectionParams();

      return connectionParams;
    },
    migrations: {
      directory: path.join(process.cwd(), 'database/migrations'),
      extension: 'ts',
      tableName: 'migrations',
    },
    pool: isVercel ? {
      min: 0,
      max: 1,
      acquireTimeoutMillis: 10000,
      createTimeoutMillis: 10000,
      idleTimeoutMillis: 1000,
      reapIntervalMillis: 1000,
      createRetryIntervalMillis: 200,
    } : {
      min: 0,
      max: 3,
      idleTimeoutMillis: 30000,
    },
  };
};

const config: { [key: string]: Knex.Config } = {
  development: createConfig(),
  production: createConfig(),
};

export default config;
