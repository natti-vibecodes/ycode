import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { splitCustomCodeByMount, MOUNT_ATTR } from './custom-code-mount';

const NAV = `<div class="navwrap" ${MOUNT_ATTR}="body-start"><nav class="nav"><a href="/">Home</a></nav></div>`;
const FOOTER = `<footer class="ftr"><a href="/about">About</a></footer>`;
const SCRIPT = `<script src="/site.js"></script>`;

describe('splitCustomCodeByMount (SCA-1253)', () => {
  test('sites that never opt in are byte-for-byte unaffected', () => {
    const html = FOOTER + SCRIPT;
    const { bodyStart, rest } = splitCustomCodeByMount(html);
    assert.equal(bodyStart, '');
    assert.equal(rest, html);
  });

  test('null/empty input is safe', () => {
    for (const v of [null, undefined, '']) {
      const out = splitCustomCodeByMount(v);
      assert.equal(out.bodyStart, '');
      assert.equal(out.rest, '');
    }
  });

  test('a declared element is lifted out and the rest keeps its order', () => {
    const { bodyStart, rest } = splitCustomCodeByMount(NAV + FOOTER + SCRIPT);
    assert.equal(bodyStart, NAV);
    assert.equal(rest, FOOTER + SCRIPT);
    // nothing is lost or duplicated
    assert.equal((bodyStart + rest).length, (NAV + FOOTER + SCRIPT).length);
  });

  test('nesting inside the declared element is preserved, not truncated at the first close tag', () => {
    // The nav contains nested <div>s; a naive indexOf('</div>') would cut it in half.
    const nested = `<div class="navwrap" ${MOUNT_ATTR}="body-start"><div class="a"><div class="b">x</div></div></div>`;
    const { bodyStart, rest } = splitCustomCodeByMount(nested + FOOTER);
    assert.equal(bodyStart, nested);
    assert.equal(rest, FOOTER);
  });

  test('a marker on a NESTED element is ignored — lifting it would be the DOM surgery we removed', () => {
    const html = `<div class="wrap"><div class="inner" ${MOUNT_ATTR}="body-start">x</div></div>`;
    const { bodyStart, rest } = splitCustomCodeByMount(html);
    assert.equal(bodyStart, `<div class="inner" ${MOUNT_ATTR}="body-start">x</div>`);
    assert.equal(rest, `<div class="wrap"></div>`);
  });

  test('several declared chunks keep document order', () => {
    const a = `<div id="a" ${MOUNT_ATTR}="body-start">A</div>`;
    const b = `<div id="b" ${MOUNT_ATTR}="body-start">B</div>`;
    const { bodyStart } = splitCustomCodeByMount(a + FOOTER + b);
    assert.equal(bodyStart, a + '\n' + b);
  });

  test('an unclosed declared element is left alone rather than swallowing the page', () => {
    // Malformed custom code must render as it always did, not silently lose everything after it.
    const html = `<div class="navwrap" ${MOUNT_ATTR}="body-start">oops` + FOOTER;
    const { bodyStart, rest } = splitCustomCodeByMount(html);
    assert.equal(bodyStart, '');
    assert.equal(rest, html);
  });

  test('single quotes and extra attributes are recognised', () => {
    const html = `<header data-x="1" ${MOUNT_ATTR}='body-start' class="c">H</header>` + FOOTER;
    const { bodyStart, rest } = splitCustomCodeByMount(html);
    assert.match(bodyStart, /^<header/);
    assert.equal(rest, FOOTER);
  });

  test('a void element declaring a mount point does not hang the scanner', () => {
    const html = `<img src="/x.png" ${MOUNT_ATTR}="body-start">` + FOOTER;
    const { bodyStart, rest } = splitCustomCodeByMount(html);
    assert.match(bodyStart, /^<img/);
    assert.equal(rest, FOOTER);
  });

  test('an unrelated mount value is left in place', () => {
    const html = `<div ${MOUNT_ATTR}="somewhere-else">x</div>` + FOOTER;
    const { bodyStart, rest } = splitCustomCodeByMount(html);
    assert.equal(bodyStart, '');
    assert.equal(rest, html);
  });
});
