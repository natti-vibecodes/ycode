import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractHtmlAttributes } from './parse-head-html';

/**
 * SCA-1253. A script in custom head code cannot durably set attributes on <html>: it runs at
 * parse time, then React strips unknown attributes when it hydrates <html>. A pre-paint theme
 * stamp was landing and being silently removed, which killed every [data-theme=…] rule on the
 * site. These attributes must therefore be rendered by the server.
 */
describe('extractHtmlAttributes', () => {
  test('REGRESSION: reads the theme declaration so data-theme is server-rendered', () => {
    const head = `<meta name="ycode:html-attributes" content='{"data-theme":"light"}'>
      <script>document.documentElement.setAttribute('data-theme','light')</script>`;
    assert.deepEqual(extractHtmlAttributes(head), { 'data-theme': 'light' });
  });

  test('no declaration means no attributes — the default stays untouched', () => {
    assert.deepEqual(extractHtmlAttributes('<meta charset="utf-8">'), {});
    assert.deepEqual(extractHtmlAttributes(''), {});
    assert.deepEqual(extractHtmlAttributes(null), {});
    assert.deepEqual(extractHtmlAttributes(undefined), {});
  });

  test('malformed JSON degrades to no attributes rather than breaking the page', () => {
    // Custom code is hand-authored; a stray quote must not take every page down with a 500.
    const head = `<meta name="ycode:html-attributes" content='{"data-theme": oops}'>`;
    assert.deepEqual(extractHtmlAttributes(head), {});
  });

  test('only theming/locale attributes are allowed onto the root element', () => {
    const head = `<meta name="ycode:html-attributes" content='{"data-theme":"dark","lang":"fr","dir":"rtl","onclick":"steal()","id":"x"}'>`;
    const out = extractHtmlAttributes(head);
    assert.deepEqual(out, { 'data-theme': 'dark', lang: 'fr', dir: 'rtl' });
    assert.equal('onclick' in out, false);
    assert.equal('id' in out, false);
  });

  test('class is mapped to className so React accepts it', () => {
    const head = `<meta name="ycode:html-attributes" content='{"class":"dark"}'>`;
    assert.deepEqual(extractHtmlAttributes(head), { className: 'dark' });
  });

  test('handles double-quoted content and HTML-escaped quotes', () => {
    assert.deepEqual(
      extractHtmlAttributes(`<meta name="ycode:html-attributes" content="{&quot;data-theme&quot;:&quot;light&quot;}">`),
      { 'data-theme': 'light' },
    );
  });

  test('non-string values are ignored, numbers coerced', () => {
    const head = `<meta name="ycode:html-attributes" content='{"data-a":{"nested":1},"data-b":2}'>`;
    assert.deepEqual(extractHtmlAttributes(head), { 'data-b': '2' });
  });

  test('a JSON array or scalar is not treated as attributes', () => {
    for (const c of ['[1,2]', '"str"', '5']) {
      assert.deepEqual(extractHtmlAttributes(`<meta name="ycode:html-attributes" content='${c}'>`), {});
    }
  });
});
