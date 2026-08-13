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
    // This test's NAME always said "ignored". Its assertions, until SCA-1369, pinned the exact
    // opposite: that the nested child was lifted out and its parent left hollow. So the suite
    // reported "nested is ignored ✔" while certifying that nested was lifted — a green test
    // asserting the reverse of its own title, which is worse than no test, because it is read as
    // proof. The module header made the same claim the title did, so two sources agreed with each
    // other and neither agreed with the code.
    //
    // Corrected to the documented, safer rule: only a TOP-LEVEL element may declare a mount.
    // Lifting a child out of its parent leaves `<div class="wrap"></div>` behind and silently
    // breaks any `.wrap > .inner` selector.
    const html = `<div class="wrap"><div class="inner" ${MOUNT_ATTR}="body-start">x</div></div>`;
    const { bodyStart, rest } = splitCustomCodeByMount(html);
    assert.equal(bodyStart, '');
    assert.equal(rest, html);
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

/**
 * SCA-1369 — the symmetric `body-end` mount.
 *
 * PageRenderer's order is: body-start global (nav) → layer tree → remaining global (footer) →
 * page custom_code.body. That is correct for a page whose content lives in its LAYER TREE. The 20
 * case-study pages keep ~75 KB of content in page custom code with an EMPTY layer tree, so they
 * served NAV → FOOTER → CONTENT — the footer at the top of every case study.
 *
 * The fix is a mount the footer OPTS INTO, not a reordering of the two injectors: swapping global
 * and page body code wholesale would silently change ordering on every page, including page-body
 * scripts written assuming global code already ran.
 */
describe('body-end mount (SCA-1369)', () => {
  const FOOTER = '<footer data-ycode-mount="body-end"><p>© Scalability</p></footer>';
  const NAV = '<div class="navwrap" data-ycode-mount="body-start"><nav>n</nav></div>';

  test('REGRESSION: THE opt-in property — code declaring nothing is byte-for-byte unmoved', () => {
    // The whole safety case. If this fails, every page's script order changed to fix 20 pages.
    const plain = '<div id="analytics"></div><script>init()</script>';
    const out = splitCustomCodeByMount(plain);
    assert.equal(out.rest, plain);
    assert.equal(out.bodyStart, '');
    assert.equal(out.bodyEnd, '');
  });

  test('a footer declaring body-end is lifted out of rest', () => {
    const out = splitCustomCodeByMount(`<div id="a"></div>${FOOTER}`);
    assert.equal(out.bodyEnd, FOOTER);
    assert.equal(out.rest, '<div id="a"></div>');
    assert.equal(out.bodyEnd.includes('Scalability'), true);
  });

  test('both mounts coexist, each landing in its own bucket', () => {
    const out = splitCustomCodeByMount(`${NAV}<div id="mid"></div>${FOOTER}`);
    assert.equal(out.bodyStart, NAV);
    assert.equal(out.bodyEnd, FOOTER);
    assert.equal(out.rest, '<div id="mid"></div>');
  });

  test('REGRESSION: a body-end chunk placed BEFORE a body-start one still routes correctly', () => {
    // Scanning for one mount and then the other would consume these out of document order and
    // put the footer's markup into `rest`.
    const out = splitCustomCodeByMount(`${FOOTER}${NAV}`);
    assert.equal(out.bodyEnd, FOOTER);
    assert.equal(out.bodyStart, NAV);
    assert.equal(out.rest.trim(), '');
  });

  test('multiple body-end chunks keep document order', () => {
    const a = '<div data-ycode-mount="body-end">A</div>';
    const b = '<div data-ycode-mount="body-end">B</div>';
    assert.equal(splitCustomCodeByMount(a + b).bodyEnd, `${a}\n${b}`);
  });

  test('a NESTED declaration is ignored, as with body-start', () => {
    // Only top-level elements may declare a mount; lifting a nested node out of its parent is
    // the DOM surgery this whole mechanism exists to avoid.
    const nested = '<div class="wrap"><footer data-ycode-mount="body-end">x</footer></div>';
    const out = splitCustomCodeByMount(nested);
    assert.equal(out.rest, nested);
    assert.equal(out.bodyEnd, '');
  });

  test('an unclosed element is left alone rather than silently swallowed', () => {
    const broken = '<footer data-ycode-mount="body-end">no closing tag';
    const out = splitCustomCodeByMount(broken);
    assert.equal(out.rest, broken);
    assert.equal(out.bodyEnd, '');
  });

  test('an unknown mount value is not treated as body-end', () => {
    const odd = '<div data-ycode-mount="body-middle">x</div>';
    assert.equal(splitCustomCodeByMount(odd).rest, odd);
    assert.equal(splitCustomCodeByMount(odd).bodyEnd, '');
  });

  test('empty and null input yield all three fields, not undefined', () => {
    for (const input of ['', null, undefined]) {
      const out = splitCustomCodeByMount(input);
      assert.equal(out.bodyStart, '');
      assert.equal(out.bodyEnd, '');
      assert.equal(out.rest, '');
    }
  });
});

