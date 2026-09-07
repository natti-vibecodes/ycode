/**
 * SCA-1490 — a decorative image could not be marked `alt=""`, asserted on RENDERED MARKUP.
 *
 * The renderer coerced an empty alt to the literal string "Image", twice and independently:
 * `String(rawImageAltContent || 'Image')` and `getTranslatedText(...) || 'Image'`. An empty
 * string is falsy, so the builder's own default for a new image —
 * `createDynamicTextVariable('')` — was exactly the state that got rewritten. Measured on served
 * output 2026-09-07: 90 images on 23 pages announced themselves to a screen reader as "Image",
 * including four unnamed client headshots in the homepage testimonials card.
 *
 * The `custom_attributes` escape hatch did not work either: `applyCustomAttributes` writes onto
 * `elementProps`, and the image branch then rebuilt `{ ...elementProps, alt: imageAlt }`, so the
 * override was overwritten a few lines later. Same shape as the SCA-1348 `loading` bug, which was
 * fixed for `loading` and left in place for `alt`.
 *
 * Two things are asserted here that a weaker test would miss:
 *
 *  - the attribute parser keeps `alt=""` distinct from a valueless `alt`. The obvious parser
 *    (and the one in `video-autoplay.test.ts`) folds an empty value to `true`, which would make
 *    the fix and a bare `alt` indistinguishable.
 *  - every assertion is preceded by a population check that an `<img>` was rendered at all.
 *    "No alt=\"Image\" found" is the same value when nothing rendered.
 *
 * The absent-alt fallback is `alt=""` for UPSTREAM PARITY, not a fallback we invented: upstream
 * ycode e048b0f ("fix: improve published HTML accessibility", 2026-09-07) makes exactly the same
 * change to both renderers. This lands that half ahead of the wider merge because the Definition
 * of Done's "decorative images: explicit alt=''" box is unachievable without it.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

/* eslint-disable @typescript-eslint/no-require-imports */
// The renderer's module graph reaches a stylesheet; Node's loader has no idea what that is.
require.extensions['.css'] = () => {};

const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const LayerRendererPublic = require('@/components/LayerRendererPublic').default;
const LayerRendererEditor = require('@/components/LayerRenderer').default;

type AnyLayer = Record<string, any>;

const SRC = 'https://example.test/headshot.webp';

/** An image layer whose `src` resolves, so the renderer takes the `<img>` path. */
function imageLayer(overrides: AnyLayer = {}): AnyLayer {
  const { variables, ...rest } = overrides;
  return {
    id: 'lyr-img-1',
    name: 'image',
    variables: {
      image: {
        src: { type: 'dynamic_text', data: { content: SRC } },
        ...(variables?.image ?? {}),
      },
    },
    ...rest,
  };
}

/** An alt variable in the shape the builder writes (`createDynamicTextVariable`). */
function alt(content: unknown) {
  return { alt: { type: 'dynamic_text', data: { content } } };
}

/**
 * Parse the attributes off the first `<img …>`.
 *
 * Unlike the parser in `video-autoplay.test.ts`, an empty VALUE stays `''` and only a valueless
 * attribute becomes `true` — the whole question here is `alt=""` versus no alt at all.
 */
