/**
 * Cover for the public form endpoint's abuse controls (audit finding H5).
 *
 * Before this, `POST /ycode/api/form-submissions` had no rate limit, no size cap and no
 * honeypot handling, behind a 500mb proxy body ceiling. These tests pin each control at its
 * boundary, and pin the two ways each control can be broken WITHOUT any test noticing:
 * a cap so low it rejects real leads, and a honeypot so eager it eats them.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  MAX_SUBMISSION_BYTES,
  HONEYPOT_FIELD,
  SUBMISSION_RATE_RULES,
  UNKNOWN_IP,
  byteLengthOf,
  clientIpFrom,
  createRateLimiter,
  declaredBodyBytes,
  exceedsSizeCap,
  formatHoneypotRejection,
  formatOversizeRejection,
  formatRateLimitRejection,
  isHoneypotTripped,
  FORM_SPAM_REJECTED,
  FORM_BODY_TOO_LARGE,
  FORM_RATE_LIMITED,
} from '@/lib/form-abuse-controls';

// ---------------------------------------------------------------------------
// Fixtures drawn from the four submissions actually stored on 2026-08-12/13.
// ---------------------------------------------------------------------------

/** Payload keys of every real submission in the database. */
const REAL_PAYLOAD_KEYS = ['name', 'email', 'budget', 'company', 'message', 'attribution'];

/** Byte size of the largest whole POST body ever received (measured, see MAX_SUBMISSION_BYTES). */
const LARGEST_REAL_BODY_BYTES = 1845;

/**
 * The worst case a LEGITIMATE submission could reach: a full 30-entry journey (the capture
 * module's cap), both touch records with query strings, every click ID, and a long message
 * from a serious prospect.
 */
function worstCaseLegitimateBody(): string {
  const journey = Array.from({ length: 30 }, (_, i) => ({
    p: `/services/design-branding-services-for-startups-${i}`,
    t: '2026-08-13T15:07:08.834Z',
  }));
  const touch = {
    landing: '/insights/what-a-brand-system-actually-buys-you',
    query: '?utm_source=linkedin&utm_medium=social&utm_campaign=founders-july&utm_content=carousel-3&utm_term=brand+system',
    referrer: 'https://www.linkedin.com/feed/update/urn:li:activity:7212345678901234567/',
    ts: '2026-07-14T09:12:44.001Z',
    utm_source: 'linkedin',
    utm_medium: 'social',
    utm_campaign: 'founders-july',
  };
  return JSON.stringify({
    form_id: 'contact-form',
    payload: {
      name: 'Alexandra Constantinopoulos-Fitzwilliam',
      email: 'alexandra.constantinopoulos@a-rather-long-company-domain.example',
      company: 'A Rather Long Company Name Holdings International',
      budget: '$50k-100k',
      message: 'x'.repeat(4000),
      attribution: JSON.stringify({
        submittedFrom: '/contact',
        first: touch,
        last: touch,
        firstSeen: '2026-07-14',
        visits: 7,
        journey,
        secondsOnPage: 412,
        gaClientId: '1234567890.1712345678',
        device: { vw: 1440, vh: 900, tz: 'America/New_York', lang: 'en-US' },
        clickIds: {
          gclid: 'Cj0KCQjw1um3BhDtARIsABjU5x6' + 'a'.repeat(60),
          fbclid: 'IwAR2' + 'b'.repeat(60),
          msclkid: 'c'.repeat(32),
          li_fat_id: 'd'.repeat(36),
          ttclid: 'e'.repeat(60),
        },
      }),
    },
    metadata: { page_url: 'http://localhost:3002/contact' },
  });
}

// ---------------------------------------------------------------------------
// Size cap
// ---------------------------------------------------------------------------

