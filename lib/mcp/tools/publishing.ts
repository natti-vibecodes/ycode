import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getUnpublishedPages, getAllDraftPages } from '@/lib/repositories/pageRepository';
import { getUnpublishedLayerStyles, publishLayerStyles } from '@/lib/repositories/layerStyleRepository';
import { getAllComponents, getUnpublishedComponents, publishComponents } from '@/lib/repositories/componentRepository';
import { getAllCollections, getUnpublishedCollections } from '@/lib/repositories/collectionRepository';
import { getItemsByCollectionId } from '@/lib/repositories/collectionItemRepository';
import { getUnpublishedAssets, publishAssets, hardDeleteSoftDeletedAssets } from '@/lib/repositories/assetRepository';
import { getUnpublishedAssetFolders, publishAssetFolders, hardDeleteSoftDeletedAssetFolders } from '@/lib/repositories/assetFolderRepository';
import { getUnpublishedFonts, publishFonts } from '@/lib/repositories/fontRepository';
import { getAllLocales } from '@/lib/repositories/localeRepository';
import { getUnpublishedTranslationsCount } from '@/lib/repositories/translationRepository';
import { getUnpublishedGlobalVariables, publishGlobalVariables, hardDeleteSoftDeletedGlobalVariables } from '@/lib/repositories/globalVariableRepository';
import { publishPages } from '@/lib/services/pageService';
import { publishCollectionWithItems } from '@/lib/services/collectionService';
import { publishLocalisation } from '@/lib/services/localisationService';
import { publishFolders } from '@/lib/services/folderService';
import { publishCSS, savePublishedAt } from '@/lib/services/settingsService';
import { generateAndSaveDraftCSS } from '@/lib/server/cssGenerator';
import { clearAllCache } from '@/lib/services/cacheService';
import { isPublishAllowed, publishBlockedMessage } from '@/lib/publish-guard';
import { getAllDraftLayers } from '@/lib/repositories/pageLayersRepository';
import { getAllDraftPageFolders } from '@/lib/repositories/pageFolderRepository';
import { buildSlugPath } from '@/lib/page-utils';
import { buildPublishManifest } from '@/lib/publish-manifest';
import { BOOT_COMMIT } from '@/lib/boot-commit';
import { readHeadCommit } from '@/lib/head-commit-server';
import type { Layer, Page } from '@/types';

/** Count draft locales not yet present in the published set (new languages awaiting publish). */
async function countUnpublishedLocales(): Promise<number> {
  const [draft, published] = await Promise.all([
    getAllLocales(false),
    getAllLocales(true),
  ]);
  const publishedIds = new Set(published.map((l) => l.id));
  return draft.filter((l) => !publishedIds.has(l.id)).length;
}

