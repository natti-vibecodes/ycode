/**
 * Settings Repository
 *
 * Data access layer for application settings stored in the database
 */

import { getSupabaseAdmin } from '@/lib/supabase-server';
import { ConflictError } from '@/lib/errors/conflict';
import type { Setting } from '@/types';

// Postgres "undefined_table" — the settings table is briefly absent right after
// a DB reset and before migrations re-run. Treat it as "no settings" instead of
// crashing page renders.
const UNDEFINED_TABLE = '42P01';

/** True when an error indicates the settings table does not exist yet. */
function isMissingTableError(error: { code?: string } | null): boolean {
  return error?.code === UNDEFINED_TABLE;
}

/**
 * Get all settings
 *
 * @returns Promise resolving to all settings
 */
export async function getAllSettings(): Promise<Setting[]> {
  const client = await getSupabaseAdmin();
  if (!client) {
    throw new Error('Failed to initialize Supabase client');
  }

  const { data, error } = await client
    .from('settings')
    .select('*')
    .order('key', { ascending: true });

  if (error) {
    if (isMissingTableError(error)) {
      return [];
    }
    throw new Error(`Failed to fetch settings: ${error.message}`);
  }

  return data || [];
}

/**
 * Get a setting by key
 *
 * @param key - The setting key
 * @param tenantId - Optional tenant scope (ignored in single-tenant deployments)
 * @returns Promise resolving to the setting value or null if not found
 */
export async function getSettingByKey(key: string, tenantId?: string): Promise<any | null> {
  const client = await getSupabaseAdmin(tenantId);
  if (!client) {
    throw new Error('Failed to initialize Supabase client');
  }

  const { data, error } = await client
    .from('settings')
    .select('value')
    .eq('key', key)
    .single();

  if (error) {
    if (error.code === 'PGRST116' || isMissingTableError(error)) {
      // Not found, or table not yet created
      return null;
    }
    throw new Error(`Failed to fetch setting: ${error.message}`);
  }

  return data?.value || null;
}

/**
 * Get multiple settings by keys in a single query
 *
 * @param keys - Array of setting keys to fetch
 * @returns Promise resolving to a map of key -> value
 */
export async function getSettingsByKeys(keys: string[]): Promise<Record<string, any>> {
  if (keys.length === 0) {
    return {};
  }

  const client = await getSupabaseAdmin();
  if (!client) {
    throw new Error('Failed to initialize Supabase client');
  }

  const { data, error } = await client
    .from('settings')
    .select('key, value')
    .in('key', keys);

  if (error) {
    if (isMissingTableError(error)) {
      return {};
    }
    throw new Error(`Failed to fetch settings: ${error.message}`);
  }

  const result: Record<string, any> = {};
  for (const setting of data || []) {
    result[setting.key] = setting.value;
  }

  return result;
}

/**
 * Get a setting's whole row, including `updated_at`.
 *
 * `getSettingByKey` returns the value alone, which is why no caller could supply a concurrency
 * precondition: the version was never handed out (SCA-1480). Returns null when the row (or the
 * table) does not exist.
 */
export async function getSettingRecordByKey(key: string): Promise<Setting | null> {
  const client = await getSupabaseAdmin();
  if (!client) {
    throw new Error('Failed to initialize Supabase client');
  }

  const { data, error } = await client
    .from('settings')
    .select('*')
    .eq('key', key)
    .single();

  if (error) {
    if (error.code === 'PGRST116' || isMissingTableError(error)) {
      return null;
    }
    throw new Error(`Failed to fetch setting: ${error.message}`);
  }

  return data || null;
}

export interface SettingWriteOptions {
  /**
   * Optimistic-concurrency precondition (SCA-1480).
   *
   * - omitted / `undefined` → unconditional upsert, exactly as before.
   * - an ISO timestamp → the row must still carry that `updated_at`, or the write is refused
   *   with a {@link ConflictError} and nothing is written.
   * - `null` → the row must NOT exist yet (first write of a key).
   */
  expectedUpdatedAt?: string | null;
  /** Who is writing — `mcp:<token id>`, `route:/ycode/api/settings/[key]`, `publish`, … */
  caller?: string;
}

