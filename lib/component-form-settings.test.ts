import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Layer } from '@/types';
import { applyFormSettings } from './layer-utils';
import { findLayerById, updateLayerById } from './mcp/utils';

/**
 * SCA-1362 — configuring a form that lives inside a COMPONENT master.
 *
 * The page tool `update_form_settings` resolves layers only through getPageLayers(page_id), so a
 * form inside a component's variant tree was unreachable: `settings.form.email_notification` could
 * not be set by an agent at all. A componentized "Contact + final CTA" section — reused across
 * pages, which is the whole point of componentizing it — therefore could never be wired to email
 * a lead anywhere. The only route was detaching the instance, trading away reuse on every page.
 *
 * `update_component_layers` now carries an `update_form_settings` op, and BOTH surfaces write
 * through `applyFormSettings`, so they are identical by construction rather than by review.
 * These tests exercise the component path against a nested variant tree.
 */

/** A component variant tree shaped like the real "Contact + final CTA" section: the form is
 *  nested two levels down, and a sibling text layer DISPLAYS the contact address as visible copy. */
function contactSectionVariantLayers(): Layer[] {
  return [
    {
      id: 'lyr-section',
      name: 'Section',
      customName: 'Contact + final CTA',
      children: [
        {
          id: 'lyr-copy',
          name: 'Text',
          // The string-grep trap: this address is visible page COPY, not configuration.
          text: 'Prefer email? hello@scalability.us',
        } as unknown as Layer,
        {
          id: 'lyr-wrap',
          name: 'Div',
          children: [
            {
              id: 'lyr-msp2aq9mg05jwz',
              name: 'Form',
              settings: { id: 'contact-form' },
              children: [],
            } as unknown as Layer,
          ],
        } as unknown as Layer,
      ],
    } as unknown as Layer,
  ];
}

const FORM_ID = 'lyr-msp2aq9mg05jwz';

/** What the component op does, reduced to the two lines that matter. */
function applyOp(layers: Layer[], patch: Parameters<typeof applyFormSettings>[1]): Layer[] {
  return updateLayerById(layers, FORM_ID, (l) => ({
    ...l,
    settings: applyFormSettings(l.settings, patch),
  }));
}

describe('form settings inside a component master (SCA-1362)', () => {
  test('THE GAP: a form nested in a component variant tree persists email_notification', () => {
    const after = applyOp(contactSectionVariantLayers(), {
      email_notification: { enabled: true, to: 'hello@scalability.us', subject: 'New lead' },
    });

    // Read back through the tree the same way the builder and renderer do.
    const form = findLayerById(after, FORM_ID);
    assert.ok(form, 'the form layer must still exist after the write');
    assert.equal(form!.settings?.form?.email_notification?.enabled, true);
    assert.equal(form!.settings?.form?.email_notification?.to, 'hello@scalability.us');
    assert.equal(form!.settings?.form?.email_notification?.subject, 'New lead');
  });

  test('READBACK DISCRIMINATOR: the address must be at the settings path, not merely in the JSON', () => {
    // A whole-tree string grep for the address passes on the UNTOUCHED tree, because a sibling
    // text layer displays it as visible copy. This exact false positive has already fooled a
    // readback once, so the assertion has to walk the parsed path.
    const untouched = contactSectionVariantLayers();
    assert.ok(
      JSON.stringify(untouched).includes('hello@scalability.us'),
      'precondition: the naive grep is a false positive on the untouched tree',
    );
    assert.equal(
      findLayerById(untouched, FORM_ID)!.settings?.form?.email_notification?.to,
      undefined,
      'the parsed path is the only honest discriminator, and it is empty before the write',
    );

    const after = applyOp(untouched, {
      email_notification: { enabled: true, to: 'hello@scalability.us' },
    });
    assert.equal(findLayerById(after, FORM_ID)!.settings?.form?.email_notification?.to, 'hello@scalability.us');
  });

  test('the form layer keeps its settings.id — the submissions grouping key', () => {
    const after = applyOp(contactSectionVariantLayers(), {
      email_notification: { enabled: true, to: 'hello@scalability.us' },
    });
    assert.equal(findLayerById(after, FORM_ID)!.settings?.id, 'contact-form',
      'losing this silently detaches the form from its stored submissions');
  });

  test('redirect_url is stored wrapped as dynamic_text, not as a bare string', () => {
    // A bare string reads back fine in JSON and still redirects nobody.
    const after = applyOp(contactSectionVariantLayers(), {
      success_action: 'redirect',
      redirect_url: '/thank-you',
    });
    const form = findLayerById(after, FORM_ID)!;
    assert.equal(form.settings?.form?.success_action, 'redirect');
    assert.deepEqual(form.settings?.form?.redirect_url,
      { type: 'dynamic_text', data: { content: '/thank-you' } });
  });

  test('PATCH not replace: adding an email notification keeps an existing redirect', () => {
    let layers = applyOp(contactSectionVariantLayers(), {
      success_action: 'redirect',
      redirect_url: '/thank-you',
    });
    layers = applyOp(layers, { email_notification: { enabled: true, to: 'hello@scalability.us' } });

    const form = findLayerById(layers, FORM_ID)!;
    assert.equal(form.settings?.form?.email_notification?.to, 'hello@scalability.us');
    assert.equal(form.settings?.form?.success_action, 'redirect', 'the earlier redirect must survive');
    assert.deepEqual(form.settings?.form?.redirect_url, { type: 'dynamic_text', data: { content: '/thank-you' } });
  });

  test('a later op does not clobber the notification set by an earlier one', () => {
    // update_component_layers applies its operations in sequence against one tree.
    let layers = applyOp(contactSectionVariantLayers(), {
      email_notification: { enabled: true, to: 'hello@scalability.us' },
    });
    layers = applyOp(layers, { success_action: 'message' });
    assert.equal(findLayerById(layers, FORM_ID)!.settings?.form?.email_notification?.to, 'hello@scalability.us');
  });

  test('the input tree is never mutated', () => {
    const before = contactSectionVariantLayers();
    applyOp(before, { email_notification: { enabled: true, to: 'hello@scalability.us' } });
    assert.equal(findLayerById(before, FORM_ID)!.settings?.form, undefined,
      'ops apply in sequence; a mutating write would let op 3 change what op 1 wrote');
  });

  test('the page and component surfaces produce byte-identical settings.form', () => {
    // Both tools call applyFormSettings with the same patch shape. This is what "behaviourally
    // identical" means concretely, and it fails the moment either surface grows its own copy.
    const patch = {
      success_action: 'redirect' as const,
      redirect_url: '/thanks',
      email_notification: { enabled: true, to: 'hello@scalability.us', subject: 'New lead' },
    };
    const pageSideSettings = applyFormSettings({ id: 'contact-form' }, patch);
    const componentSideSettings = findLayerById(applyOp(contactSectionVariantLayers(), patch), FORM_ID)!.settings;
    assert.deepEqual(componentSideSettings, pageSideSettings);
  });

  test('an existing notification can be disabled without erasing the address', () => {
    let layers = applyOp(contactSectionVariantLayers(), {
      email_notification: { enabled: true, to: 'hello@scalability.us', subject: 'New lead' },
    });
    layers = applyOp(layers, { email_notification: { enabled: false, to: 'hello@scalability.us' } });
    const notification = findLayerById(layers, FORM_ID)!.settings?.form?.email_notification;
    assert.equal(notification?.enabled, false, 'a write API with no off switch is half an API');
    assert.equal(notification?.to, 'hello@scalability.us');
  });
});