describe('size cap — the limit itself', () => {
  test('POPULATION LAW: the cap clears the largest submission ever actually received', () => {
    // If someone tunes the cap down to "tighter is safer", this fails before real leads do.
    assert.ok(
      MAX_SUBMISSION_BYTES > LARGEST_REAL_BODY_BYTES * 4,
      `cap ${MAX_SUBMISSION_BYTES} must leave room over the largest real body (${LARGEST_REAL_BODY_BYTES})`
    );
  });

  test('a worst-case LEGITIMATE submission fits under the cap', () => {
    const body = worstCaseLegitimateBody();
    const bytes = byteLengthOf(body);

    // Sanity: the fixture must actually be big, or this assertion passes vacuously.
    assert.ok(bytes > 8000, `worst-case fixture should be several KB, got ${bytes}`);
    assert.equal(
      exceedsSizeCap(bytes),
      false,
      `a real prospect writing 4000 characters with a full journey (${bytes} bytes) must be accepted`
    );
  });

  test('the cap is far below the 500mb the proxy would otherwise allow', () => {
    assert.ok(MAX_SUBMISSION_BYTES < 1024 * 1024, 'cap must be well under a megabyte');
  });
});

describe('size cap — exceedsSizeCap boundary', () => {
  test('exactly at the cap is ACCEPTED', () => {
    assert.equal(exceedsSizeCap(MAX_SUBMISSION_BYTES), false);
  });

  test('one byte over the cap is REJECTED', () => {
    assert.equal(exceedsSizeCap(MAX_SUBMISSION_BYTES + 1), true);
  });

  test('an ordinary submission is accepted', () => {
    assert.equal(exceedsSizeCap(LARGEST_REAL_BODY_BYTES), false);
  });

  test('a megabyte of junk is rejected', () => {
    assert.equal(exceedsSizeCap(1024 * 1024), true);
  });
});

describe('size cap — measurement is in BYTES, not characters', () => {
  test('multi-byte characters count for what they cost', () => {
    assert.equal(byteLengthOf('abc'), 3);
    assert.equal(byteLengthOf('é'), 2);
    assert.equal(byteLengthOf('日'), 3);
    assert.equal(byteLengthOf('🙂'), 4);
  });

  test('a body under the cap by character count but over it by bytes is rejected', () => {
    // 3 bytes each: 20k characters is under a 32k character count but ~60KB on the wire.
    const padded = '日'.repeat(20_000);
    assert.ok(padded.length < MAX_SUBMISSION_BYTES, 'fixture must be short by CHARACTER count');
    assert.equal(
      exceedsSizeCap(byteLengthOf(padded)),
      true,
      'measuring string length instead of byte length would hand an attacker 3x the budget'
    );
  });
});

describe('size cap — content-length header', () => {
  function headers(init: Record<string, string>): Headers {
    return new Headers(init);
  }

  test('a well-formed content-length is read', () => {
    assert.equal(declaredBodyBytes(headers({ 'content-length': '1845' })), 1845);
  });

  test('surrounding whitespace is tolerated', () => {
    assert.equal(declaredBodyBytes(headers({ 'content-length': ' 42 ' })), 42);
  });

  test('an absent header reads as unknown, not as zero', () => {
    // Zero would silently pass the cap check; unknown forces the body measurement instead.
    assert.equal(declaredBodyBytes(headers({})), null);
  });

  test('a garbage header reads as unknown', () => {
    assert.equal(declaredBodyBytes(headers({ 'content-length': 'lots' })), null);
    assert.equal(declaredBodyBytes(headers({ 'content-length': '12.5' })), null);
    assert.equal(declaredBodyBytes(headers({ 'content-length': '-1' })), null);
  });

  test('a huge declared length is caught before the body is read', () => {
    const declared = declaredBodyBytes(headers({ 'content-length': String(500 * 1024 * 1024) }));
    assert.equal(declared, 500 * 1024 * 1024);
    assert.equal(exceedsSizeCap(declared as number), true);
  });
});

