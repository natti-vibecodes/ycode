import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {
  extractHtmlAttributes,
  extractStyleBlockContents,
  extractStylesheetHrefs,
  renderRootLayoutHeadCode,
} from './parse-head-html';

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

/**
 * SCA-1458. `renderRootLayoutHeadCode` scanned the global head setting with a regex that had no
 * concept of an HTML comment, so ordinary explanatory prose was rendered as markup. Measured on
 * :3002 on 2026-09-06 from ONE comment added to `tools/ycode/head.html`, two separate sitewide
 * failures:
 *
 *   1. the words "the first <link> below" matched the void branch → a phantom attribute-less
 *      <link> in <head> → "Hydration failed because the server rendered HTML didn't match the
 *      client" on every page;
 *   2. the words "every custom-code <script>" matched the PAIRED branch, whose non-greedy body
 *      ran forward to the next REAL </script> and swallowed the font preloads, both stylesheet
 *      links and the token <style> block into one phantom script's innerHTML — i.e. it deleted
 *      the site's CSS from the head, then threw a replaceWith SyntaxError from the activator.
 *
 * These assert on the RENDERED ELEMENT LIST, not on the input string: the population law says a
 * check must look at what the parser produced, and the earlier attempt at a parser test was fed
 * the rendered output, which had already stripped the comments that break the parser.
 */
type RenderedTag = { type: string; props: Record<string, unknown> };

function render(html: string): RenderedTag[] {
  return renderRootLayoutHeadCode(html).map((node) => {
    const el = node as React.ReactElement<Record<string, unknown>>;
    const { key: _key, ...props } = el.props as Record<string, unknown> & { key?: unknown };
    void _key;
    return { type: el.type as string, props };
  });
}

/** Element names in order — the cheap discriminator for "did something phantom appear". */
function tagNames(html: string): string[] {
  return render(html).map((t) => t.type);
}

