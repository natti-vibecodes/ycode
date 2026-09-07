import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isAgentSecretSettingKey } from '@/lib/agent/config';
import {
  getAllSettings,
  getSettingRecordByKey,
  setSettings,
} from '@/lib/repositories/settingsRepository';
import { setSettingAndInvalidate } from '@/lib/services/settingsService';
import { isDraftOnlySettingKey } from '@/lib/settings-keys';
import { clearAllCache } from '@/lib/services/cacheService';
import { isConflictError } from '@/lib/errors/conflict';
import type { McpCaller } from '@/lib/mcp/caller';
import { describeCaller } from '@/lib/mcp/caller';

/**
 * A refused write, rendered for an agent.
 *
 * MCP has no status codes, so the 409 arrives as an isError result whose payload carries the same
 * three things the HTTP route returns: what was expected, what is stored now, and the current
 * value so the caller can diff. `sync-chrome.py` prints that diff and stops.
 */
function conflictResult(key: string, error: unknown) {
  const conflict = error as { expected?: string | null; current?: { value?: unknown; updated_at?: string } | null };
  const current = conflict.current ?? null;
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        error: 'conflict',
        http_equivalent: 409,
        key,
        message:
          `Setting "${key}" changed since you read it. Nothing was written — the other writer's ` +
          'value is intact. Re-read the setting, redo your change on top of it, and write again ' +
          'with the new expected_updated_at.',
        expected_updated_at: conflict.expected ?? null,
        current_updated_at: current?.updated_at ?? null,
        current_value: current?.value ?? null,
      }, null, 2),
    }],
    isError: true,
  };
}

export function registerSettingsTools(server: McpServer, caller?: McpCaller) {
  const callerLabel = describeCaller(caller);

  server.tool(
    'get_settings',
    'Get all site settings or a specific setting by key. Settings include site_name, site_description, custom_css, redirects, etc. ' +
    'Every result carries `updated_at` — pass it back as `expected_updated_at` on set_setting to make your write safe against a concurrent writer.',
    {
      key: z.string().optional().describe('Specific setting key to retrieve. Omit to get all settings.'),
    },
    async ({ key }) => {
      if (key) {
        const record = await getSettingRecordByKey(key);
        const value = isAgentSecretSettingKey(key) ? '[redacted]' : (record?.value ?? null);
        return {
          content: [{
            type: 'text' as const,
            // `updated_at` is null when the key does not exist yet — pass null back as
            // expected_updated_at to write it create-only.
            text: JSON.stringify({ key, value, updated_at: record?.updated_at ?? null }, null, 2),
          }],
        };
      }

      const settings = await getAllSettings();
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(settings.map((s) => ({
            key: s.key,
            value: isAgentSecretSettingKey(s.key) ? '[redacted]' : s.value,
            updated_at: s.updated_at ?? null,
          })), null, 2),
        }],
      };
    },
  );

  server.tool(
    'set_setting',
    'Set a site setting value. Creates the setting if it does not exist, updates it otherwise. ' +
    'Pass expected_updated_at (from get_settings) to refuse the write if someone else changed the setting since you read it.',
    {
      key: z.string().describe('Setting key (e.g. "site_name", "site_description", "custom_css")'),
      value: z.unknown().describe('Setting value (string, number, boolean, or object)'),
      expected_updated_at: z.string().nullable().optional().describe(
        'Optimistic-concurrency precondition. The `updated_at` you read for this key; pass null if the key did not exist. ' +
        'Omit for an unconditional write (last-write-wins).',
      ),
    },
    async ({ key, value, expected_updated_at }) => {
      // Invalidates the public cache for render-affecting keys, exactly as the HTTP route does
      // (SCA-1345). Writing the setting alone leaves cached pages serving the old value with no
      // signal that anything is stale — which is how every chrome sync silently failed to reach
      // already-published pages.
      try {
        const saved = await setSettingAndInvalidate(key, value, undefined, {
          expectedUpdatedAt: expected_updated_at,
          caller: callerLabel,
        });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              message: `Setting "${key}" saved`,
              updated_at: saved?.updated_at ?? null,
              cache_invalidated: !isDraftOnlySettingKey(key),
            }, null, 2),
          }],
        };
      } catch (error) {
        if (isConflictError(error)) return conflictResult(key, error);
        throw error;
      }
    },
  );

  server.tool(
    'set_settings_batch',
    'Set multiple site settings at once. Pass null as value to delete a setting. ' +
    'Pass expected_updated_at to guard individual keys against a concurrent writer.',
    {
      settings: z.record(z.string(), z.unknown()).describe('Object of key-value pairs to set. Use null to delete a key.'),
      expected_updated_at: z.record(z.string(), z.string().nullable()).optional().describe(
        'Per-key concurrency preconditions: { key: updated_at }. Use null for "this key did not exist". ' +
        'Guarded keys are written first and fail fast; keys omitted here are written unconditionally.',
      ),
    },
    async ({ settings, expected_updated_at }) => {
      try {
        const { count, updatedAt } = await setSettings(settings, {
          expectedUpdatedAt: expected_updated_at,
          caller: callerLabel,
        });
        // Same gap as set_setting, and worse here — a batch is exactly how a whole chrome sync
        // lands. One purge covers the batch; per-key purging would nuke the cache N times.
        const invalidated = Object.keys(settings).some((k) => !isDraftOnlySettingKey(k));
        if (invalidated) await clearAllCache();
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              message: `Updated ${count} setting(s)`,
              count,
              updated_at: updatedAt,
              cache_invalidated: invalidated,
            }, null, 2),
          }],
        };
      } catch (error) {
        if (isConflictError(error)) {
          return conflictResult((error as { key: string }).key, error);
        }
        throw error;
      }
    },
  );
}
