/**
 * What an automated backup is allowed to carry.
 *
 * The builder's own export (`POST /ycode/api/project/export`) is a full project dump: every
 * CONTENT_TABLE, including `api_keys`, `app_settings` (app integration tokens), the `email`
 * setting (SMTP host/user/PASSWORD) and every AI provider key. That is defensible for a
 * human-initiated download behind builder auth. It is NOT defensible for an unattended nightly
 * job that commits the result into a git repository, where every byte is permanent and a repo
 * that is private today may not be tomorrow.
 *
 * So the cron backup is the same dump minus two classes of content:
 *
 *   1. SECRETS — whole tables that exist to hold credentials, and individual `settings` rows
 *      whose key names a credential. Stripped by NAME, before serialization, so a secret never
 *      reaches the archive buffer at all.
 *   2. PERSONAL DATA — `form_submissions` (her leads' names, emails and messages) and
 *      `ai_chats`. Neither is project structure; both would otherwise be replayed into git
 *      history nightly, forever.
 *
 * Deliberately dependency-free apart from the agent-key predicate, so it is importable and
 * testable without Supabase credentials or anything `server-only`.
 */

import { isAgentSecretSettingKey } from '@/lib/agent/models';

/**
 * Tables dropped wholesale from an automated backup.
 *
 * `webhooks` is here because a webhook URL routinely embeds its own auth token in the path or
 * query — the URL *is* the credential.
 */
export const BACKUP_EXCLUDED_TABLES: readonly string[] = [
  'api_keys',
  'app_settings',
  'webhooks',
  'webhook_deliveries',
  'form_submissions',
  'ai_chats',
];

/**
 * `settings` keys stripped by exact match.
 *
 * `email` is the SMTP credential blob (host, port, user, password) — see lib/settings-keys.ts,
 * which classifies it as builder-only for cache purposes and is the reason it is easy to forget
 * that it is also the one settings row holding a password.
 */
const EXPLICIT_SECRET_SETTING_KEYS = new Set(['email']);

/**
 * Substring patterns that make a settings key secret-bearing.
 *
 * Default-deny by shape rather than by an enumerated list: a new integration adds its key
 * without editing this file, and the failure mode of an over-broad match (a non-secret setting
 * missing from the backup) is recoverable, while the failure mode of a miss is a credential in
 * git forever.
 */
const SECRET_KEY_PATTERNS: readonly RegExp[] = [
  /api[_-]?key/i,
  /secret/i,
  /password/i,
  /passwd/i,
  /token/i,
  /credential/i,
  /private[_-]?key/i,
  /access[_-]?key/i,
];

/** True for any `settings` key whose value must never enter an automated backup. */
export function isSecretSettingKey(key: string): boolean {
  if (EXPLICIT_SECRET_SETTING_KEYS.has(key)) return true;
  if (isAgentSecretSettingKey(key)) return true;
  return SECRET_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

export interface BackupRedactionReport {
  /** Tables removed in full, in the order they were found. */
  tables: string[];
  /** `settings` keys removed, sorted. Names only — values are never recorded. */
  settingKeys: string[];
}

export interface RedactedBackup {
  data: Record<string, Record<string, unknown>[]>;
  redactions: BackupRedactionReport;
}

/**
 * Strip secret-bearing and personal-data content from an export's table map.
 *
 * Returns a NEW map; the input is not mutated, so a caller holding the full export for another
 * purpose is unaffected. The report names what was removed so the archive can carry its own
 * redaction record and a reviewer never has to guess whether a missing table is a redaction or
 * a failed read.
 */
export function redactBackupData(
  data: Record<string, Record<string, unknown>[]>,
): RedactedBackup {
  const out: Record<string, Record<string, unknown>[]> = {};
  const removedTables: string[] = [];
  const removedSettingKeys = new Set<string>();

  for (const [table, rows] of Object.entries(data)) {
    if (BACKUP_EXCLUDED_TABLES.includes(table)) {
      removedTables.push(table);
      continue;
    }

    if (table === 'settings') {
      out[table] = rows.filter((row) => {
        const key = typeof row.key === 'string' ? row.key : '';
        if (key && isSecretSettingKey(key)) {
          removedSettingKeys.add(key);
          return false;
        }
        return true;
      });
      continue;
    }

    out[table] = rows;
  }

  return {
    data: out,
    redactions: {
      tables: removedTables,
      settingKeys: [...removedSettingKeys].sort(),
    },
  };
}

/**
 * Byte-level markers of a leaked credential, for use as a last-line assertion.
 *
 * These are the shapes that actually exist in this deployment: Supabase's new secret keys
 * (`sb_secret_…`), any JWT (the legacy service-role key and anon key are both JWTs, and a JWT
 * always starts `eyJ` because that is base64url for `{"`), and the SMTP settings blob's own
 * field names. Matching on shape rather than on the live values means the check keeps working
 * after a key rotation — and means this module never has to be given a secret to compare against.
 */
export const SECRET_MARKERS: readonly { name: string; pattern: RegExp }[] = [
  { name: 'supabase secret key', pattern: /sb_secret_[A-Za-z0-9_-]/ },
  { name: 'jwt', pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./ },
  // No surrounding quotes: the settings blob is JSON inside JSON, so by the time it reaches the
  // archive the field name reads `\"smtp_password\"` and an anchored-quote pattern misses it.
  { name: 'smtp credentials', pattern: /smtp[_-]?(password|passwd|pass|user|username)\b/i },
  { name: 'service role key', pattern: /service[_-]?role[_-]?key/i },
];

/**
 * Scan serialized archive text for credential markers.
 *
 * Returns the names of every marker that matched — empty means clean. Kept separate from
 * `redactBackupData` on purpose: redaction works on structure (it knows table and key names),
 * this works on bytes (it knows nothing), so the two fail independently and a test that runs
 * both is not one check written twice.
 */
export function findSecretMarkers(serialized: string): string[] {
  return SECRET_MARKERS.filter(({ pattern }) => pattern.test(serialized)).map(({ name }) => name);
}
