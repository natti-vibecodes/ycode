import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { syncCustomStylesheetLinks, CUSTOM_STYLESHEET_MARKER } from './canvas-stylesheets';

/**
 * SCA-1337. Exercised against a stub head rather than a browser — this repo has no DOM test
 * environment, and the reconciliation logic (what survives a re-run, what gets removed, what
 * order things land in) is the part that can silently be wrong. Whether the canvas iframe
 * subsequently PAINTS those stylesheets is not proven here; that needs an authenticated builder.
 */

interface StubLink {
  rel: string;
  href: string;
  _attrs: Record<string, string>;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  remove(): void;
}

function stubHead() {
  const children: StubLink[] = [];
  const head = {
    children,
    hrefs: () => children.map((c) => c.href),
    querySelectorAll(selector: string) {
      assert.equal(selector, `link[${CUSTOM_STYLESHEET_MARKER}]`);
      return children.filter((c) => CUSTOM_STYLESHEET_MARKER in c._attrs);
    },
    appendChild(el: StubLink) { children.push(el); },
    ownerDocument: {
      createElement(): StubLink {
        const el: StubLink = {
          rel: '',
          href: '',
          _attrs: {},
          setAttribute(k, v) { el._attrs[k] = v; if (k === 'href') el.href = v; },
          getAttribute(k) { return k === 'href' ? el.href : el._attrs[k] ?? null; },
          remove() { const i = children.indexOf(el); if (i >= 0) children.splice(i, 1); },
        };
        return el;
      },
    },
  };
  return head;
}

/** Adds a link this module does NOT own, to prove it is left alone. */
function addForeignLink(head: ReturnType<typeof stubHead>, href: string) {
  const el = head.ownerDocument.createElement();
  el.href = href;
  head.appendChild(el);
  return el;
}

const sync = (head: ReturnType<typeof stubHead>, hrefs: string[]) =>
  // The stub implements the narrow slice of HTMLHeadElement the helper touches.
  syncCustomStylesheetLinks(head as unknown as HTMLHeadElement, hrefs);

describe('syncCustomStylesheetLinks (SCA-1337)', () => {
  test('appends the stylesheets, in order, marked as ours', () => {
    const head = stubHead();
    sync(head, ['/site.css', '/overrides.css']);
    assert.deepEqual(head.hrefs(), ['/site.css', '/overrides.css']);
    assert.ok(head.children.every((c) => c.rel === 'stylesheet'));
    assert.ok(head.children.every((c) => CUSTOM_STYLESHEET_MARKER in c._attrs));
  });

  test('REGRESSION: a re-run with the same hrefs touches nothing', () => {
    // The failure this guards is not visible in markup — clearing and re-adding produces an
    // IDENTICAL head, while refetching every stylesheet and flashing the canvas unstyled on
    // every unrelated edit.
    const head = stubHead();
    sync(head, ['/site.css', '/overrides.css']);
    const before = [...head.children];
    sync(head, ['/site.css', '/overrides.css']);
    assert.deepEqual(head.children, before);
    head.children.forEach((c, i) => assert.equal(c, before[i], 'element was re-created'));
  });

  test('a removed stylesheet is dropped and the survivor kept intact', () => {
    const head = stubHead();
    sync(head, ['/site.css', '/overrides.css']);
    const survivor = head.children[0];
    sync(head, ['/site.css']);
    assert.deepEqual(head.hrefs(), ['/site.css']);
    assert.equal(head.children[0], survivor);
  });

  test('an added stylesheet appends without disturbing the existing one', () => {
    const head = stubHead();
    sync(head, ['/site.css']);
    const first = head.children[0];
    sync(head, ['/site.css', '/late.css']);
    assert.deepEqual(head.hrefs(), ['/site.css', '/late.css']);
    assert.equal(head.children[0], first);
  });

  test('emptying head code removes every link we own', () => {
    const head = stubHead();
    sync(head, ['/site.css', '/overrides.css']);
    sync(head, []);
    assert.deepEqual(head.hrefs(), []);
  });

  test('links we do not own are never removed', () => {
    // Ycode and the user both put links in this head. Reconciling on `link[rel=stylesheet]`
    // instead of on our marker would delete theirs.
    const head = stubHead();
    const foreign = addForeignLink(head, '/ycode-internal.css');
    sync(head, ['/site.css']);
    sync(head, []);
    assert.deepEqual(head.hrefs(), ['/ycode-internal.css']);
    assert.equal(head.children[0], foreign);
  });

  test('replacing the whole set leaves exactly the new hrefs', () => {
    const head = stubHead();
    sync(head, ['/a.css', '/b.css']);
    sync(head, ['/c.css']);
    assert.deepEqual(head.hrefs(), ['/c.css']);
  });
});
