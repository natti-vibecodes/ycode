/**
 * Settings Store
 *
 * Global state management for application settings
 * Settings are loaded once at startup and can be updated individually
 */

import { create } from 'zustand';
import { settingsApi } from '@/lib/api';
import type { Setting } from '@/types';

interface SettingsState {
  settings: Setting[];
  settingsByKey: Record<string, any>;
  /**
   * The `updated_at` the SERVER last reported for each key — the optimistic-concurrency token
   * sent back as `expected_updated_at` (SCA-1480).
   *
   * Deliberately separate from `settings[].updated_at`, which `updateSetting` stamps with a
   * LOCAL clock for optimistic UI. A locally invented timestamp matches nothing in the database,
   * so using it as a precondition would make every save conflict; using the server's value is
   * what makes the guard real.
   */
  serverUpdatedAt: Record<string, string>;
  isLoading: boolean;
  error: string | null;
  /** Set when a save was refused because someone else changed these settings first. */
  conflictKey: string | null;
}

interface SettingsActions {
  // Data loading
  setSettings: (settings: Setting[]) => void;

  // Getters
  getSettingByKey: (key: string) => any | null;

  // Update individual setting (local state only)
  updateSetting: (key: string, value: any) => void;

  // Save settings to server and update local state
  saveSettings: (settings: Record<string, any>) => Promise<boolean>;

  // State management
  setError: (error: string | null) => void;
  clearError: () => void;
  clearConflict: () => void;
}

type SettingsStore = SettingsState & SettingsActions;

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  // Initial state
  settings: [],
  settingsByKey: {},
  serverUpdatedAt: {},
  isLoading: false,
  error: null,
  conflictKey: null,

  // Set settings (used by unified init)
  setSettings: (settings) => {
    const settingsByKey: Record<string, any> = {};
    const serverUpdatedAt: Record<string, string> = {};
    settings.forEach((setting) => {
      settingsByKey[setting.key] = setting.value;
      if (setting.updated_at) serverUpdatedAt[setting.key] = setting.updated_at;
    });
    set({ settings, settingsByKey, serverUpdatedAt });
  },

  // Get a setting value by key
  getSettingByKey: (key) => {
    const { settingsByKey } = get();
    return settingsByKey[key] ?? null;
  },

  // Update a single setting in the store (local state)
  updateSetting: (key, value) => {
    set((state) => {
      const updatedSettings = state.settings.map((setting) =>
        setting.key === key
          ? { ...setting, value, updated_at: new Date().toISOString() }
          : setting
      );

      // If the setting doesn't exist, add it
      const exists = state.settings.some((s) => s.key === key);
      if (!exists) {
        updatedSettings.push({
          id: `temp-${key}`,
          key,
          value,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      }

      const settingsByKey = { ...state.settingsByKey, [key]: value };

      return { settings: updatedSettings, settingsByKey };
    });
  },

  // Save settings to server and update local state
  saveSettings: async (settings) => {
    // Guard every key we are about to write with the version the server last gave us. A key we
    // have never seen from the server is sent as `null` = "expect absent", so an unrelated writer
    // that created it in the meantime collides instead of being overwritten.
    const { serverUpdatedAt } = get();
    const expected: Record<string, string | null> = {};
    for (const key of Object.keys(settings)) {
      expected[key] = serverUpdatedAt[key] ?? null;
    }

    try {
      const response = await settingsApi.batchUpdate(settings, expected);
      if (response.conflict) {
        // Refused, not failed: another writer (a chrome sync, another tab, an agent lane) changed
        // these settings since this page loaded them. Saving anyway would replay a stale
        // `custom_code_head` over their work — exactly SCA-1480 — so stop and tell the user.
        set({
          error:
            'These settings changed since you opened this page — reload to see the latest before saving.',
          conflictKey: response.conflict.key ?? null,
        });
        return false;
      }
      if (response.error) {
        set({ error: response.error });
        return false;
      }
      // Update local state for all settings
      Object.entries(settings).forEach(([key, value]) => {
        get().updateSetting(key, value);
      });
      // Adopt the versions the server just minted so the NEXT save is guarded too.
      const written = response.data?.updated_at;
      if (written) {
        set((state) => ({ serverUpdatedAt: { ...state.serverUpdatedAt, ...written } }));
      }
      set({ conflictKey: null });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save settings';
      set({ error: message });
      return false;
    }
  },

  // Error management
  setError: (error) => set({ error }),
  clearError: () => set({ error: null }),
  clearConflict: () => set({ conflictKey: null }),
}));
