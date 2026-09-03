/**
 * Route-level cover for the form endpoint's abuse controls (audit finding H5).
 *
 * These drive the REAL POST handler with the real controls, faking only the stores — the same
 * shape as lib/services/form-email-config.test.ts. The point is the whole path: an abusive
 * request must not reach storage, the mailer, the webhook or the integrations, and a legitimate
 * one must still be stored and notified exactly as before.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import {
  MAX_SUBMISSION_BYTES,
  HONEYPOT_FIELD,
  byteLengthOf,
  submissionRateLimiter,
  FORM_SPAM_REJECTED,
  FORM_BODY_TOO_LARGE,
  FORM_RATE_LIMITED,
} from '@/lib/form-abuse-controls';
import type { Layer } from '@/types';

// `server-only` throws on import; pre-seed require.cache so the route's graph loads.
const serverOnlyPath = require.resolve('server-only');
require.cache[serverOnlyPath] = {
  id: serverOnlyPath,
  filename: serverOnlyPath,
  loaded: true,
  exports: {},
} as unknown as NodeModule;

// These are require()d, not imported, on purpose: the tests swap these modules' exports for
// fakes, and an ESM import binding is read-only — reassigning one is a TypeError. This is the
// same harness lib/services/form-email-config.test.ts uses.
/* eslint-disable @typescript-eslint/no-require-imports */
const repo = require('@/lib/repositories/formSubmissionRepository');
const pageLayersRepo = require('@/lib/repositories/pageLayersRepository');
const componentRepo = require('@/lib/repositories/componentRepository');
const emailService = require('@/lib/services/emailService');
const webhookService = require('@/lib/services/webhookService');
const integrationService = require('@/lib/apps/integration-service');
const serverConfig = require('@/lib/services/form-email-config.server');
const route = require('@/app/(builder)/ycode/api/form-submissions/route');
/* eslint-enable @typescript-eslint/no-require-imports */

const STORED_RECIPIENT = 'hello@scalability.us';
const STORED_SUBJECT = 'New lead from scalability.us';

interface SendCall { to: string; subject: string }

function contactFormLayer(): Layer {
  return {
    id: 'layer_contact_form',
    name: 'form',
    settings: {
      id: 'contact-form',
      tag: 'form',
      form: {
        email_notification: { enabled: true, to: STORED_RECIPIENT, subject: STORED_SUBJECT },
      },
    },
    children: [],
  } as unknown as Layer;
}

function pageLayers(): Layer[] {
  return [
    {
      id: 'body',
      name: 'body',
      children: [{ id: 'section', name: 'section', children: [contactFormLayer()] } as unknown as Layer],
    } as unknown as Layer,
  ];
}

/** Let the route's fire-and-forget notification settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
}

function post(rawBody: string, headers: Record<string, string> = {}): Promise<Response> {
  return route.POST(
    new Request('http://localhost:3002/ycode/api/form-submissions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: rawBody,
    })
  );
}

function legitimateBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    form_id: 'contact-form',
    payload: {
      name: 'Jane Doe',
      email: 'jane@example.com',
      company: 'Example Co',
      message: 'We are looking for a brand refresh.',
      ...overrides,
    },
    metadata: { page_url: 'http://localhost:3002/contact' },
  });
}

/** A body of EXACTLY n bytes, still valid JSON the route accepts. */
function bodyOfExactly(bytes: number): string {
  const base = JSON.parse(legitimateBody());
  base.payload.message = '';
  const overhead = byteLengthOf(JSON.stringify(base));
  base.payload.message = 'x'.repeat(bytes - overhead);
  const body = JSON.stringify(base);
  assert.equal(byteLengthOf(body), bytes, 'fixture must be exactly the requested size');
  return body;
}

