/**
 * Optimistic-concurrency conflict (SCA-1476, SCA-1480).
 *
 * Three write paths in this fork were blind last-write-wins: the builder's whole-tree component
 * PUT, the builder's whole-tree page-layers PUT, and every `settings` write. Each sends state the
 * caller read at some earlier point and replaces the stored row with it, so a write that landed in
 * between — from MCP, another tab, another lane — disappears with no error anywhere. It cost the
 * third form's honeypot (SCA-1476) and a whole `custom_code_head` (SCA-1480).
 *
 * The guard is a PRECONDITION supplied by the caller: the `content_hash` (components, page_layers)
 * or `updated_at` (settings) it read. The UPDATE carries that value in its WHERE clause, so a row
 * someone else has touched matches ZERO rows and the write never happens. The repository then
 * re-reads and throws this error carrying the CURRENT state, so the caller can show a diff, merge,
 * or tell the user to reload — never silently overwrite.
 *
 * Preconditions are OPTIONAL by design. A caller that passes none keeps the old unconditional
 * behaviour, which is what keeps unrelated writers (CSS autosave, publish bookkeeping, page
 * creation) working untouched while the writers that actually race adopt the guard.
 */

export type ConflictResource = 'setting' | 'component' | 'page_layers';

export class ConflictError extends Error {
  /** Set on the prototype chain AND as an own property so it survives a structured copy. */
  readonly isConflict = true;

  constructor(
    /** Which table the conflict is on. */
    readonly resource: ConflictResource,
    /** The row's identity — setting key, component id, page id. */
    readonly key: string,
    /** The precondition the caller supplied (hash or ISO timestamp). `null` meant "expect absent". */
    readonly expected: string | null,
    /** The row as it exists NOW, so the caller can diff/merge instead of guessing. */
    readonly current: unknown,
    message?: string,
  ) {
    super(
      message ??
        `${resource} "${key}" changed since it was read (expected ${expected ?? 'no row'}). ` +
          'The write was refused so the other writer\'s change is not lost.',
    );
    this.name = 'ConflictError';
    // ts-node/CommonJS down-levels `extends Error`; restore the prototype so instanceof works.
    Object.setPrototypeOf(this, ConflictError.prototype);
  }
}

/**
 * True for a conflict raised by any repository.
 *
 * Checks the marker property rather than `instanceof` alone: Next bundles server code into more
 * than one module graph (route handlers, MCP tools, the site renderer), so two copies of this
 * class can legitimately exist in one process and `instanceof` would miss one of them — the
 * failure mode being a 500 where a 409 belongs, i.e. the caller silently retrying a clobber.
 */
export function isConflictError(error: unknown): error is ConflictError {
  return (
    error instanceof ConflictError ||
    (typeof error === 'object' && error !== null && (error as { isConflict?: unknown }).isConflict === true)
  );
}
