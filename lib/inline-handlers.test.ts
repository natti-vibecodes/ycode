import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { splitInlineHandlers, applyInlineHandlers } from './inline-handlers';

/**
 * SCA-1380. React drops a lowercase `onclick` prop and warns. The carousel arrows on ~10 pages
 * carry an inline onclick; the served DOM had the buttons, had `.rail3`, and had ZERO onclick
 * attributes — the arrows rendered and did nothing.
 */
describe('splitInlineHandlers (SCA-1380)', () => {
  test('REGRESSION: an inline onclick is separated out, not passed to React', () => {
    const { handlers, attributes } = splitInlineHandlers({
      class: 'nav3', onclick: "this.closest('section').querySelector('.rail3').scrollBy({left:-380})",
      'aria-label': 'Prev',
    });
    assert.deepEqual(Object.keys(handlers), ['onclick']);
    assert.deepEqual(attributes, { class: 'nav3', 'aria-label': 'Prev' });
  });

  test('a camelCase onClick STRING is rescued too — matching is case-insensitive', () => {
    // I first wrote this test asserting the opposite, reasoning that camelCase names are React's
    // real function props and must not be stripped. That premise is wrong at this call site: this
    // only ever receives `settings.customAttributes`, which is author-written HTML and always
    // strings — never React handlers. React drops a STRING onClick exactly as it drops onclick,
    // so rescuing both is the correct behaviour, and refusing to would leave the same bug for
    // anyone who happened to type it that way.
    const { handlers, attributes } = splitInlineHandlers({ onClick: 'go()', class: 'x' });
    assert.deepEqual(handlers, { onClick: 'go()' });
    assert.deepEqual(attributes, { class: 'x' });
  });

  test('REGRESSION: ordinary attributes that merely BEGIN with "on" are left alone', () => {
    // A /^on[a-z]+$/ pattern also matches `once` and `only`. Stripping those would remove real
    // attributes from the DOM to fix a different bug. This test caught exactly that in the first
    // implementation, which is why the handler list is explicit rather than a regex.
    const { handlers, attributes } = splitInlineHandlers({ once: 'true', only: 'x', onclick: 'go()' });
    assert.deepEqual(handlers, { onclick: 'go()' });
    assert.deepEqual(attributes, { once: 'true', only: 'x' });
  });

  test('empty and missing input yield empty maps, never undefined', () => {
    for (const input of [undefined, null, {}]) {
      const r = splitInlineHandlers(input as never);
      assert.deepEqual(r.handlers, {});
      assert.deepEqual(r.attributes, {});
    }
  });
});

describe('applyInlineHandlers (SCA-1380)', () => {
  const fakeEl = () => {
    const attrs: Record<string, string> = {};
    let writes = 0;
    return {
      attrs, get writes() { return writes; },
      getAttribute: (k: string) => (k in attrs ? attrs[k] : null),
      setAttribute: (k: string, v: string) => { writes++; attrs[k] = v; },
    };
  };

  test('sets the handler on the node', () => {
    const el = fakeEl();
    applyInlineHandlers(el as never, { onclick: 'doThing()' });
    assert.equal(el.attrs.onclick, 'doThing()');
  });

  test('REGRESSION: re-applying identical code writes nothing', () => {
    // A re-render must not stack duplicates or churn the DOM on every paint.
    const el = fakeEl();
    applyInlineHandlers(el as never, { onclick: 'doThing()' });
    const after = el.writes;
    applyInlineHandlers(el as never, { onclick: 'doThing()' });
    assert.equal(el.writes, after, 'identical re-application should be a no-op');
  });

  test('a null node is safe', () => {
    assert.doesNotThrow(() => applyInlineHandlers(null, { onclick: 'x' }));
  });
});
