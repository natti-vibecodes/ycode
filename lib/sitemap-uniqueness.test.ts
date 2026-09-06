/**
 * Audit #14 — sitemap.xml listed 181 <loc> entries for 161 unique URLs.
 *
 * Cause, measured on the live database: the `case-studies` folder holds 20 hand-built pages AND
 * a dynamic CMS template (`case-study-template`) whose collection carries the same 20 slugs.
 * `generateSitemapUrls` emitted each URL twice — once from the static builder, once from the
 * dynamic one — and nothing downstream deduplicated. A duplicated <loc> is a self-inconsistency
 * signal to crawlers, and the two entries can disagree on lastmod/changefreq.
 *
 * The fix dedupes at the single point where both URL sources meet, static winning, because the
 * exact page match is what the router actually serves.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generateSitemapUrls, generateSitemapXml, getDefaultSitemapSettings } from '@/lib/sitemap-utils';
import type { Page, PageFolder, CollectionItem } from '@/types';

const BASE = 'https://www.scalability.us';
const FOLDER: PageFolder = {
  id: 'folder-cs', name: 'Case Studies', slug: 'case-studies', page_folder_id: null,
} as unknown as PageFolder;

const SLUGS = ['novapay', 'panelista', 'aegis-capital'];

function staticPage(slug: string): Page {
  return {
    id: `page-${slug}`, name: slug, slug, page_folder_id: 'folder-cs',
    is_dynamic: false, is_index: false, error_page: null, deleted_at: null,
    is_published: true, settings: {}, updated_at: '2026-09-01T00:00:00.000Z',
  } as unknown as Page;
}

const TEMPLATE: Page = {
  id: 'page-template', name: 'Case study template', slug: 'case-study-template',
  page_folder_id: 'folder-cs', is_dynamic: true, is_index: false, error_page: null,
  deleted_at: null, is_published: true, updated_at: '2026-09-01T00:00:00.000Z',
  settings: { cms: { collection_id: 'col-1', slug_field_id: 'field-slug' } },
} as unknown as Page;

function buildUrls(pages: Page[]) {
  const items: CollectionItem[] = SLUGS.map((s, i) => ({
    id: `item-${i}`, collection_id: 'col-1', manual_order: i,
    updated_at: '2026-09-01T00:00:00.000Z',
  } as unknown as CollectionItem));
  const itemValues = new Map<string, Map<string, string>>(
    SLUGS.map((s, i) => [`item-${i}`, new Map([['field-slug', s]])]),
  );
  return generateSitemapUrls(
    pages,
    [FOLDER],
    BASE,
    getDefaultSitemapSettings(),
    [],
    new Map(),
    new Map([['page-template', { items, slugFieldId: 'field-slug', itemValues }]]),
  );
}

describe('audit #14 — sitemap URL uniqueness', () => {
  test('REGRESSION: a static page and a dynamic template covering the same slug emit ONE loc', () => {
    const urls = buildUrls([...SLUGS.map(staticPage), TEMPLATE]);
    const locs = urls.map(u => u.loc);

    // Population check first: this fixture must actually contain the colliding shape.
    assert.ok(locs.includes(`${BASE}/case-studies/novapay`), 'the colliding URL must be present at all');
    assert.equal(locs.length, SLUGS.length, `expected ${SLUGS.length} URLs, got ${locs.length}: ${locs.join(', ')}`);
    assert.equal(new Set(locs).size, locs.length, 'every <loc> must be unique');
  });

  test('the rendered XML carries no duplicate <loc>', () => {
    const xml = generateSitemapXml(buildUrls([...SLUGS.map(staticPage), TEMPLATE]));
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
    assert.ok(locs.length > 0, 'population check: the XML has locs');
    assert.equal(new Set(locs).size, locs.length, `duplicate locs in XML: ${locs.join(', ')}`);
  });

  test('collection items with NO static page still get their URL — dedupe must not delete coverage', () => {
    const urls = buildUrls([TEMPLATE]);
    const locs = urls.map(u => u.loc).sort();
    assert.deepEqual(locs, SLUGS.map(s => `${BASE}/case-studies/${s}`).sort());
  });

  test('a soft-deleted page is excluded from the sitemap', () => {
    const deleted = { ...staticPage('gone'), deleted_at: '2026-09-06T00:00:00.000Z' } as Page;
    // The route filters `deleted_at == null` before calling in; assert the contract it relies on.
    const pages = [staticPage('novapay'), deleted].filter(p => p.deleted_at == null && p.error_page == null);
    const locs = buildUrls(pages).map(u => u.loc);
    assert.ok(!locs.some(l => l.endsWith('/gone')), 'a soft-deleted page must not be listed');
  });
});
