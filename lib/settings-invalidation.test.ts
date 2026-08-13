import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isDraftOnlySettingKey } from './settings-keys';

/**
 * SCA-1345. Global settings are resolved at RENDER time — `app/(site)/layout.tsx` reads
 * `custom_code_head` live, and the settings table has no draft/published pair — so a written
 * setting is live for any page that re-renders, and cached pages hold the old value until
 * something invalidates them.
 *
 * The HTTP route invalidated. The MCP `set_setting` tool called the repository directly and did
 * not, and `tools/ycode/sync-chrome.py` writes the global head through that tool. So every chrome
 * sync left the route cache stale, and the new CSS reached only pages that happened to re-render
 * for another reason. A publish did not rescue it either: `globalChanged` keys on the colour
 * variable hash and global variables, never on custom code.
 */

describe('isDraftOnlySettingKey (SCA-1345)', () => {
  test('REGRESSION: custom_code_head is NOT draft-only — it must purge the cache', () => {
    // The whole incident in one assertion. Classifying this key as builder-only would restore
    // the bug exactly: the head goes live, no page re-renders, nothing looks broken.
    assert.equal(isDraftOnlySettingKey('custom_code_head'), false);
    assert.equal(isDraftOnlySettingKey('custom_code_body'), false);
  });

  test('other render-affecting keys purge too', () => {
    for (const key of ['published_css', 'redirects', 'favicon_url', 'ga_measurement_id']) {
      assert.equal(isDraftOnlySettingKey(key), false, `${key} should invalidate`);
    }
  });

  test('builder-only keys do NOT purge — autosave must not nuke the cache per keystroke', () => {
    for (const key of ['draft_css', 'email', 'ai_model', 'ai_enabled_models', 'ai_agent_enabled']) {
      assert.equal(isDraftOnlySettingKey(key), true, `${key} should be skipped`);
    }
  });

  test('an unknown key defaults to invalidating', () => {
    // Safe direction: a needless purge costs a cold cache, a missed one serves stale content
    // indefinitely with every signal green.
    assert.equal(isDraftOnlySettingKey('some_future_setting'), false);
  });
});

/**
 * Source-level guards. The defect was not a wrong branch — it was one writer of three doing its
 * own thing, and a hand-maintained "keep these in sync" comment across two more. Unit tests
 * cannot catch a caller that simply doesn't call, so these assert the wiring itself.
 */
describe('every settings writer invalidates (SCA-1345)', () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

  test('REGRESSION: the MCP tool does not write settings behind the cache\'s back', () => {
    const src = read('./mcp/tools/settings.ts');
    assert.match(src, /setSettingAndInvalidate/, 'set_setting must go through the shared writer');
    assert.match(src, /clearAllCache/, 'set_settings_batch must invalidate too');
    // The precise shape of the bug: importing the raw repository writer and calling it.
    assert.doesNotMatch(
      src.replace(/setSettings\b/g, ''), // setSettings (batch) is still legitimately imported
      /\bsetSetting\s*\(/,
      'MCP must not call the bare repository setSetting()',
    );
  });

  test('the skip-list exists in exactly one place', () => {
    // It previously lived in three, two of them carrying a "keep in sync" comment — an invariant
    // maintained by hope. A drifted copy would silently stop purging for some keys.
    for (const p of ['../app/(builder)/ycode/api/settings/[key]/route.ts',
      '../app/(builder)/ycode/api/settings/batch/route.ts']) {
      assert.doesNotMatch(read(p), /DRAFT_ONLY_SETTING_KEYS/, `${p} must not redefine the list`);
    }
    assert.match(read('./settings-keys.ts'), /DRAFT_ONLY_SETTING_KEYS/);
  });

  test('the HTTP route still invalidates, via the shared writer', () => {
    assert.match(
      read('../app/(builder)/ycode/api/settings/[key]/route.ts'),
      /setSettingAndInvalidate/,
    );
  });
});
