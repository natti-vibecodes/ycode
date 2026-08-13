import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { canvasRootAttributes, syncCanvasRootAttributes } from './canvas-root-attributes';

/**
 * SCA-1343. The canvas loaded the real stylesheets (SCA-1337) without the root context they
 * branch on, so theme-dependent sections rendered dark in the editor and light on the site.
 * Stub root rather than a browser — this repo has no DOM test environment. Whether the canvas
 * then REPAINTS is not proven here.
 */

/** The real declaration, as it sits in her global head custom code. */
const REAL_HEAD = `<!-- SCA-1253 colour fix -->
  <meta name="ycode:html-attributes" content='{"data-theme":"light"}'>
  <style id="scal-tokens">:root{--ink:#111}</style>`;

function stubRoot(initial: Record<string, string> = {}) {
  const attrs: Record<string, string> = { ...initial };
  return {
    attrs,
    getAttribute: (k: string) => (k in attrs ? attrs[k] : null),
    setAttribute: (k: string, v: string) => { attrs[k] = v; },
    removeAttribute: (k: string) => { delete attrs[k]; },
  };
}
const sync = (root: ReturnType<typeof stubRoot>, attrs: Record<string, string>) =>
  syncCanvasRootAttributes(root as unknown as HTMLElement, attrs);

describe('canvasRootAttributes (SCA-1343)', () => {
  test('REGRESSION: reads the theme the served page stamps', () => {
    assert.deepEqual(canvasRootAttributes(REAL_HEAD), { 'data-theme': 'light' });
  });

  test('class is returned in HTML spelling, not React spelling', () => {
    // extractHtmlAttributes renames class -> className for JSX; setAttribute needs it back.
    assert.deepEqual(
      canvasRootAttributes(`<meta name="ycode:html-attributes" content='{"class":"dark"}'>`),
      { class: 'dark' }
    );
  });

  test('no declaration means no attributes — the canvas root is left alone', () => {
    assert.deepEqual(canvasRootAttributes('<meta charset="utf-8">'), {});
    assert.deepEqual(canvasRootAttributes(null), {});
  });

  test('FORWARD-COMPAT: a dark declaration flows through with no code change (SCA-1302)', () => {
    assert.deepEqual(
      canvasRootAttributes(`<meta name="ycode:html-attributes" content='{"data-theme":"dark"}'>`),
      { 'data-theme': 'dark' }
    );
  });
});

describe('syncCanvasRootAttributes (SCA-1343)', () => {
  test('stamps the declared attributes onto the root', () => {
    const root = stubRoot();
    sync(root, { 'data-theme': 'light' });
    assert.equal(root.attrs['data-theme'], 'light');
  });

  test('a changed declaration replaces the old value', () => {
    const root = stubRoot();
    sync(root, { 'data-theme': 'light' });
    sync(root, { 'data-theme': 'dark' });
    assert.equal(root.attrs['data-theme'], 'dark');
  });

  test('REGRESSION: a withdrawn declaration removes the attribute', () => {
    // Leaving a stale data-theme behind would pin the canvas to a theme the site no longer has.
    const root = stubRoot();
    sync(root, { 'data-theme': 'light' });
    sync(root, {});
    assert.equal('data-theme' in root.attrs, false);
  });

  test('attributes we did not stamp are never removed', () => {
    // The iframe root belongs to the browser and to Ycode. Reconciling over ALL attributes
    // instead of the ones we recorded would strip theirs.
    const root = stubRoot({ lang: 'en', 'data-ycode-canvas': 'true' });
    sync(root, { 'data-theme': 'light' });
    sync(root, {});
    assert.equal(root.attrs.lang, 'en');
    assert.equal(root.attrs['data-ycode-canvas'], 'true');
  });

  test('a re-run with the same declaration writes nothing', () => {
    const root = stubRoot();
    sync(root, { 'data-theme': 'light' });
    let writes = 0;
    const counting = {
      ...root,
      setAttribute: (k: string, v: string) => { writes++; root.attrs[k] = v; },
    };
    syncCanvasRootAttributes(counting as unknown as HTMLElement, { 'data-theme': 'light' });
    // Only the bookkeeping attribute is rewritten; the theme itself is already correct.
    assert.equal(writes, 1);
  });

  test('dropping one of several attributes keeps the rest', () => {
    const root = stubRoot();
    sync(root, { 'data-theme': 'light', lang: 'en' });
    sync(root, { 'data-theme': 'light' });
    assert.equal(root.attrs['data-theme'], 'light');
    assert.equal('lang' in root.attrs, false);
  });

  test('the runtime armed classes are NOT part of this — they must stay absent', () => {
    // site.js adds nav-armed/reveal-armed on the real site. The canvas runs no scripts, and
    // `html.reveal-armed .reveal{opacity:0}` would hide content nothing will ever reveal.
    // Driving off the declaration (not off a served root) is what keeps them out.
    assert.deepEqual(canvasRootAttributes(REAL_HEAD), { 'data-theme': 'light' });
    assert.equal('class' in canvasRootAttributes(REAL_HEAD), false);
  });
});
