import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildPublishManifest, pageUrl } from './publish-manifest';

const layer = (cls: string, children: any[] = [], componentId?: string) => ({
  id: 'l-' + cls + (componentId ?? ''),
  componentId,
  settings: { customAttributes: { class: cls } },
  children,
});

const NEWSLETTER = {
  id: 'comp-nl',
  name: 'Newsletter + Insights',
  layers: [layer('nl-sec', [layer('nl-zone', [layer('nl-form')])])],
};

/** Mirrors the real shape: two pages instance the component, one keeps its own copy. */
const PAGES = [
  { id: 'p-home', name: 'Homepage', slug: '', folder: null, layers: [layer('x', [], 'comp-nl')] },
  { id: 'p-db', name: 'Design & Branding', slug: 'design-branding', folder: 'services', layers: [layer('x', [], 'comp-nl')] },
  { id: 'p-wad', name: 'Web & App Development', slug: 'web-app-development', folder: 'services',
    layers: [layer('nl-sec', [layer('nl-zone', [layer('nl-form')])])] },
];

describe('pageUrl', () => {
  test('resolves at the full folder path — a bare slug 404s', () => {
    assert.equal(pageUrl({ slug: 'design-branding', folder: 'services' }), '/services/design-branding');
    assert.equal(pageUrl({ slug: '', folder: null }), '/');
    assert.equal(pageUrl({ slug: 'privacy-policy', folder: null }), '/privacy-policy');
  });
});

describe('buildPublishManifest (SCA-1272)', () => {
  const queuedComponent = {
    queued: { pages: [], components: [{ id: 'comp-nl', name: 'Newsletter + Insights' }] },
    components: [NEWSLETTER],
    pages: PAGES,
  };

  test('REGRESSION: names the page a component fix will NOT reach', () => {
    // The newsletter shipped wired on two pages and dead on a third, with every signal green.
    const m = buildPublishManifest(queuedComponent);
    assert.deepEqual(m.willShip.map((e) => e.pageName).sort(), ['Design & Branding', 'Homepage']);
    assert.equal(m.willNotReach.length, 1);
    assert.equal(m.willNotReach[0].pageName, 'Web & App Development');
    assert.match(m.summary, /will NOT get it/);
  });

  test('reach is reported per page with the reason attached', () => {
    const m = buildPublishManifest(queuedComponent);
    assert.deepEqual(m.willShip.find((e) => e.pageName === 'Homepage')?.reasons, ['renders “Newsletter + Insights”']);
    assert.equal(m.willShip.find((e) => e.pageName === 'Design & Branding')?.url, '/services/design-branding');
  });

  test('accepted divergence is reported but not called a defect', () => {
    // Page-local Collection Lists are a deliberate standard here. A manifest that flags policy
    // as breakage trains people to ignore it, which costs more than saying nothing.
    const m = buildPublishManifest({ ...queuedComponent, acceptedDivergence: ['comp-nl'] });
    assert.equal(m.willNotReach[0].accepted, true);
    assert.doesNotMatch(m.summary, /will NOT get it/);
  });

  test('a queued page ships on its own account', () => {
    const m = buildPublishManifest({
      queued: { pages: [{ id: 'p-wad', name: 'Web & App Development' }], components: [] },
      components: [NEWSLETTER], pages: PAGES,
    });
    assert.deepEqual(m.willShip.map((e) => e.pageName), ['Web & App Development']);
    assert.deepEqual(m.willShip[0].reasons, ['queued directly']);
  });

  test('a page both queued and reached is listed once, with both reasons', () => {
    const m = buildPublishManifest({
      queued: { pages: [{ id: 'p-home', name: 'Homepage' }], components: [{ id: 'comp-nl', name: 'Newsletter + Insights' }] },
      components: [NEWSLETTER], pages: PAGES,
    });
    const home = m.willShip.filter((e) => e.pageId === 'p-home');
    assert.equal(home.length, 1);
    assert.equal(home[0].reasons.length, 2);
  });

  test('REGRESSION: a server running older code than HEAD is flagged, not silent', () => {
    // adea726 reached staging through hot-reload only; a restart would have lost it, invisibly.
    const m = buildPublishManifest({ ...queuedComponent, bootCommit: 'aaaaaaa1', headCommit: 'bbbbbbb2' });
    assert.equal(m.runningCodeDrift.stale, true);
    assert.match(m.summary, /restart to be sure/);
  });

  test('matching boot and HEAD is not flagged', () => {
    const m = buildPublishManifest({ ...queuedComponent, bootCommit: 'same123', headCommit: 'same123' });
    assert.equal(m.runningCodeDrift.stale, false);
    assert.doesNotMatch(m.summary, /restart/);
  });

  test('every shipping page gets a verification target', () => {
    const m = buildPublishManifest(queuedComponent);
    assert.equal(m.verify.length, m.willShip.length);
    assert.deepEqual(m.verify.map((v) => v.url).sort(), ['/', '/services/design-branding']);
  });

  test('nothing queued produces an empty, honest manifest', () => {
    const m = buildPublishManifest({ queued: { pages: [], components: [] }, components: [NEWSLETTER], pages: PAGES });
    assert.deepEqual(m.willShip, []);
    assert.deepEqual(m.willNotReach, []);
    assert.match(m.summary, /^0 page\(s\)/);
  });
});
