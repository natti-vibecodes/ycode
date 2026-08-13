import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mergeAttributeMap } from './layer-utils';

/**
 * SCA-1361 — writing a layer's `attributes` INSIDE a component master.
 *
 * `update_component_layers`' update_settings op could set `custom_attributes` but had no
 * `attributes` field at all, so a layer inside a component master could not have its
 * `loading`/`sizes` (images) or `controls`/`autoplay`/`muted`/`loop` (media) set by an agent —
 * the same gap SCA-1348 closed on the page surface, still open on the component one. The only
 * route was detaching the instance, which trades away reuse on every page that uses it.
 *
 * These cover the semantics the op relies on. The merge behaviour is the safety-critical half:
 * `attributes` carries `src`, `width` and `height`, so a REPLACE to set `loading="eager"` would
 * silently wipe the image — which is why this field merges while its neighbour `custom_attributes`
 * deliberately replaces.
 */

describe('component-master attribute writes (SCA-1361)', () => {
  test('REGRESSION: setting loading does NOT wipe src/width/height', () => {
    // The whole reason this merges. A replace here empties the image and the layer still looks
    // structurally fine in a readback.
    const existing = { src: '/a/img.webp', width: '1200', height: '800' };
    const out = mergeAttributeMap(existing, { loading: 'eager' });
    assert.deepEqual(out, { src: '/a/img.webp', width: '1200', height: '800', loading: 'eager' });
  });

  test('the Dimov case: flipping lazy to eager touches nothing else', () => {
    const existing = { src: '/a/dimov.webp', loading: 'lazy', width: '96', height: '96' };
    assert.deepEqual(mergeAttributeMap(existing, { loading: 'eager' }),
      { src: '/a/dimov.webp', loading: 'eager', width: '96', height: '96' });
  });

  test('video attributes can be set together and removed individually', () => {
    const video = mergeAttributeMap({ src: '/a/reel.mp4' },
      { autoplay: 'true', muted: 'true', loop: 'true', controls: 'false' });
    assert.equal(video?.autoplay, 'true');
    assert.deepEqual(mergeAttributeMap(video, { controls: null })?.controls, undefined);
    assert.equal(mergeAttributeMap(video, { controls: null })?.src, '/a/reel.mp4', 'removing one must keep the rest');
  });

  test('null deletes, and does so case-insensitively', () => {
    assert.equal(mergeAttributeMap({ LOADING: 'lazy' }, { loading: null }), undefined);
  });

  test('a layer with no attributes yet can receive its first', () => {
    assert.deepEqual(mergeAttributeMap(undefined, { loading: 'eager' }), { loading: 'eager' });
  });

  test('the existing map is never mutated — batch ops apply in sequence', () => {
    // update_component_layers applies operations in order against one tree; a mutating merge
    // would let op 3 change what op 1 already wrote.
    const existing = { src: '/a/x.webp', loading: 'lazy' };
    mergeAttributeMap(existing, { loading: 'eager', width: '10' });
    assert.deepEqual(existing, { src: '/a/x.webp', loading: 'lazy' });
  });
});
