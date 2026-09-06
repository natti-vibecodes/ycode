/**
 * SCA-1465 — the gate that decides whether a URL gets the fully server-rendered `/404`.
 *
 * The dangerous direction here is a FALSE positive: saying "missing" about a page that
 * exists takes a live URL off the site. So most of this file pins the one-sided contract —
 * every uncertain outcome must answer `false` — rather than the happy path.
 *
 * Mutation-checked: making the catch in `isMissingSiteRoute` return `true`, dropping the
 * redirect check, or removing the `/` exclusion each fails a test below.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
  isMissingSiteRoute,
  isCheckableSitePath,
  __resetRouteExistenceCache,
  type RouteExistenceDeps,
} from '@/lib/route-existence';
import type { Redirect } from '@/types';

function deps(over: Partial<RouteExistenceDeps> = {}): RouteExistenceDeps {
  return {
    fetchPageForPath: async () => null,
    fetchRedirects: async () => [],
    ...over,
  };
}

beforeEach(() => {
  __resetRouteExistenceCache();
});

describe('isCheckableSitePath', () => {
  /**
   * The homepage is served by `app/(site)/page.tsx`, and the path resolver returns null for
   * the empty slug — so checking `/` would rewrite the front page to a 404. This is the
   * single most expensive mistake this module could make.
   */
  test('never has an opinion about the homepage', () => {
    assert.equal(isCheckableSitePath('/'), false);
  });

  test('skips the builder, APIs, assets and the 404 route itself', () => {
    for (const p of [
      '/ycode',
      '/ycode/pages/1',
      '/api/page-auth/verify',
      '/_next/static/chunks/x',
      '/dynamic/services',
      '/a/abc123/site.js',
      '/404',
    ]) {
      assert.equal(isCheckableSitePath(p), false, p);
    }
  });

  /**
   * `public/` assets are served AFTER the proxy runs, so a rewrite would make them
   * unreachable. Anything with an extension in its last segment is left alone.
   */
  test('skips paths with a file extension', () => {
    for (const p of ['/canvas.css', '/y-filled.svg', '/sitemap.xml', '/robots.txt', '/some/deep/file.woff2']) {
      assert.equal(isCheckableSitePath(p), false, p);
    }
  });

  test('owns ordinary page paths, including nested and collection-item shapes', () => {
    for (const p of ['/services', '/services/design-branding', '/case-studies/nope', '/insight/nope']) {
      assert.equal(isCheckableSitePath(p), true, p);
    }
  });

  /** A prefix must not swallow a real page that merely starts with the same letters. */
  test('a skipped prefix does not swallow a sibling page path', () => {
    assert.equal(isCheckableSitePath('/apiary'), true);
    assert.equal(isCheckableSitePath('/dynamics-365'), true);
    assert.equal(isCheckableSitePath('/404-error-guide'), true);
  });
});

describe('isMissingSiteRoute', () => {
  test('reports a genuine absence', async () => {
    assert.equal(await isMissingSiteRoute('/no-such-page', deps()), true);
  });

  test('reports a resolvable page as present', async () => {
    const d = deps({ fetchPageForPath: async () => ({ page: { id: 'p1' } }) });
    assert.equal(await isMissingSiteRoute('/services', d), false);
  });

  test('a dynamic-collection item that resolves is present', async () => {
    const d = deps({
      fetchPageForPath: async (slug) => (slug === 'insight/real-article' ? { page: { id: 'p2' } } : null),
    });
    assert.equal(await isMissingSiteRoute('/insight/real-article', d), false);
    assert.equal(await isMissingSiteRoute('/insight/nope', d), true);
  });

  /**
   * `fetchPageByPathForMetadata` THROWS on a backend failure and returns null only for a
   * genuine absence. Collapsing the two is exactly what turns a Supabase blip into a
   * sitewide 404 — so a throw must leave the request alone.
   */
  test('an infrastructure failure is never read as "missing"', async () => {
    const d = deps({
      fetchPageForPath: async () => {
        throw new Error('Supabase not configured');
      },
    });
    assert.equal(await isMissingSiteRoute('/services', d), false);
  });

  test('a failure is not cached — the next request re-asks', async () => {
    let calls = 0;
    const d = deps({
      fetchPageForPath: async () => {
        calls += 1;
        if (calls === 1) throw new Error('blip');
        return { page: { id: 'p1' } };
      },
    });
    assert.equal(await isMissingSiteRoute('/services', d), false);
    assert.equal(await isMissingSiteRoute('/services', d), false);
    assert.equal(calls, 2, 'a cached failure would have skipped the second lookup');
  });

  /**
   * A redirect source has no page behind it — the resolver returns null. Without this
   * check every 301 on the site would answer 404 instead of redirecting.
   */
  test('a path that matches a redirect is not missing', async () => {
    const redirects: Redirect[] = [
      { oldUrl: '/old-page', newUrl: '/services', type: '301' } as Redirect,
    ];
    const d = deps({ fetchRedirects: async () => redirects });
    assert.equal(await isMissingSiteRoute('/old-page', d), false);
    assert.equal(await isMissingSiteRoute('/other-old-page', d), true);
  });

  test('a regex redirect pattern is honoured too', async () => {
    const redirects: Redirect[] = [
      { oldUrl: '/blog/.+', newUrl: '/insight/$0', type: '301' } as Redirect,
    ];
    const d = deps({ fetchRedirects: async () => redirects });
    assert.equal(await isMissingSiteRoute('/blog/anything', d), false);
  });

  /** The resolver is expensive; a second request for the same path must not repeat it. */
  test('answers are cached per path', async () => {
    let calls = 0;
    const d = deps({
      fetchPageForPath: async () => {
        calls += 1;
        return null;
      },
    });
    assert.equal(await isMissingSiteRoute('/gone', d), true);
    assert.equal(await isMissingSiteRoute('/gone', d), true);
    assert.equal(calls, 1);
  });

  test('the slug handed to the resolver is the path without its leading slash', async () => {
    const seen: string[] = [];
    const d = deps({
      fetchPageForPath: async (slug) => {
        seen.push(slug);
        return null;
      },
    });
    await isMissingSiteRoute('/services/design-branding', d);
    assert.deepEqual(seen, ['services/design-branding']);
  });

  test('an excluded path is answered without touching the resolver at all', async () => {
    let calls = 0;
    const d = deps({
      fetchPageForPath: async () => {
        calls += 1;
        return null;
      },
    });
    assert.equal(await isMissingSiteRoute('/', d), false);
    assert.equal(await isMissingSiteRoute('/ycode/pages/1', d), false);
    assert.equal(calls, 0);
  });
});
