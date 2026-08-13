/**
 * Settings Service
 *
 * Business logic for managing application settings
 */

import { getSettingsByKeys, setSetting } from '@/lib/repositories/settingsRepository';
import { isDraftOnlySettingKey } from '@/lib/settings-keys';
import { clearAllCache, getAllPublishedRoutes, warmRoutes } from '@/lib/services/cacheService';
import type { Setting } from '@/types';

/**
 * Sync CSS between draft and published based on direction.
 * Publish: draft_css → published_css
 * Revert: published_css → draft_css
 *
 * @returns True if CSS was updated, false if unchanged or missing
 */
export async function syncCSS(direction: 'publish' | 'revert' = 'publish'): Promise<boolean> {
  const { draft_css: draftCSS, published_css: publishedCSS } =
    await getSettingsByKeys(['draft_css', 'published_css']);

  const sourceCSS = direction === 'publish' ? draftCSS : publishedCSS;
  const targetCSS = direction === 'publish' ? publishedCSS : draftCSS;
  const targetKey = direction === 'publish' ? 'published_css' : 'draft_css';

  if (!sourceCSS) {
    if (direction === 'publish') {
      throw new Error('draft_css is empty — open the builder to generate CSS before publishing');
    }
    return false;
  }

  if (sourceCSS === targetCSS) {
    return false;
  }

  await setSetting(targetKey, sourceCSS);
  return true;
}

/** @deprecated Use syncCSS('publish') instead */
export const publishCSS = () => syncCSS('publish');

/**
 * Save the published timestamp
 * @param timestamp - ISO timestamp string
 * @returns The created/updated setting
 */
export async function savePublishedAt(timestamp: string): Promise<Setting> {
  return await setSetting('published_at', timestamp);
}

/**
 * Write a setting and invalidate the public cache when the key affects rendering.
 *
 * SHARED ON PURPOSE (SCA-1345). Global settings are resolved at RENDER time —
 * `app/(site)/layout.tsx` reads `custom_code_head` live, and the settings table has no
 * draft/published pair — so a written setting is live for any page that re-renders, and cached
 * pages keep the old value until something invalidates them.
 *
 * The HTTP route did this invalidation; the MCP `set_setting` tool called the repository
 * directly and did not. `tools/ycode/sync-chrome.py` writes the global head through that tool,
 * so every chrome sync left the route cache stale — new CSS reached only pages that happened to
 * re-render for some other reason. A publish does not rescue it either: `globalChanged` in the
 * publish route keys on the colour-variable hash and global variables, not on custom code, so
 * selective invalidation skips every page whose own content didn't change.
 *
 * `warmRoutes` needs a Request and is a Vercel-only optimisation, so callers without one (MCP)
 * skip warming. Invalidation is the correctness half; warming is not.
 */
export async function setSettingAndInvalidate(
  key: string,
  value: unknown,
  request?: Request,
): Promise<void> {
  await setSetting(key, value);
  if (isDraftOnlySettingKey(key)) return;

  await clearAllCache();

  if (!request) return;
  try {
    const routes = await getAllPublishedRoutes();
    const warmResult = await warmRoutes(routes, request);
    if (warmResult) {
      console.log(
        `[Cache] settings (${key}): warming ${warmResult.warmed}${warmResult.total > warmResult.warmed ? ` of ${warmResult.total}` : ''} route(s) in background`,
      );
    }
  } catch {
    // Non-fatal: warming is an optimisation.
  }
}