/**
 * SCA-1371 — the page-level `before-layers` mount.
 *
 * The 20 case studies keep their whole article in page custom_code.body with an EMPTY layer tree,
 * so it rendered after everything else on the page. This lets a page declare that its body comes
 * before the layer tree, WITHOUT moving the content out of the server HTML.
 *
 * That last part is the reason this primitive exists instead of an htmlEmbed migration: embeds
 * are a sandboxed iframe or client-side innerHTML, so migrating 20 ranking pages into them would
 * have pulled their content out of the crawlable response.
 */
describe('before-layers mount (SCA-1371)', () => {
  const ARTICLE = '<article data-ycode-mount="before-layers"><h1>Aegis Capital</h1></article>';

  test('REGRESSION: a page declaring nothing is byte-for-byte unchanged', () => {
    // /case-studies keeps a filter script in page body and declares no mount. If this fails,
    // one opt-in feature reordered every page's body code.
    const filterScript = '<script>initFilters()</script><div id="x"></div>';
    const out = splitCustomCodeByMount(filterScript);
    assert.equal(out.rest, filterScript);
    assert.equal(out.beforeLayers, '');
  });

  test('a declaring article is lifted out of rest', () => {
    const out = splitCustomCodeByMount(`${ARTICLE}<script>tail()</script>`);
    assert.equal(out.beforeLayers, ARTICLE);
    assert.equal(out.rest, '<script>tail()</script>');
  });

  test('all three mounts route independently in one pass', () => {
    const nav = '<div data-ycode-mount="body-start">n</div>';
    const foot = '<footer data-ycode-mount="body-end">f</footer>';
    const out = splitCustomCodeByMount(`${foot}${ARTICLE}${nav}`);
    assert.equal(out.bodyStart, nav);
    assert.equal(out.bodyEnd, foot);
    assert.equal(out.beforeLayers, ARTICLE);
    assert.equal(out.rest.trim(), '');
  });

  test('multiple before-layers chunks keep document order', () => {
    const a = '<section data-ycode-mount="before-layers">A</section>';
    const b = '<section data-ycode-mount="before-layers">B</section>';
    assert.equal(splitCustomCodeByMount(a + b).beforeLayers, `${a}\n${b}`);
  });

  test('nested declarations are ignored here too', () => {
    const nested = '<div class="wrap"><article data-ycode-mount="before-layers">x</article></div>';
    const out = splitCustomCodeByMount(nested);
    assert.equal(out.beforeLayers, '');
    assert.equal(out.rest, nested);
  });

  test('every split result carries all four fields', () => {
    // A caller destructuring `beforeLayers` must never get undefined and render nothing silently.
    for (const input of ['', null, undefined, '<div>plain</div>']) {
      const out = splitCustomCodeByMount(input);
      assert.equal(typeof out.bodyStart, 'string');
      assert.equal(typeof out.bodyEnd, 'string');
      assert.equal(typeof out.beforeLayers, 'string');
      assert.equal(typeof out.rest, 'string');
    }
  });
});

