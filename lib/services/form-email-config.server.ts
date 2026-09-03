/**
 * Supabase-backed sources for form email notification config.
 *
 * Split from `form-email-config.ts` so the resolution logic stays pure and testable without a
 * database. See that file's header for why the config is read server-side at all.
 */

import { getAllPublishedLayers, getAllDraftLayers } from '@/lib/repositories/pageLayersRepository';
import { getAllComponents } from '@/lib/repositories/componentRepository';
import { getComponentVariantLayers } from '@/lib/component-variant-utils';
import { sendFormSubmissionEmail } from '@/lib/services/emailService';
import {
  notifyFormSubmission,
  resolveStoredFormEmailNotification,
  type FormLayerTree,
  type FormNotificationEmailData,
  type FormNotificationOutcome,
  type ResolvedFormEmail,
} from '@/lib/services/form-email-config';
import type { Component } from '@/types';

/**
 * A form can live in a page's own tree OR only inside a component master — `resolveComponents()`
 * inlines masters at render time, so the page row holds just an instance with no children, and a
 * component-hosted form would be invisible to a page-only scan. Commit 2c809ff exists precisely
 * because forms in components are a real shape here, so both stores are searched.
 */
function componentTrees(components: Component[], scope: string): FormLayerTree[] {
  const trees: FormLayerTree[] = [];

  for (const component of components) {
    const variants = component.variants?.length ? component.variants : undefined;

    if (variants) {
      for (const variant of variants) {
        trees.push({
          label: `${scope}:component[${component.name}]/variant[${variant.name}]`,
          layers: getComponentVariantLayers(component, variant.id) || [],
        });
      }
    } else {
      // Pre-variants-migration shape.
      trees.push({ label: `${scope}:component[${component.name}]`, layers: component.layers || [] });
    }
  }

  return trees;
}

async function loadTrees(isPublished: boolean): Promise<FormLayerTree[]> {
  const scope = isPublished ? 'published' : 'draft';

  const [pageRows, components] = await Promise.all([
    isPublished ? getAllPublishedLayers() : getAllDraftLayers(),
    getAllComponents(isPublished),
  ]);

  const trees: FormLayerTree[] = pageRows.map(row => ({
    label: `${scope}:page[${row.page_id}]`,
    layers: row.layers || [],
  }));

  return trees.concat(componentTrees(components, scope));
}

/**
 * The lookup walks every page and component tree, which is a lot of JSON to pull for one
 * submission — and this endpoint is public, so doing it per request would hand an attacker a
 * cheap amplification lever (one small POST costing a full-site layer read). A short in-process
 * TTL bounds that to one scan per window however hard the endpoint is hammered, and a config
 * change still takes effect within the window. This is a cache, deliberately not a retry or a
 * queue.
 */
const TREE_CACHE_TTL_MS = 60_000;

interface TreeCacheEntry {
  loadedAt: number;
  inFlight: Promise<FormLayerTree[]>;
}

const treeCache = new Map<string, TreeCacheEntry>();

/** Exported for tests and for callers that need a guaranteed-fresh read. */
export function clearFormLayerTreeCache(): void {
  treeCache.clear();
}

function loadTreesCached(isPublished: boolean, now: () => number = Date.now): Promise<FormLayerTree[]> {
  const key = isPublished ? 'published' : 'draft';
  const cached = treeCache.get(key);

  if (cached && now() - cached.loadedAt < TREE_CACHE_TTL_MS) {
    return cached.inFlight;
  }

  const inFlight = loadTrees(isPublished).catch(error => {
    // Never cache a failure: drop the entry so the next submission retries the read.
    treeCache.delete(key);
    throw error;
  });

  treeCache.set(key, { loadedAt: now(), inFlight });
  return inFlight;
}

export function resolveFormEmailFromStore(formId: string): Promise<ResolvedFormEmail> {
  return resolveStoredFormEmailNotification(formId, {
    published: () => loadTreesCached(true),
    draft: () => loadTreesCached(false),
  });
}

/**
 * Resolve the submitting form's OWN stored notification config and send it. Nothing from the
 * request body reaches this call. Never throws — the submission is already stored by the time
 * this runs.
 */
export function dispatchStoredFormNotification(
  data: FormNotificationEmailData
): Promise<FormNotificationOutcome> {
  return notifyFormSubmission(data, {
    resolve: resolveFormEmailFromStore,
    send: (to, subject, emailData) =>
      sendFormSubmissionEmail(to, subject, {
        formId: emailData.formId,
        submissionId: emailData.submissionId,
        payload: emailData.payload,
        metadata: emailData.metadata,
        replyTo: emailData.replyTo,
      }),
    logError: event => console.error('[form-submissions]', JSON.stringify(event)),
  });
}