describe('size cap — rejection trace', () => {
  test('the trace names the marker, the size and the limit, and omits the body', () => {
    const trace = formatOversizeRejection({
      formId: 'contact-form',
      bytes: 900_000,
      source: 'content-length',
      ip: '203.0.113.9',
    });

    assert.ok(trace.startsWith(FORM_BODY_TOO_LARGE), 'trace must be greppable');
    const record = JSON.parse(trace.slice(FORM_BODY_TOO_LARGE.length + 1));
    assert.equal(record.event, 'form_submission_too_large');
    assert.equal(record.bytes, 900_000);
    assert.equal(record.limit, MAX_SUBMISSION_BYTES);
    assert.equal(record.measured_from, 'content-length');
    assert.equal(record.ip, '203.0.113.9');
  });
});

// ---------------------------------------------------------------------------
// Honeypot
// ---------------------------------------------------------------------------

describe('honeypot — what does NOT trip it', () => {
  test('POPULATION LAW: no real stored submission carries the honeypot field', () => {
    // The four real payloads use these keys. If the honeypot name ever collides with one of
    // them, every submission to that form would be binned in silence.
    assert.ok(
      !REAL_PAYLOAD_KEYS.includes(HONEYPOT_FIELD),
      `honeypot field "${HONEYPOT_FIELD}" collides with a real payload field`
    );
  });

  test('a real submission payload does not trip it', () => {
    const payload = {
      name: 'Jane Doe',
      email: 'jane@example.com',
      company: 'Example Co',
      message: 'We are looking for a brand refresh.',
      attribution: '{"submittedFrom":"/contact"}',
    };
    assert.equal(isHoneypotTripped(payload), false);
  });

  test('the field rendered but left empty does not trip it', () => {
    // This is what EVERY legitimate browser submission looks like once the markup lands:
    // browsers submit empty inputs. Treating presence as guilt would reject every real lead.
    assert.equal(isHoneypotTripped({ [HONEYPOT_FIELD]: '' }), false);
  });

  test('whitespace only does not trip it', () => {
    assert.equal(isHoneypotTripped({ [HONEYPOT_FIELD]: '   ' }), false);
    assert.equal(isHoneypotTripped({ [HONEYPOT_FIELD]: '\n\t ' }), false);
  });

  test('null, undefined, false and zero do not trip it', () => {
    assert.equal(isHoneypotTripped({ [HONEYPOT_FIELD]: null }), false);
    assert.equal(isHoneypotTripped({ [HONEYPOT_FIELD]: undefined }), false);
    assert.equal(isHoneypotTripped({ [HONEYPOT_FIELD]: false }), false);
    assert.equal(isHoneypotTripped({ [HONEYPOT_FIELD]: 0 }), false);
  });

  test('a non-object payload does not trip it', () => {
    assert.equal(isHoneypotTripped(undefined), false);
    assert.equal(isHoneypotTripped(null), false);
    assert.equal(isHoneypotTripped('a string'), false);
    assert.equal(isHoneypotTripped([1, 2, 3]), false);
  });
});

describe('honeypot — what DOES trip it', () => {
  test('a filled-in value trips it', () => {
    assert.equal(isHoneypotTripped({ [HONEYPOT_FIELD]: 'http://spam.example' }), true);
  });

  test('padded content still trips it', () => {
    assert.equal(isHoneypotTripped({ [HONEYPOT_FIELD]: '  spam  ' }), true);
  });

  test('a bot filling every field trips it', () => {
    const payload = {
      name: 'BotName',
      email: 'bot@spam.example',
      message: 'buy cheap backlinks',
      [HONEYPOT_FIELD]: 'https://cheap-backlinks.example',
    };
    assert.equal(isHoneypotTripped(payload), true);
  });

  test('non-string truthy values trip it', () => {
    assert.equal(isHoneypotTripped({ [HONEYPOT_FIELD]: true }), true);
    assert.equal(isHoneypotTripped({ [HONEYPOT_FIELD]: 1 }), true);
    assert.equal(isHoneypotTripped({ [HONEYPOT_FIELD]: ['x'] }), true);
    assert.equal(isHoneypotTripped({ [HONEYPOT_FIELD]: { a: 1 } }), true);
  });

  test('the field name is configurable and only that field is watched', () => {
    assert.equal(isHoneypotTripped({ trap: 'x' }, 'trap'), true);
    assert.equal(isHoneypotTripped({ trap: 'x' }, 'other'), false);
    assert.equal(isHoneypotTripped({ message: 'a real message' }, 'trap'), false);
  });
});

