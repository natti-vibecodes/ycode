import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAssetProxyUrl } from './asset-utils';

/**
 * `upload_asset` returns the /a/ proxy path (Supabase egress).
 *
 * Storage URLs are served `public, max-age=3600`; the same bytes through this app's /a/ route are
 * `max-age=31536000, immutable`. So anything writing markup should write the proxy path — but the
 * path encodes the asset id in base62 plus a slug and a mime-derived extension, and the only
 * caller that needs it (`tools/ycode/sync-chrome.py`) is Python.
 *
 * That left two bad options and one good one:
 *   - reimplement base62 in Python → URLs that look right and 404, invisible on a background
 *     video until someone opens the page;
 *   - pin a URL map in the other repo → routine CSS edits hard-block the sync until someone
 *     regenerates the map in THIS repo;
 *   - return it from the upload response → no derivation, no pinning, cannot go stale.
 *
 * These guard the third.
 */

const asset = (over: Record<string, unknown> = {}) => ({
  id: '143a4884-e185-46be-8ebf-fd77e0c6fa2b',
  filename: 'site',
  mime_type: 'text/javascript',
  storage_path: 'website/1786694891291-ro7zog9cu9.js',
  ...over,
}) as Parameters<typeof getAssetProxyUrl>[0];

describe('getAssetProxyUrl', () => {
  test('produces a stable /a/<base62-id>/<slug>.<ext> path', () => {
    const url = getAssetProxyUrl(asset());
    assert.ok(url, 'a stored asset must get a proxy path');
    assert.match(url!, /^\/a\/[0-9A-Za-z]+\/[a-z0-9-]+\.[a-z0-9]+$/,
      `unexpected shape: ${url}`);
  });

  test('is deterministic — the same asset always yields the same URL', () => {
    // The whole scheme depends on this: a URL that moved would be an immutable-cached 404.
    assert.equal(getAssetProxyUrl(asset()), getAssetProxyUrl(asset()));
  });

  test('distinct ids yield distinct paths', () => {
    assert.notEqual(
      getAssetProxyUrl(asset()),
      getAssetProxyUrl(asset({ id: 'e6255bf5-c9ce-445e-8331-7de136666f21' })),
    );
  });

  test('REGRESSION: null when there is no storage_path', () => {
    // SVGs are stored inline rather than in the bucket. Callers must fall back to `public_url`
    // instead of assuming a path exists — an empty proxy path would render as a broken asset.
    assert.equal(getAssetProxyUrl(asset({ storage_path: null })), null);
    assert.equal(getAssetProxyUrl(asset({ storage_path: undefined })), null);
  });
});

describe('upload_asset returns the proxy path (source guard)', () => {
  const src = readFileSync(join(__dirname, 'mcp/tools/assets.ts'), 'utf8');

  test('REGRESSION: the response carries proxy_url', () => {
    // Without it the sync has to derive the path itself, which is the failure this avoids.
    assert.match(src, /proxy_url:\s*getAssetProxyUrl\(asset\)/);
  });

  test('and derives it from the shared helper, not a local copy', () => {
    assert.match(src, /import \{ getAssetProxyUrl \} from '@\/lib\/asset-utils'/);
    // A second implementation would drift from the route that has to resolve these paths.
    assert.doesNotMatch(src.replace(/getAssetProxyUrl/g, ''), /\/a\/\$\{/,
      'assets.ts must not build an /a/ path itself');
  });
});
