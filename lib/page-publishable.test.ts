import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveNewPagePublishable } from './page-publishable';

/**
 * SCA-1254. Publishing is global, so a new page that defaults to publishable ships on whoever
 * publishes next — usually someone who has never seen it. Forgetting the flag must fail safe.
 */
describe('resolveNewPagePublishable', () => {
  test('REGRESSION: omitting the flag creates a DRAFT, never a live page', () => {
    assert.equal(resolveNewPagePublishable(undefined), false);
    assert.equal(resolveNewPagePublishable(null), false);
    assert.equal(resolveNewPagePublishable(), false);
  });

  test('publishing is opt-in and must be explicit', () => {
    assert.equal(resolveNewPagePublishable(true), true);
    assert.equal(resolveNewPagePublishable(false), false);
  });

  test('only a real boolean true opts in — no truthy coercion', () => {
    // A stray string from a JSON payload must not silently publish a page.
    for (const v of ['true', 1, {}, []] as unknown as boolean[]) {
      assert.equal(resolveNewPagePublishable(v), false, `value ${JSON.stringify(v)}`);
    }
  });
});