/** Size of a setting value as stored, for the write log. */
function valueBytes(value: any): number {
  try {
    return typeof value === 'string' ? value.length : JSON.stringify(value ?? null).length;
  } catch {
    return -1;
  }
}

/**
 * One line per settings write, so the next silent clobber has a named writer.
 *
 * SCA-1480 burned a day precisely because the question "who else wrote `custom_code_head` in that
 * window?" had no answer anywhere — not in a log, not in the row, which keeps only the winner.
 */
function logSettingWrite(
  key: string,
  value: any,
  options: SettingWriteOptions | undefined,
  outcome: 'ok' | 'conflict',
): void {
  const precondition =
    options?.expectedUpdatedAt === undefined
      ? 'none'
      : options.expectedUpdatedAt === null
        ? 'expect-absent'
        : options.expectedUpdatedAt;
  console.log(
    `[settings] write key=${key} bytes=${valueBytes(value)} caller=${options?.caller ?? 'unknown'} ` +
      `precondition=${precondition} outcome=${outcome}`,
  );
}

/**
 * Set a setting value (insert or update)
 *
 * @param key - The setting key
 * @param value - The value to store
 * @param options - Optional concurrency precondition and caller label
 * @returns Promise resolving to the created/updated setting
 * @throws ConflictError when a precondition is supplied and the stored row has moved on
 */
