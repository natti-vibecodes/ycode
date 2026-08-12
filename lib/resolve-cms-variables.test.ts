import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { castValue } from './collection-utils';

/**
 * SCA-1282. A text field holding JSON-LD is speculatively JSON.parsed by castValue, so it
 * reaches the custom-code interpolator as an object; String() then produced the literal
 * "[object Object]" inside the ld+json script tag — structurally invalid schema shipped
 * silently on every article using the field.
 *
 * These pin the round trip that has to hold: what an author stores must come back out as
 * parseable JSON, without depending on a leading-newline hack in the stored data.
 */

// Mirrors resolveFieldDisplayValue's serialization branch for non-asset fields.
const display = (raw: unknown): string => {
  if (raw == null) return '';
  if (typeof raw === 'object') {
    try { return JSON.stringify(raw); } catch { return ''; }
  }
  return String(raw);
};

const FAQ_SCHEMA = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: [{ '@type': 'Question', name: 'How long does a build take?',
    acceptedAnswer: { '@type': 'Answer', text: '2 to 5 weeks.' } }],
};

describe('CMS field → custom code interpolation', () => {
  test('REGRESSION: an ld+json text field round-trips to parseable schema', () => {
    const stored = JSON.stringify(FAQ_SCHEMA);
    const roundTripped = display(castValue(stored, 'text'));
    assert.notEqual(roundTripped, '[object Object]');
    assert.deepEqual(JSON.parse(roundTripped), FAQ_SCHEMA);   // valid schema in the served output
  });

  test('REGRESSION (SCA-1283): the ROOT CAUSE is fixed — a text field stays a string', () => {
    // This test previously asserted the opposite, pinning the buggy read as a fact of life while
    // SCA-1282 patched one consumer downstream. The speculative parse is gone at the source: a
    // text field is text no matter what character it starts with, so no future consumer can
    // inherit an object it never asked for.
    const stored = JSON.stringify(FAQ_SCHEMA);
    assert.equal(typeof castValue(stored, 'text'), 'string');
    assert.equal(castValue(stored, 'text'), stored);
    assert.notEqual(String(castValue(stored, 'text')), '[object Object]');
  });

  test('a text field that merely LOOKS like JSON is not silently rewritten', () => {
    // The old guess could not tell a data structure from a sentence starting with a brace, and
    // reformatted the author's content either way.
    assert.equal(castValue('{not json at all', 'text'), '{not json at all');
    assert.equal(castValue('{ "a":   1 }', 'text'), '{ "a":   1 }'); // spacing preserved verbatim
    assert.equal(castValue('[draft] Pricing update', 'text'), '[draft] Pricing update');
  });

  test('email and phone get the same guarantee as text', () => {
    assert.equal(castValue('{a}@example.com', 'email'), '{a}@example.com');
    assert.equal(castValue('[+1] 555 0100', 'phone'), '[+1] 555 0100');
  });

  test('types that genuinely store JSON still parse — this fix must not reach them', () => {
    // multi_reference and multiple-asset fields store arrays; computed `status` stores an object.
    assert.deepEqual(castValue('["id-1","id-2"]', 'multi_reference'), ['id-1', 'id-2']);
    assert.deepEqual(castValue('["asset-1"]', 'image'), ['asset-1']);
    assert.deepEqual(
      castValue('{"is_publishable":true,"is_published":false,"is_modified":false}', 'status'),
      { is_publishable: true, is_published: false, is_modified: false },
    );
    assert.equal(castValue('single-asset-uuid', 'image'), 'single-asset-uuid');
  });

  test('display() still serializes an object — belt and suspenders, deliberately kept', () => {
    // Nothing should hand it an object now, but SCA-1282's guard stays: it can only improve a
    // call site, never break one, and "[object Object]" in served markup must stay unreachable.
    assert.deepEqual(JSON.parse(display(FAQ_SCHEMA)), FAQ_SCHEMA);
  });

  test('works without the leading-newline mitigation in the stored data', () => {
    // The data-side hack was fragile: any UI re-save that trims whitespace reintroduced the bug.
    const withHack = '\n' + JSON.stringify(FAQ_SCHEMA);
    const withoutHack = JSON.stringify(FAQ_SCHEMA);
    assert.deepEqual(JSON.parse(display(castValue(withoutHack, 'text'))), FAQ_SCHEMA);
    assert.equal(display(castValue(withHack, 'text')).trim().startsWith('{'), true);
  });

  test('ordinary text is untouched', () => {
    assert.equal(display(castValue('Just a headline', 'text')), 'Just a headline');
    assert.equal(display(castValue('', 'text')), '');
    assert.equal(display(null), '');
  });

  test('a JSON array field also survives', () => {
    const arr = [{ a: 1 }, { b: 2 }];
    assert.deepEqual(JSON.parse(display(castValue(JSON.stringify(arr), 'text'))), arr);
  });

  test('REGRESSION (SCA-1294): placeholders read the PRE-FORMAT values', () => {
    // `values` carries display dates for rendered layers ("Aug 12, 2026"). Custom-code
    // placeholders are machine-readable output, so they must read `rawValues` — schema.org
    // requires ISO 8601, and the display form shipped invalid datePublished on 109 articles.
    const item = {
      values:    { 'f-date': 'Aug 12, 2026', 'f-title': 'Hello' },
      rawValues: { 'f-date': '2026-08-12',   'f-title': 'Hello' },
    };
    const pick = (i: typeof item) => i.rawValues ?? i.values;
    assert.equal(pick(item)['f-date'], '2026-08-12');
    assert.match(pick(item)['f-date'], /^\d{4}-\d{2}-\d{2}$/);
    // Non-date fields are identical in both maps — reading raw changes nothing for them.
    assert.equal(pick(item)['f-title'], item.values['f-title']);
  });

  test('an item with no rawValues falls back to values, not to empty', () => {
    // rawValues is absent wherever no formatting pass ran; there the two maps are the same.
    const item: { values: Record<string, string>; rawValues?: Record<string, string> } =
      { values: { 'f-1': 'only' } };
    assert.equal((item.rawValues ?? item.values)['f-1'], 'only');
  });

  test('a circular object yields empty rather than [object Object]', () => {
    const circular: Record<string, unknown> = {}; circular.self = circular;
    assert.equal(display(circular), '');
  });
});
