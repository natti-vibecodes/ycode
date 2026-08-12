import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  headingAnchorSlug, createHeadingAnchorRegistry, isHeadingTag, headingLayerText,
} from './heading-anchors';

/**
 * SCA-1313. The slug format is a COMPATIBILITY SURFACE: table-of-contents links and answer-engine
 * passage citations point at these ids. Changing the format silently breaks every existing deep
 * link while the page still returns 200 — so these pin the exact shape `0eeb9ee` shipped and
 * `tools/gen_article.py` mints.
 */
describe('headingAnchorSlug', () => {
  test('REGRESSION: byte-identical to the format article anchors already use', () => {
    assert.equal(headingAnchorSlug('What is AI development?'), 'what-is-ai-development');
    assert.equal(headingAnchorSlug('Best SaaS website designs in 2026'), 'best-saas-website-designs-in-2026');
    assert.equal(headingAnchorSlug('Cost & timeline'), 'cost-timeline');
    assert.equal(headingAnchorSlug('  Leading and trailing  '), 'leading-and-trailing');
    assert.equal(headingAnchorSlug('Multiple   spaces--and--dashes'), 'multiple-spaces-and-dashes');
  });

  test('strips markup before slugifying', () => {
    assert.equal(headingAnchorSlug('<em>Design</em> &amp; Branding'), 'design-amp-branding');
  });

  test('caps at 60 characters', () => {
    const slug = headingAnchorSlug('a'.repeat(200));
    assert.equal(slug.length, 60);
  });

  test('text with no slug-able characters falls back rather than producing an empty id', () => {
    // id="" is invalid and would collide with every other empty one.
    assert.equal(headingAnchorSlug('!!!'), 'section');
    assert.equal(headingAnchorSlug(''), 'section');
    assert.equal(headingAnchorSlug('日本語'), 'section');
  });
});

describe('createHeadingAnchorRegistry', () => {
  test('REGRESSION: the FIRST occurrence stays unsuffixed', () => {
    // Suffixing the original when a duplicate appears later would break every link already
    // pointing at it — the common case is a page gaining a second "FAQ" heading months on.
    const next = createHeadingAnchorRegistry();
    assert.equal(next('Overview'), 'overview');
    assert.equal(next('Overview'), 'overview-2');
    assert.equal(next('Overview'), 'overview-3');
  });

  test('different headings do not interfere', () => {
    const next = createHeadingAnchorRegistry();
    assert.equal(next('Pricing'), 'pricing');
    assert.equal(next('Process'), 'process');
    assert.equal(next('Pricing'), 'pricing-2');
  });

  test('registries are independent per document', () => {
    const a = createHeadingAnchorRegistry();
    const b = createHeadingAnchorRegistry();
    assert.equal(a('Intro'), 'intro');
    assert.equal(b('Intro'), 'intro'); // a fresh page starts clean
  });

  test('collision counting happens AFTER slugification', () => {
    // "Cost & timeline" and "Cost timeline" slug identically, so they must be deduped.
    const next = createHeadingAnchorRegistry();
    assert.equal(next('Cost & timeline'), 'cost-timeline');
    assert.equal(next('Cost timeline'), 'cost-timeline-2');
  });
});

describe('isHeadingTag', () => {
  test('h1-h6 only', () => {
    for (const t of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'H2']) assert.equal(isHeadingTag(t), true, t);
    for (const t of ['div', 'p', 'span', 'header', 'hgroup', '', null, undefined]) {
      assert.equal(isHeadingTag(t as string), false, String(t));
    }
  });
});

describe('headingLayerText', () => {
  test('reads static and dynamic text layers', () => {
    assert.equal(headingLayerText({ variables: { text: { type: 'static_text', data: { content: 'Our process' } } } }), 'Our process');
    assert.equal(headingLayerText({ variables: { text: { type: 'dynamic_text', data: { content: 'Bound title' } } } }), 'Bound title');
  });

  test('REGRESSION: reads dynamic_rich_text — the shape the page builder ACTUALLY produces', () => {
    // The first version of this function skipped rich-text docs, so it derived anchors for
    // exactly zero of 155 headings while every unit test passed. Page-builder headings are
    // dynamic_rich_text, not static_text.
    const doc = { type: 'doc', content: [{ type: 'paragraph', content: [
      { type: 'text', text: 'Custom ' }, { type: 'text', text: 'AI development' },
    ] }] };
    assert.equal(headingLayerText({ variables: { text: { type: 'dynamic_rich_text', data: { content: doc } } } }),
      'Custom AI development');
  });

  test('a container heading takes text from its descendants', () => {
    const child = { variables: { text: { type: 'static_text', data: { content: 'Enterprise ready' } } } };
    assert.equal(headingLayerText({ children: [child] }), 'Enterprise ready');
  });

  test('descendant walk is depth-bounded', () => {
    let deep: any = { variables: { text: { type: 'static_text', data: { content: 'buried' } } } };
    for (let i = 0; i < 8; i++) deep = { children: [deep] };
    assert.equal(headingLayerText(deep), '');
  });

  test('REGRESSION: unresolved or non-plain content yields NO anchor rather than a wrong one', () => {
    // A heading with no id is a missing feature; a heading with the wrong id is a broken deep
    // link that still returns 200 — strictly worse, and invisible.
    assert.equal(headingLayerText({ variables: { text: { type: 'field', data: { content: undefined } } } }), '');
    assert.equal(headingLayerText({ variables: {} }), '');
    assert.equal(headingLayerText({}), '');
  });
});
