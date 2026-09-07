import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { commentRanges, isInsideComment, tokenizeTags } from './html-tokenizer';

/**
 * SCA-1458. The tokenizer exists because every regex-over-authored-HTML reader in the fork has
 * eventually parsed prose out of a comment as markup. These pin the behaviour the readers rely
 * on: comments are inert, raw-text content is opaque, and a quoted `>` does not end a tag.
 */
describe('tokenizeTags', () => {
  const names = (html: string) => [...tokenizeTags(html)].map((t) => t.name);

  test('comments are skipped entirely, whatever they contain', () => {
    assert.deepEqual(names('<!-- <link> <script> <body> <meta charset=x> --><meta charset="utf-8">'), ['meta']);
  });

  test('a comment between two real tags does not break the pair', () => {
    assert.deepEqual(names('<meta a=1><!-- <link> --><link href="/x">'), ['meta', 'link']);
  });

  test('an unterminated comment swallows the remainder, as the HTML parser does', () => {
    assert.deepEqual(names('<meta charset="utf-8"><!-- oops <link href="/x">'), ['meta']);
  });

  test('doctypes, CDATA and processing instructions are not elements', () => {
    assert.deepEqual(names('<!DOCTYPE html><?xml version="1.0"?><meta charset="utf-8">'), ['meta']);
  });

  test('a stray closing tag is skipped without emitting anything', () => {
    assert.deepEqual(names('</div><meta charset="utf-8">'), ['meta']);
  });

  test('a bare `<` in text is not a tag', () => {
    assert.deepEqual(names('a < b and 3<4 <meta charset="utf-8">'), ['meta']);
  });

  test('tag names are lowercased; attribute names keep the authored case', () => {
    const [tag] = [...tokenizeTags('<META charSet="utf-8">')];
    assert.equal(tag.name, 'meta');
    assert.deepEqual(tag.attrs, { charSet: 'utf-8' });
  });

  test('quoted, single-quoted, unquoted and valueless attributes all parse', () => {
    const [tag] = [...tokenizeTags(`<link rel="stylesheet" href='/a.css' media=screen crossorigin>`)];
    assert.deepEqual(tag.attrs, { rel: 'stylesheet', href: '/a.css', media: 'screen', crossorigin: '' });
  });

  test('a `>` inside a quoted value does not end the tag', () => {
    const [tag] = [...tokenizeTags('<link rel="stylesheet" href="/h.css?a=1>2" id="after">')];
    assert.deepEqual(tag.attrs, { rel: 'stylesheet', href: '/h.css?a=1>2', id: 'after' });
  });

  test('self-closing and void tags both report selfClosing and carry no content', () => {
    const [selfClosed] = [...tokenizeTags('<link href="/a.css" />')];
    assert.equal(selfClosed.selfClosing, true);
    assert.equal(selfClosed.content, '');
    const [voidTag] = [...tokenizeTags('<meta charset="utf-8">')];
    assert.equal(voidTag.selfClosing, true);
  });

  test('raw-text content is opaque — a tag or comment inside a script is content', () => {
    const [tag] = [...tokenizeTags('<script>var a = "<link rel=x>"; /* <!-- --> */</script>')];
    assert.equal(tag.name, 'script');
    assert.equal(tag.content, 'var a = "<link rel=x>"; /* <!-- --> */');
  });

  test('a CSS string containing a closing style tag name still terminates correctly', () => {
    // The tokenizer ends raw text at the first `</style>`, which is exactly what a browser does —
    // this is a pinned limitation, not an aspiration.
    assert.deepEqual(names('<style>.a{content:"x"}</style><link href="/a.css">'), ['style', 'link']);
  });

  test('two adjacent scripts are two tokens, not one greedy match', () => {
    const tags = [...tokenizeTags('<script>a</script><script>b</script>')];
    assert.deepEqual(tags.map((t) => t.content), ['a', 'b']);
  });

  test('an unclosed raw-text element is skipped and scanning continues after it', () => {
    // Fail-safe: one malformed element is lost rather than every tag after it being swallowed.
    assert.deepEqual(names('<script src="/a.js"><link rel="stylesheet" href="/a.css">'), ['link']);
  });

  test('nested tags are yielded flat, in source order', () => {
    assert.deepEqual(names('<div><link href="/a.css"><span><meta charset="utf-8"></span></div>'), [
      'div', 'link', 'span', 'meta',
    ]);
  });

  test('offsets bound the element: start/openEnd/end line up with the source', () => {
    const html = 'x<style id="t">.a{}</style>y';
    const [tag] = [...tokenizeTags(html)];
    assert.equal(html.slice(tag.start, tag.openEnd), '<style id="t">');
    assert.equal(html.slice(tag.start, tag.end), '<style id="t">.a{}</style>');
    assert.equal(tag.content, '.a{}');
  });
});

describe('commentRanges / isInsideComment', () => {
  test('reports every comment range in order', () => {
    const html = '<!--a--><p><!--b-->';
    assert.deepEqual(commentRanges(html), [[0, 8], [11, 19]]);
  });

  test('an unterminated comment runs to the end of the input', () => {
    assert.deepEqual(commentRanges('ab<!--c'), [[2, 7]]);
  });

  test('no comments means no ranges, and nothing is inside one', () => {
    const ranges = commentRanges('<p>hi</p>');
    assert.deepEqual(ranges, []);
    assert.equal(isInsideComment(ranges, 0), false);
  });

  test('membership is half-open: the opening `<` is inside, the char after `-->` is not', () => {
    const ranges = commentRanges('<!--x-->y');
    assert.equal(isInsideComment(ranges, 0), true);
    assert.equal(isInsideComment(ranges, 7), true);  // the final '>'
    assert.equal(isInsideComment(ranges, 8), false); // 'y'
  });
});
