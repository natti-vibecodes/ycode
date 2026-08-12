/**
 * Whether a NEWLY created page may go live on the next publish (SCA-1254).
 *
 * Default: NO.
 *
 * Publishing in Ycode is global — one publish ships every pending change across the site, not
 * just the caller's. A page created without anyone thinking about this flag therefore goes live
 * under whoever publishes next, which in a multi-session setup is usually someone who has never
 * seen it. Half-built pages have shipped this way.
 *
 * Opting a page IN to publishing is a decision someone makes once it is ready. Opting OUT should
 * never be something you have to remember: forgetting must fail safe (page stays a draft), not
 * fail live.
 *
 * Applies to creation only. update_page still sets the flag either way — that IS the decision.
 */
export function resolveNewPagePublishable(explicit?: boolean | null): boolean {
  return explicit === true;
}
