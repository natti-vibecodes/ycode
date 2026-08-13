import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractHtmlAttributes, extractStylesheetHrefs } from './parse-head-html';

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

/**
 * SCA-1337. The canvas injected `<style>` block contents and nothing else, so a site whose design
 * system lives in an external stylesheet rendered unstyled in the editor and correct when
 * published. Natalia asked for this twice — she was editing hand-written sections against
 * Tailwind defaults while the real rules sat in a file the canvas never loaded.
 */
describe('extractStylesheetHrefs', () => {
  // The shape of the real setting: font preloads, then the stylesheet links.
  const REAL_HEAD = `<meta name="ycode:html-attributes" content='{"data-theme":"light"}'>
    <link rel="preload" as="font" type="font/woff2" crossorigin href="https://cdn.example/lausanne-300.woff2">
    <link rel="preload" as="font" type="font/woff2" crossorigin href="https://cdn.example/lausanne-400.woff2">
    <style id="scal-tokens">:root{--ink:#111}</style>
    <link rel="stylesheet" href="https://cdn.example/site.css">
    <link rel="stylesheet" href="https://cdn.example/overrides.css">`;

  test('REGRESSION: finds the external stylesheets the canvas was dropping', () => {
    assert.deepEqual(extractStylesheetHrefs(REAL_HEAD), [
      'https://cdn.example/site.css',
      'https://cdn.example/overrides.css',
    ]);
  });

  test('font preloads are NOT admitted', () => {
    // @font-face in the injected <style> block already delivers the fonts; a preload is a
    // fetch-priority hint with no rendering effect, so admitting it would add editor network
    // traffic and change nothing on screen.
    assert.deepEqual(extractStylesheetHrefs(
      '<link rel="preload" as="font" href="https://cdn.example/x.woff2">'
    ), []);
  });

  test('scripts stay out — the canvas sandbox boundary is unchanged', () => {
    assert.deepEqual(extractStylesheetHrefs(
      '<script src="https://cdn.example/tracker.js"></script><link rel="stylesheet" href="/a.css">'
    ), ['/a.css']);
  });

  test('rel is a token list, not a string', () => {
    assert.deepEqual(extractStylesheetHrefs('<link rel="alternate stylesheet" href="/b.css">'), ['/b.css']);
    assert.deepEqual(extractStylesheetHrefs('<link rel="STYLESHEET" href="/c.css">'), ['/c.css']);
    // A rel that merely CONTAINS the word must not match — substring comparison would admit these.
    assert.deepEqual(extractStylesheetHrefs('<link rel="stylesheet-preload" href="/d.css">'), []);
  });

  test('single quotes, self-closing and unquoted values all parse', () => {
    assert.deepEqual(extractStylesheetHrefs("<link rel='stylesheet' href='/e.css' />"), ['/e.css']);
    assert.deepEqual(extractStylesheetHrefs('<link rel=stylesheet href=/f.css>'), ['/f.css']);
  });

  test('duplicates collapse and href-less links are skipped', () => {
    assert.deepEqual(extractStylesheetHrefs(
      '<link rel="stylesheet" href="/g.css"><link rel="stylesheet"><link rel="stylesheet" href="/g.css">'
    ), ['/g.css']);
  });

  test('empty, null and undefined input yield no hrefs rather than throwing', () => {
    for (const input of ['', null, undefined]) {
      assert.deepEqual(extractStylesheetHrefs(input), []);
    }
  });

  test('a URL containing a > inside quotes does not truncate the tag', () => {
    assert.deepEqual(extractStylesheetHrefs('<link rel="stylesheet" href="/h.css?a=1>2">'), ['/h.css?a=1>2']);
  });
});
