/**
 * Publish manifest — what each page will ACTUALLY serve after this publish (SCA-1272).
 *
 * The question this answers is deliberately not "what changed?". Every failure that cost us a day
 * had a clean change list: the fix was made, the queue was empty, `is_published` said true, and
 * the served page was still wrong. What was missing was the step from "I edited a thing" to
 * "these specific URLs will contain it".
 *
 * Three signals, each earned from a real incident:
 *
 * 1. REACH — which pages an edited component actually reaches. A component fix reaches instances
 *    only; a page holding its own copy of the section silently keeps the old version. That is how
 *    the newsletter form shipped wired on two pages and dead on a third.
 *
 * 2. VERIFICATION TARGETS — the URLs to fetch after publishing, and what to grep for. Assumption
 *    is not evidence: four separate fixes in one day looked correct, reviewed clean, and did
 *    nothing, and every one was caught only by reading the served output.
 *
 * 3. RUNNING-CODE DRIFT — the fork commit the server was STARTED from versus HEAD. A fix can be
 *    committed, pushed and live in the working tree while the running process predates it, or
 *    (as with adea726) reach staging only through hot-reload, which no restart would preserve.
 *    Silent either way.
 *
 * Divergence is reported with intent attached, not as a defect list. Page-local Collection Lists
 * with per-page filters are a deliberate standard here, so nine of the divergence scanner's first
 * findings were policy rather than bugs — a manifest that calls them defects trains people to
 * ignore it, which costs more than saying nothing.
 */

import { findStructuralDivergence, type DivergenceComponent, type DivergencePage } from './component-divergence';

export interface ManifestInput {
  /** Entities the publish queue reports as pending. */
  queued: { pages: { id: string; name: string }[]; components: { id: string; name: string }[] };
  components: DivergenceComponent[];
  /**
   * `url` is the authoritative served path when the caller can build one (`buildSlugPath` knows
   * about index pages, nested folders and dynamic slugs; the `pageUrl` fallback here does not).
   * `isPublishable === false` means the page does not go live at all — see ManifestEntry.
   */
  pages: (DivergencePage & { slug?: string; folder?: string | null; url?: string; isPublishable?: boolean })[];
  /** Component ids whose page-local copies are intentional (policy, not drift). */
  acceptedDivergence?: string[];
  /** Fork commit the running server was started from, and the working tree's HEAD. */
  bootCommit?: string | null;
  headCommit?: string | null;
}

export interface ManifestEntry {
  pageId: string;
  pageName: string;
  url: string;
  /** Why this page is affected — queued directly, or reached by a queued component. */
  reasons: string[];
  /**
   * False when `is_publishable` is off: the edit publishes, and the page still serves nothing.
   * Only an explicit false counts — an unknown flag is not evidence of a problem.
   */
  publishable: boolean;
}

export interface PublishManifest {
  willShip: ManifestEntry[];
  /** Pages holding their own copy of a queued component — the fix will NOT reach these. */
  willNotReach: { pageId: string; pageName: string; componentName: string; accepted: boolean }[];
  verify: { url: string; expect: string }[];
  runningCodeDrift: { bootCommit: string | null; headCommit: string | null; stale: boolean };
  summary: string;
}

/** A page's served URL. Pages resolve at their full folder path — a bare slug 404s. */
export function pageUrl(page: { slug?: string; folder?: string | null }): string {
  const slug = (page.slug ?? '').replace(/^\/+|\/+$/g, '');
  const folder = (page.folder ?? '').replace(/^\/+|\/+$/g, '');
  if (!slug) return '/';
  return '/' + [folder, slug].filter(Boolean).join('/');
}

function usesComponent(page: DivergencePage, componentId: string): boolean {
  let found = false;
  const walk = (layers: typeof page.layers) => {
    for (const l of layers ?? []) {
      if (l.componentId === componentId) found = true;
      walk(l.children ?? []);
    }
  };
  walk(page.layers);
  return found;
}

export function buildPublishManifest(input: ManifestInput): PublishManifest {
  const accepted = new Set(input.acceptedDivergence ?? []);
  const byPage = new Map<string, ManifestEntry>();

  const add = (page: ManifestInput['pages'][number], reason: string) => {
    const existing = byPage.get(page.id);
    if (existing) { if (!existing.reasons.includes(reason)) existing.reasons.push(reason); return; }
    byPage.set(page.id, {
      pageId: page.id,
      pageName: page.name,
      url: page.url ?? pageUrl(page),
      reasons: [reason],
      publishable: page.isPublishable !== false,
    });
  };

  const queuedPageIds = new Set(input.queued.pages.map((p) => p.id));
  for (const page of input.pages) {
    if (queuedPageIds.has(page.id)) add(page, 'queued directly');
  }

  // Reach: a queued component ships to the pages that actually instance it.
  for (const queuedComponent of input.queued.components) {
    for (const page of input.pages) {
      if (usesComponent(page, queuedComponent.id)) add(page, `renders “${queuedComponent.name}”`);
    }
  }

  // Non-reach: pages that look like they contain the section but hold their own copy.
  const divergence = findStructuralDivergence(input.components, input.pages);
  const queuedComponentIds = new Set(input.queued.components.map((c) => c.id));
  const willNotReach = divergence
    .filter((d) => queuedComponentIds.has(d.componentId))
    .map((d) => ({
      pageId: d.pageId,
      pageName: d.pageName,
      componentName: d.componentName,
      accepted: accepted.has(d.componentId),
    }));

  // Non-publishable pages get no verification target: they serve a 404 either way, so listing
  // them would hand back a check that fails for a reason unrelated to the change.
  const verify = [...byPage.values()].filter((e) => e.publishable).map((e) => ({
    url: e.url,
    // A dynamic page's path carries a placeholder (`/insight/{slug}`). Dropping it from the list
    // would leave that template unverified and silent; handing it over as-is gives a URL that
    // 404s for a reason unrelated to the change. Keep it, and say what to substitute.
    expect: e.url.includes('{')
      ? 'dynamic page — substitute a real item slug for the placeholder, then grep for a marker that is PRESENT when the fix is in'
      : 'the change you made — fetch this URL and grep for a marker that is PRESENT when the fix is in',
  }));

  const boot = input.bootCommit ?? null;
  const head = input.headCommit ?? null;
  const stale = Boolean(boot && head && boot !== head);

  const unexpected = willNotReach.filter((w) => !w.accepted);
  const unpublishable = [...byPage.values()].filter((e) => !e.publishable);
  const summary = [
    `${byPage.size} page(s) will serve this publish.`,
    unexpected.length ? `⚠️ ${unexpected.length} page(s) hold their own copy and will NOT get it.` : '',
    unpublishable.length ? `⚠️ ${unpublishable.length} page(s) are affected but not publishable — the edit ships and the page still serves nothing.` : '',
    stale ? `⚠️ Running server was started from ${boot?.slice(0, 7)}, HEAD is ${head?.slice(0, 7)} — restart to be sure what is running.` : '',
  ].filter(Boolean).join(' ');

  return { willShip: [...byPage.values()], willNotReach, verify, runningCodeDrift: { bootCommit: boot, headCommit: head, stale }, summary };
}
