/**
 * Regression cover for the form-submission mail-relay hole (found 2026-08-21 auditing 2c809ff).
 *
 * The route used to hand the CLIENT-POSTED `body.email` object straight to the mailer, so a
 * public POST could name any `to` and any `subject`. These tests drive the REAL route handler
 * with the REAL resolver, faking only the stores, so an assertion here fails if anyone puts the
 * client back in charge of routing.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { getLayerHtmlTag } from '@/lib/layer-utils';
import {
  submissionFormId,
  resolveFormEmailFromTrees,
  notifyFormSubmission,
  resolveStoredFormEmailNotification,
  UNNAMED_FORM_ID,
  type FormLayerTree,
  type ResolvedFormEmail,
} from '@/lib/services/form-email-config';
import type { Layer } from '@/types';

// `server-only` throws on import; pre-seed require.cache so the route's dependency graph loads.
const serverOnlyPath = require.resolve('server-only');
require.cache[serverOnlyPath] = {
  id: serverOnlyPath,
  filename: serverOnlyPath,
  loaded: true,
  exports: {},
} as unknown as NodeModule;

const STORED_RECIPIENT = 'hello@scalability.us';
const STORED_SUBJECT = 'New lead from scalability.us';
const ATTACKER_RECIPIENT = 'attacker@evil.test';

function contactFormLayer(overrides: Partial<Layer['settings']> = {}): Layer {
  return {
    id: 'layer_contact_form',
    name: 'form',
    settings: {
      id: 'contact-form',
      tag: 'form',
      form: {
        email_notification: {
          enabled: true,
          to: STORED_RECIPIENT,
          subject: STORED_SUBJECT,
        },
      },
      ...overrides,
    },
    children: [],
  } as unknown as Layer;
}

/** Wrap the form a couple of levels deep — a real page never has the form at the root. */
function pageTree(form: Layer, label = 'published:page[p1]'): FormLayerTree {
  return {
    label,
    layers: [
      {
        id: 'body',
        name: 'body',
        children: [{ id: 'section', name: 'section', children: [form] } as unknown as Layer],
      } as unknown as Layer,
    ],
  };
}

describe('form email config — fixture sanity (population law)', () => {
  test('the fixture really is a form layer that submits as "contact-form"', () => {
    const form = contactFormLayer();
    // If either of these drifts, every "nothing was sent" assertion below would pass vacuously.
    assert.equal(getLayerHtmlTag(form), 'form');
    assert.equal(submissionFormId(form), 'contact-form');
  });

  test('a form with no settings.id submits under the renderer\'s unnamed-form fallback', () => {
    const form = contactFormLayer({ id: undefined } as never);
    assert.equal(submissionFormId(form), UNNAMED_FORM_ID);
  });

  test('the fixture tree resolves to the stored recipient', () => {
    const resolution = resolveFormEmailFromTrees([pageTree(contactFormLayer())], 'contact-form');
    assert.equal(resolution.outcome, 'send');
    assert.equal(resolution.outcome === 'send' && resolution.to, STORED_RECIPIENT);
  });
});

describe('form email config — resolution rules', () => {
  test('an unknown form id finds nothing', () => {
    const resolution = resolveFormEmailFromTrees([pageTree(contactFormLayer())], 'no-such-form');
    assert.equal(resolution.outcome, 'form-not-found');
  });

  test('a form with notifications switched off does not send', () => {
    const form = contactFormLayer({
      form: { email_notification: { enabled: false, to: STORED_RECIPIENT } },
    } as never);
    assert.equal(resolveFormEmailFromTrees([pageTree(form)], 'contact-form').outcome, 'disabled');
  });

  test('duplicate copies agreeing on the recipient still send (cloned pages share layer ids)', () => {
    const trees = [
      pageTree(contactFormLayer(), 'published:page[p1]'),
      pageTree(contactFormLayer(), 'published:page[p2]'),
    ];
    const resolution = resolveFormEmailFromTrees(trees, 'contact-form');
    assert.equal(resolution.outcome, 'send');
    assert.equal(resolution.outcome === 'send' && resolution.matchedIn.length, 2);
  });

  test('a form with no email_notification key at all reads as unconfigured, not disabled', () => {
    const form = contactFormLayer({ form: {} } as never);
    assert.equal(resolveFormEmailFromTrees([pageTree(form)], 'contact-form').outcome, 'unconfigured');
  });

  test('duplicate copies DISAGREEING on the recipient refuse to send', () => {
    const other = contactFormLayer({
      form: { email_notification: { enabled: true, to: 'someone-else@scalability.us' } },
    } as never);
    const resolution = resolveFormEmailFromTrees(
      [pageTree(contactFormLayer(), 'published:page[p1]'), pageTree(other, 'published:page[p2]')],
      'contact-form'
    );
    assert.equal(resolution.outcome, 'ambiguous');
  });
});

