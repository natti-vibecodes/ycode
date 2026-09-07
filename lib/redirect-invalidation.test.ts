/**
 * SCA-1491 — the three MCP redirect writers wrote the row and never purged the cache.
 *
 * `add_redirect` / `update_redirect` / `delete_redirect` called the bare repository `setSetting`.
 * Redirects are matched INSIDE the cached page route (`app/(site)/[...slug]/page.tsx:285`,
 * `app/(site)/page.tsx:127`), which is `unstable_cache` with `revalidate: false` — so a new
 * redirect was live on the uncached `/dynamic` mirror and 404'd on the cached public route until
 * someone pressed Publish.
 *
 * Measured 2026-09-07: `/services/web-development` and `/work` both returned 308 on `/dynamic/…`
 * and 404 on the cached route, while `/services/web-development-old` — an OLDER entry in the same
 * table — returned 308 on both. Same mechanism, same table; only the freshly-written entries were
 * invisible, which is cache staleness rather than a bad redirect.
 *
 * SCA-1345 collapsed the settings writers onto `setSettingAndInvalidate` for exactly this reason,
 * and `lib/settings-keys.ts` names `redirects` as a key that requires invalidation. These three
 * tools were missed.
 *
 * These drive the REAL registered tool handlers through the REAL `setSettingAndInvalidate` and
 * the REAL `clearAllCache`, with only `next/cache` / `@vercel/functions` and the settings
 * repository stubbed. The assertion is on the TAG that reached the cache layer — not on a
 * re-implementation of the two lines under test, and not on the row, which a row-only assertion
 * would have found perfectly healthy on the old code.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/* eslint-disable @typescript-eslint/no-require-imports */
// require(), not import: these modules are stubbed in require.cache before the tool module
// loads, and hoisted imports cannot express that ordering.

function stub(specifier: string, exports: Record<string, unknown>) {
  const path = require.resolve(specifier);
  require.cache[path] = {
    id: path, filename: path, loaded: true, exports,
  } as unknown as NodeModule;
}

stub('server-only', {});

/** Every tag handed to the cache layer during a test. Both branches of clearAllCache land here. */
let purgedTags: string[] = [];
stub('next/cache', {
  revalidateTag: (tag: string) => { purgedTags.push(tag); },
  revalidatePath: () => {},
  unstable_cache: (fn: unknown) => fn,
});
stub('@vercel/functions', {
  invalidateByTag: async (tag: string) => { purgedTags.push(tag); },
});

type Redirect = { id: string; oldUrl: string; newUrl: string; type?: string };

/** The two entries from the ticket, plus the older one that was serving correctly. */
const SEED: Redirect[] = [
  { id: 'redirect_old_1', oldUrl: '/services/web-development-old', newUrl: '/services/web-app-development', type: '301' },
];

let stored: Redirect[] = [];
/** Every write that reached the repository, so "row written" and "cache purged" stay separable. */
let writes: Array<{ key: string; value: unknown; caller?: string }> = [];

stub('@/lib/repositories/settingsRepository', {
  getSettingByKey: async (key: string) => (key === 'redirects' ? stored : null),
  setSetting: async (key: string, value: unknown, options?: { caller?: string }) => {
    writes.push({ key, value, caller: options?.caller });
    if (key === 'redirects') stored = value as Redirect[];
    return { key, value, updated_at: new Date().toISOString() };
  },
  setSettings: async () => [],
  getSettingsByKeys: async () => ({}),
});

// pages.ts registers far more than the redirect tools; these are stubbed so requiring it does not
// drag the whole page stack in. The redirect handlers touch none of them.
for (const spec of [
  '@/lib/repositories/pageRepository',
  '@/lib/repositories/pageFolderRepository',
  '@/lib/repositories/pageLayersRepository',
  '@/lib/mcp/broadcast',
]) {
  stub(spec, new Proxy({}, {
    get: () => async () => [],
    has: () => true,
  }) as unknown as Record<string, unknown>);
}

const { registerPageTools } = require('@/lib/mcp/tools/pages');

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

/** Capture the real handlers by registering the tools against a fake MCP server. */
const handlers = new Map<string, Handler>();
registerPageTools({
  tool: (name: string, _description: string, _schema: never, handler: Handler) => {
    handlers.set(name, handler);
  },
} as never);