describe('POST /ycode/api/form-submissions — abuse controls', () => {
  let sendCalls: SendCall[];
  let created: unknown[];
  let webhookCalls: number;
  let integrationCalls: number;
  let logs: string[];
  let originalError: typeof console.error;
  let originalWarn: typeof console.warn;

  beforeEach(() => {
    sendCalls = [];
    created = [];
    webhookCalls = 0;
    integrationCalls = 0;
    logs = [];

    // The limiter is a module singleton shared with the route; without this the suite would
    // rate-limit itself after five posts.
    submissionRateLimiter.reset();
    serverConfig.clearFormLayerTreeCache();

    repo.createFormSubmission = async (data: unknown) => {
      created.push(data);
      return { id: 'sub_42', created_at: '2026-09-03T00:00:00Z' };
    };
    webhookService.dispatchFormSubmittedEvent = () => { webhookCalls++; };
    integrationService.processAppIntegrations = () => { integrationCalls++; };
    componentRepo.getAllComponents = async () => [];
    pageLayersRepo.getAllPublishedLayers = async () => [{ page_id: 'p1', layers: pageLayers() }];
    pageLayersRepo.getAllDraftLayers = async () => [];
    emailService.sendFormSubmissionEmail = async (to: string, subject: string) => {
      sendCalls.push({ to, subject });
      return true;
    };

    originalError = console.error;
    originalWarn = console.warn;
    console.error = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    console.warn = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  });

  afterEach(() => {
    console.error = originalError;
    console.warn = originalWarn;
    submissionRateLimiter.reset();
    serverConfig.clearFormLayerTreeCache();
  });

  // -------------------------------------------------------------------------
  // The invariant: none of this may cost a real lead.
  // -------------------------------------------------------------------------

  describe('the legitimate path is untouched', () => {
    test('a normal submission is still 201, stored and notified', async () => {
      const response = await post(legitimateBody());
      const body = await response.json();
      await flush();

      assert.equal(response.status, 201);
      assert.equal(body.data.id, 'sub_42');
      assert.equal(created.length, 1, 'the lead is stored');
      assert.equal(sendCalls.length, 1, 'the notification still goes out');
      assert.equal(sendCalls[0].to, STORED_RECIPIENT);
      assert.equal(webhookCalls, 1);
      assert.equal(integrationCalls, 1);
    });

    test('an empty honeypot field — what a real browser submits — is accepted', async () => {
      const response = await post(legitimateBody({ [HONEYPOT_FIELD]: '' }));
      await flush();

      assert.equal(response.status, 201);
      assert.equal(created.length, 1, 'a rendered-but-empty honeypot must never cost a lead');
      assert.equal(sendCalls.length, 1);
    });

    test('a body of exactly the cap is accepted', async () => {
      const response = await post(bodyOfExactly(MAX_SUBMISSION_BYTES));
      await flush();

      assert.equal(response.status, 201, 'the boundary belongs to the visitor');
      assert.equal(created.length, 1);
    });

    test('four submissions in a row all get through', async () => {
      for (let i = 0; i < 4; i++) {
        assert.equal((await post(legitimateBody())).status, 201, `submission ${i + 1}`);
      }
      await flush();
      assert.equal(created.length, 4);
    });
  });

  // -------------------------------------------------------------------------
  // Size cap
  // -------------------------------------------------------------------------

  describe('size cap', () => {
    test('a body one byte over the cap is refused with 413', async () => {
      const response = await post(bodyOfExactly(MAX_SUBMISSION_BYTES + 1));

      assert.equal(response.status, 413);
      assert.equal(created.length, 0, 'nothing oversized reaches storage');
      assert.equal(sendCalls.length, 0, 'nothing oversized reaches the mailer');
      assert.equal(webhookCalls, 0);
      assert.equal(integrationCalls, 0);
    });

    test('a large body is refused even with NO content-length header', async () => {
      // undici does not set content-length on a Request, so this exercises the path where the
      // header is absent entirely — the body itself has to be measured.
      const response = await post(bodyOfExactly(MAX_SUBMISSION_BYTES * 4));

      assert.equal(response.status, 413);
      assert.equal(created.length, 0);
      const trace = logs.find(l => l.includes(FORM_BODY_TOO_LARGE));
      assert.ok(trace, `expected an oversize trace, got: ${JSON.stringify(logs)}`);
      assert.ok(trace.includes('"measured_from":"body"'), 'the body path must be what caught it');
    });

    test('a huge declared content-length is refused before the body is read', async () => {
      const response = await post(legitimateBody(), {
        'content-length': String(500 * 1024 * 1024),
      });

      assert.equal(response.status, 413);
      assert.equal(created.length, 0);
      const trace = logs.find(l => l.includes(FORM_BODY_TOO_LARGE));
      assert.ok(trace?.includes('"measured_from":"content-length"'), 'the header check must fire');
    });

    test('a LYING content-length does not smuggle an oversized body through', async () => {
      const response = await post(bodyOfExactly(MAX_SUBMISSION_BYTES * 2), {
        'content-length': '42',
      });

      assert.equal(response.status, 413, 'the header is a claim; the body is the fact');
      assert.equal(created.length, 0);
    });

    test('multi-byte padding does not buy extra budget', async () => {
      const base = JSON.parse(legitimateBody());
      base.payload.message = '日'.repeat(15_000); // 45KB of bytes, 15k characters
      const body = JSON.stringify(base);
      assert.ok(body.length < MAX_SUBMISSION_BYTES, 'fixture is under the cap by CHARACTER count');

      const response = await post(body);

      assert.equal(response.status, 413, 'the cap must be measured in bytes');
      assert.equal(created.length, 0);
    });

    test('the 413 response does not echo the submitted body back', async () => {
      const response = await post(bodyOfExactly(MAX_SUBMISSION_BYTES + 1));
      const text = await response.text();
      assert.ok(!text.includes('xxxx'), 'the refusal must not reflect the payload');
    });
  });

  // -------------------------------------------------------------------------
  // Honeypot
  // -------------------------------------------------------------------------

  describe('honeypot', () => {
    test('a filled honeypot gets 201 but is NOT stored and NOT notified', async () => {
      const response = await post(legitimateBody({ [HONEYPOT_FIELD]: 'https://spam.example' }));
      const body = await response.json();
      await flush();

      assert.equal(response.status, 201, 'the bot must not learn that it was caught');
      assert.equal(body.message, 'Form submitted successfully');
      assert.equal(body.data, null);

      assert.equal(created.length, 0, 'spam must not be stored');
      assert.equal(sendCalls.length, 0, 'spam must not be emailed');
      assert.equal(webhookCalls, 0, 'spam must not fire the webhook');
      assert.equal(integrationCalls, 0, 'spam must not reach app integrations');
    });

    test('the spam trace is structured and keeps the payload', async () => {
      await post(legitimateBody({ [HONEYPOT_FIELD]: 'https://spam.example' }));
      await flush();

      const trace = logs.find(l => l.includes(FORM_SPAM_REJECTED));
      assert.ok(trace, `expected a spam trace, got: ${JSON.stringify(logs)}`);
      const record = JSON.parse(trace.slice(trace.indexOf(FORM_SPAM_REJECTED) + FORM_SPAM_REJECTED.length + 1));
      assert.equal(record.event, 'form_submission_honeypot_tripped');
      assert.equal(record.form_id, 'contact-form');
      assert.equal(record.honeypot_field, HONEYPOT_FIELD);
      assert.equal(record.payload.email, 'jane@example.com', 'a false positive must be recoverable');
    });

    test('the spam 201 is indistinguishable from the write-failure 201', async () => {
      // The route already answers 201 {data:null} when storage fails. Reusing exactly that
      // shape means the honeypot adds no new signal for a bot to detect.
      repo.createFormSubmission = async () => { throw new Error('db down'); };
      const writeFailure = await post(legitimateBody());
      const failureBody = await writeFailure.json();

      submissionRateLimiter.reset();
      repo.createFormSubmission = async (data: unknown) => {
        created.push(data);
        return { id: 'sub_42', created_at: '2026-09-03T00:00:00Z' };
      };
      const spam = await post(legitimateBody({ [HONEYPOT_FIELD]: 'spam' }));
      const spamBody = await spam.json();

      assert.equal(spam.status, writeFailure.status);
      assert.deepEqual(spamBody, failureBody);
    });
  });

  // -------------------------------------------------------------------------
  // Rate limit
  // -------------------------------------------------------------------------

  describe('rate limit', () => {
    const flooder = { 'x-forwarded-for': '203.0.113.99' };

    test('the sixth submission in a minute is refused with 429', async () => {
      for (let i = 0; i < 5; i++) {
        assert.equal((await post(legitimateBody(), flooder)).status, 201, `submission ${i + 1}`);
      }
      await flush();

      const sixth = await post(legitimateBody(), flooder);

      assert.equal(sixth.status, 429);
      assert.equal(created.length, 5, 'the refused submission is not stored');
      assert.equal(sendCalls.length, 5, 'the refused submission is not emailed');
    });

    test('the 429 carries a Retry-After header', async () => {
      for (let i = 0; i < 5; i++) await post(legitimateBody(), flooder);
      const sixth = await post(legitimateBody(), flooder);

      const retryAfter = sixth.headers.get('retry-after');
      assert.ok(retryAfter, 'a 429 without Retry-After tells the caller nothing');
      const seconds = Number(retryAfter);
      assert.ok(seconds >= 1 && seconds <= 60, `Retry-After should be within the window, got ${retryAfter}`);
    });

    test('the refusal is traced', async () => {
      for (let i = 0; i < 6; i++) await post(legitimateBody(), flooder);
      const trace = logs.find(l => l.includes(FORM_RATE_LIMITED));
      assert.ok(trace, `expected a rate-limit trace, got: ${JSON.stringify(logs)}`);
      assert.ok(trace.includes('203.0.113.99'), 'the trace names the caller');
      assert.ok(trace.includes('5/min'), 'the trace names the rule');
    });

    test('one flooder does not lock out a different visitor', async () => {
      for (let i = 0; i < 6; i++) await post(legitimateBody(), flooder);

      const other = await post(legitimateBody(), { 'x-forwarded-for': '198.51.100.4' });
      await flush();

      assert.equal(other.status, 201, 'a real visitor must not pay for someone else flooding');
    });

    test('the platform header, not the forgeable one, decides the key', async () => {
      // A flooder rotating x-forwarded-for behind a platform that sets its own header must
      // still land in one bucket.
      for (let i = 0; i < 5; i++) {
        await post(legitimateBody(), {
          'x-vercel-forwarded-for': '203.0.113.50',
          'x-forwarded-for': `10.0.0.${i}`,
        });
      }

      const sixth = await post(legitimateBody(), {
        'x-vercel-forwarded-for': '203.0.113.50',
        'x-forwarded-for': '10.0.0.99',
      });

      assert.equal(sixth.status, 429, 'rotating a spoofable header must not reset the budget');
    });

    test('oversized floods still count against the flooder', async () => {
      // Refusing for size without counting the attempt would make a flood free.
      for (let i = 0; i < 5; i++) {
        assert.equal((await post(bodyOfExactly(MAX_SUBMISSION_BYTES + 1), flooder)).status, 413);
      }

      const next = await post(legitimateBody(), flooder);
      assert.equal(next.status, 429, 'the size check must sit behind the rate limiter, not ahead of it');
    });
  });
});
