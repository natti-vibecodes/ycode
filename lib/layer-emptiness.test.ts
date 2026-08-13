import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isLayerEmpty } from './layer-emptiness';

/**
 * SCA-1368. `data-is-empty` is a diagnostic marker read by humans and agents — it is in the
 * playbook as the component-GUTTED symptom. The old predicate was `!textContent && !children`,
 * which is TRUE for every leaf media element: all 18 homepage <img> tags carried it alongside a
 * valid `src`. A flag true for every image says nothing about images, and it nearly misdirected
 * the Midjourney-tile diagnosis.
 *
 * Safe to narrow because nothing consumes it programmatically — three emit sites, zero readers in
 * the fork, the site CSS, or the site JS. Enumerated before changing it, per the band-token rule.
 */
const layer = (variables?: Record<string, unknown>) => ({ variables } as never);

describe('isLayerEmpty (SCA-1368)', () => {
  test('REGRESSION: an <img> is NOT empty just because it has no children', () => {
    assert.equal(isLayerEmpty(layer(), null, [], 'img'), false);
  });

  test('REGRESSION: a layer with a media source is NOT empty', () => {
    assert.equal(isLayerEmpty(layer({ image: { src: { type: 'asset' } } }), null, [], 'div'), false);
    assert.equal(isLayerEmpty(layer({ video: { src: 'x' } }), null, [], 'div'), false);
    assert.equal(isLayerEmpty(layer({ backgroundImage: { src: 'x' } }), null, [], 'div'), false);
  });

  test('form controls and rules are their own content', () => {
    for (const tag of ['input', 'textarea', 'select', 'video', 'iframe', 'canvas', 'svg', 'hr']) {
      assert.equal(isLayerEmpty(layer(), null, [], tag), false, `<${tag}> should not read as empty`);
    }
  });

  test('a genuinely empty div IS still empty — the marker must keep working', () => {
    // The narrowing must not turn the flag off for everything; then it would carry no information
    // in the other direction and the GUTTED signature would stop being detectable at all.
    assert.equal(isLayerEmpty(layer(), null, [], 'div'), true);
    assert.equal(isLayerEmpty(layer(), '', [], 'section'), true);
    assert.equal(isLayerEmpty(layer({ image: {} }), null, [], 'div'), true, 'a media slot with no src is empty');
  });

  test('text or children still make a layer non-empty', () => {
    assert.equal(isLayerEmpty(layer(), 'hello', [], 'div'), false);
    assert.equal(isLayerEmpty(layer(), null, [{}], 'div'), false);
  });

  test('tag matching is case-insensitive', () => {
    assert.equal(isLayerEmpty(layer(), null, [], 'IMG'), false);
  });
});
