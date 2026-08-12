/**
 * Dynamic llms.txt Route
 *
 * Serves the custom content from settings when set, and otherwise GENERATES the file from the
 * live pages — the same set sitemap.xml draws from, through the shared `isIndexablePage` rule.
 *
 * It used to 404 unless someone pasted the whole document into settings by hand, which meant it
 * was never served, and every page added afterwards would have had to be pasted in again.
 * See: https://llmstxt.org/
 */

import { NextResponse } from 'next/server';
import { getSettingByKey, getSettingsByKeys } from '@/lib/repositories/settingsRepository';
import { getAllPages } from '@/lib/repositories/pageRepository';
import { getAllPublishedPageFolders } from '@/lib/repositories/pageFolderRepository';
import { getItemsByCollectionId } from '@/lib/repositories/collectionItemRepository';
import { getValuesByItemIds } from '@/lib/repositories/collectionItemValueRepository';
import { getFieldsByCollectionId } from '@/lib/repositories/collectionFieldRepository';
import { findDisplayField } from '@/lib/collection-field-utils';
import { isIndexablePage } from '@/lib/sitemap-utils';
import { buildLlmsTxt, findSummaryField, type LlmsEntry, type LlmsSection } from '@/lib/llms-txt';
import { buildSlugPath } from '@/lib/page-utils';
import { getSiteBaseUrl, buildAbsolutePageUrl } from '@/lib/url-utils';
import type { Page, PageFolder } from '@/types';

const TEXT_HEADERS = {
  'Content-Type': 'text/plain; charset=utf-8',
  'Cache-Control': 'public, max-age=86400, s-maxage=86400',
};

/** Top-level folder a page sits under — the section it is grouped into. */
function topLevelFolder(page: Page, folders: PageFolder[]): PageFolder | null {
  let current = folders.find((f) => f.id === page.page_folder_id) ?? null;
  while (current?.page_folder_id) {
    const parent = folders.find((f) => f.id === current!.page_folder_id);
    if (!parent) break;
    current = parent;
  }
  return current;
}

function pageEntry(page: Page, folders: PageFolder[], baseUrl: string): LlmsEntry {
  return {
    url: buildAbsolutePageUrl(baseUrl, buildSlugPath(page, folders, 'page')),
    title: page.settings?.seo?.title || page.name,
    description: page.settings?.seo?.description,
  };
}

/** Expand a dynamic page into one entry per published collection item. */
async function dynamicPageEntries(page: Page, folders: PageFolder[], baseUrl: string): Promise<LlmsEntry[]> {
  const collectionId = page.settings?.cms?.collection_id;
  const slugFieldId = page.settings?.cms?.slug_field_id;
  if (!collectionId || !slugFieldId) return [];

  const [{ items }, fields] = await Promise.all([
    getItemsByCollectionId(collectionId, true),
    getFieldsByCollectionId(collectionId, true),
  ]);
  if (!items.length) return [];

  const valuesByItem = await getValuesByItemIds(items.map((i: { id: string }) => i.id), true);
  const folderPath = buildSlugPath(page, folders, 'page', '').replace(/\/$/, '');

  // The collection's own display field — the same one the builder shows. Without it every
  // article lists under its slug, which is what the first live run produced.
  const titleField = findDisplayField(fields);
  const summaryField = findSummaryField(fields);

  const entries: LlmsEntry[] = [];
  for (const item of items) {
    const values = valuesByItem[item.id] as Record<string, unknown> | undefined;
    const slug = values?.[slugFieldId];
    if (!slug || typeof slug !== 'string') continue;

    const title = titleField ? values?.[titleField.id] : null;
    const summary = summaryField ? values?.[summaryField.id] : null;
    entries.push({
      url: buildAbsolutePageUrl(baseUrl, `${folderPath}/${slug}`),
      title: typeof title === 'string' && title.trim() ? title : slug,
      description: typeof summary === 'string' && summary.trim() ? summary : undefined,
    });
  }
  return entries;
}

/**
 * Folder names here are lowercase slugs ("services", "insight"). Rendered as-is they read as
 * broken headings, so title-case them for display only.
 */
function sectionHeading(name: string): string {
  return name.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function GET() {
  try {
    const customLlms = await getSettingByKey('llms_txt');
    if (customLlms && typeof customLlms === 'string' && customLlms.trim()) {
      return new NextResponse(customLlms.trim(), { headers: TEXT_HEADERS });
    }

    const [settings, pages, folders] = await Promise.all([
      getSettingsByKeys(['global_canonical_url']),
      getAllPages({ is_published: true }),
      getAllPublishedPageFolders(),
    ]);

    const baseUrl = getSiteBaseUrl({ globalCanonicalUrl: settings.global_canonical_url }) || '';
    const live = pages.filter((p) => p.deleted_at == null && isIndexablePage(p));

    if (!live.length) {
      // Nothing published yet. A file listing no pages is worse than no file: it reads as an
      // authoritative "this site has nothing", which is the wrong answer to cache for a day.
      return new NextResponse(null, { status: 404 });
    }

    const home = live.find((p) => p.is_index && p.page_folder_id === null);
    const siteName = home?.settings?.seo?.title
      || (baseUrl ? baseUrl.replace(/^https?:\/\//, '').replace(/\/$/, '') : 'Site');

    // Group by top-level folder; root-level pages go in a single leading section.
    const rootEntries: LlmsEntry[] = [];
    const byFolder = new Map<string, { name: string; order: number; entries: LlmsEntry[] }>();

    for (const page of live) {
      const entries = page.is_dynamic
        ? await dynamicPageEntries(page, folders, baseUrl)
        : [pageEntry(page, folders, baseUrl)];
      if (!entries.length) continue;

      const folder = topLevelFolder(page, folders);
      if (!folder) {
        rootEntries.push(...entries);
        continue;
      }
      const bucket = byFolder.get(folder.id)
        ?? { name: folder.name, order: folder.order, entries: [] };
      bucket.entries.push(...entries);
      byFolder.set(folder.id, bucket);
    }

    const sections: LlmsSection[] = [
      { name: 'Pages', entries: rootEntries },
      ...[...byFolder.values()]
        .sort((a, b) => a.order - b.order)
        .map((f) => ({ name: sectionHeading(f.name), entries: f.entries })),
    ];

    return new NextResponse(buildLlmsTxt({ siteName, sections }), { headers: TEXT_HEADERS });
  } catch (error) {
    console.error('[llms.txt] Error:', error);
    return new NextResponse(null, { status: 404 });
  }
}
