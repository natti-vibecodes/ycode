import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildFormEventDetail, dispatchFormEvent, FORM_SUCCESS_EVENT } from './form-events';

describe('buildFormEventDetail (SCA-1181)', () => {
  test('REGRESSION: the unnamed fallback matches what the submission POSTs', () => {
    // The submission body sends `form_id: formId || 'unnamed-form'`. A different fallback here
    // would make GA4 and the submissions list disagree about which form produced a lead —
    // silently, and only for forms with no configured id.
    assert.equal(buildFormEventDetail({ formId: '', pageUrl: '/x' }).formId, 'unnamed-form');
    assert.equal(buildFormEventDetail({ formId: null, pageUrl: '/x' }).formId, 'unnamed-form');
    assert.equal(buildFormEventDetail({ formId: 'contact', pageUrl: '/x' }).formId, 'contact');
  });

  test('status is present only when there was one', () => {
    assert.equal('status' in buildFormEventDetail({ formId: 'f', pageUrl: '/' }), false);
    assert.equal(buildFormEventDetail({ formId: 'f', pageUrl: '/', status: 500 }).status, 500);
    // 0 is a real value, not "absent" — a falsy check here would drop it.
    assert.equal(buildFormEventDetail({ formId: 'f', pageUrl: '/', status: 0 }).status, 0);
  });

  test('a missing page url is an empty string, never undefined', () => {
    assert.equal(buildFormEventDetail({ formId: 'f' }).pageUrl, '');
  });
});

describe('dispatchFormEvent', () => {
  test('bubbles, so one document-level listener covers every form', () => {
    const parent = new EventTarget();
    let seen: unknown = null;
    parent.addEventListener(FORM_SUCCESS_EVENT, (e) => { seen = (e as CustomEvent).detail; });
    dispatchFormEvent(parent, FORM_SUCCESS_EVENT, buildFormEventDetail({ formId: 'contact', pageUrl: '/contact' }));
    assert.deepEqual(seen, { formId: 'contact', pageUrl: '/contact' });
  });

  test('REGRESSION: a target that refuses dispatch cannot break the submission', () => {
    // This is the failure the try/catch actually covers. A THROWING LISTENER is handled by the
    // DOM itself — dispatchEvent reports it to the global error handler rather than propagating
    // to the caller — so there is nothing for this code to catch there, and asserting otherwise
    // would document a guarantee we do not provide.
    const hostile = { dispatchEvent() { throw new Error('dispatch refused'); } } as unknown as EventTarget;
    assert.doesNotThrow(() =>
      dispatchFormEvent(hostile, FORM_SUCCESS_EVENT, buildFormEventDetail({ formId: 'f', pageUrl: '/' })));
  });

  test('a null target is a no-op, not a crash', () => {
    assert.doesNotThrow(() =>
      dispatchFormEvent(null, FORM_SUCCESS_EVENT, buildFormEventDetail({ formId: 'f', pageUrl: '/' })));
  });
});
