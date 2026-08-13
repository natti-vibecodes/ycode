import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { designToClasses } from './tailwind-class-mapper';

/**
 * SCA-1336. `isActive: false` looked like an undo and wasn't: the generator skipped the
 * `isActive` PROPERTY but never read its VALUE, so a switched-off category kept emitting classes
 * for everything else. An author who set a wrong value could not take it back — which is the
 * likely reason a bad 16px survived an attempted revert across 24 pages.
 */
describe('designToClasses honours isActive', () => {
  test('REGRESSION: a category switched OFF emits nothing', () => {
    const on = designToClasses({ typography: { isActive: true, color: '#ff0000' } } as never);
    const off = designToClasses({ typography: { isActive: false, color: '#ff0000' } } as never);
    assert.ok(on.some((c) => c.includes('ff0000')), 'active category should emit');
    assert.deepEqual(off, [], 'inactive category must emit nothing');
  });

  test('an ABSENT flag still emits — absent is not off', () => {
    // Plenty of existing categories omit the flag. Treating absent as off would strip styling
    // across the whole site on the next class regeneration.
    const classes = designToClasses({ typography: { color: '#ff0000' } } as never);
    assert.ok(classes.some((c) => c.includes('ff0000')));
  });

  test('switching one category off leaves the others alone', () => {
    const classes = designToClasses({
      layout: { isActive: true, display: 'Flex' },
      typography: { isActive: false, color: '#ff0000' },
    } as never);
    assert.ok(classes.length > 0, 'layout should still emit');
    assert.ok(!classes.some((c) => c.includes('ff0000')), 'typography must not emit');
  });

  test('an empty design is still empty', () => {
    assert.deepEqual(designToClasses(undefined), []);
    assert.deepEqual(designToClasses({} as never), []);
  });
});
