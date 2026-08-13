import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { stripEmptyJsonLd } from './strip-empty-json-ld';

/**
 * SCA-1290. CMS-driven schema is a template — `<script type="application/ld+json">{{FAQ
 * Schema}}</script>` — and the tag shipped whether or not the placeholder resolved to anything.
 * 85 of 113 /insight/* pages carried an empty schema block: exactly the ones with no FAQPage data.
 */

const FAQ = '<script type="application/ld+json">{"@type":"FAQPage"}</script>';
const EMPTY = '<script type="application/ld+json"></script>';

describe('stripEmptyJsonLd (SCA-1290)', () => {
  test('REGRESSION: a page WITHOUT the field emits nothing', () => {
    assert.equal(stripEmptyJsonLd(EMPTY).trim(), '');
  });

  test('REGRESSION: a page WITH the field keeps its block', () => {
    // The half that matters most: a strip that also removed real schema would be a far worse bug
    // than the one it fixes, and would look identical in a "no empty blocks" audit.
    assert.equal(stripEmptyJsonLd(FAQ), FAQ);
  });

  test('the empty one goes and the populated siblings stay — the real page shape', () => {
    // The reported URL had exactly this: 581 chars, 1191 chars, then 0.
    const page = `<head>${FAQ}<script type="application/ld+json">{"@type":"BlogPosting"}</script>${EMPTY}</head>`;
    const out = stripEmptyJsonLd(page);
    assert.equal(out.includes('FAQPage'), true);
    assert.equal(out.includes('BlogPosting'), true);
    assert.equal((out.match(/ld\+json/g) || []).length, 2, 'exactly the empty one should be gone');
  });

  test('whitespace-only counts as empty', () => {
    assert.equal(stripEmptyJsonLd('<script type="application/ld+json">\n  \n</script>').trim(), '');
  });

  test('extra attributes on the tag do not save it', () => {
    assert.equal(stripEmptyJsonLd('<script id="faq" type="application/ld+json" data-x="1"></script>').trim(), '');
    assert.equal(stripEmptyJsonLd("<script type='application/ld+json'></script>").trim(), '');
  });

  test('OTHER empty script types are left alone', () => {
    // A non-schema empty script may be a placeholder something later fills. Only ld+json is noise.
    const other = '<script type="text/template"></script>';
    assert.equal(stripEmptyJsonLd(other), other);
    const plain = '<script></script>';
    assert.equal(stripEmptyJsonLd(plain), plain);
  });

  test('input without any ld+json is returned untouched', () => {
    const html = '<head><meta charset="utf-8"></head>';
    assert.equal(stripEmptyJsonLd(html), html);
  });
});