describe('form email config — published vs draft fallback', () => {
  const enabledForm = () => pageTree(contactFormLayer(), 'draft:component[Contact + final CTA]');

  test('a published notification wins over a draft one', async () => {
    const publishedForm = contactFormLayer({
      form: { email_notification: { enabled: true, to: 'published@scalability.us' } },
    } as never);

    const resolved = await resolveStoredFormEmailNotification('contact-form', {
      published: async () => [pageTree(publishedForm)],
      draft: async () => [enabledForm()],
    });

    assert.equal(resolved.source, 'published');
    assert.equal(resolved.resolution.outcome === 'send' && resolved.resolution.to, 'published@scalability.us');
  });

  test('a published notification switched OFF does not fall through to an enabled draft', async () => {
    const off = contactFormLayer({
      form: { email_notification: { enabled: false, to: STORED_RECIPIENT } },
    } as never);

    const resolved = await resolveStoredFormEmailNotification('contact-form', {
      published: async () => [pageTree(off)],
      draft: async () => [enabledForm()],
    });

    assert.equal(resolved.resolution.outcome, 'disabled');
    assert.equal(resolved.source, 'published');
  });

  test('THE LIVE SHAPE (2026-09-03): published form never configured, draft holds the real config', async () => {
    // Published `Contact + final CTA` carries no email_notification; the draft has the real one.
    // Treating "never configured" as "off" would mean the contact form notifies nobody.
    const neverConfigured = contactFormLayer({ form: {} } as never);

    const resolved = await resolveStoredFormEmailNotification('contact-form', {
      published: async () => [pageTree(neverConfigured)],
      draft: async () => [enabledForm()],
    });

    assert.equal(resolved.source, 'draft');
    assert.equal(resolved.resolution.outcome, 'send');
    assert.equal(resolved.resolution.outcome === 'send' && resolved.resolution.to, STORED_RECIPIENT);
  });

  test('nothing anywhere resolves to form-not-found', async () => {
    const resolved = await resolveStoredFormEmailNotification('contact-form', {
      published: async () => [],
      draft: async () => [],
    });
    assert.equal(resolved.resolution.outcome, 'form-not-found');
    assert.equal(resolved.source, 'none');
  });
});

describe('form email config — notifyFormSubmission never throws', () => {
  const emailData = {
    formId: 'contact-form',
    submissionId: 'sub_1',
    payload: {},
    metadata: { submitted_at: '2026-09-03T00:00:00Z' },
  };

  const sendResolution: ResolvedFormEmail = {
    source: 'published',
    resolution: { outcome: 'send', to: STORED_RECIPIENT, subject: STORED_SUBJECT, matchedIn: ['x'] },
  };

  test('a throwing mailer is traced, not swallowed, and does not reject', async () => {
    const logged: Record<string, unknown>[] = [];
    const outcome = await notifyFormSubmission(emailData, {
      resolve: async () => sendResolution,
      send: async () => { throw new Error('SMTP exploded'); },
      logError: e => logged.push(e),
    });

    assert.equal(outcome, 'send-failed');
    assert.equal(logged.length, 1);
    assert.equal(logged[0].event, 'form_email_send_failed');
    assert.equal(logged[0].error, 'SMTP exploded');
  });

  test('a mailer that declines (returns false) is traced rather than passing as sent', async () => {
    const logged: Record<string, unknown>[] = [];
    const outcome = await notifyFormSubmission(emailData, {
      resolve: async () => sendResolution,
      send: async () => false,
      logError: e => logged.push(e),
    });

    assert.equal(outcome, 'not-sent');
    assert.equal(logged[0].event, 'form_email_not_sent');
  });

  test('a failing lookup is traced and does not reject', async () => {
    const logged: Record<string, unknown>[] = [];
    const outcome = await notifyFormSubmission(emailData, {
      resolve: async () => { throw new Error('db down'); },
      send: async () => { throw new Error('should not be reached'); },
      logError: e => logged.push(e),
    });

    assert.equal(outcome, 'lookup-failed');
    assert.equal(logged[0].event, 'form_email_lookup_failed');
  });
});

// ---------------------------------------------------------------------------
// Route-level: the real POST handler, the real resolver, faked stores only.
// ---------------------------------------------------------------------------

const repo = require('@/lib/repositories/formSubmissionRepository');
const pageLayersRepo = require('@/lib/repositories/pageLayersRepository');
const componentRepo = require('@/lib/repositories/componentRepository');
const emailService = require('@/lib/services/emailService');
const webhookService = require('@/lib/services/webhookService');
const integrationService = require('@/lib/apps/integration-service');
const serverConfig = require('@/lib/services/form-email-config.server');
const route = require('@/app/(builder)/ycode/api/form-submissions/route');

interface SendCall { to: string; subject: string }

