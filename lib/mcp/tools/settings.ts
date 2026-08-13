import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isAgentSecretSettingKey } from '@/lib/agent/config';
import { getAllSettings, getSettingByKey, setSettings } from '@/lib/repositories/settingsRepository';
import { setSettingAndInvalidate } from '@/lib/services/settingsService';
import { isDraftOnlySettingKey } from '@/lib/settings-keys';
import { clearAllCache } from '@/lib/services/cacheService';

export function registerSettingsTools(server: McpServer) {
  server.tool(
    'get_settings',
    'Get all site settings or a specific setting by key. Settings include site_name, site_description, custom_css, redirects, etc.',
    {
      key: z.string().optional().describe('Specific setting key to retrieve. Omit to get all settings.'),
    },
    async ({ key }) => {
      if (key) {
        const value = isAgentSecretSettingKey(key) ? '[redacted]' : await getSettingByKey(key);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ key, value }, null, 2),
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
          })), null, 2),
        }],
      };
    },
  );

  server.tool(
    'set_setting',
    'Set a site setting value. Creates the setting if it does not exist, updates it otherwise.',
    {
      key: z.string().describe('Setting key (e.g. "site_name", "site_description", "custom_css")'),
      value: z.unknown().describe('Setting value (string, number, boolean, or object)'),
    },
    async ({ key, value }) => {
      // Invalidates the public cache for render-affecting keys, exactly as the HTTP route does
      // (SCA-1345). Writing the setting alone leaves cached pages serving the old value with no
      // signal that anything is stale — which is how every chrome sync silently failed to reach
      // already-published pages.
      await setSettingAndInvalidate(key, value);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            message: `Setting "${key}" saved`,
            cache_invalidated: !isDraftOnlySettingKey(key),
          }, null, 2),
        }],
      };
    },
  );

  server.tool(
    'set_settings_batch',
    'Set multiple site settings at once. Pass null as value to delete a setting.',
    {
      settings: z.record(z.string(), z.unknown()).describe('Object of key-value pairs to set. Use null to delete a key.'),
    },
    async ({ settings }) => {
      const count = await setSettings(settings);
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
            cache_invalidated: invalidated,
          }, null, 2),
        }],
      };
    },
  );
}
