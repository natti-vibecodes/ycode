/**
 * Trim `pages` / `folders` to the fields the CLIENT renderer actually reads (SCA-1390).
 *
 * `PageRenderer` fetches every page and folder row so links can be resolved, then hands both
 * arrays to `LayerRendererPublic` — a client component. Everything a client component receives
 * as a prop is serialized into the RSC Flight payload verbatim, so the full `Page` row crossed
 * the boundary: `settings` included, and `settings.custom_code.body` with it.
 *
 * On this site 20 case studies keep their entire article in page custom code (~70 KB each, with
 * an empty layer tree — see lib/custom-code-mount.ts). So EVERY page served every case study's
 * article to the browser. A text-only legal page shipped 3.85 MB, of which ~1.75 MB was other
 * pages' custom code, and none of it rendered: it existed only in the Flight stream. The visible
 * document was 108 KB. Even a 404 shipped 1.89 MB.
 *
 * That is also why "the TOC takes a minute": every custom-code behaviour — reveals, nav, cookie
 * banner, TOC — runs from CustomCodeInjector's effect, which cannot fire until the whole stream
 * has downloaded and hydrated.
 *
 * ALLOW-LIST, not a deny-list, and deliberately so. Stripping only the fields that are big today
 * would leave the next fat settings key to be discovered the same way — by someone measuring a
 * slow page. It also keeps secrets out by construction: `PageSettings.auth.password` and
 * `PageFolderSettings.auth.password` are plain strings on these very rows, so a deny-list that
 * forgot one would publish every protected page's password in the payload of every public page.
 * Nothing is password-protected today, which is exactly why it would have gone unnoticed.
 *
 * Adding a field is fine — add it here, and the test in client-page-projection.test.ts will make
 * the decision explicit rather than silent.
 */

import type { Page, PageFolder } from '@/types';

/** The only `Page` fields reachable from the client. */
export const CLIENT_PAGE_FIELDS = [
  'id',
  'slug',
  'name',
  'is_index',
  'is_dynamic',
  'page_folder_id',
] as const;

/** The only `PageFolder` fields reachable from the client. */
export const CLIENT_FOLDER_FIELDS = [
  'id',
  'slug',
  'name',
  'page_folder_id',
] as const;

export type ClientPage = Pick<Page, (typeof CLIENT_PAGE_FIELDS)[number]>;
export type ClientFolder = Pick<PageFolder, (typeof CLIENT_FOLDER_FIELDS)[number]>;

/**
 * Why these fields and no others: the client reaches `pages`/`folders` only through
 * `LinkResolutionContext` (lib/link-utils.ts), which looks a page up by `id` and hands it to
 * `buildLocalizedSlugPath` / `buildLocalizedDynamicPageUrl` (lib/page-utils.ts). Between them
 * they read `id`, `slug`, `is_index`, `is_dynamic` and `page_folder_id` on a page, and `id`,
 * `slug` and `page_folder_id` while walking the folder chain. `name` is carried because it is
 * two words wide and several shared helpers accept a page or folder interchangeably.
 *
 * `settings` is NOT carried. No client-side path reads it — `settings.cms.collection_id` is
 * resolved server-side in PageRenderer before the boundary.
 */
export function toClientPages(pages: Page[] | undefined | null): ClientPage[] {
  if (!pages) return [];
  return pages.map((page) => ({
    id: page.id,
    slug: page.slug,
    name: page.name,
    is_index: page.is_index,
    is_dynamic: page.is_dynamic,
    page_folder_id: page.page_folder_id,
  }));
}

export function toClientFolders(folders: PageFolder[] | undefined | null): ClientFolder[] {
  if (!folders) return [];
  return folders.map((folder) => ({
    id: folder.id,
    slug: folder.slug,
    name: folder.name,
    page_folder_id: folder.page_folder_id,
  }));
}
