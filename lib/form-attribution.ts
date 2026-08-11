/**
 * Lead attribution capture for form submissions (SCA-1186).
 *
 * Every submission must record where the person came from and the journey that led to the
 * form — first-touch source, referrer, the ordered page journey, and the page they submitted
 * on. The client serialises all of that into a hidden `attribution` field (lead-attribution.md);
 * this module turns a raw submission into the metadata we store alongside it.
 *
 * Two things are deliberate:
 *
 * 1. Server-derived values WIN over client-supplied ones. user_agent and referer come from
 *    request headers, which a visitor cannot forge as easily as a form field, and the client
 *    only ever sends page_url.
 *
 * 2. The attribution field is parsed into an object rather than left as the JSON string the
 *    form submits. Stored as a string it is effectively unqueryable — "which leads came from
 *    LinkedIn?" would mean a LIKE over serialised JSON. Parsed into JSONB it answers directly.
 *    The raw string stays in `payload` untouched, so nothing is lost if parsing is ever wrong.
 */

export interface SubmissionMetadata {
  page_url?: string;
  user_agent?: string;
  referrer?: string;
  submitted_at: string;
  /** Parsed contents of the hidden `attribution` field; null when absent or unparseable. */
  attribution: Record<string, unknown> | null;
  /** Present only when the attribution field existed but could not be parsed. */
  attribution_parse_error?: string;
  [key: string]: unknown;
}

/**
 * Parse the hidden `attribution` field. Tolerates the field being absent, empty, already an
 * object, or malformed — a broken attribution blob must never cost us the lead itself.
 */
export function parseAttribution(raw: unknown): {
  attribution: Record<string, unknown> | null;
  error?: string;
} {
  if (raw === undefined || raw === null || raw === '') return { attribution: null };

  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return { attribution: raw as Record<string, unknown> };
  }

  if (typeof raw !== 'string') {
    return { attribution: null, error: `unexpected type: ${typeof raw}` };
  }

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { attribution: parsed as Record<string, unknown> };
    }
    return { attribution: null, error: 'attribution JSON was not an object' };
  } catch (e) {
    return { attribution: null, error: e instanceof Error ? e.message : 'invalid JSON' };
  }
}

/**
 * Build the metadata stored with a submission, merging what the client sent with what the
 * server can see. Merge — not the `||` fallback this replaced, which meant user_agent and
 * referrer were never captured at all: the client always sends a metadata object (page_url),
 * so the fallback branch was dead code.
 */
export function buildSubmissionMetadata(input: {
  clientMetadata?: unknown;
  payload?: Record<string, unknown>;
  userAgent?: string | null;
  referrer?: string | null;
  submittedAt?: string;
}): SubmissionMetadata {
  const client =
    input.clientMetadata && typeof input.clientMetadata === 'object' && !Array.isArray(input.clientMetadata)
      ? (input.clientMetadata as Record<string, unknown>)
      : {};

  const { attribution, error } = parseAttribution(input.payload?.attribution);

  return {
    ...client,
    user_agent: input.userAgent || undefined,
    referrer: input.referrer || undefined,
    submitted_at: input.submittedAt ?? new Date().toISOString(),
    attribution,
    ...(error ? { attribution_parse_error: error } : {}),
  };
}

/** Greppable marker for submissions that could not be written to the database. */
export const LEAD_WRITE_FAILED = 'LEAD_WRITE_FAILED';

/**
 * Failure record for a submission we could not persist.
 *
 * The visitor still sees success (see the route): showing an error would lose a prospect who
 * has already decided to get in touch, and a recoverable log line beats an empty database.
 * This is the only place submission content is logged — the success path logs nothing — so
 * the log holds personal data only for submissions that actually failed, which keeps the
 * recoverable set small and short-lived rather than mirroring every lead into the logs.
 */
export function formatLeadWriteFailure(input: {
  formId: string;
  payload: unknown;
  metadata: unknown;
  error: unknown;
}): string {
  return `${LEAD_WRITE_FAILED} ${JSON.stringify({
    form_id: input.formId,
    payload: input.payload,
    metadata: input.metadata,
    error: input.error instanceof Error ? input.error.message : String(input.error),
    failed_at: new Date().toISOString(),
  })}`;
}
