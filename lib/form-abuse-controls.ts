/**
 * Abuse controls for the PUBLIC form-submission endpoint (audit finding H5).
 *
 * `POST /ycode/api/form-submissions` is unauthenticated by design — it is the endpoint every
 * visitor's contact form posts to. Before this module it had no ceiling of any kind: no rate
 * limit, no size cap, and no honeypot handling, with the global proxy body limit sitting at
 * 500mb. One script could fill the submissions table, and every stored row also fans out to a
 * notification email, a webhook and the app integrations — so the cost of a junk POST is much
 * larger than one row.
 *
 * Three controls, deliberately kept as pure functions so they can be tested without a server:
 *
 *   1. SIZE CAP      — reject anything larger than a real submission could plausibly be.
 *   2. HONEYPOT      — a field no human ever fills; if it is filled, accept and drop.
 *   3. RATE LIMIT    — a per-IP sliding window.
 *
 * The route wires them in; the numbers and the reasoning live here.
 */

// ---------------------------------------------------------------------------
// 1. Size cap
// ---------------------------------------------------------------------------

/**
 * Maximum accepted request body, in bytes.
 *
 * MEASURED, not guessed. The four real submissions stored on 2026-08-12/13 have JSON payloads
 * of 1135, 1335, 1434 and 1779 bytes; reconstructed as whole POST bodies (form_id + payload +
 * metadata) that is 1201–1845 bytes. So the largest submission this site has ever actually
 * taken is ~1.8KB, and the dominant part of it is the `attribution` blob (1288 bytes in the
 * largest), not the message.
 *
 * The largest REAL submission is not the largest LEGITIMATE one, so the cap is set against a
 * modelled worst case rather than against 1.8KB:
 *
 *   journey, capped at 30 entries by the capture module   30 x ~90B  ~2,700B
 *   first + last touch, full query strings and referrers   2 x ~600B ~1,200B
 *   click IDs (gclid/fbclid/msclkid/li_fat_id/ttclid)                 ~300B
 *   GA client id, device, timezone, seconds-on-page                   ~200B
 *   a genuinely long message from a serious prospect                ~4,000B
 *   name / email / company / budget                                   ~200B
 *                                                                  ---------
 *                                                                    ~8.6KB
 *
 * 32KB is ~3.5x that modelled worst case and ~18x the largest submission ever received, while
 * being ~16,000x smaller than the 500mb the proxy would otherwise wave through. It is chosen to
 * be impossible for a real visitor to hit and pointless for an attacker to sit under.
 *
 * If a form ever grows a file upload, this is the number that has to move — and an upload
 * should go to storage with its own limits rather than inline in this JSON body.
 */
export const MAX_SUBMISSION_BYTES = 32 * 1024;

/** Greppable marker for submissions refused for being oversized. */
export const FORM_BODY_TOO_LARGE = 'FORM_BODY_TOO_LARGE';

/**
 * Parse `content-length` into a byte count. Returns null when the header is absent (a chunked
 * request need not send one), unparseable, or negative — in which case the caller must fall
 * back to measuring the body it actually read. The header is a claim, not a fact: it is checked
 * first only because it lets us refuse a huge upload before buffering it.
 */
export function declaredBodyBytes(headers: Headers): number | null {
  const raw = headers.get('content-length');
  if (raw === null) return null;

  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) return null;
  return parsed;
}

/**
 * Byte length of a body as read. Deliberately bytes and not `string.length`: an attacker
 * padding with multi-byte characters would otherwise get several times the intended budget,
 * and legitimate non-ASCII text (a name with accents, a message in any non-Latin script) has
 * to be measured the same way the database and the mailer will see it.
 */
export function byteLengthOf(body: string): number {
  return Buffer.byteLength(body, 'utf8');
}

/** True when a body of `bytes` must be refused. Exactly at the cap is allowed. */
export function exceedsSizeCap(bytes: number, cap: number = MAX_SUBMISSION_BYTES): boolean {
  return bytes > cap;
}

/** Trace for an oversized submission. The body itself is NOT logged — that is the point. */
export function formatOversizeRejection(input: {
  formId?: unknown;
  bytes: number;
  source: 'content-length' | 'body';
  ip: string;
}): string {
  return `${FORM_BODY_TOO_LARGE} ${JSON.stringify({
    event: 'form_submission_too_large',
    form_id: typeof input.formId === 'string' ? input.formId : null,
    bytes: input.bytes,
    limit: MAX_SUBMISSION_BYTES,
    measured_from: input.source,
    ip: input.ip,
    rejected_at: new Date().toISOString(),
  })}`;
}

