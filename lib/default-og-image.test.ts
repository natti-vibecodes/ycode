import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDefaultOgImage, pickSocialImageUrl, twitterCardFor } from './default-og-image';

/**
 * SCA-1111. 161 pages served no og:image, no twitter:image, and
 * `twitter:card=summary`, because the metadata generator only ever looked at a
 * page's own SEO image. These pin the site-level fallback that fixed it.
 *
 * The functions under test are the ones `generate-page-metadata` calls — not a
 * copy of them — so a regression in the fallback fails here.
 */

const BASE = 'https://www.scalability.us';
const DEFAULT_IMG = '/a/3kPq9/og-default.png';
const PAGE_IMG = '/a/7bZx2/case-study-cover.png';

describe('default_og_image setting value', () => {
  test('an asset ID is classified for asset resolution', () => {
    assert.deepEqual(
      classifyDefaultOgImage('9f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f'),
      { kind: 'asset', assetId: '9f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f' },
    );
  });

  test('an absolute URL is used as-is', () => {
    assert.deepEqual(
      classifyDefaultOgImage(`${BASE}/a/3kPq9/og-default.png`),
      { kind: 'url', url: `${BASE}/a/3kPq9/og-default.png` },
    );
  });

  test('a root-relative path is a URL, not an asset ID', () => {
    assert.deepEqual(classifyDefaultOgImage(DEFAULT_IMG), { kind: 'url', url: DEFAULT_IMG });
  });

  test('unset / blank / non-string values resolve to no default', () => {
    for (const value of [undefined, null, '', '   ', 42, {}]) {
      assert.equal(classifyDefaultOgImage(value), null);
    }
  });

  test('surrounding whitespace is trimmed', () => {
    assert.deepEqual(classifyDefaultOgImage(`  ${DEFAULT_IMG}  `), { kind: 'url', url: DEFAULT_IMG });
  });
});

describe('social image selection', () => {
  test('a page WITHOUT its own image falls back to the site default, absolute', () => {
    assert.equal(pickSocialImageUrl(null, DEFAULT_IMG, BASE), `${BASE}${DEFAULT_IMG}`);
  });

  test('a page WITH its own image keeps it — the default never overrides', () => {
    assert.equal(pickSocialImageUrl(PAGE_IMG, DEFAULT_IMG, BASE), `${BASE}${PAGE_IMG}`);
  });

  test('no page image and no default means no og:image at all', () => {
    assert.equal(pickSocialImageUrl(null, null, BASE), null);
  });

  test('an already-absolute image is not prefixed with the base URL', () => {
    const absolute = 'https://cdn.example.com/cover.png';
    assert.equal(pickSocialImageUrl(absolute, DEFAULT_IMG, BASE), absolute);
    assert.equal(pickSocialImageUrl(null, absolute, BASE), absolute);
  });

  test('without a site base URL the relative path is left alone (preview)', () => {
    assert.equal(pickSocialImageUrl(null, DEFAULT_IMG, null), DEFAULT_IMG);
  });
});

describe('twitter:card', () => {
  test('an image present means summary_large_image', () => {
    assert.equal(twitterCardFor(`${BASE}${DEFAULT_IMG}`), 'summary_large_image');
  });

  test('no image falls back to the small summary card', () => {
    assert.equal(twitterCardFor(null), 'summary');
    assert.equal(twitterCardFor(''), 'summary');
  });

  test('REGRESSION: with a default configured, every page gets the large card', () => {
    // The bug: 161 pages had no image, so this was `summary` sitewide.
    const served = pickSocialImageUrl(null, DEFAULT_IMG, BASE);
    assert.equal(twitterCardFor(served), 'summary_large_image');
    assert.equal(served, `${BASE}${DEFAULT_IMG}`);
    assert.ok(served.startsWith('https://'), 'og:image must be absolute for social crawlers');
  });
});
