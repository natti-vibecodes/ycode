import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { findStructuralDivergence, signatureClasses, type DivergenceComponent, type DivergencePage } from './component-divergence';

const cls = (c: string, children: any[] = [], componentId?: string) => ({
  id: 'l-' + Math.random().toString(36).slice(2),
  componentId,
  settings: { customAttributes: { class: c } },
  children,
});

/** Mirrors the real "Newsletter + Insights" master closely enough to be meaningful. */
const NEWSLETTER: DivergenceComponent = {
  id: 'comp-newsletter',
  name: 'Newsletter + Insights',
  layers: [cls('nl-sec', [cls('nl-zone', [cls('nl-form', [cls('nl-legal')])])])],
};

describe('findStructuralDivergence (SCA-1272)', () => {
  test('REGRESSION: catches the page holding its own copy — the case that shipped broken', () => {
    // /services/web-app-development was cloned from design-branding BEFORE the section became a
    // component, so it kept a private copy and every component-level fix silently missed it.
    const pages: DivergencePage[] = [
      { id: 'p-db',  name: 'Design & Branding',      layers: [cls('sec', [], 'comp-newsletter')] },
      { id: 'p-wad', name: 'Web & App Development',  layers: [cls('nl-sec', [cls('nl-zone', [cls('nl-form')])])] },
    ];
    const found = findStructuralDivergence([NEWSLETTER], pages);
    assert.equal(found.length, 1);
    assert.equal(found[0].pageName, 'Web & App Development');
    assert.deepEqual(found[0].matchedClasses, ['nl-form', 'nl-sec', 'nl-zone']);
  });

  test('a page using the component properly is never flagged', () => {
    const pages: DivergencePage[] = [{ id: 'p', name: 'Home', layers: [cls('sec', [], 'comp-newsletter')] }];
    assert.deepEqual(findStructuralDivergence([NEWSLETTER], pages), []);
  });

  test('a page with no trace of the section is never flagged', () => {
    const pages: DivergencePage[] = [{ id: 'p', name: 'Terms', layers: [cls('doc', [cls('doc-body')])] }];
    assert.deepEqual(findStructuralDivergence([NEWSLETTER], pages), []);
  });

  test('one incidental shared class is not evidence — the threshold prevents crying wolf', () => {
    // A scan nobody trusts is a scan nobody runs.
    const pages: DivergencePage[] = [{ id: 'p', name: 'Work', layers: [cls('nl-legal')] }];
    assert.deepEqual(findStructuralDivergence([NEWSLETTER], pages), []);
  });

  test('generic layout classes are ignored so every page is not a suspect', () => {
    const generic: DivergenceComponent = {
      id: 'c', name: 'Generic', layers: [cls('sec', [cls('reveal', [cls('cta2')])])],
    };
    assert.equal(signatureClasses(generic).size, 0);
    const pages: DivergencePage[] = [{ id: 'p', name: 'Any', layers: [cls('sec', [cls('reveal')])] }];
    assert.deepEqual(findStructuralDivergence([generic], pages), []);
  });

  test('finds copies nested deep in a page tree', () => {
    const pages: DivergencePage[] = [
      { id: 'p', name: 'Deep', layers: [cls('a', [cls('b', [cls('nl-sec', [cls('nl-form')])])])] },
    ];
    assert.equal(findStructuralDivergence([NEWSLETTER], pages).length, 1);
  });

  test('reports every divergent page, not just the first', () => {
    const pages: DivergencePage[] = [
      { id: 'p1', name: 'One', layers: [cls('nl-sec', [cls('nl-form')])] },
      { id: 'p2', name: 'Two', layers: [cls('nl-sec', [cls('nl-zone')])] },
    ];
    assert.equal(findStructuralDivergence([NEWSLETTER], pages).length, 2);
  });

  test('layers without classes do not throw', () => {
    const pages: DivergencePage[] = [
      { id: 'p', name: 'Bare', layers: [{ id: 'x', settings: null, children: [{ id: 'y' }] }] },
    ];
    assert.deepEqual(findStructuralDivergence([NEWSLETTER], pages), []);
  });
});
