/**
 * Audit #16 — `lang` was absent from the SERVER HTML on 161/161 pages.
 *
 * The fork renders `<html>` in exactly one place (`components/RootLayoutShell`) and the public
 * site deliberately passed no `lang`; the per-page locale was applied afterwards by
 * `PageRenderer` with `document.documentElement.lang = …`, a hydration-time script. So every
 * non-hydrating consumer — crawlers, `curl`, AI agents, and a screen reader choosing a voice
 * before JS runs — received an unlabelled document.
 *
 * These render the REAL `(site)` layout element to static markup and assert on the rendered
 * `<html>` tag, not on the source text.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/* eslint-disable @typescript-eslint/no-require-imports */
const serverOnlyPath = require.resolve('server-only');
require.cache[serverOnlyPath] = {
  id: serverOnlyPath, filename: serverOnlyPath, loaded: true, exports: {},
} as unknown as NodeModule;

// `app/(site)/layout.tsx` imports a stylesheet; Node's loader has no idea what that is.
require.extensions['.css'] = () => {};

let localeRows: Array<{ code: string }> = [{ code: 'en' }];
let localesFail = false;

const supabaseServer = require('@/lib/supabase-server');
supabaseServer.getSupabaseAdmin = async () => ({
  from: () => {
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    for (const m of ['select', 'eq', 'is', 'not', 'in', 'order', 'limit', 'single']) builder[m] = chain;
    builder.then = (resolve: (r: unknown) => unknown) =>
      resolve(localesFail ? { data: null, error: { message: 'down' } } : { data: localeRows, error: null });
    return builder;
  },
});

const settingsRepo = require('@/lib/repositories/settingsRepository');
settingsRepo.getSettingsByKeys = async () => ({});
settingsRepo.getSettingByKey = async () => null;

const { renderToStaticMarkup } = require('react-dom/server');
const SiteLayout = require('@/app/(site)/layout').default;
const { fetchSiteLang, normalizeLangCode, DEFAULT_SITE_LANG } = require('@/lib/site-lang');

/** Render the real layout element and return its opening <html> tag. */
async function renderHtmlTag() {
  const element = await SiteLayout({ children: null });
  const markup = renderToStaticMarkup(element);
  const match = markup.match(/<html[^>]*>/);
  assert.ok(match, `population check: no <html> in the rendered markup: ${markup.slice(0, 200)}`);
  return match[0];
}

beforeEach(() => {
  localeRows = [{ code: 'en' }];
  localesFail = false;
});

describe('audit #16 — <html lang> in the server response', () => {
  test('REGRESSION: the server-rendered <html> carries a lang attribute', async () => {
    const tag = await renderHtmlTag();
    assert.match(tag, /\slang="en"/, `the served <html> must be language-labelled, got: ${tag}`);
  });

  test('the lang comes from the site default locale, not a hardcoded value', async () => {
    localeRows = [{ code: 'fr' }];
    assert.match(await renderHtmlTag(), /\slang="fr"/);
  });

  test('a locales failure degrades to `en`, never to a missing lang', async () => {
    localesFail = true;
    assert.match(await renderHtmlTag(), /\slang="en"/);
  });

  test('normalizeLangCode rejects anything that is not a plausible language tag', () => {
    assert.equal(normalizeLangCode('en'), 'en');
    assert.equal(normalizeLangCode('en-US'), 'en-US');
    assert.equal(normalizeLangCode('  fr  '), 'fr');
    assert.equal(normalizeLangCode('"><script>'), null);
    assert.equal(normalizeLangCode(''), null);
    assert.equal(normalizeLangCode(null), null);
    assert.equal(DEFAULT_SITE_LANG, 'en');
  });

  test('fetchSiteLang never throws', async () => {
    localesFail = true;
    assert.equal(await fetchSiteLang(true), 'en');
  });
});
