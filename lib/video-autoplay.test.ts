/**
 * SCA-1468 — deferred autoplay, asserted on RENDERED MARKUP.
 *
 * These render the real `LayerRendererPublic` (and, for the control arm, the real builder-canvas
 * `LayerRenderer`) to static markup and read the attributes off the parsed tag. Two reasons it is
 * done this way rather than by unit-testing the decision helpers alone:
 *
 *  - the bug was never in a helper. It was in which attributes reach the HTML, and the renderer
 *    has three separate writers for a media element (`elementProps`, `normalizedAttributes`, then
 *    the ref) whose precedence is not obvious from any one of them.
 *  - `autoplay` is a SUBSTRING of `data-autoplay`, so a text search for the bug's signature
 *    matches the fix. Every assertion below goes through an attribute parser, never `includes()`.
 *
 * Each render asserts the tag exists before asserting anything about its attributes, so an
 * assertion cannot pass because nothing was rendered.
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

import {
  ABOVE_FOLD_ATTR,
  AUTOPLAY_MARKER_ATTR,
  DEFER_ATTR,
  isDeferredAutoplayLayer,
  readLayerFlag,
  resolveDeferredPreload,
  treeHasDeferredAutoplayVideo,
} from './video-autoplay';

type AnyLayer = Record<string, any>;

/** A video layer with a real src, so the renderer takes the media path rather than bailing. */
function videoLayer(overrides: AnyLayer = {}): AnyLayer {
  const { attributes, ...rest } = overrides;
  return {
    id: 'vid-1',
    name: 'video',
    attributes: { autoplay: true, muted: true, loop: true, ...attributes },
    variables: {
      video: { src: { type: 'dynamic_text', data: { content: 'https://example.test/reel.mp4' } } },
    },
    ...rest,
  };
}

/**
 * Parse the attributes off the first `<tag …>` in the markup.
 * Returns `true` for a valueless/empty attribute, matching HTML boolean semantics.
 */
