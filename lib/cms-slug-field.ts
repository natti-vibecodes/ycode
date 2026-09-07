/**
 * Which collection field supplies a dynamic page's URL slug (SCA-1486).
 *
 * One rule, in one place, because three separate copies of "find the slug field" in
 * `cacheService.ts` all used `.eq('key', 'slug')` — and `collection_fields.key` is NULL on every
 * field in this workspace (70 of 70 on Insights, 36 of 36 on Case Studies, measured 2026-09-07).
 * All three therefore matched NOTHING and failed silently:
 *
 *   - `resolveDynamicPageRoutes` bailed out with `continue`, so a dynamic page expanded to ZERO
 *     item routes. Publishing the `insight-article` template invalidated none of its 113
 *     `/insight/<slug>` pages, which is the bug as Natalia measured it: the template published
 *     correctly (`/dynamic/insight/<slug>` showed the new one) while every cached item route kept
 *     serving the old one until a global settings write ran `clearAllCache`.
 *   - `getRoutePathsForDeletedCollectionItems` could not map a deleted slug back to its item, so
 *     orphaned URLs were never purged.
 *   - `loadCurrentLocalisationState` built an EMPTY item-slug map, so locale-prefixed CMS routes
 *     were never reconstructed.
 *
 * This is the same trap CLAUDE.md already records from llms.txt shipping a description on 0 of
 * 109 articles: "CMS field `key` is NULL on every field in this workspace — match fields by
 * `name`." An empty population and a clean result are the same value.
 *
 * Precedence, most authoritative first:
 *   1. the page's own `settings.cms.slug_field_id` — what the builder writes when a dynamic page
 *      is bound, and what `sitemap.xml` and `llms.txt` already read to build these exact URLs.
 *      Draft and published field rows share an id, so one value serves both;
 *   2. a field whose `key` is `slug`;
 *   3. a field whose `name` is `slug` — the fallback that makes this workspace work at all.
 */

export interface SlugFieldCandidate {
  id: string;
  key?: string | null;
  name?: string | null;
}

/** The page's `settings.cms` block, as far as slug resolution cares. */
export interface DynamicPageCms {
  collection_id?: string | null;
  slug_field_id?: string | null;
}

/**
 * Pick the slug field for one collection.
 *
 * `configuredSlugFieldId` wins outright — it is a deliberate binding, and honouring it also
 * covers collections that have several slug-ish fields.
 */
export function pickSlugFieldId(
  fields: readonly SlugFieldCandidate[],
  configuredSlugFieldId?: string | null,
): string | null {
  if (configuredSlugFieldId) return configuredSlugFieldId;

  const byKey = fields.find((f) => typeof f.key === 'string' && f.key.toLowerCase() === 'slug');
  if (byKey) return byKey.id;

  const byName = fields.find((f) => typeof f.name === 'string' && f.name.toLowerCase() === 'slug');
  return byName ? byName.id : null;
}

/**
 * Every field id that acts as a slug across a whole workspace, given all collection fields and
 * the `settings.cms` blocks of the dynamic pages bound to them.
 *
 * Used where the caller resolves item slugs in bulk rather than one collection at a time.
 * Configured ids are included even when their field row is not in `fields` (a caller may have
 * filtered the field query), because the binding is the authority.
 */
export function collectSlugFieldIds(
  fields: readonly (SlugFieldCandidate & { collection_id?: string | null })[],
  dynamicPageCms: readonly DynamicPageCms[],
): Set<string> {
  const configuredByCollection = new Map<string, string>();
  const ids = new Set<string>();

  for (const cms of dynamicPageCms) {
    if (!cms?.slug_field_id) continue;
    ids.add(cms.slug_field_id);
    if (cms.collection_id) configuredByCollection.set(cms.collection_id, cms.slug_field_id);
  }

  const byCollection = new Map<string, SlugFieldCandidate[]>();
  for (const field of fields) {
    const collectionId = field.collection_id;
    if (!collectionId) continue;
    const list = byCollection.get(collectionId);
    if (list) list.push(field);
    else byCollection.set(collectionId, [field]);
  }

  for (const [collectionId, collectionFields] of byCollection) {
    const picked = pickSlugFieldId(collectionFields, configuredByCollection.get(collectionId));
    if (picked) ids.add(picked);
  }

  return ids;
}