/** Let the route's fire-and-forget notification settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
}

function postSubmission(body: unknown): Promise<Response> {
  const request = new Request('http://localhost:3002/ycode/api/form-submissions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return route.POST(request);
}

describe('POST /ycode/api/form-submissions — client email config is ignored', () => {
  let sendCalls: SendCall[];
  let createdSubmissions: unknown[];
  let errorLogs: string[];
  let originalConsoleError: typeof console.error;

  beforeEach(() => {
    sendCalls = [];
    createdSubmissions = [];
    errorLogs = [];

    serverConfig.clearFormLayerTreeCache();

    repo.createFormSubmission = async (data: unknown) => {
      createdSubmissions.push(data);
      return { id: 'sub_42', created_at: '2026-09-03T00:00:00Z' };
    };
    webhookService.dispatchFormSubmittedEvent = () => undefined;
    integrationService.processAppIntegrations = () => undefined;
    componentRepo.getAllComponents = async () => [];
    emailService.sendFormSubmissionEmail = async (to: string, subject: string) => {
      sendCalls.push({ to, subject });
      return true;
    };

    originalConsoleError = console.error;
    console.error = (...args: unknown[]) => { errorLogs.push(args.map(String).join(' ')); };
  });

  afterEach(() => {
    console.error = originalConsoleError;
    serverConfig.clearFormLayerTreeCache();
  });

  function storeHolds(layers: Layer[]): void {
    pageLayersRepo.getAllPublishedLayers = async () => [{ page_id: 'p1', layers }];
    pageLayersRepo.getAllDraftLayers = async () => [];
  }

  test('(a) the STORED recipient is used even when the client posts a different `to`', async () => {
    storeHolds(pageTree(contactFormLayer()).layers);

    const response = await postSubmission({
      form_id: 'contact-form',
      payload: { email: 'lead@example.com', message: 'hi' },
      metadata: { page_url: 'http://localhost:3002/contact' },
      // Exactly what an attacker would post.
      email: { enabled: true, to: ATTACKER_RECIPIENT, subject: 'PWNED' },
    });
    await flush();

    assert.equal(response.status, 201);
    assert.equal(sendCalls.length, 1, 'exactly one notification should be sent');
    assert.equal(sendCalls[0].to, STORED_RECIPIENT);
    assert.equal(sendCalls[0].subject, STORED_SUBJECT);
    assert.ok(
      !sendCalls.some(c => c.to === ATTACKER_RECIPIENT),
      'the client-posted recipient must never be mailed'
    );
    assert.ok(
      !sendCalls.some(c => c.subject === 'PWNED'),
      'the client-posted subject must never be used'
    );
  });

  test('(b) a client-posted `to` with NO stored config sends nothing', async () => {
    // The store holds no form at all — the only email config in play is the attacker's.
    pageLayersRepo.getAllPublishedLayers = async () => [];
    pageLayersRepo.getAllDraftLayers = async () => [];

    const response = await postSubmission({
      form_id: 'contact-form',
      payload: { email: 'lead@example.com' },
      metadata: {},
      email: { enabled: true, to: ATTACKER_RECIPIENT, subject: 'PWNED' },
    });
    await flush();

    assert.equal(response.status, 201, 'the visitor still gets a success response');
    assert.equal(sendCalls.length, 0, 'no mail may be sent on client config alone');
    assert.equal(createdSubmissions.length, 1, 'the submission is still stored');
  });

  test('(c) storage succeeds and the visitor still gets 201 when the mailer throws', async () => {
    storeHolds(pageTree(contactFormLayer()).layers);
    emailService.sendFormSubmissionEmail = async () => { throw new Error('SMTP exploded'); };

    const response = await postSubmission({
      form_id: 'contact-form',
      payload: { email: 'lead@example.com' },
      metadata: {},
    });
    const body = await response.json();
    await flush();

    assert.equal(response.status, 201);
    assert.equal(body.data.id, 'sub_42', 'the stored submission is returned to the client');
    assert.equal(createdSubmissions.length, 1, 'storage happened despite the send failure');

    const trace = errorLogs.find(l => l.includes('form_email_send_failed'));
    assert.ok(trace, `expected a structured send-failure trace, got: ${JSON.stringify(errorLogs)}`);
    assert.ok(trace.includes('SMTP exploded'), 'the trace names the underlying error');
  });

  test('a form stored ONLY in a component master is still found', async () => {
    pageLayersRepo.getAllPublishedLayers = async () => [];
    pageLayersRepo.getAllDraftLayers = async () => [];
    componentRepo.getAllComponents = async (isPublished: boolean) =>
      isPublished
        ? [{
            id: 'c1',
            name: 'Contact band',
            layers: pageTree(contactFormLayer()).layers,
            variants: [{ id: 'v1', name: 'Default', layers: pageTree(contactFormLayer()).layers }],
            is_published: true,
          }]
        : [];

    await postSubmission({
      form_id: 'contact-form',
      payload: { email: 'lead@example.com' },
      metadata: {},
      email: { enabled: true, to: ATTACKER_RECIPIENT },
    });
    await flush();

    assert.equal(sendCalls.length, 1);
    assert.equal(sendCalls[0].to, STORED_RECIPIENT);
  });
});