function imgAttrs(markup: string): Record<string, string | true> {
  const match = markup.match(/<img(\s[^>]*)?>/);
  assert.ok(match, `population check: no <img> in the rendered markup: ${markup.slice(0, 400)}`);
  const attrs: Record<string, string | true> = {};
  const attrRe = /(?:^|\s)([A-Za-z_:][-A-Za-z0-9_:.]*)(?:=("[^"]*"|'[^']*'|[^\s"'>]+))?/g;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(match[1] || '')) !== null) {
    const raw = m[2];
    attrs[m[1].toLowerCase()] = raw === undefined ? true : raw.replace(/^["']|["']$/g, '');
  }
  return attrs;
}

function renderPublic(layer: AnyLayer): Record<string, string | true> {
  return imgAttrs(renderToStaticMarkup(
    React.createElement(LayerRendererPublic, { layers: [layer], isPublished: true }),
  ));
}

function renderEditor(layer: AnyLayer): Record<string, string | true> {
  return imgAttrs(renderToStaticMarkup(React.createElement(LayerRendererEditor, { layers: [layer] })));
}

describe('SCA-1490 public renderer: an empty alt ships as alt=""', () => {
  test('BEFORE-FAIL: content "" serves alt="" — the decorative marking the authors already wrote', () => {
    // The exact draft state of the four `bc-cluster` headshots in `Testimonials bento`.
    const attrs = renderPublic(imageLayer({ variables: { image: alt('') } }));
    assert.equal(attrs.alt, '', 'an explicitly empty alt is a decorative marking, not an absence');
    assert.notEqual(attrs.alt, 'Image', 'the coercion is what a screen reader read aloud 90 times');
  });

  test('BEFORE-FAIL: an ABSENT alt variable falls back to alt="" — upstream parity (e048b0f)', () => {
    // Not a fallback of our own choosing: this is what upstream's renderer emits for a missing
    // alt. Keeping parity means the eventual upstream merge is a no-op on these lines.
    const attrs = renderPublic(imageLayer());
    assert.equal(attrs.alt, '');
  });

  test('BEFORE-FAIL: an empty Tiptap doc also serves alt="" — the second, independent coercion', () => {
    // The object branch had its own `|| 'Image'`, so fixing only the string branch would leave
    // legacy rich-text alt values still announcing "Image".
    const attrs = renderPublic(imageLayer({
      variables: { image: alt({ type: 'doc', content: [{ type: 'paragraph' }] }) },
    }));
    assert.equal(attrs.alt, '');
  });

  test('CONTROL: a real alt is untouched — the field works, only the empty case was broken', () => {
    // The control arm from the ticket: the two NAMED avatars in the same component always
    // rendered correctly. Without this, a fix that dropped alt entirely would pass everything above.
    const attrs = renderPublic(imageLayer({ variables: { image: alt('George Dimov') } }));
    assert.equal(attrs.alt, 'George Dimov');
  });

  test('an alt of only whitespace is preserved verbatim, not treated as missing', () => {
    // Truthy, so it was never part of the bug — pinned so a future "trim then coerce" cannot
    // reintroduce a fallback through the back door.
    assert.equal(renderPublic(imageLayer({ variables: { image: alt(' ') } })).alt, ' ');
  });
});

describe('SCA-1490 public renderer: an explicit alt attribute wins over the variable', () => {
  test('BEFORE-FAIL: custom_attributes.alt overrides the image variable', () => {
    // customAttributes beats attributes and beats the variable — the documented contract for
    // every other element. On images the override was applied and then overwritten.
    const attrs = renderPublic(imageLayer({
      variables: { image: alt('stale variable text') },
      settings: { customAttributes: { alt: 'LinkedIn' } },
    }));
    assert.equal(attrs.alt, 'LinkedIn');
  });

  test('BEFORE-FAIL: custom_attributes.alt="" marks an image decorative even over a non-empty variable', () => {
    // `??`, not `||`: an empty override is a value. With `||` this test reads "stale variable
    // text" and the escape hatch is still missing for exactly the case it exists to serve.
    const attrs = renderPublic(imageLayer({
      variables: { image: alt('stale variable text') },
      settings: { customAttributes: { alt: '' } },
    }));
    assert.equal(attrs.alt, '');
  });

  test('BEFORE-FAIL: an `attributes` alt is honoured when customAttributes does not set one', () => {
    const attrs = renderPublic(imageLayer({
      variables: { image: alt('stale variable text') },
      attributes: { alt: 'Porsche' },
    }));
    assert.equal(attrs.alt, 'Porsche');
  });

  test('customAttributes beats attributes on collision, as everywhere else', () => {
    const attrs = renderPublic(imageLayer({
      attributes: { alt: 'from attributes' },
      settings: { customAttributes: { alt: 'from customAttributes' } },
    }));
    assert.equal(attrs.alt, 'from customAttributes');
  });

  test('the variable still wins when no attribute is set — the override is opt-in', () => {
    // Guards the other direction: `resolveLayerAttribute` returning '' for an unset attribute
    // would silently blank every described image on the site.
    const attrs = renderPublic(imageLayer({
      variables: { image: alt('Scalability branding on a billboard in Downtown Dubai') },
      settings: { customAttributes: { loading: 'eager' } },
    }));
    assert.equal(attrs.alt, 'Scalability branding on a billboard in Downtown Dubai');
  });

  test('an img always carries an alt attribute — never dropped', () => {
    // `alt` missing entirely is a worse defect than `alt="Image"`; assert presence separately
    // from value so a future refactor cannot trade one bug for the other.
    for (const layer of [imageLayer(), imageLayer({ variables: { image: alt('') } })]) {
      assert.ok('alt' in renderPublic(layer), 'the alt attribute must be emitted');
    }
  });
});

describe('SCA-1490 builder renderer: the canvas agrees with what ships', () => {
  test('BEFORE-FAIL: content "" renders alt="" on the canvas too', () => {
    // Both renderers carried their own copy of the coercion. Fixing one would leave draft and
    // served disagreeing about which images are decorative.
    assert.equal(renderEditor(imageLayer({ variables: { image: alt('') } })).alt, '');
  });

  test('BEFORE-FAIL: custom_attributes.alt overrides the variable on the canvas too', () => {
    assert.equal(
      renderEditor(imageLayer({
        variables: { image: alt('stale variable text') },
        settings: { customAttributes: { alt: 'Instagram' } },
      })).alt,
      'Instagram',
    );
  });

  test('CONTROL: a real alt is untouched on the canvas', () => {
    assert.equal(renderEditor(imageLayer({ variables: { image: alt('Paul Tanico') } })).alt, 'Paul Tanico');
  });
});