describe('honeypot — rejection trace', () => {
  test('the trace keeps the payload so a false positive is recoverable', () => {
    const payload = { name: 'Jane', email: 'jane@example.com', [HONEYPOT_FIELD]: 'spam' };
    const trace = formatHoneypotRejection({
      formId: 'contact-form',
      field: HONEYPOT_FIELD,
      payload,
      ip: '203.0.113.9',
    });

    assert.ok(trace.startsWith(FORM_SPAM_REJECTED), 'trace must be greppable');
    const record = JSON.parse(trace.slice(FORM_SPAM_REJECTED.length + 1));
    assert.equal(record.event, 'form_submission_honeypot_tripped');
    assert.equal(record.form_id, 'contact-form');
    assert.equal(record.honeypot_field, HONEYPOT_FIELD);
    assert.deepEqual(record.payload, payload, 'the dropped lead must be reconstructable');
    assert.equal(record.ip, '203.0.113.9');
  });
});

// ---------------------------------------------------------------------------
// Rate limit
// ---------------------------------------------------------------------------

describe('rate limit — the configured rules', () => {
  test('the shipped rules are 5/min and 20/hour', () => {
    assert.deepEqual(
      SUBMISSION_RATE_RULES.map(r => [r.max, r.windowMs]),
      [[5, 60_000], [20, 3_600_000]]
    );
  });

  test('one person submitting once is never affected', () => {
    const limiter = createRateLimiter();
    assert.equal(limiter.check('203.0.113.1').allowed, true);
  });
});

describe('rate limit — per-minute window', () => {
  test('five in a minute pass and the sixth is refused', () => {
    const limiter = createRateLimiter();
    const t0 = 1_000_000;

    for (let i = 0; i < 5; i++) {
      assert.equal(limiter.check('ip-a', t0 + i * 100).allowed, true, `request ${i + 1} of 5`);
    }

    const sixth = limiter.check('ip-a', t0 + 500);
    assert.equal(sixth.allowed, false);
    assert.equal(sixth.rule?.label, '5/min');
    assert.ok(
      sixth.retryAfterSeconds !== undefined &&
        sixth.retryAfterSeconds >= 1 &&
        sixth.retryAfterSeconds <= 60,
      `retry-after should be within the window, got ${sixth.retryAfterSeconds}`
    );
  });

  test('the window slides: once a minute has passed the caller is allowed again', () => {
    const limiter = createRateLimiter();
    const t0 = 1_000_000;

    for (let i = 0; i < 5; i++) limiter.check('ip-a', t0 + i * 100);
    assert.equal(limiter.check('ip-a', t0 + 500).allowed, false);
    assert.equal(limiter.check('ip-a', t0 + 60_001).allowed, true, 'the oldest hit has aged out');
  });

  test('a refused request does not extend the ban', () => {
    const limiter = createRateLimiter();
    const t0 = 1_000_000;

    for (let i = 0; i < 5; i++) limiter.check('ip-a', t0 + i * 100);
    // Hammer throughout the window; none of these may count as new hits.
    for (let t = t0 + 500; t < t0 + 60_000; t += 1000) {
      assert.equal(limiter.check('ip-a', t).allowed, false);
    }
    assert.equal(
      limiter.check('ip-a', t0 + 60_001).allowed,
      true,
      'recording refusals would make this a self-extending ban'
    );
  });
});

describe('rate limit — hourly window', () => {
  test('a slow drip under the per-minute rule is still caught at 20/hour', () => {
    const limiter = createRateLimiter();
    const t0 = 1_000_000;
    const spacing = 61_000; // one per 61s never trips the 5/min rule

    for (let i = 0; i < 20; i++) {
      const verdict = limiter.check('ip-drip', t0 + i * spacing);
      assert.equal(verdict.allowed, true, `drip ${i + 1} of 20 should pass the per-minute rule`);
    }

    const twentyFirst = limiter.check('ip-drip', t0 + 20 * spacing);
    assert.equal(twentyFirst.allowed, false);
    assert.equal(twentyFirst.rule?.label, '20/hour');
  });
});

