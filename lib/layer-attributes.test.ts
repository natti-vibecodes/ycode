import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveLayerAttribute, mergeAttributeMap } from './layer-utils';

/**
 * SCA-1348. A layer carries attributes in two fields — `attributes` (the element's own) and
 * `settings.customAttributes` (the only one the MCP tool could write). For a general element the
 * renderer spreads `attributes` first and applies `customAttributes` after, so customAttributes
 * wins. The image path did not follow that rule: it read `layer.attributes.loading` directly, so
 * a `loading` written through customAttributes was silently inert while the template's
 * `attributes.loading="lazy"` kept winning — a write that applies on a <div> and vanishes on an
 * <img>, with nothing visible to explain it. A lane hit exactly that and could not diagnose it
 * from outside the renderer.
 */

describe('resolveLayerAttribute (SCA-1348)', () => {
  test('REGRESSION: customAttributes beats attributes, matching every other element', () => {
    const layer = {
      attributes: { loading: 'lazy' },
      settings: { customAttributes: { loading: 'eager' } },
    };
    assert.equal(resolveLayerAttribute(layer, 'loading'), 'eager');
  });

  test('falls back to attributes when customAttributes does not set it', () => {
    assert.equal(resolveLayerAttribute({ attributes: { loading: 'lazy' } }, 'loading'), 'lazy');
  });

  test('matching is case-insensitive, because HTML attribute names are', () => {
    const layer = { settings: { customAttributes: { LOADING: 'eager' } } };
    assert.equal(resolveLayerAttribute(layer, 'loading'), 'eager');
  });

  test('absent, null and undefined all read as unset rather than as ""', () => {
    assert.equal(resolveLayerAttribute({}, 'loading'), undefined);
    assert.equal(resolveLayerAttribute({ attributes: null }, 'loading'), undefined);
    assert.equal(resolveLayerAttribute({ attributes: { loading: null } as never }, 'loading'), undefined);
  });

  test('an empty string is a real value, not an absence', () => {
    // `sizes=""` is meaningfully different from no sizes attribute at all.
    assert.equal(resolveLayerAttribute({ attributes: { sizes: '' } }, 'sizes'), '');
  });

  test('non-string values are stringified rather than dropped', () => {
    assert.equal(resolveLayerAttribute({ attributes: { width: 320 } }, 'width'), '320');
  });
});

describe('mergeAttributeMap (SCA-1348)', () => {
  test('REGRESSION: null DELETES a key — merging alone could only overwrite', () => {
    // Before this, a mistaken attribute could be blanked to "" (which still renders) but never
    // removed. Same half-an-API shape as isActive before SCA-1336.
    assert.deepEqual(mergeAttributeMap({ loading: 'eager', alt: 'x' }, { loading: null }), { alt: 'x' });
  });

  test('deletion is case-insensitive, so a differently-cased key cannot survive', () => {
    // Surviving under another case is worse than not deleting: the caller sees success and the
    // renderer still emits the attribute.
    assert.equal(mergeAttributeMap({ LOADING: 'eager' }, { loading: null }), undefined);
  });

  test('sets and updates behave as a normal merge', () => {
    assert.deepEqual(mergeAttributeMap({ a: '1' }, { b: '2' }), { a: '1', b: '2' });
    assert.deepEqual(mergeAttributeMap({ a: '1' }, { a: '2' }), { a: '2' });
  });

  test('emptying the map yields undefined, not a lingering {}', () => {
    assert.equal(mergeAttributeMap({ a: '1' }, { a: null }), undefined);
    assert.equal(mergeAttributeMap(undefined, {}), undefined);
  });

  test('deleting a key that is not there is a no-op, not an error', () => {
    assert.deepEqual(mergeAttributeMap({ a: '1' }, { b: null }), { a: '1' });
  });

  test('the existing map is not mutated', () => {
    const existing = { a: '1', b: '2' };
    mergeAttributeMap(existing, { a: null, c: '3' });
    assert.deepEqual(existing, { a: '1', b: '2' });
  });
});
