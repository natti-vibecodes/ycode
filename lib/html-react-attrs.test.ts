import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { HTML_TO_REACT_ATTRS } from './parse-head-html';

/**
 * SCA-1309. React does not merely warn about an HTML-spelled attribute — it DROPS the prop.
 * `autocomplete="email"` authored on a layer therefore never reached the rendered input, with
 * only a console line to show for it. These pin the renames so the silent-drop cannot return.
 */
describe('HTML_TO_REACT_ATTRS — form attributes', () => {
  test('REGRESSION: the three seen live are mapped', () => {
    assert.equal(HTML_TO_REACT_ATTRS['autocomplete'], 'autoComplete');
    assert.equal(HTML_TO_REACT_ATTRS['novalidate'], 'noValidate');
    assert.equal(HTML_TO_REACT_ATTRS['readonly'], 'readOnly');
  });

  test('the rest of the form surface is mapped too', () => {
    const expected: Record<string, string> = {
      formnovalidate: 'formNoValidate', formaction: 'formAction', formmethod: 'formMethod',
      formtarget: 'formTarget', formenctype: 'formEncType', enctype: 'encType',
      acceptcharset: 'acceptCharset', maxlength: 'maxLength', minlength: 'minLength',
      inputmode: 'inputMode', enterkeyhint: 'enterKeyHint', autocapitalize: 'autoCapitalize',
      spellcheck: 'spellCheck',
    };
    for (const [html, react] of Object.entries(expected)) {
      assert.equal(HTML_TO_REACT_ATTRS[html], react, html);
    }
  });

  test('every key is lowercase — lookups normalise before matching', () => {
    // applyCustomAttributes does HTML_TO_REACT_ATTRS[name.toLowerCase()]; a capitalised key
    // here would be unreachable and the attribute would silently pass through unmapped.
    for (const key of Object.keys(HTML_TO_REACT_ATTRS)) {
      assert.equal(key, key.toLowerCase(), key);
    }
  });

  test('no mapping is an identity, which would be a typo', () => {
    for (const [html, react] of Object.entries(HTML_TO_REACT_ATTRS)) {
      assert.notEqual(html, react, `${html} maps to itself`);
    }
  });

  test('previously-mapped attributes are untouched', () => {
    assert.equal(HTML_TO_REACT_ATTRS['class'], 'className');
    assert.equal(HTML_TO_REACT_ATTRS['for'], 'htmlFor');
    assert.equal(HTML_TO_REACT_ATTRS['stroke-width'], 'strokeWidth');
  });
});
