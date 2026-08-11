import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAttribution,
  buildSubmissionMetadata,
  formatLeadWriteFailure,
  LEAD_WRITE_FAILED,
} from './form-attribution';

/** A realistic attribution blob as the capture module serialises it (lead-attribution.md). */
const JOURNEY = {
  first_touch: { source: 'linkedin', medium: 'social', landing_page: '/services/web-app-development' },
  last_touch: { source: 'google', medium: 'organic' },
  referrer: 'https://www.linkedin.com/',
  journey: ['/services/web-app-development', '/work', '/services/design-branding', '/contact'],
  ga_client_id: 'GA1.1.123.456',
};

describe('parseAttribution', () => {
  test('parses the serialised JSON the hidden field submits', () => {
    const { attribution, error } = parseAttribution(JSON.stringify(JOURNEY));
    assert.equal(error, undefined);
    assert.deepEqual(attribution, JOURNEY);
    // the point of parsing: the journey stays ordered and queryable
    assert.deepEqual((attribution as typeof JOURNEY).journey, JOURNEY.journey);
  });

  test('accepts an object that was already parsed', () => {
    assert.deepEqual(parseAttribution(JOURNEY).attribution, JOURNEY);
  });

  test('absent or empty attribution is not an error — plenty of forms have none', () => {
    for (const v of [undefined, null, '']) {
      const { attribution, error } = parseAttribution(v);
      assert.equal(attribution, null);
      assert.equal(error, undefined);
    }
  });

  test('malformed JSON degrades instead of throwing', () => {
    // A broken attribution blob must never cost us the lead itself.
    const { attribution, error } = parseAttribution('{"journey":[oops');
    assert.equal(attribution, null);
    assert.ok(error);
  });

  test('valid JSON that is not an object is rejected', () => {
    for (const v of ['"a string"', '42', '[1,2,3]']) {
      const { attribution, error } = parseAttribution(v);
      assert.equal(attribution, null, `value ${v}`);
      assert.ok(error, `value ${v}`);
    }
  });
});

describe('buildSubmissionMetadata', () => {
  const base = {
    clientMetadata: { page_url: 'http://localhost:3002/contact' },
    payload: { name: 'A', attribution: JSON.stringify(JOURNEY) },
    userAgent: 'Mozilla/5.0',
    referrer: 'https://www.linkedin.com/',
    submittedAt: '2026-08-11T21:00:00.000Z',
  };

  test('captures everything the acceptance criteria ask for', () => {
    const m = buildSubmissionMetadata(base);
    assert.equal(m.page_url, 'http://localhost:3002/contact');   // the page they submitted on
    assert.equal(m.referrer, 'https://www.linkedin.com/');       // where they came from
    assert.equal(m.user_agent, 'Mozilla/5.0');
    assert.equal(m.submitted_at, '2026-08-11T21:00:00.000Z');
    const a = m.attribution as typeof JOURNEY;
    assert.deepEqual(a.journey, JOURNEY.journey);                // the journey, in order
    assert.equal(a.first_touch.source, 'linkedin');              // first-touch source
  });

  test('REGRESSION: server-derived fields are captured even though the client sends metadata', () => {
    // The bug this replaced: `body.metadata || {…}` meant the fallback never ran, because the
    // client always sends { page_url } — so user_agent and referrer were silently never stored.
    const m = buildSubmissionMetadata(base);
    assert.equal(m.user_agent, 'Mozilla/5.0');
    assert.equal(m.referrer, 'https://www.linkedin.com/');
  });

  test('server-derived referrer wins over a client-supplied one', () => {
    const m = buildSubmissionMetadata({
      ...base,
      clientMetadata: { page_url: '/contact', referrer: 'https://evil.example/' },
    });
    assert.equal(m.referrer, 'https://www.linkedin.com/');
  });

  test('a submission with no attribution still stores cleanly', () => {
    const m = buildSubmissionMetadata({ ...base, payload: { name: 'A' } });
    assert.equal(m.attribution, null);
    assert.equal(m.attribution_parse_error, undefined);
    assert.equal(m.page_url, 'http://localhost:3002/contact');
  });

  test('unparseable attribution is flagged but the rest of the metadata survives', () => {
    const m = buildSubmissionMetadata({ ...base, payload: { name: 'A', attribution: '{broken' } });
    assert.equal(m.attribution, null);
    assert.ok(m.attribution_parse_error);
    assert.equal(m.page_url, 'http://localhost:3002/contact');
  });

  test('missing or malformed client metadata does not throw', () => {
    for (const v of [undefined, null, 'nonsense', 42, []]) {
      const m = buildSubmissionMetadata({ ...base, clientMetadata: v });
      assert.equal(m.user_agent, 'Mozilla/5.0', `clientMetadata ${JSON.stringify(v)}`);
    }
  });
});

describe('formatLeadWriteFailure', () => {
  test('emits a greppable marker with everything needed to recover the lead by hand', () => {
    const line = formatLeadWriteFailure({
      formId: 'contact',
      payload: { name: 'A', email: 'a@example.com' },
      metadata: { page_url: '/contact' },
      error: new Error('connection refused'),
    });
    assert.ok(line.startsWith(LEAD_WRITE_FAILED));
    const json = JSON.parse(line.slice(LEAD_WRITE_FAILED.length + 1));
    assert.equal(json.form_id, 'contact');
    assert.equal(json.payload.email, 'a@example.com');   // recoverable
    assert.equal(json.error, 'connection refused');      // diagnosable
    assert.ok(json.failed_at);
  });

  test('a non-Error rejection is still recorded', () => {
    const line = formatLeadWriteFailure({ formId: 'f', payload: {}, metadata: {}, error: 'timeout' });
    assert.equal(JSON.parse(line.slice(LEAD_WRITE_FAILED.length + 1)).error, 'timeout');
  });
});
