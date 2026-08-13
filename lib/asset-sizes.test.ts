import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildImageSizes } from './asset-utils';

/**
 * SCA-1120. `sizes` is a claim about DISPLAY width; the intrinsic width is the SOURCE FILE's
 * width. Conflating them told browsers a 1600px source in a ~380px card occupied 1600px, so they
 * downloaded the 1600w variant — 116 images, 4.19MB on /insights, with nothing in the markup
 * looking wrong.
 */
describe('buildImageSizes', () => {
  test('REGRESSION: lazy images hand sizing to the browser with sizes=auto', () => {
    const s = buildImageSizes(1600, true);
    assert.ok(s.startsWith('auto,'), s); // `auto` must come FIRST or the spec ignores it
  });

  test('the previous value is preserved verbatim as the fallback', () => {
    // Browsers without sizes=auto parse past it, so they cannot regress.
    assert.equal(buildImageSizes(1600, true), 'auto, (max-width: 768px) 100vw, 1600px');
    assert.equal(buildImageSizes(1600, false), '(max-width: 768px) 100vw, 1600px');
  });

  test('eager images never get auto — the spec requires loading=lazy', () => {
    // The LCP hero is eager, so it must keep an explicit value or sizing breaks entirely.
    assert.doesNotMatch(buildImageSizes(1409, false), /auto/);
  });

  test('defaults to non-lazy, so existing callers are unchanged', () => {
    assert.equal(buildImageSizes(800), buildImageSizes(800, false));
  });

  test('an unknown intrinsic width still yields a usable value', () => {
    const lazy = buildImageSizes(null, true);
    assert.ok(lazy.startsWith('auto,'));
    assert.ok(lazy.length > 'auto, '.length);
  });
});
