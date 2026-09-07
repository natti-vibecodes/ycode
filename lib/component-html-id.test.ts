/**
 * SCA-1459 — `update_component_layers` `update_settings` reported "ok" and the element id never
 * moved.
 *
 * Reported 2026-09-06 while landing the honeypot fix: the op returned
 * `{"op":1,"status":"ok","detail":"Updated settings on \"input\""}` and a `get_component`
 * readback still showed `settings.id: "input"`.
 *
 * Characterised 2026-09-07 against the live workspace. The op does NOT drop `html_id` — it
 * writes it to `settings.html_id`, a key with exactly ONE writer and ZERO readers anywhere in
 * the fork (the renderer emits `settings.id`; so do `layer-utils`' anchor collection and the
 * heading-anchor pass). So it lands somewhere nothing looks. Measured across all 26 components:
 * six layer rows (three inputs × draft/published) carry `settings.html_id` alongside
 * `settings.id: "input"`, and the ids that actually render — `ct-website`, `nl-website`,
 * `ni-website` — come from the `custom_attributes` workaround on the same layers. That is why a
 * later lane read the value back and concluded it "did land": `ni-website` is genuinely present
 * on that layer, in the field that works, put there by the workaround rather than by `html_id`.
 *
 * There is no input under which it worked. The condition is "always", so these tests drive the
 * REAL tool handler and assert on the tree handed to `updateComponent` — not on a re-implementation
 * of the two lines under test, which would agree with the bug.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Layer } from '@/types';

/* eslint-disable @typescript-eslint/no-require-imports */
// require(), not import: the repository and broadcast modules are stubbed in require.cache
// before the tool module loads, and hoisted imports cannot express that ordering.

function stub(specifier: string, exports: Record<string, unknown>) {
  const path = require.resolve(specifier);
  require.cache[path] = { id: path, filename: path, loaded: true, exports } as unknown as NodeModule;
}

stub('server-only', {});

/** The honeypot input as it exists in the live "Contact + final CTA" component. */
const INPUT_ID = 'lyr-mtl1teoju0gekt';
const COMPONENT_ID = 'cmp-contact';

function contactComponent() {
  return {
    id: COMPONENT_ID,
    name: 'Contact + final CTA',
    content_hash: 'hash-1',
    variables: [],
    variants: [{
      id: 'var-primary',
      name: 'Default',
      layers: [{
        id: 'lyr-form',
        name: 'Form',
        settings: { id: 'contact-form' },
        children: [{
          id: INPUT_ID,
          name: 'input',
          settings: {
            id: 'input',
            customAttributes: { name: 'website', type: 'text', tabindex: '-1', autocomplete: 'off' },
          },
          children: [],
        }],
      }] as unknown as Layer[],
    }],
  };
}

let component = contactComponent();
/** The variants handed to updateComponent by the last call. */
let saved: Array<{ id: string; layers: Layer[] }> | null = null;

const componentRepo = require('@/lib/repositories/componentRepository');
componentRepo.getComponentById = async (id: string) => (id === COMPONENT_ID ? component : null);
componentRepo.updateComponent = async (_id: string, patch: { variants: Array<{ id: string; layers: Layer[] }> }) => {
  saved = patch.variants;
  return component;
};
componentRepo.getAllComponents = async () => [component];
componentRepo.createComponent = async () => component;
componentRepo.softDeleteComponent = async () => true;

const broadcast = require('@/lib/mcp/broadcast');
for (const key of Object.keys(broadcast)) {
  if (typeof broadcast[key] === 'function') broadcast[key] = async () => {};
}

const fontInstall = require('@/lib/mcp/font-install');
fontInstall.ensureFontsInstalled = async () => ({ installed: [], missing: [] });
fontInstall.fontWarnings = () => [];

const pageRepo = require('@/lib/repositories/pageRepository');
pageRepo.getAllPages = async () => [];

const { registerComponentTools } = require('@/lib/mcp/tools/components');

/** Capture the real handlers by registering the tools against a fake MCP server. */
const handlers = new Map<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>>();
const schemas = new Map<string, Record<string, { parse: (v: unknown) => unknown }>>();
registerComponentTools({
  tool: (name: string, _description: string, schema: never, handler: never) => {
    handlers.set(name, handler);
    schemas.set(name, schema);
  },
} as never);

async function updateSettings(op: Record<string, unknown>) {
  const handler = handlers.get('update_component_layers');
  assert.ok(handler, 'update_component_layers must be registered');
  const res = await handler({
    component_id: COMPONENT_ID,
    operations: [{ type: 'update_settings', layer_id: INPUT_ID, ...op }],
  });
  return { res, body: JSON.parse(res.content[0].text) as { message: string; results: Array<{ status: string; detail: string }> } };
}

/** The input layer as it was written back to the repository. */
function savedInput(): Layer & { settings?: Record<string, unknown> } {
  assert.ok(saved, 'updateComponent must have been called');
  const form = saved![0].layers[0] as Layer & { children: Layer[] };
  return form.children[0] as Layer & { settings?: Record<string, unknown> };
}

beforeEach(() => {
  component = contactComponent();
  saved = null;
});

