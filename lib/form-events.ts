/**
 * DOM events emitted when a public form submission resolves (SCA-1181).
 *
 * The site's own JS needs to know a form succeeded — to fire a GA4 `generate_lead` conversion —
 * and it must not learn that by watching for a success alert to become visible. That reading is
 * a guess about styling: the alert is hidden and shown by inline style, a CSS rule can hide it
 * anyway (that is exactly what `.nl-done` did), and a redirect-on-success form never shows one
 * at all. A submission that succeeded and reported nothing is indistinguishable from one that
 * silently failed.
 *
 * So the pipeline says what happened, once, on the element that did it.
 *
 * The fork stays analytics-agnostic on purpose: it emits a fact, and the site decides what to do
 * with it under whatever consent policy applies. Wiring `gtag` in here would put a consent
 * decision inside a generic CMS renderer, where nobody would think to look for one.
 */

export const FORM_SUCCESS_EVENT = 'ycode:form-success';
export const FORM_ERROR_EVENT = 'ycode:form-error';

export interface FormEventDetail {
  /** The form's configured id, or the same 'unnamed-form' fallback the submission itself uses. */
  formId: string;
  /** URL of the page the form was submitted from. */
  pageUrl: string;
  /** Present on error events only: the HTTP status, when there was a response at all. */
  status?: number;
}

export function buildFormEventDetail(input: {
  formId?: string | null;
  pageUrl?: string | null;
  status?: number;
}): FormEventDetail {
  const detail: FormEventDetail = {
    // Must match the fallback used when POSTing the submission, or analytics and the submissions
    // list disagree about which form a lead came from.
    formId: input.formId || 'unnamed-form',
    pageUrl: input.pageUrl || '',
  };
  if (typeof input.status === 'number') detail.status = input.status;
  return detail;
}

/**
 * Emit a form lifecycle event. Bubbles, so a single document-level listener covers every form on
 * the page — including forms added later.
 *
 * A listener that throws cannot break the submission, but NOT because of the try/catch below:
 * `dispatchEvent` never propagates a listener's exception to its caller — the DOM spec has it
 * reported to the global error handler instead. The try/catch covers the other failure, the one
 * that would propagate: a host without `CustomEvent`, or a target that refuses dispatch.
 * Analytics is never worth losing a lead over, either way.
 */
export function dispatchFormEvent(target: EventTarget | null, type: string, detail: FormEventDetail): void {
  if (!target || typeof CustomEvent === 'undefined') return;
  try {
    target.dispatchEvent(new CustomEvent(type, { detail, bubbles: true }));
  } catch {
    // Construction or dispatch refused — drop the signal, keep the submission.
  }
}
