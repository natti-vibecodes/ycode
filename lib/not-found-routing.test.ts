/**
 * SCA-1465 — a missing URL must be answered by the `/404` ROUTE, not by `notFound()`.
 *
 * Why the routing matters more than it looks: `notFound()` returns the right status with an
 * EMPTY document (Next 16.3 aborts the RSC render and recovers with a hardcoded
 * `<html id="__next_error__">`), while `app/(site)/404/page.tsx` renders a complete document
 * AND answers 404 — but only because its route path is exactly `/404`
 * (`isNotFoundPath` in Next's `renderToHTMLOrFlightImpl`). Both halves of that are silent
 * when broken: rename the folder and every 404 quietly becomes a soft 200; drop the rewrite
 * and every 404 quietly becomes an empty page. So both are pinned here.
 *
 * These drive the REAL `proxy` function with real `NextRequest`s, stubbing only the
 * existence lookup and the security-header write.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/* eslint-disable @typescript-eslint/no-require-imports */
// require(), not import: these modules are replaced before proxy.ts loads them, and hoisted
// imports cannot express that ordering.

const serverOnlyPath = require.resolve('server-only');
require.cache[serverOnlyPath] = {
  id: serverOnlyPath,
  filename: serverOnlyPath,
  loaded: true,
  exports: {},
} as unknown as NodeModule;

const routeExistence = require('@/lib/route-existence');
let missingPaths = new Set<string>();
let asked: string[] = [];
routeExistence.isMissingSiteRoute = async (pathname: string) => {
  asked.push(pathname);
  return missingPaths.has(pathname);
};

const securityHeaders = require('@/lib/security-headers-server');
securityHeaders.applySecurityHeaders = async () => {};

const { proxy } = require('@/proxy');

const ORIGIN = 'http://localhost:3002';

function get(path: string, method = 'GET') {
  return new NextRequest(`${ORIGIN}${path}`, { method });
}

/**
 * A middleware rewrite is expressed as the `x-middleware-rewrite` header on the response —
 * asserting on the parsed header rather than on "did it not throw".
 */
function rewriteTarget(res: Response): string | null {
  const raw = res.headers.get('x-middleware-rewrite');
  if (!raw) return null;
  return new URL(raw, ORIGIN).pathname;
}

beforeEach(() => {
  missingPaths = new Set();
  asked = [];
});

describe('the /404 route itself', () => {
  /**
   * The status comes from the ROUTE PATH, nothing else. `app/(site)/404/page.tsx` →
   * page path `/404` → Next sets `res.statusCode = 404` before rendering. Move this file
   * and the 404 silently becomes a 200 with 404-looking content, which is precisely the
   * soft-404 this ticket exists to remove.
   */
  test('lives at the exact route path that makes Next answer 404', () => {
    const root = join(__dirname, '..');
    assert.ok(
      existsSync(join(root, 'app/(site)/404/page.tsx')),
      'app/(site)/404/page.tsx is what gives the 404 document its 404 status',
    );
  });

  /** One implementation for both 404 surfaces — see components/SiteNotFound.tsx. */
  test('shares its markup with the notFound() boundary', () => {
    const root = join(__dirname, '..');
    const routeSrc = require('node:fs').readFileSync(join(root, 'app/(site)/404/page.tsx'), 'utf8');
    const boundarySrc = require('node:fs').readFileSync(join(root, 'app/(site)/not-found.tsx'), 'utf8');
    for (const src of [routeSrc, boundarySrc]) {
      assert.match(src, /@\/components\/SiteNotFound/);
    }
  });
});

describe('proxy routing of missing URLs', () => {
  test('rewrites a missing page to /404', async () => {
    missingPaths.add('/no-such-page');
    const res = await proxy(get('/no-such-page'));
    assert.equal(rewriteTarget(res), '/404');
  });

  test('rewrites a missing dynamic-collection item to /404', async () => {
    missingPaths.add('/case-studies/nope');
    missingPaths.add('/insight/nope');
    for (const p of ['/case-studies/nope', '/insight/nope']) {
      assert.equal(rewriteTarget(await proxy(get(p))), '/404', p);
    }
  });

  /** The whole point of the one-sided contract: a real page must pass through untouched. */
  test('leaves a page that resolves alone', async () => {
    const res = await proxy(get('/services/design-branding'));
    assert.equal(rewriteTarget(res), null);
    assert.equal(res.headers.get('x-pathname'), '/services/design-branding');
  });

  test('HEAD is routed like GET', async () => {
    missingPaths.add('/no-such-page');
    assert.equal(rewriteTarget(await proxy(get('/no-such-page', 'HEAD'))), '/404');
  });

  /**
   * A POST to a missing URL is a form submission or an API-ish call, not a crawl — rewriting
   * it would swallow the body and answer 404 for something the page might handle.
   */
  test('POST is never rewritten', async () => {
    missingPaths.add('/no-such-page');
    const res = await proxy(get('/no-such-page', 'POST'));
    assert.equal(rewriteTarget(res), null);
    assert.equal(asked.length, 0, 'the existence lookup should not even run for POST');
  });

  test('builder and API paths are never asked about', async () => {
    for (const p of ['/ycode', '/ycode/pages/1', '/api/page-auth/verify']) {
      await proxy(get(p));
    }
    assert.deepEqual(asked, [], `asked about: ${asked.join(', ')}`);
  });

  /**
   * The pagination rewrite to `/dynamic/...` must still happen for pages that exist —
   * ordering the 404 check before it is only safe because the check is one-sided.
   */
  test('a resolvable paginated URL still rewrites to /dynamic, not /404', async () => {
    const res = await proxy(get('/case-studies?p_1=2'));
    assert.equal(rewriteTarget(res), '/dynamic/case-studies');
  });

  test('a missing paginated URL goes to /404 rather than /dynamic', async () => {
    missingPaths.add('/nope');
    const res = await proxy(get('/nope?p_1=2'));
    assert.equal(rewriteTarget(res), '/404');
  });

  /** The original URL has to survive for logging, canonicals and analytics. */
  test('the rewritten response still carries the requested path', async () => {
    missingPaths.add('/no-such-page');
    const res = await proxy(get('/no-such-page'));
    assert.equal(res.headers.get('x-pathname'), '/no-such-page');
  });
});