describe('update_component_layers update_settings honours html_id (SCA-1459)', () => {
  test('REGRESSION: the reported call actually moves the element id', async () => {
    // The exact op from the ticket body.
    const { body } = await updateSettings({
      html_id: 'ct-website',
      custom_attributes: {
        id: 'ct-website', name: 'website', type: 'text', value: '',
        tabindex: '-1', placeholder: '', autocomplete: 'off',
      },
    });

    assert.equal(body.results[0].status, 'ok');
    const input = savedInput();
    // The field the renderer emits (`elementProps.id = layer.settings.id`).
    assert.equal(input.settings?.id, 'ct-website', 'settings.id must carry the new id');
    // And NOT the orphan key this used to write.
    assert.equal('html_id' in (input.settings ?? {}), false, 'settings.html_id is read by nothing');
  });

  test('html_id alone is enough — no custom_attributes needed', async () => {
    // The original report wondered whether sending both fields was the trigger. It was not:
    // the op behaved identically with and without custom_attributes.
    await updateSettings({ html_id: 'ct-website' });
    assert.equal(savedInput().settings?.id, 'ct-website');
  });

  test('an existing settings.id is replaced, not preserved', async () => {
    // The layer already carried `settings.id: "input"` — the value the ticket saw survive.
    const seeded = contactComponent().variants[0].layers[0] as unknown as
      { children: Array<{ settings: Record<string, unknown> }> };
    assert.equal(seeded.children[0].settings.id, 'input');
    await updateSettings({ html_id: 'ct-website' });
    assert.equal(savedInput().settings?.id, 'ct-website');
  });

  test('a legacy orphan settings.html_id is cleared when the id is repaired', async () => {
    // The six rows the bug already wrote must not keep looking set after a repair.
    (component.variants[0].layers[0] as unknown as { children: Array<{ settings: Record<string, unknown> }> })
      .children[0].settings.html_id = 'ct-website';
    await updateSettings({ html_id: 'ct-website' });
    const settings = savedInput().settings ?? {};
    assert.equal(settings.id, 'ct-website');
    assert.equal('html_id' in settings, false);
  });

  test('html_id lands on a NON-primary variant too', async () => {
    // One of the hypotheses in the ticket: does it drop on a variant tree? It never did — but
    // the variant path is pinned so the answer stays measured rather than remembered.
    component.variants.push({
      id: 'var-alt',
      name: 'Alt',
      layers: [{ id: INPUT_ID, name: 'input', settings: { id: 'input' }, children: [] }] as unknown as Layer[],
    });
    const handler = handlers.get('update_component_layers')!;
    await handler({
      component_id: COMPONENT_ID,
      variant_id: 'var-alt',
      operations: [{ type: 'update_settings', layer_id: INPUT_ID, html_id: 'alt-website' }],
    });
    assert.ok(saved);
    assert.equal((saved![1].layers[0] as Layer & { settings?: Record<string, unknown> }).settings?.id, 'alt-website');
    // The primary variant is untouched.
    assert.equal(
      ((saved![0].layers[0] as Layer & { children: Array<Layer & { settings?: Record<string, unknown> }> }).children[0]).settings?.id,
      'input',
    );
  });

  test('other update_settings fields still work alongside html_id', async () => {
    await updateSettings({ html_id: 'ct-website', tag: 'section', attributes: { 'data-x': '1' } });
    const input = savedInput();
    assert.equal(input.settings?.id, 'ct-website');
    assert.equal(input.settings?.tag, 'section');
    assert.deepEqual((input as unknown as { attributes: Record<string, string> }).attributes, { 'data-x': '1' });
  });

  test('form_id keeps writing settings.id — the same field, deliberately', async () => {
    await updateSettings({ form_id: 'contact-2026' });
    assert.equal(savedInput().settings?.id, 'contact-2026');
  });

  test('html_id and form_id disagreeing is an ERROR, not a coin toss', async () => {
    // Both write settings.id, so write order used to decide silently — the exact failure shape
    // this ticket is about.
    const { body } = await updateSettings({ html_id: 'ct-website', form_id: 'contact-2026' });
    assert.equal(body.results[0].status, 'error');
    assert.match(body.results[0].detail, /both write settings\.id/);
    assert.equal(saved, null, 'a rejected op must not write the tree');
  });

  test('html_id and form_id agreeing is accepted', async () => {
    const { body } = await updateSettings({ html_id: 'same-id', form_id: 'same-id' });
    assert.equal(body.results[0].status, 'ok');
    assert.equal(savedInput().settings?.id, 'same-id');
  });

  test('omitting html_id leaves settings.id exactly as it was', async () => {
    await updateSettings({ tag: 'section' });
    assert.equal(savedInput().settings?.id, 'input');
  });

  test('the schema still advertises html_id — the field the ticket was promised', async () => {
    // The handler is called directly above, which bypasses zod; assert separately that the
    // published contract still carries the field, so "honoured" and "advertised" cannot drift.
    const operations = schemas.get('update_component_layers')?.operations;
    assert.ok(operations, 'operations schema must be registered');
    const parsed = operations.parse([
      { type: 'update_settings', layer_id: INPUT_ID, html_id: 'ct-website' },
    ]) as Array<{ html_id?: string }>;
    assert.equal(parsed[0].html_id, 'ct-website');
  });
});
