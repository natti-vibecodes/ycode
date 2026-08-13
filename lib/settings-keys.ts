/**
 * Which setting keys affect public-page rendering (SCA-1345).
 *
 * Deliberately dependency-free. This classification decides whether a settings write purges the
 * public cache, so it must be importable — and testable — without dragging in the cache service,
 * Supabase credentials, or anything else `server-only`. It previously lived inline in two API
 * routes with a hand-maintained "keep these in sync" comment between them.
 */

import { isAgentSecretSettingKey } from '@/lib/agent/models';

/**
 * Keys that do NOT affect public-page rendering, and therefore must not trigger a cache purge.
 *
 * - `draft_css`: builder-only preview CSS. Public pages serve `published_css`. Saved on every
 *   edit, so invalidating here would purge every page on every keystroke and undo selective
 *   invalidation entirely.
 * - `email`: SMTP credentials for the form-submission backend. Not read by public renders.
 * - `ai_*`: AI builder configuration. Builder-only.
 *
 * Everything else — redirects, favicon_url, ga_measurement_id, published_css, colour variables,
 * and `custom_code_head`/`custom_code_body` — is read by public pages and DOES require
 * invalidation. Anything unrecognised defaults to invalidating: a needless purge costs one cold
 * cache, a missed one serves stale content indefinitely with every signal green.
 */
const DRAFT_ONLY_SETTING_KEYS = new Set([
  'draft_css',
  'email',
  'ai_model',
  'ai_enabled_models',
  'ai_agent_enabled',
]);

/** Builder-only keys that must not purge the public cache. Agent secrets (shared and per-user)
 * are covered by isAgentSecretSettingKey. */
export function isDraftOnlySettingKey(key: string): boolean {
  return DRAFT_ONLY_SETTING_KEYS.has(key) || isAgentSecretSettingKey(key);
}