export async function setSetting(key: string, value: any, options?: SettingWriteOptions): Promise<Setting> {
  const client = await getSupabaseAdmin();
  if (!client) {
    throw new Error('Failed to initialize Supabase client');
  }

  if (options?.expectedUpdatedAt !== undefined) {
    const saved = await setSettingWithPrecondition(client, key, value, options.expectedUpdatedAt, options);
    logSettingWrite(key, value, options, 'ok');
    return saved;
  }

  const { data, error } = await client
    .from('settings')
    .upsert({
      key,
      value,
      updated_at: new Date().toISOString(),
    }, {
      onConflict: 'key',
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to set setting: ${error.message}`);
  }

  logSettingWrite(key, value, options, 'ok');
  return data;
}

/** Postgres unique_violation — someone inserted the key between our check and our insert. */
const UNIQUE_VIOLATION = '23505';

/**
 * Conditional settings write. The precondition rides in the UPDATE's WHERE clause, so a row
 * another writer has touched matches zero rows and is never overwritten.
 */
async function setSettingWithPrecondition(
  client: any,
  key: string,
  value: any,
  expectedUpdatedAt: string | null,
  options: SettingWriteOptions,
): Promise<Setting> {
  if (expectedUpdatedAt === null) {
    // "I read no row for this key." An INSERT is the precondition: the UNIQUE index on `key`
    // rejects it if someone created the row first.
    const now = new Date().toISOString();
    const { data, error } = await client
      .from('settings')
      .insert({ key, value, updated_at: now })
      .select()
      .single();

    if (error) {
      if (error.code === UNIQUE_VIOLATION) {
        logSettingWrite(key, value, options, 'conflict');
        const current = await getSettingRecordByKey(key);
        throw new ConflictError('setting', key, null, current);
      }
      throw new Error(`Failed to set setting: ${error.message}`);
    }
    return data;
  }

  // Two writes inside the same millisecond would stamp the same `updated_at` and make the second
  // caller's stale precondition pass. Cheap to rule out: never write the timestamp we are
  // matching on.
  let now = new Date().toISOString();
  if (now === expectedUpdatedAt) {
    now = new Date(Date.parse(now) + 1).toISOString();
  }

  const { data, error } = await client
    .from('settings')
    .update({ value, updated_at: now })
    .eq('key', key)
    .eq('updated_at', expectedUpdatedAt)
    .select();

  if (error) {
    throw new Error(`Failed to set setting: ${error.message}`);
  }

  const rows = (data as Setting[] | null) || [];
  if (rows.length === 0) {
    // Zero rows matched: the row is gone, or its `updated_at` moved. Either way we did NOT write.
    logSettingWrite(key, value, options, 'conflict');
    const current = await getSettingRecordByKey(key);
    throw new ConflictError('setting', key, expectedUpdatedAt, current);
  }

  return rows[0];
}

export interface SettingsBatchWriteOptions {
  /**
   * Per-key preconditions (SCA-1480). Keys present here are written one at a time through the
   * conditional path and fail fast on the first conflict; keys absent from the map are written
   * unconditionally in the batch, as before. A conflict on key N leaves keys 1..N-1 written —
   * there is no cross-row transaction here — so the error names what was already applied.
   */
  expectedUpdatedAt?: Record<string, string | null>;
  caller?: string;
}

export interface SettingsBatchResult {
  /** How many keys the call touched (upserts + deletes), unchanged from the old return value. */
  count: number;
  /**
   * The `updated_at` each written key now carries. A client that keeps this can send it back as
   * the next write's precondition instead of guessing a local timestamp — guessing is what made
   * the builder's settings store unable to guard itself (SCA-1480).
   */
  updatedAt: Record<string, string>;
}

/**
 * Set multiple settings at once (batch upsert)
 * Settings with null/undefined values are deleted instead of upserted.
 *
 * @param settings - Object with key-value pairs to store
 * @param options - Optional per-key concurrency preconditions and a caller label
 * @returns Promise resolving to the number of settings updated and their new versions
 * @throws ConflictError when a guarded key has moved on; guarded keys are written first, so no
 *         unguarded key has been touched when that happens
 */
export async function setSettings(
  settings: Record<string, any>,
  options?: SettingsBatchWriteOptions,
): Promise<SettingsBatchResult> {
  const entries = Object.entries(settings);
  if (entries.length === 0) {
    return { count: 0, updatedAt: {} };
  }

  const updatedAt: Record<string, string> = {};

  const client = await getSupabaseAdmin();
  if (!client) {
    throw new Error('Failed to initialize Supabase client');
  }

  // Separate entries: null/undefined values should be deleted, others upserted
  const toUpsert: [string, any][] = [];
  const toDelete: string[] = [];

  for (const [key, value] of entries) {
    if (value === null || value === undefined) {
      toDelete.push(key);
    } else {
      toUpsert.push([key, value]);
    }
  }

  // Guarded keys go first and one at a time, so a conflict aborts BEFORE any unguarded key is
  // touched. This is where the builder's Settings → General save lands, and it is the writer
  // that can clobber a chrome sync's `custom_code_head` (SCA-1480).
  const preconditions = options?.expectedUpdatedAt;
  if (preconditions) {
    const guarded = toUpsert.filter(([key]) => key in preconditions);
    for (const [key, value] of guarded) {
      const saved = await setSetting(key, value, {
        expectedUpdatedAt: preconditions[key],
        caller: options?.caller,
      });
      if (saved?.updated_at) updatedAt[key] = saved.updated_at;
    }
    const guardedKeys = new Set(guarded.map(([key]) => key));
    for (let i = toUpsert.length - 1; i >= 0; i--) {
      if (guardedKeys.has(toUpsert[i][0])) toUpsert.splice(i, 1);
    }
  }

  // Delete settings with null values
  if (toDelete.length > 0) {
    const { error: deleteError } = await client
      .from('settings')
      .delete()
      .in('key', toDelete);

    if (deleteError) {
      throw new Error(`Failed to delete settings: ${deleteError.message}`);
    }
  }

  // Upsert settings with non-null values
  if (toUpsert.length > 0) {
    const now = new Date().toISOString();
    const records = toUpsert.map(([key, value]) => ({
      key,
      value,
      updated_at: now,
    }));

    const { data, error } = await client
      .from('settings')
      .upsert(records, {
        onConflict: 'key',
      })
      .select();

    if (error) {
      throw new Error(`Failed to set settings: ${error.message}`);
    }

    for (const row of (data as Setting[] | null) || []) {
      if (row?.key && row.updated_at) updatedAt[row.key] = row.updated_at;
    }
    for (const [key, value] of toUpsert) {
      logSettingWrite(key, value, { caller: options?.caller }, 'ok');
    }
  }

  return { count: entries.length, updatedAt };
}