export function registerPublishingTools(server: McpServer) {
  server.tool(
    'get_unpublished_changes',
    'Check what changes are pending and need to be published. Reports unpublished pages, styles, components, collections, fonts, assets, translations, and locales.',
    {},
    async () => {
      const [pages, styles, components, collections, fonts, assets, assetFolders, translations, locales, globals] = await Promise.all([
        getUnpublishedPages().catch(() => []),
        getUnpublishedLayerStyles().catch(() => []),
        getUnpublishedComponents().catch(() => []),
        getUnpublishedCollections().catch(() => []),
        getUnpublishedFonts().catch(() => []),
        getUnpublishedAssets().catch(() => []),
        getUnpublishedAssetFolders().catch(() => []),
        getUnpublishedTranslationsCount().catch(() => 0),
        countUnpublishedLocales().catch(() => 0),
        getUnpublishedGlobalVariables().catch(() => []),
      ]);

      const hasChanges = pages.length > 0 || styles.length > 0 || components.length > 0
        || collections.length > 0 || fonts.length > 0 || assets.length > 0 || assetFolders.length > 0
        || translations > 0 || locales > 0 || globals.length > 0;

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            has_unpublished_changes: hasChanges,
            unpublished_pages: pages.map((p) => ({ id: p.id, name: p.name })),
            unpublished_styles: styles.map((s) => ({ id: s.id, name: s.name })),
            unpublished_components: components.map((c: { id: string; name: string }) => ({ id: c.id, name: c.name })),
            unpublished_collections: collections.map((c: { id: string; name: string }) => ({ id: c.id, name: c.name })),
            unpublished_fonts: fonts.map((f) => ({ id: f.id, family: f.family })),
            unpublished_assets: assets.length,
            unpublished_asset_folders: assetFolders.length,
            unpublished_translations: translations,
            unpublished_locales: locales,
            unpublished_global_variables: globals.map((g) => ({ id: g.id, name: g.name })),
          }, null, 2),
        }],
      };
    },
  );

  server.tool(
    'get_publish_manifest',
    'Pre-publish gate: which URLs will ACTUALLY serve this publish, which pages a queued component will NOT reach (they hold their own copy), the list of URLs to re-fetch afterwards, and whether the running server predates the working tree. Read-only. Answers "where does this land?", which get_unpublished_changes does not (SCA-1272).',
    {
      accepted_divergence: z.array(z.string()).optional().describe(
        'Component ids whose page-local copies are deliberate (e.g. page-local Collection Lists with per-page filters). Listed as accepted rather than reported as breakage.',
      ),
    },
    async ({ accepted_divergence }) => {
      const [queuedPages, queuedComponents, allPages, allComponents, allLayers, folders] = await Promise.all([
        getUnpublishedPages().catch(() => [] as Page[]),
        getUnpublishedComponents().catch(() => [] as { id: string; name: string }[]),
        getAllDraftPages().catch(() => [] as Page[]),
        getAllComponents(false).catch(() => [] as { id: string; name: string; layers: Layer[] }[]),
        getAllDraftLayers().catch(() => [] as { page_id: string; layers: Layer[] }[]),
        getAllDraftPageFolders().catch(() => []),
      ]);

      const layersByPage = new Map(allLayers.map((row) => [row.page_id, row.layers ?? []]));

      const manifest = buildPublishManifest({
        queued: {
          pages: queuedPages.map((p) => ({ id: p.id, name: p.name })),
          components: queuedComponents.map((c) => ({ id: c.id, name: c.name })),
        },
        components: allComponents.map((c) => ({ id: c.id, name: c.name, layers: c.layers ?? [] })),
        pages: allPages.map((p) => ({
          id: p.id,
          name: p.name,
          layers: layersByPage.get(p.id) ?? [],
          // buildSlugPath is the site's own resolver — index pages, nested folders and dynamic
          // slugs all get their real served path, not a guess assembled from the slug.
          url: buildSlugPath(p, folders, 'page'),
          isPublishable: p.is_publishable,
        })),
        acceptedDivergence: accepted_divergence,
        bootCommit: BOOT_COMMIT,
        headCommit: readHeadCommit(),
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(manifest, null, 2) }],
      };
    },
  );

  server.tool(
    'publish',
    'Publish all draft changes to make them live. This publishes pages, collections, components, styles, assets, and regenerates CSS. Disabled for agent sessions unless PUBLISH_ALLOWED and PUBLISH_ALLOWED_MCP are set — publishing is global and ships every other session\'s drafts too (SCA-1227).',
    {},
    async () => {
      // Gate first: publishing is global, so a stray call here ships every other
      // session's pending work. See lib/publish-guard.ts.
      if (!isPublishAllowed('mcp')) {
        return {
          content: [{ type: 'text' as const, text: publishBlockedMessage('mcp') }],
          isError: true,
        };
      }

      const publishedAt = new Date().toISOString();
      const changes: Record<string, number> = {};

      // Publish folders
      try {
        const foldersResult = await publishFolders([], undefined);
        changes.folders = foldersResult.count;
      } catch { changes.folders = 0; }

      // Publish all draft pages
      try {
        const draftPages = await getAllDraftPages();
        if (draftPages.length > 0) {
          const result = await publishPages(draftPages.map((p) => p.id));
          changes.pages = result.count;
        } else {
          changes.pages = 0;
        }
      } catch { changes.pages = 0; }

      // Publish collections with items
      try {
        const allCollections = await getAllCollections({ is_published: false });
        let totalItems = 0;
        for (const collection of allCollections) {
          const { items } = await getItemsByCollectionId(collection.id, false);
          if (items.length > 0) {
            const result = await publishCollectionWithItems({
              collectionId: collection.id,
              itemIds: items.map((item: { id: string }) => item.id),
            });
            totalItems += result.published?.itemsCount || 0;
          }
        }
        changes.collection_items = totalItems;
      } catch { changes.collection_items = 0; }

      // Publish components
      try {
        const unpublished = await getUnpublishedComponents();
        if (unpublished.length > 0) {
          const result = await publishComponents(unpublished.map((c: { id: string }) => c.id));
          changes.components = result.count;
        } else {
          changes.components = 0;
        }
      } catch { changes.components = 0; }

      // Publish layer styles
      try {
        const unpublished = await getUnpublishedLayerStyles();
        if (unpublished.length > 0) {
          const result = await publishLayerStyles(unpublished.map((s) => s.id));
          changes.layer_styles = result.count;
        } else {
          changes.layer_styles = 0;
        }
      } catch { changes.layer_styles = 0; }

      // Publish asset folders
      try {
        await hardDeleteSoftDeletedAssetFolders();
        const unpublished = await getUnpublishedAssetFolders();
        if (unpublished.length > 0) {
          const result = await publishAssetFolders(unpublished.map((f: { id: string }) => f.id));
          changes.asset_folders = result.count;
        }
      } catch { /* non-fatal */ }

      // Publish assets
      try {
        await hardDeleteSoftDeletedAssets();
        const unpublished = await getUnpublishedAssets();
        if (unpublished.length > 0) {
          const result = await publishAssets(unpublished.map((a: { id: string }) => a.id));
          changes.assets = result.count;
        }
      } catch { /* non-fatal */ }

      // Publish fonts
      try { await publishFonts(); } catch { /* non-fatal */ }

      // Publish global variables
      try {
        const globalsResult = await publishGlobalVariables();
        changes.globalVariables = globalsResult.count;
        await hardDeleteSoftDeletedGlobalVariables();
      } catch { /* non-fatal */ }

      // Publish locales and translations
      try {
        const locResult = await publishLocalisation();
        changes.locales = locResult.locales;
        changes.translations = locResult.translations;
      } catch { /* non-fatal */ }

      // Regenerate draft CSS from all current layers, then publish it
      try {
        await generateAndSaveDraftCSS();
        await publishCSS();
      } catch { /* non-fatal */ }

      // Clear cache. No warming here: MCP is invoked over JSON-RPC, not HTTP,
      // so there's no Request/host header to build absolute URLs from. The
      // builder's HTTP publish endpoint warms after publish — this AI tool
      // path is rare enough that a cold next-visit is acceptable.
      try { await clearAllCache(); } catch { /* non-fatal */ }

      // Save published_at timestamp
      try { await savePublishedAt(publishedAt); } catch { /* non-fatal */ }

      const total = Object.values(changes).reduce((sum, n) => sum + n, 0);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            message: `Published ${total} item(s) successfully`,
            published_at: publishedAt,
            changes,
          }, null, 2),
        }],
      };
    },
  );
}