describe('rate limit — keys and housekeeping', () => {
  test('different IPs do not share a budget', () => {
    const limiter = createRateLimiter();
    const t0 = 1_000_000;

    for (let i = 0; i < 5; i++) limiter.check('ip-a', t0 + i * 100);
    assert.equal(limiter.check('ip-a', t0 + 500).allowed, false);
    assert.equal(limiter.check('ip-b', t0 + 500).allowed, true, 'one flooder must not block others');
  });

  test('reset drops all state', () => {
    const limiter = createRateLimiter();
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) limiter.check('ip-a', t0 + i * 100);

    limiter.reset();

    assert.equal(limiter.size(), 0);
    assert.equal(limiter.check('ip-a', t0 + 500).allowed, true);
  });

  test('stale keys are evicted so the map cannot grow without bound', () => {
    const limiter = createRateLimiter(SUBMISSION_RATE_RULES, 10);
    const t0 = 1_000_000;

    for (let i = 0; i < 12; i++) limiter.check(`ip-${i}`, t0);
    assert.ok(limiter.size() > 10, 'precondition: the map is over the eviction threshold');

    // An hour and change later every one of those keys has aged out.
    limiter.check('ip-new', t0 + 3_600_001);
    assert.ok(limiter.size() < 12, `stale keys should have been evicted, size is ${limiter.size()}`);
  });

  test('the rejection trace names the rule that refused', () => {
    const trace = formatRateLimitRejection({
      ip: '203.0.113.9',
      rule: { windowMs: 60_000, max: 5, label: '5/min' },
      retryAfterSeconds: 47,
    });

    assert.ok(trace.startsWith(FORM_RATE_LIMITED), 'trace must be greppable');
    const record = JSON.parse(trace.slice(FORM_RATE_LIMITED.length + 1));
    assert.equal(record.event, 'form_submission_rate_limited');
    assert.equal(record.rule, '5/min');
    assert.equal(record.retry_after_seconds, 47);
    assert.equal(record.ip, '203.0.113.9');
  });
});

describe('rate limit — client IP', () => {
  function headers(init: Record<string, string>): Headers {
    return new Headers(init);
  }

  test('the platform header wins over a client-supplied one', () => {
    const ip = clientIpFrom(
      headers({
        'x-vercel-forwarded-for': '203.0.113.7',
        'x-forwarded-for': '10.0.0.1, 203.0.113.7',
      })
    );
    assert.equal(ip, '203.0.113.7', 'a forgeable header must never beat the platform header');
  });

  test('the x-forwarded-for FIRST hop is used', () => {
    // Later hops are the proxies, not the caller; keying on them would bucket everyone together.
    assert.equal(clientIpFrom(headers({ 'x-forwarded-for': '203.0.113.7, 70.41.3.18' })), '203.0.113.7');
    assert.equal(clientIpFrom(headers({ 'x-forwarded-for': '  203.0.113.7 , 70.41.3.18' })), '203.0.113.7');
  });

  test('x-real-ip is the last resort before unknown', () => {
    assert.equal(clientIpFrom(headers({ 'x-real-ip': '203.0.113.7' })), '203.0.113.7');
  });

  test('no identifying header at all falls back to a shared bucket, not to a free pass', () => {
    assert.equal(clientIpFrom(headers({})), UNKNOWN_IP);
    assert.equal(clientIpFrom(headers({ 'x-forwarded-for': '' })), UNKNOWN_IP);
    assert.equal(clientIpFrom(headers({ 'x-forwarded-for': '  ,  ' })), UNKNOWN_IP);
  });

  test('the unknown bucket is rate limited like any other key', () => {
    const limiter = createRateLimiter();
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) limiter.check(UNKNOWN_IP, t0 + i * 100);
    assert.equal(
      limiter.check(UNKNOWN_IP, t0 + 500).allowed,
      false,
      'stripping headers must not buy an unlimited lane'
    );
  });
});