// ---------------------------------------------------------------------------
// 2. Honeypot
// ---------------------------------------------------------------------------

/**
 * Name of the honeypot input.
 *
 * NOTE FOR WHOEVER ADDS THE MARKUP: as of 2026-09-03 no form on the site renders this field —
 * the served markup carries only the hidden `attribution` input. The honeypot and time-trap
 * were specified (lead-attribution.md §1, architecture.md §5) but never built, and the spec
 * never named the field. This constant IS the contract: the markup half must render an input
 * named exactly this, visually hidden, with `tabindex="-1"` and `autocomplete="off"`.
 *
 * The route-side half is live regardless, so the day the markup lands it starts working with
 * no server change — and until then this costs nothing, because a field nobody renders is a
 * field nobody fills.
 *
 * COLLISION RISK, stated plainly: `website` is a name a real form could want ("your company
 * website"). If any form on the site ever adds a genuine website field, every submission to it
 * would be silently treated as spam. Two things guard that: this name must change if such a
 * field is ever wanted, and the rejection trace below records the full payload so a false
 * positive is recoverable from the log rather than lost.
 */
export const HONEYPOT_FIELD = 'website';

/** Greppable marker for submissions dropped by the honeypot. */
export const FORM_SPAM_REJECTED = 'FORM_SPAM_REJECTED';

/**
 * True when the honeypot field carries content.
 *
 * Only a non-empty value trips it. Absent, null, empty string and whitespace-only all read as
 * untripped: browsers submit empty inputs for every rendered field, so "the key is present"
 * cannot be the test — it would reject every legitimate submission the moment the markup lands.
 */
export function isHoneypotTripped(payload: unknown, field: string = HONEYPOT_FIELD): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;

  const value = (payload as Record<string, unknown>)[field];
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) && value !== 0;

  // Any other shape (array, object) means something filled it in; treat it as tripped.
  return true;
}

/**
 * Trace for a honeypot rejection.
 *
 * The payload IS logged here, mirroring formatLeadWriteFailure: a submission dropped in silence
 * is unrecoverable, and the failure mode that actually costs money is a false positive — a real
 * lead binned because a form grew a colliding field name. Volume is bounded by the rate limiter,
 * so this cannot become a log-flooding lever on its own.
 */
export function formatHoneypotRejection(input: {
  formId: unknown;
  field: string;
  payload: unknown;
  ip: string;
}): string {
  return `${FORM_SPAM_REJECTED} ${JSON.stringify({
    event: 'form_submission_honeypot_tripped',
    form_id: typeof input.formId === 'string' ? input.formId : null,
    honeypot_field: input.field,
    payload: input.payload,
    ip: input.ip,
    rejected_at: new Date().toISOString(),
  })}`;
}

// ---------------------------------------------------------------------------
// 3. Rate limit
// ---------------------------------------------------------------------------

/** Value used when no client IP can be determined. See clientIpFrom. */
export const UNKNOWN_IP = 'unknown';

/**
 * Client IP for rate-limiting purposes.
 *
 * Order matters. `x-vercel-forwarded-for` is set by the platform and cannot be spoofed by the
 * client; the plain `x-forwarded-for` first hop is the fallback for any other host, and it CAN
 * be forged by a client talking to an origin that is not behind a trusted proxy — which is the
 * honest limit of a header-derived key. Next 15 removed `request.ip`, so headers are all there
 * is on Next 16.
 *
 * When nothing identifies the caller, everyone shares the UNKNOWN_IP bucket. That is a
 * deliberate fail-closed choice — an attacker who strips headers gets throttled with everyone
 * else rather than getting an unlimited lane — but it does mean a misconfigured proxy could
 * throttle real visitors collectively. In local dev every request is `::1` anyway.
 */
export function clientIpFrom(headers: Headers): string {
  const platform = headers.get('x-vercel-forwarded-for')?.trim();
  if (platform) return platform.split(',')[0].trim() || UNKNOWN_IP;

  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    const firstHop = forwarded.split(',')[0]?.trim();
    if (firstHop) return firstHop;
  }

  const real = headers.get('x-real-ip')?.trim();
  if (real) return real;

  return UNKNOWN_IP;
}

export interface RateLimitRule {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Requests allowed within that window. */
  max: number;
  /** Human label, used in the 429 trace. */
  label: string;
}

/**
 * The limits.
 *
 * A person filling in a contact form submits once, occasionally twice if they mistyped an
 * email. Five in a minute is already far beyond human, and twenty in an hour bounds a slow
 * drip that would slip under the per-minute rule. Both rules apply; the stricter one that
 * trips wins.
 */