/**
 * SCA-1369 regression, found on the live chrome — the reason mounts must skip comments.
 *
 * The real custom_code_body opens with a DO-NOT-REMOVE comment that explains the mechanism and,
 * in doing so, contains the text `<body>`. The top-level walk matched that as an element, looked
 * for a `</body>` that does not exist, hit the unclosed-element guard and abandoned the scan on
 * its FIRST iteration — so nothing was routed and every mount went inert.
 *
 * It hid because `rest` preserves document order: the nav is first in the file, so it still
 * rendered first and body-start looked like it was working. The footer being in the wrong place
 * was the only visible symptom, and that was read as "the new body-end fix doesn't work" rather
 * than "the fix broke the mount that already worked".
 */
describe('comments cannot break the walk (SCA-1369 regression)', () => {
  const REAL_SHAPE = `    <!-- data-ycode-mount="body-start" is Development's SCA-1253 fix: Ycode
     server-renders this element at the start of <body>, so no client-side hoist is needed. -->
<div class="navwrap" data-ycode-mount="body-start"><nav>n</nav></div>
<footer data-ycode-mount="body-end"><p>&copy; 2026</p></footer>`;

  test('REGRESSION: a comment mentioning <body> does not abort the scan', () => {
    const out = splitCustomCodeByMount(REAL_SHAPE);
    assert.ok(out.bodyStart.includes('navwrap'), 'nav must still be hoisted');
    assert.ok(out.bodyEnd.includes('<footer'), 'footer must reach body-end');
    assert.equal(out.rest.includes('<footer'), false);
  });

  test('the comment itself survives in rest, byte-for-byte', () => {
    // It is a DO-NOT-REMOVE comment; silently eating it would be its own bug.
    const out = splitCustomCodeByMount(REAL_SHAPE);
    assert.ok(out.rest.includes('SCA-1253 fix'), 'comment text must be preserved');
    assert.ok(out.rest.includes('<body>'), 'including the tag-like text inside it');
  });

  test('a comment containing a full element does not swallow the real one', () => {
    const html = `<!-- example: <footer data-ycode-mount="body-end">x</footer> -->
<footer data-ycode-mount="body-end">real</footer>`;
    const out = splitCustomCodeByMount(html);
    assert.equal(out.bodyEnd.includes('real'), true);
    assert.equal((out.bodyEnd.match(/<footer/g) || []).length, 1, 'only the real footer is routed');
  });

  test('the HOUSE COMMENT STYLE — quoting the mount attribute in prose — is safe', () => {
    // The cards lane flagged this: nav.html's comment (which broke the walk) and the footer
    // comment they added both QUOTE the attribute and describe render order in prose. The house
    // style will keep producing this family, so it is fixtured rather than left to luck — their
    // footer comment avoided compounding the bug by not containing a literal <body>, which was
    // chance, not design.
    const houseStyle = `<!-- data-ycode-mount="body-end" is Development's SCA-1369 fix. Global body
     code renders before page content, so a page whose article lives in custom code would show the
     footer above it. Value is exactly "body-end"; "body-start" is the nav's. DO NOT REMOVE. -->
<footer data-ycode-mount="body-end"><p>&copy;</p></footer>`;
    const out = splitCustomCodeByMount(houseStyle);
    assert.ok(out.bodyEnd.includes('<footer'), 'the real footer must still route');
    assert.equal((out.bodyEnd.match(/<footer/g) || []).length, 1, 'the comment must not add a phantom');
    assert.ok(out.rest.includes('DO NOT REMOVE'), 'the comment survives');
  });

  test('an unterminated comment leaves the remainder exactly as authored', () => {
    const html = '<!-- never closed <div data-ycode-mount="body-end">x</div>';
    const out = splitCustomCodeByMount(html);
    assert.equal(out.rest, html);
    assert.equal(out.bodyEnd, '');
  });
});