describe('renderRootLayoutHeadCode — comments are inert (SCA-1458)', () => {
  test('REGRESSION 1: a comment naming <link> does not render a phantom link', () => {
    // The exact prose that shipped and broke hydration sitewide, from tools/ycode/head.html
    // before commit 4928611 reworded it.
    const head = `<!-- PRECONNECT to the storage origin (audit 2026-09-06 #48, Codex confirmed there was none).
     Every page's two render-blocking stylesheets (site.css, cookie.css) and its site.js preload
     come from this one cross-origin host, and the browser only learns that when it parses the
     first <link> below — paying DNS + TCP + TLS before the CSS can even start downloading. -->
<link rel="preconnect" href="https://fbmruqiyqntekoqknswb.supabase.co" crossorigin>`;

    const rendered = render(head);
    assert.equal(rendered.length, 1, 'exactly one real tag in this fixture');
    assert.deepEqual(rendered[0], {
      type: 'link',
      props: {
        suppressHydrationWarning: true,
        rel: 'preconnect',
        href: 'https://fbmruqiyqntekoqknswb.supabase.co',
        crossOrigin: '',
      },
    });
  });

  test('REGRESSION 2: a comment naming <script> does not swallow the tags after it', () => {
    // Draft 2 of the same comment. The paired branch matched inside the comment and ran to the
    // ld+json script at the bottom of head.html, taking everything between with it.
    const head = `<!-- PRECONNECT to the storage origin.
     Every page's stylesheets, font preloads and every custom-code <script> come from this one
     cross-origin host. -->
<link rel="preconnect" href="https://cdn.example" crossorigin>
<link rel="preload" as="font" type="font/woff2" crossorigin href="https://cdn.example/twk-200.woff2">
<link rel="preload" as="font" type="font/woff2" crossorigin href="https://cdn.example/twk-300.woff2">
<link rel="preload" as="font" type="font/woff2" crossorigin href="https://cdn.example/twk-400.woff2">
<link rel="preload" as="font" type="font/woff2" crossorigin href="https://cdn.example/twk-500.woff2">
<link rel="stylesheet" href="https://cdn.example/a/abc/site.css" integrity="sha384-aaa" crossorigin="anonymous">
<link rel="stylesheet" href="https://cdn.example/a/def/cookie.css" integrity="sha384-bbb" crossorigin="anonymous">
<style id="scal-asset-repoint">.hero{background-image:url(https://cdn.example/hero.webp)}</style>
<script type="application/ld+json">{"@type":"Organization"}</script>`;

    // Population, stated before measuring: 7 links + 1 style + 1 script = 9 elements.
    assert.deepEqual(tagNames(head), [
      'link', 'link', 'link', 'link', 'link', 'link', 'link', 'style', 'script',
    ]);

    const rendered = render(head);
    const stylesheets = rendered.filter((t) => t.type === 'link' && t.props.rel === 'stylesheet');
    assert.equal(stylesheets.length, 2, 'both stylesheet links survive the comment');
    assert.equal(
      rendered.filter((t) => t.type === 'link' && t.props.rel === 'preload').length,
      4,
      'all four TWK font preloads survive the comment',
    );
    const style = rendered.find((t) => t.type === 'style');
    assert.equal(style?.props.id, 'scal-asset-repoint');
    assert.equal(
      (style?.props.dangerouslySetInnerHTML as { __html: string }).__html,
      '.hero{background-image:url(https://cdn.example/hero.webp)}',
    );
    // The ld+json script keeps its real type: it is data, not an executable script.
    const script = rendered.find((t) => t.type === 'script');
    assert.equal(script?.props.type, 'application/ld+json');
    assert.equal((script?.props.dangerouslySetInnerHTML as { __html: string }).__html, '{"@type":"Organization"}');
  });

  test('a comment naming <body> is inert too, and does not abort the scan', () => {
    // The mount walker's twin failure (SCA-1369): a DO-NOT-REMOVE comment containing <body>
    // ended the scan on its first iteration and silently disabled the whole mechanism.
    const head = `<!-- Ycode server-renders this element at the start of <body>. DO NOT REMOVE. -->
<meta name="ycode:html-attributes" content='{"data-theme":"light"}'>`;
    assert.deepEqual(tagNames(head), ['meta']);
  });

  test('the fixture from the incident renders the real head and nothing else', () => {
    const head = `<!-- Development's SCA-1253 colour fix. Ycode reads this and emits the attributes on
     <html> SERVER-SIDE, so there is no hydration mismatch for React to reconcile away.
     DO NOT REMOVE: this sync rewrites custom_code_head wholesale. -->
<meta name="ycode:html-attributes" content='{"data-theme":"light"}'>

<!-- 🔴 NEVER WRITE AN HTML TAG INSIDE A COMMENT IN THIS FILE. A first draft used the word
     <link> in angle brackets and every page threw a hydration failure; a second used <script>
     and the paired branch swallowed the stylesheets. Both went away with the brackets.
     TAG_REGEX matched <meta>, <link>, <base>, <style>, <title> and <noscript> alike. -->
<link rel="preconnect" href="https://cdn.example" crossorigin>
<style id="scal-tokens">:root{--ink:#111}</style>
<script type="application/ld+json">{"@type":"Organization","name":"Scalability"}</script>`;

    assert.deepEqual(tagNames(head), ['meta', 'link', 'style', 'script']);
    // And the declaration still comes from the REAL meta, not the one named inside a comment.
    assert.deepEqual(extractHtmlAttributes(head), { 'data-theme': 'light' });
  });

  test('comments INSIDE a script or style block are content, not markup', () => {
    // The other direction: stripping comments blindly would corrupt CSS and JS that legally
    // contain `<!--` (the historic script-hiding idiom) or a commented-out rule.
    const head = `<style>/* <!-- a commented-out rule: .x{color:red} --> */.y{color:blue}</style>
<script>var a = 1; /* <link rel="stylesheet" href="/evil.css"> */ var b = 2;</script>`;
    const rendered = render(head);
    assert.deepEqual(rendered.map((t) => t.type), ['style', 'script']);
    assert.equal(
      (rendered[0].props.dangerouslySetInnerHTML as { __html: string }).__html,
      '/* <!-- a commented-out rule: .x{color:red} --> */.y{color:blue}',
    );
    assert.match((rendered[1].props.dangerouslySetInnerHTML as { __html: string }).__html, /var b = 2;/);
  });

  test('real tags still render exactly as before — the parser was replaced, not the contract', () => {
    const head = `<title>Scalability</title>
<meta charset="utf-8">
<base href="/">
<noscript><link rel="stylesheet" href="/nojs.css"></noscript>
<script src="/site.js" defer fetchpriority="high"></script>`;
    const rendered = render(head);
    assert.deepEqual(rendered.map((t) => t.type), ['title', 'meta', 'base', 'noscript', 'script']);
    assert.equal(rendered[1].props.charSet, 'utf-8');
    assert.equal(rendered[2].props.href, '/');
    assert.equal(
      (rendered[3].props.dangerouslySetInnerHTML as { __html: string }).__html,
      '<link rel="stylesheet" href="/nojs.css">',
    );
    // An executable script is parked with the inert marker for HeadScriptActivator.
    assert.equal(rendered[4].props.type, 'text/ycode-deferred');
    assert.equal(rendered[4].props.src, '/site.js');
    assert.equal(rendered[4].props.fetchPriority, 'high');
  });

  test('an unterminated comment leaves the rest of the head inert rather than parsing it', () => {
    const head = `<meta charset="utf-8"><!-- oops <link rel="stylesheet" href="/x.css">`;
    assert.deepEqual(tagNames(head), ['meta']);
  });

  test('empty head code renders nothing', () => {
    assert.deepEqual(render(''), []);
  });
});

describe('the canvas readers ignore commented-out chrome (SCA-1458)', () => {
  test('a commented-out stylesheet is not injected into the canvas', () => {
    const head = `<!-- retired 2026-09-05: <link rel="stylesheet" href="/dark.css"> -->
<link rel="stylesheet" href="/site.css">`;
    assert.deepEqual(extractStylesheetHrefs(head), ['/site.css']);
  });

  test('a commented-out style block contributes no CSS', () => {
    const head = `<!-- old tokens: <style>:root{--ink:#fff}</style> -->
<style>:root{--ink:#111}</style>`;
    assert.equal(extractStyleBlockContents(head), ':root{--ink:#111}');
  });

  test('a commented-out html-attributes declaration does not win over the real one', () => {
    const head = `<!-- was: <meta name="ycode:html-attributes" content='{"data-theme":"dark"}'> -->
<meta name="ycode:html-attributes" content='{"data-theme":"light"}'>`;
    assert.deepEqual(extractHtmlAttributes(head), { 'data-theme': 'light' });
  });

  test('a declaration that only exists inside a comment declares nothing', () => {
    const head = `<!-- <meta name="ycode:html-attributes" content='{"data-theme":"dark"}'> -->`;
    assert.deepEqual(extractHtmlAttributes(head), {});
  });
});
