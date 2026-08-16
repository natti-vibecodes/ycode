import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  toClientPages,
  toClientFolders,
  CLIENT_PAGE_FIELDS,
  CLIENT_FOLDER_FIELDS,
} from './client-page-projection';
import { buildLocalizedSlugPath } from './page-utils';
import type { Page, PageFolder } from '@/types';

/**
 * SCA-1390. `PageRenderer` passes every page and folder row to `LayerRendererPublic`, a client
 * component, so links can be resolved. Client-component props are serialized into the RSC Flight
 * payload verbatim — so the whole `Page` row crossed, `settings.custom_code.body` included.
 *
 * Measured on /terms-of-service, a text-only legal page: 3.85 MB served, 3.73 MB of it Flight
 * payload, ~1.75 MB of that being 20 OTHER pages' case-study articles. The rendered document was
 * 108 KB. A 404 shipped 1.89 MB.
 */

const folder = (over: Partial<PageFolder>): PageFolder => ({
  id: 'f1', page_folder_id: null, name: 'Case Studies', slug: 'case-studies', depth: 0, order: 0,
  settings: {}, is_published: true, created_at: '', updated_at: '', deleted_at: null, ...over,
});

const page = (over: Partial<Page>): Page => ({
  id: 'p1', slug: 'panelista', name: 'Panelista', page_folder_id: 'f1', order: 0, depth: 1,
  is_index: false, is_dynamic: false, error_page: null, settings: {}, is_published: true,
  is_publishable: true, created_at: '', updated_at: '', deleted_at: null, ...over,
});

describe('toClientPages / toClientFolders (SCA-1390)', () => {
  test('REGRESSION: page custom code never crosses the client boundary', () => {
    // The whole incident in one assertion. A 70 KB case-study article in `custom_code.body`,
    // multiplied by every page of the site, is what made a legal page 3.85 MB.
    const article = '<div class="wf-panelista">'.padEnd(70_000, 'x') + '</div>';
    const [projected] = toClientPages([page({ settings: { custom_code: { head: '', body: article } } })]);

    assert.equal('settings' in projected, false, 'settings must not be carried at all');
    assert.equal(JSON.stringify(projected).includes('wf-panelista'), false);
    assert.ok(JSON.stringify(projected).length < 200, 'a projected page should be tiny');
  });

  test('REGRESSION: a protected page/folder password never reaches the browser', () => {
    // Nothing is password-protected today, which is precisely why a deny-list would have
    // shipped this unnoticed: `auth.password` is a plain string on these same rows.
    const [p] = toClientPages([page({ settings: { auth: { enabled: true, password: 'hunter2' } } })]);
    const [f] = toClientFolders([folder({ settings: { auth: { enabled: true, password: 'hunter2' } } })]);

    assert.equal(JSON.stringify(p).includes('hunter2'), false);
    assert.equal(JSON.stringify(f).includes('hunter2'), false);
  });

  test('the allow-list is pinned — widening it is a decision, not an accident', () => {
    assert.deepEqual([...CLIENT_PAGE_FIELDS],
      ['id', 'slug', 'name', 'is_index', 'is_dynamic', 'page_folder_id']);
    assert.deepEqual([...CLIENT_FOLDER_FIELDS], ['id', 'slug', 'name', 'page_folder_id']);

    // And the projection actually emits exactly those keys — a field added to the list above
    // but not to the mapper would be a silently missing prop on the client.
    assert.deepEqual(Object.keys(toClientPages([page({})])[0]).sort(), [...CLIENT_PAGE_FIELDS].sort());
    assert.deepEqual(Object.keys(toClientFolders([folder({})])[0]).sort(), [...CLIENT_FOLDER_FIELDS].sort());
  });

  test('link resolution is unchanged — the projected row builds the same URL', () => {
    // The point of the allow-list is that it keeps every field link resolution reads. This is
    // the assertion that would fail if one were dropped, and it compares against the full row
    // rather than a hardcoded string, so it stays honest if the URL scheme ever changes.
    const folders = [folder({}), folder({ id: 'f0', slug: 'work', page_folder_id: null }),
      folder({ id: 'f1', slug: 'case-studies', page_folder_id: 'f0' })];

    const cases: Page[] = [
      page({}),
      page({ id: 'p2', slug: '', is_index: true, page_folder_id: null }),
      page({ id: 'p3', slug: 'insights', is_dynamic: true, page_folder_id: null }),
      page({ id: 'p4', slug: 'deep', page_folder_id: 'f1' }),
    ];

    for (const full of cases) {
      const [projected] = toClientPages([full]);
      assert.equal(
        buildLocalizedSlugPath(projected as Page, folders, 'page', null, undefined),
        buildLocalizedSlugPath(full, folders, 'page', null, undefined),
        `projected row changed the URL for page ${full.id}`,
      );
    }
  });

  test('empty and missing inputs are safe', () => {
    assert.deepEqual(toClientPages(undefined), []);
    assert.deepEqual(toClientPages(null), []);
    assert.deepEqual(toClientFolders(undefined), []);
    assert.deepEqual(toClientFolders([]), []);
  });
});

