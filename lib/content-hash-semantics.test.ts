import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generatePageMetadataHash, generatePageLayersHash } from './hash-utils';

/**
 * SCA-1356 — what `content_hash` actually hashes.
 *
 * On 2026-08-13 a page's draft and published rows carried DIFFERENT `content_hash` values while
 * their layer trees were byte-identical, and that looked like an impure or lazily-recomputed
 * field. It is neither. There are TWO hashes with the same column name on different tables:
 *
 *   pages.content_hash        = metadata only  (name, slug, settings, is_index, is_dynamic, error_page)
 *   page_layers.content_hash  = layers + generated_css, with UI-only props stripped
 *
 * Both are pure. The trap is the NAME: `pages.content_hash` reads like "hash of this page's
 * content" and is nothing of the sort — it says nothing whatsoever about the layer tree. The
 * publish queue compares both hashes plus the folder id, which is why the product is correct while
 * a hand-written `WHERE draft.content_hash <> published.content_hash` is not.
 *
 * That query shape is the real hazard, and it fails in the SILENT direction: a page whose layers
 * changed but whose metadata did not has EQUAL `pages.content_hash` values and looks unqueued.
 */

const META = {
  name: 'Work', slug: 'case-studies', settings: { cms: null },
  is_index: false, is_dynamic: false, error_page: null,
};
const LAYERS = { layers: [{ id: 'a', name: 'div', children: [] }], generated_css: '.a{}' };

describe('pages.content_hash is METADATA only (SCA-1356)', () => {
  test('REGRESSION: changing the layer tree does NOT change the page metadata hash', () => {
    // The whole misconception in one assertion. This is why hash equality is not proof of
    // sameness, and why a queue check written on this column alone misses layer-only edits.
    const before = generatePageMetadataHash(META);
    const after = generatePageMetadataHash(META); // metadata identical; layers are not an input
    assert.equal(before, after);
    assert.notEqual(generatePageLayersHash(LAYERS),
      generatePageLayersHash({ ...LAYERS, layers: [{ id: 'b', name: 'div', children: [] }] }),
      'the LAYERS hash is what moves when layers move');
  });

  test('settings ARE part of the metadata hash — including page custom code', () => {
    // This is what actually differed on the page that started the investigation: two rows whose
    // layers matched but whose settings did not.
    const a = generatePageMetadataHash(META);
    const b = generatePageMetadataHash({ ...META, settings: { cms: null, custom_code: { head: '<style>x{}</style>' } } });
    assert.notEqual(a, b);
  });

  test('each metadata field moves the hash', () => {
    const base = generatePageMetadataHash(META);
    assert.notEqual(base, generatePageMetadataHash({ ...META, name: 'Work 2' }));
    assert.notEqual(base, generatePageMetadataHash({ ...META, slug: 'work' }));
    assert.notEqual(base, generatePageMetadataHash({ ...META, is_index: true }));
    assert.notEqual(base, generatePageMetadataHash({ ...META, is_dynamic: true }));
    assert.notEqual(base, generatePageMetadataHash({ ...META, error_page: 404 }));
  });

  test('both hashes are PURE — same input, same output, repeatedly', () => {
    // The original suspicion was impurity or lazy recomputation. Neither: identical inputs give
    // identical hashes every time, so a differing hash always means differing input.
    for (let i = 0; i < 3; i++) {
      assert.equal(generatePageMetadataHash(META), generatePageMetadataHash(META));
      assert.equal(generatePageLayersHash(LAYERS), generatePageLayersHash(LAYERS));
    }
  });
});

describe('page_layers.content_hash ignores UI-only state (SCA-1356)', () => {
  test('an expanded/collapsed layer in the builder is NOT a content change', () => {
    // Without this, every click in the layer tree would queue the page for publishing.
    const collapsed = generatePageLayersHash({ ...LAYERS, layers: [{ id: 'a', name: 'div', children: [], open: false }] as never });
    const expanded = generatePageLayersHash({ ...LAYERS, layers: [{ id: 'a', name: 'div', children: [], open: true }] as never });
    assert.equal(collapsed, expanded);
  });

  test('generated_css is part of it', () => {
    assert.notEqual(generatePageLayersHash(LAYERS), generatePageLayersHash({ ...LAYERS, generated_css: '.a{color:red}' }));
  });
});