async function call(name: string, args: Record<string, unknown>) {
  const handler = handlers.get(name);
  assert.ok(handler, `population check: ${name} must be registered`);
  const res = await handler!(args);
  return { res, text: res.content[0].text };
}

beforeEach(() => {
  stored = SEED.map((r) => ({ ...r }));
  writes = [];
  purgedTags = [];
});

describe('SCA-1491: every redirect write purges the public route cache', () => {
  test('BEFORE-FAIL: add_redirect invalidates', async () => {
    // The exact write from the ticket.
    await call('add_redirect', { old_url: '/work', new_url: '/case-studies', type: '301' });

    assert.equal(writes.length, 1, 'population check: the row must still be written');
    assert.equal((writes[0].value as Redirect[]).length, 2, 'the new redirect is in the written value');
    assert.ok(
      purgedTags.includes('all-pages'),
      'the cached route keeps serving its 404 unless the write purges "all-pages"',
    );
  });

  test('BEFORE-FAIL: update_redirect invalidates', async () => {
    await call('update_redirect', { redirect_id: 'redirect_old_1', new_url: '/case-studies' });

    assert.equal((stored[0] as Redirect).newUrl, '/case-studies', 'population check: the row changed');
    assert.ok(purgedTags.includes('all-pages'));
  });

  test('BEFORE-FAIL: delete_redirect invalidates', async () => {
    // A deletion is the direction where staleness is worst: the redirect is gone from the table
    // and the cached route keeps redirecting, with nothing in the tool output to say so.
    await call('delete_redirect', { redirect_id: 'redirect_old_1' });

    assert.equal(stored.length, 0, 'population check: the row changed');
    assert.ok(purgedTags.includes('all-pages'));
  });

  test('re-saving an existing redirect purges — the recovery path for already-stale entries', async () => {
    // This fix prevents future staleness; it does not retro-invalidate the two entries written
    // before it. Re-saving one through update_redirect is what clears them, so it is pinned.
    await call('update_redirect', { redirect_id: 'redirect_old_1', new_url: '/services/web-app-development' });
    assert.ok(purgedTags.includes('all-pages'));
  });
});

describe('SCA-1491: a refused write purges nothing', () => {
  // Mirrors the ordering `setSettingAndInvalidate` already documents: the cache work runs AFTER
  // the write, so a rejected call must not cost every cached route a re-render.
  test('update_redirect on an unknown id neither writes nor purges', async () => {
    const { res } = await call('update_redirect', { redirect_id: 'redirect_missing', new_url: '/x' });
    assert.equal(res.isError, true);
    assert.equal(writes.length, 0);
    assert.deepEqual(purgedTags, []);
  });

  test('delete_redirect on an unknown id neither writes nor purges', async () => {
    const { res } = await call('delete_redirect', { redirect_id: 'redirect_missing' });
    assert.equal(res.isError, true);
    assert.equal(writes.length, 0);
    assert.deepEqual(purgedTags, []);
  });
});

/**
 * Source-level guard, in the shape SCA-1345 established. A unit test cannot catch a FOURTH
 * redirect writer added later that calls the repository directly — that is precisely how these
 * three survived SCA-1345's collapse of the other settings writers.
 */
describe('SCA-1491: no redirect writer calls the repository directly', () => {
  const read = (p: string) => readFileSync(join(__dirname, p), 'utf8');

  test('REGRESSION: pages.ts never calls the bare repository setSetting()', () => {
    const src = read('./mcp/tools/pages.ts');
    assert.match(src, /setSettingAndInvalidate/, 'redirect writes must go through the shared writer');
    assert.doesNotMatch(
      src.replace(/setSettingAndInvalidate/g, ''),
      /\bsetSetting\s*\(/,
      'the precise shape of the bug: importing the raw repository writer and calling it',
    );
  });

  test('the builder HTTP route for redirects invalidates too', () => {
    // The builder's redirects screen PUTs to /ycode/api/settings/redirects, i.e. the generic
    // settings route — which already goes through the shared writer. Pinned so the two surfaces
    // cannot drift apart again.
    assert.match(
      read('../app/(builder)/ycode/api/settings/[key]/route.ts'),
      /setSettingAndInvalidate/,
    );
  });
});
