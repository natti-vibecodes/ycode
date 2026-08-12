import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isExecutableScriptType, INERT_TYPE, ORIGINAL_TYPE_ATTR } from './deferred-scripts';

/**
 * These mirror `isScriptDataBlock` in react-dom-client.development.js. If they ever disagree,
 * a script we consider inert would be treated by React as executable — warned about, and
 * replaced with a <div> on a client render (SCA-1297).
 */
describe('isExecutableScriptType', () => {
  test('absent or empty type is a classic script — executable', () => {
    assert.equal(isExecutableScriptType(undefined), true);
    assert.equal(isExecutableScriptType(null), true);
    assert.equal(isExecutableScriptType(''), true);
    assert.equal(isExecutableScriptType('   '), true);
  });

  test('every JavaScript mime type React lists is executable', () => {
    for (const t of ['text/javascript', 'application/javascript', 'text/ecmascript',
      'application/ecmascript', 'text/jscript', 'text/livescript',
      'application/x-javascript', 'text/javascript1.5']) {
      assert.equal(isExecutableScriptType(t), true, t);
    }
  });

  test('module, importmap and speculationrules execute too', () => {
    // React excludes these from its data-block set for the same reason: they are not inert.
    assert.equal(isExecutableScriptType('module'), true);
    assert.equal(isExecutableScriptType('importmap'), true);
    assert.equal(isExecutableScriptType('speculationrules'), true);
  });

  test('REGRESSION: ld+json is DATA — it must never be parked', () => {
    // It has to stay a real script element in the served HTML or crawlers lose the schema.
    // React already leaves it alone, so it was never the source of the warning.
    assert.equal(isExecutableScriptType('application/ld+json'), false);
    assert.equal(isExecutableScriptType('APPLICATION/LD+JSON'), false);
    assert.equal(isExecutableScriptType('text/template'), false);
  });

  test('the inert marker itself is not executable — parking must be idempotent', () => {
    // A second pass over already-parked markup must not re-park it.
    assert.equal(isExecutableScriptType(INERT_TYPE), false);
  });

  test('type matching ignores case and surrounding whitespace', () => {
    assert.equal(isExecutableScriptType('  TEXT/JavaScript '), true);
  });

  test('the contract constants are what CustomCodeInjector already parks with', () => {
    // Body and head must park identically or one side silently never un-parks.
    assert.equal(INERT_TYPE, 'text/ycode-deferred');
    assert.equal(ORIGINAL_TYPE_ATTR, 'data-ycode-type');
  });
});
