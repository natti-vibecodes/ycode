/**
 * Audit #22 — the served 404 emitted TWO robots metas.
 *
 * Next renders `<meta name="robots" content="noindex">` itself for any response whose status is
 * above 400 (`NonIndex`, next/dist/server/app-render/app-render.js). `app/(site)/not-found.tsx`
 * added a second one from the custom 404 page's own SEO settings, so the document carried both
 * `noindex` and `noindex, nofollow` — two directives on the same page, from two layers, with
 * nothing keeping them in agreement.
 *
 * Ownership rule: the layer that knows the status code owns the robots directive.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

/* eslint-disable @typescript-eslint/no-require-imports */
const serverOnlyPath = require.resolve('server-only');
require.cache[serverOnlyPath] = {
  id: serverOnlyPath, filename: serverOnlyPath, loaded: true, exports: {},
} as unknown as NodeModule;
require.extensions['.css'] = () => {};

/** A custom 404 page whose own SEO settings ask for noindex,nofollow — the shape that duplicated. */
const ERROR_PAGE = {
  id: 'page-404', name: '404 - Page not found', slug: '', error_page: 404,
  is_published: true, deleted_at: null,
  settings: { seo: { title: 'Page not found — Scalability', noindex: true, nofollow: true } },
};

const pageFetcher = require('@/lib/page-fetcher');
pageFetcher.fetchErrorPage = async () => ({
  page: ERROR_PAGE, pageLayers: { layers: [] }, components: [],
  locale: null, availableLocales: [], translations: {},
});
pageFetcher.slimPageData = (d: unknown) => d;

// `generatePageMetadata` reaches global settings through the module-local binding, so the stub
// has to be one level down, at the repository.
const settingsRepo = require('@/lib/repositories/settingsRepository');
settingsRepo.getSettingsByKeys = async () => ({ global_canonical_url: 'https://www.scalability.us' });
settingsRepo.getSettingByKey = async () => null;
const supabaseServer = require('@/lib/supabase-server');
supabaseServer.getSupabaseAdmin = async () => null;

const nextCache = require('next/cache');
nextCache.unstable_cache = (fn: (...a: unknown[]) => unknown) => fn;

const notFoundRoute = require('@/app/(site)/not-found');

describe('audit #22 — exactly one robots directive on the served 404', () => {
  test('REGRESSION: not-found metadata carries NO robots key', async () => {
    const metadata = await notFoundRoute.generateMetadata();

    // Population check: the metadata really was produced from the custom 404 page, so a missing
    // `robots` cannot be an artifact of the fetch having returned nothing.
    assert.ok(metadata.title, `expected a title from the custom 404 page, got ${JSON.stringify(metadata)}`);

    assert.equal(
      metadata.robots, undefined,
      'Next already emits `noindex` for a 404 status; a second robots meta here is the duplicate ' +
      'the audit measured (`noindex` AND `noindex, nofollow` on one document)',
    );
  });
});

describe('audit #22 — the catch-all route must not add a second robots meta either', () => {
  test('REGRESSION: the not-found metadata branch of [...slug] carries no robots key', async () => {
    // This one shows up after hydration, where the client re-applies the page route's metadata
    // over the not-found boundary's — the real browser saw `noindex, nofollow` AND `noindex`.
    const source = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'app/(site)/[...slug]/page.tsx'), 'utf8',
    );
    const start = source.indexOf('export async function generateMetadata');
    assert.ok(start > 0, 'population check: generateMetadata was located');
    const branch = source.slice(start, start + 1600);
    assert.ok(branch.includes("title: 'Page Not Found'"), 'population check: the not-found branch is in range');
    const notFoundBranch = branch.slice(branch.indexOf('if (!data) {'), branch.indexOf("title: 'Page Not Found'") + 40);
    assert.ok(
      !/robots:/.test(notFoundBranch),
      'the 404 metadata branch must not emit its own robots directive',
    );
  });
});

describe('audit #33 — `next dev` must not re-append AGENTS.md', () => {
  test('REGRESSION: agentRules is explicitly false in the resolved Next config', async () => {
    const config = require('@/next.config').default;
    assert.equal(
      config.agentRules, false,
      'Next 16.3 gates writeAgentFiles() on `agentRules !== false` ' +
      '(next/dist/server/lib/start-server.js:418-426); without this the file is re-dirtied on every boot',
    );
  });

  test('the opt-out this relies on actually exists in the installed Next', () => {
    const fs = require('fs');
    const path = require('path');
    const decl = fs.readFileSync(
      path.join(__dirname, '..', 'node_modules/next/dist/server/config-shared.d.ts'), 'utf8',
    );
    assert.match(decl, /agentRules\?: boolean;/, 'the installed Next must expose the agentRules option');
    const startServer = fs.readFileSync(
      path.join(__dirname, '..', 'node_modules/next/dist/server/lib/start-server.js'), 'utf8',
    );
    assert.match(startServer, /agentRules !== false/, 'the gate this fix depends on must still be there');
  });
});