/**
 * Source-level guard. The defect was not a wrong branch — it was one prop handed over raw. A
 * unit test cannot catch a caller that stops projecting, so assert the wiring itself.
 */
/**
 * SCA-1390 (DB side) — the database-side twin. SCA-1390 stopped the fat `settings` crossing into the RSC
 * payload; it did NOT stop it leaving Postgres, because that projection runs after the fetch.
 * These guard the query itself. Source-level, because the alternative is a live Supabase call.
 */
describe('link-resolution reads are projected at the QUERY level (SCA-1390 (DB side))', () => {
  const fnBody = (src: string, name: string) => {
    const start = src.indexOf(`export async function ${name}`);
    assert.notEqual(start, -1, `${name} must exist`);
    const end = src.indexOf('\nexport ', start + 1);
    return src.slice(start, end === -1 ? undefined : end);
  };
  const pageSrc = readFileSync(join(__dirname, 'repositories/pageRepository.ts'), 'utf8');
  const folderSrc = readFileSync(join(__dirname, 'repositories/pageFolderRepository.ts'), 'utf8');

  test('REGRESSION: neither link-resolution read selects *', () => {
    // `select('*')` on 55 published rows pulled 1.71 MB of settings out of Postgres — 85% of it
    // case-study articles — so PageRenderer could read an id and a slug.
    assert.doesNotMatch(fnBody(pageSrc, 'getPagesForLinkResolution'), /select\('\*'\)/);
    assert.doesNotMatch(fnBody(folderSrc, 'getFoldersForLinkResolution'), /select\('\*'\)/);
  });

  test('the page read still selects everything link resolution needs', () => {
    const body = fnBody(pageSrc, 'getPagesForLinkResolution');
    for (const col of ['id', 'slug', 'name', 'is_index', 'is_dynamic', 'page_folder_id']) {
      assert.match(body, new RegExp(`\\b${col}\\b`), `${col} is read by buildLocalizedSlugPath`);
    }
    // `settings->cms` is read SERVER-side to resolve ref-* links through a dynamic page's
    // collection binding. Dropping it would break those links silently, at HTTP 200.
    assert.match(body, /cms:settings->cms/);
  });

  test('REGRESSION: getAllPages itself is NOT narrowed', () => {
    // It has 12 callers; the MCP tools and builder page API legitimately need the full row.
    // Narrowing it globally would surface in the builder as lost work, not as a bad query.
    assert.match(fnBody(pageSrc, 'getAllPages'), /select\('\*'\)/);
  });
});

describe('PageRenderer projects before crossing the boundary (SCA-1390)', () => {
  // `__dirname`, not `new URL(..., import.meta.url)`: the suite runs under `ts-node/register`
  // in CommonJS, and `import.meta` makes node treat the file as ESM — which then cannot resolve
  // the extensionless TS imports above. That is what kept settings-invalidation.test.ts from
  // ever running: it failed at import, so its SCA-1345 guard had never once executed.
  const src = readFileSync(join(__dirname, '../components/PageRenderer.tsx'), 'utf8');

  test('REGRESSION: raw pages/folders are not passed to the client renderer', () => {
    assert.doesNotMatch(src, /pages=\{pages as any\}/, 'the raw rows must not cross');
    assert.doesNotMatch(src, /folders=\{folders as any\}/, 'the raw rows must not cross');
    assert.match(src, /pages=\{toClientPages\(pages\)/);
    assert.match(src, /folders=\{toClientFolders\(folders\)/);
  });
});