export const SUBMISSION_RATE_RULES: readonly RateLimitRule[] = [
  { windowMs: 60_000, max: 5, label: '5/min' },
  { windowMs: 60 * 60_000, max: 20, label: '20/hour' },
];

export interface RateLimitVerdict {
  allowed: boolean;
  /** The rule that refused the request, when allowed is false. */
  rule?: RateLimitRule;
  /** Seconds until the caller could succeed, for the Retry-After header. Always >= 1. */
  retryAfterSeconds?: number;
}

export interface RateLimiter {
  /** Record an attempt and say whether it may proceed. */
  check(key: string, now?: number): RateLimitVerdict;
  /** Drop all state. Tests use this; nothing in the route does. */
  reset(): void;
  /** Number of keys currently tracked. Exposed for tests and eviction assertions. */
  size(): number;
}

/**
 * Sliding-window limiter over per-key hit timestamps.
 *
 * Sliding rather than fixed-window because a fixed window lets a caller send `max` at
 * 11:59:59 and `max` again at 12:00:00 — double the intended burst, exactly at the moment a
 * flood is trying to get through.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────
 * THE AUDIT'S CAVEAT, RECORDED HONESTLY: this state lives in one process's memory. On
 * serverless it is per-instance and per-cold-start, so the effective limit is (rules x
 * instances) and any deploy or scale event resets it to zero. A distributed attacker spread
 * across IPs is not slowed by a per-IP key at all.
 *
 * This is a TRIPWIRE, NOT A WALL. It stops a single script hammering the endpoint — the
 * realistic threat to a small agency site, and the one that would otherwise fill the table and
 * the inbox. It does not stop a determined or distributed attacker, and it is not claimed to.
 *
 * A durable store (Upstash Redis, Vercel KV, or the platform WAF's own rate limiting) is what
 * makes this a wall. That is a launch-infra decision with cost and vendor implications, and it
 * is DELIBERATELY NOT TAKEN HERE: shipping an in-process tripwire now is strictly better than
 * the nothing that was there before, and it does not prejudge the infra choice.
 * ────────────────────────────────────────────────────────────────────────────────────────────
 */
export function createRateLimiter(
  rules: readonly RateLimitRule[] = SUBMISSION_RATE_RULES,
  maxKeys = 10_000
): RateLimiter {
  const hits = new Map<string, number[]>();
  const longestWindowMs = rules.reduce((longest, rule) => Math.max(longest, rule.windowMs), 0);

  /** Drop keys whose every timestamp has aged out. Opportunistic — this is not a cache. */
  function evictStale(now: number): void {
    for (const [key, stamps] of hits) {
      if (stamps.every(stamp => now - stamp >= longestWindowMs)) hits.delete(key);
    }
  }

  return {
    check(key: string, now: number = Date.now()): RateLimitVerdict {
      if (hits.size > maxKeys) evictStale(now);

      const previous = hits.get(key) ?? [];
      const live = previous.filter(stamp => now - stamp < longestWindowMs);

      for (const rule of rules) {
        const inWindow = live.filter(stamp => now - stamp < rule.windowMs);
        if (inWindow.length >= rule.max) {
          // Write back the pruned list so a key that stops being hit still ages out.
          hits.set(key, live);
          const oldest = Math.min(...inWindow);
          const msRemaining = rule.windowMs - (now - oldest);
          return {
            allowed: false,
            rule,
            // A refused request is NOT recorded. Recording it would keep refilling the window,
            // so a caller that kept retrying could never come back — a self-extending ban,
            // which is not what "5 per minute" says.
            retryAfterSeconds: Math.max(1, Math.ceil(msRemaining / 1000)),
          };
        }
      }

      live.push(now);
      hits.set(key, live);
      return { allowed: true };
    },

    reset(): void {
      hits.clear();
    },

    size(): number {
      return hits.size;
    },
  };
}

/** Greppable marker for rate-limited submissions. */
export const FORM_RATE_LIMITED = 'FORM_RATE_LIMITED';

/** Trace for a rate-limited submission. No payload — it was never read. */
export function formatRateLimitRejection(input: {
  ip: string;
  rule: RateLimitRule;
  retryAfterSeconds: number;
}): string {
  return `${FORM_RATE_LIMITED} ${JSON.stringify({
    event: 'form_submission_rate_limited',
    ip: input.ip,
    rule: input.rule.label,
    retry_after_seconds: input.retryAfterSeconds,
    rejected_at: new Date().toISOString(),
  })}`;
}

/**
 * The limiter the route uses. Module-scoped so it survives between requests within one process
 * — which is exactly as far as it survives, per the caveat above.
 */
export const submissionRateLimiter: RateLimiter = createRateLimiter();