function parseTag(markup: string, tag: string): Record<string, string | true> {
  const match = markup.match(new RegExp(`<${tag}(\\s[^>]*)?>`));
  assert.ok(match, `population check: no <${tag}> in the rendered markup: ${markup.slice(0, 400)}`);
  const attrs: Record<string, string | true> = {};
  const source = match[1] || '';
  const attrRe = /(?:^|\s)([A-Za-z_:][-A-Za-z0-9_:.]*)(?:=("[^"]*"|'[^']*'|[^\s"'>]+))?/g;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(source)) !== null) {
    const raw = m[2];
    const value = raw === undefined ? true : raw.replace(/^["']|["']$/g, '');
    attrs[m[1].toLowerCase()] = value === '' ? true : value;
  }
  return attrs;
}

function renderPublic(layer: AnyLayer): Record<string, string | true> {
  const markup = renderToStaticMarkup(
    React.createElement(LayerRendererPublic, { layers: [layer], isPublished: true }),
  );
  return parseTag(markup, layer.name === 'audio' ? 'audio' : 'video');
}

function renderEditor(layer: AnyLayer): Record<string, string | true> {
  const markup = renderToStaticMarkup(React.createElement(LayerRendererEditor, { layers: [layer] }));
  return parseTag(markup, 'video');
}

describe('SCA-1468 public renderer: an autoplay video ships in deferred form', () => {
  test('BEFORE-FAIL: no `autoplay` attribute, and the author\'s `preload="auto"` is overridden to "none"', () => {
    // The exact layer that measured 8.4 s buffered by 1.3 s on /services/design-branding.
    const attrs = renderPublic(videoLayer({ attributes: { preload: 'auto' } }));
    assert.equal(attrs.autoplay, undefined, 'autoplay must not reach the HTML — it defeats preload="none"');
    assert.equal(attrs.preload, 'none');
  });

  test('BEFORE-FAIL: the author\'s intent survives as the `data-autoplay` marker', () => {
    const attrs = renderPublic(videoLayer());
    assert.equal(attrs[AUTOPLAY_MARKER_ATTR], '1');
  });

  test('muted, loop and playsinline are preserved — the driver\'s play() depends on them', () => {
    const attrs = renderPublic(videoLayer());
    assert.equal(attrs.muted, true);
    assert.equal(attrs.loop, true);
    assert.equal(attrs.playsinline, true);
  });

  test('a configured poster still renders, so the frame paints with no JS at all', () => {
    const attrs = renderPublic(videoLayer({
      variables: {
        video: {
          src: { type: 'dynamic_text', data: { content: 'https://example.test/reel.mp4' } },
          poster: { type: 'dynamic_text', data: { content: 'https://example.test/poster.jpg' } },
        },
      },
    }));
    assert.equal(attrs.poster, 'https://example.test/poster.jpg');
    assert.equal(attrs.preload, 'none', 'a poster already paints; metadata would buy nothing');
  });

  test('above the fold with NO poster keeps preload="metadata" for a first frame', () => {
    const attrs = renderPublic(videoLayer({ attributes: { [ABOVE_FOLD_ATTR]: true } }));
    assert.equal(attrs.preload, 'metadata');
    assert.equal(attrs.autoplay, undefined, 'above-the-fold is a preload decision, never an autoplay one');
  });

  test('above the fold WITH a poster stays at preload="none"', () => {
    const attrs = renderPublic(videoLayer({
      attributes: { [ABOVE_FOLD_ATTR]: true },
      variables: {
        video: {
          src: { type: 'dynamic_text', data: { content: 'https://example.test/reel.mp4' } },
          poster: { type: 'dynamic_text', data: { content: 'https://example.test/poster.jpg' } },
        },
      },
    }));
    assert.equal(attrs.preload, 'none');
  });

  test('the settings are reachable through customAttributes, the only carrier the MCP can write', () => {
    const attrs = renderPublic(videoLayer({
      settings: { customAttributes: { [ABOVE_FOLD_ATTR]: 'true' } },
    }));
    assert.equal(attrs.preload, 'metadata');
  });
});

describe('SCA-1468 public renderer: what deferral must NOT touch', () => {
  test('opting out restores eager autoplay and leaves the author\'s preload alone', () => {
    const attrs = renderPublic(videoLayer({ attributes: { preload: 'auto', [DEFER_ATTR]: false } }));
    assert.equal(attrs[AUTOPLAY_MARKER_ATTR], undefined);
    assert.equal(attrs.preload, 'auto');
  });

  test('SCOPE GUARD: a video with no autoplay is rendered exactly as before', () => {
    const attrs = renderPublic(videoLayer({ attributes: { autoplay: false, preload: 'metadata' } }));
    assert.equal(attrs[AUTOPLAY_MARKER_ATTR], undefined, 'nothing to defer, so nothing to mark');
    assert.equal(attrs.preload, 'metadata', 'a non-autoplay preload is the author\'s call and stays');
  });

  test('SCOPE GUARD: <audio autoplay> is untouched — it has no visibility to key on', () => {
    const attrs = renderPublic({
      id: 'aud-1',
      name: 'audio',
      attributes: { autoplay: true, preload: 'auto' },
      variables: { audio: { src: { type: 'dynamic_text', data: { content: 'https://example.test/a.mp3' } } } },
    });
    assert.equal(attrs[AUTOPLAY_MARKER_ATTR], undefined);
    assert.equal(attrs.preload, 'auto');
  });
});

describe('SCA-1468 the BUILDER CANVAS keeps eager autoplay', () => {
  test('the editor renderer emits neither the marker nor a forced preload', () => {
    // Same layer as the first public test. A designer placing a video expects it to play in the
    // canvas immediately; the bandwidth problem this fixes is a visitor's, not the editor's.
    const attrs = renderEditor(videoLayer({ attributes: { preload: 'auto' } }));
    assert.equal(attrs[AUTOPLAY_MARKER_ATTR], undefined);
    assert.equal(attrs.preload, 'auto');
  });
});

describe('SCA-1468 the decision helpers', () => {
  test('autoplay is required — deferral is not a way to pause a video nobody asked to play', () => {
    assert.equal(isDeferredAutoplayLayer({ attributes: { autoplay: true } }), true);
    assert.equal(isDeferredAutoplayLayer({ attributes: {} }), false);
    assert.equal(isDeferredAutoplayLayer(null), false);
  });

  test('a string "true"/""/"1" reads as set — customAttributes cannot hold a real boolean', () => {
    for (const raw of ['true', '1', '', 'on', 'yes', 'TRUE']) {
      assert.equal(readLayerFlag({ settings: { customAttributes: { flag: raw } } }, 'flag', false), true, raw);
    }
    for (const raw of ['false', '0', 'off', 'no']) {
      assert.equal(readLayerFlag({ settings: { customAttributes: { flag: raw } } }, 'flag', true), false, raw);
    }
    assert.equal(readLayerFlag({}, 'flag', true), true, 'an unset flag falls back');
    assert.equal(readLayerFlag({ attributes: { flag: 'maybe' } }, 'flag', true), true, 'garbage falls back');
  });

  test('preload resolves from the poster and the above-fold setting, never from tree position', () => {
    const above = { attributes: { [ABOVE_FOLD_ATTR]: true } };
    assert.equal(resolveDeferredPreload(above, { hasPoster: false }), 'metadata');
    assert.equal(resolveDeferredPreload(above, { hasPoster: true }), 'none');
    assert.equal(resolveDeferredPreload({}, { hasPoster: false }), 'none');
  });
});

describe('SCA-1468 the initializer gate finds videos wherever they live', () => {
  const deferred = { name: 'video', attributes: { autoplay: true } };

  test('a nested video is found', () => {
    assert.equal(treeHasDeferredAutoplayVideo([{ name: 'div', children: [{ name: 'section', children: [deferred] }] }]), true);
  });

  test('a rich-text-embedded component\'s pre-resolved layers are searched', () => {
    assert.equal(treeHasDeferredAutoplayVideo([{
      name: 'text',
      variables: {
        text: {
          type: 'dynamic_rich_text',
          data: { content: { content: [{ type: 'richTextComponent', attrs: { _resolvedLayers: [deferred] } }] } },
        },
      },
    }]), true);
  });

  test('VACUITY GUARD: a page with no deferred video does not mount the driver', () => {
    assert.equal(treeHasDeferredAutoplayVideo([{ name: 'video', attributes: {} }]), false);
    assert.equal(treeHasDeferredAutoplayVideo([{ name: 'video', attributes: { autoplay: true, [DEFER_ATTR]: false } }]), false);
    assert.equal(treeHasDeferredAutoplayVideo([]), false);
    assert.equal(treeHasDeferredAutoplayVideo(null), false);
  });
});
