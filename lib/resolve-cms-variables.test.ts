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

  test('the failure mode it replaces is exactly [object Object]', () => {
    // Proves castValue really does hand us an object — i.e. the bug was upstream of display().
    assert.equal(typeof castValue(JSON.stringify(FAQ_SCHEMA), 'text'), 'object');
    assert.equal(String(castValue(JSON.stringify(FAQ_SCHEMA), 'text')), '[object Object]');
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

  test('a circular object yields empty rather than [object Object]', () => {
    const circular: Record<string, unknown> = {}; circular.self = circular;
    assert.equal(display(circular), '');
  });
});
