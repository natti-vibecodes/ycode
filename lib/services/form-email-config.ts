/**
 * Where a form submission's email notification config comes from.
 *
 * SECURITY (found 2026-08-21 while auditing 2c809ff). The public submission route used to take
 * the `email` object straight off the request body — `{ enabled, to, subject }` exactly as the
 * browser posted it — and hand it to the mailer. The renderer really does post that object (it
 * reads the form layer's settings client-side, see LayerRendererPublic), but a request body is
 * attacker-controlled: `/ycode/api/form-submissions` is public and unauthenticated, so the
 * moment SMTP credentials exist any visitor can POST an arbitrary `to` with an
 * attacker-chosen `subject` and use the site as a mail relay.
 *
 * The fix is not to validate the posted object — it is to stop reading it. This module resolves
 * the SAME source of truth the renderer read, but server-side: the submitting form layer's own
 * `settings.form.email_notification`. The client may keep posting whatever it likes; nothing it
 * posts can affect who receives mail or what the subject says.
 *
 * Everything here is pure and dependency-injected. The Supabase-backed sources live in
 * `form-email-config.server.ts` so this file (and its tests) never touch the database.
 */

import { getLayerHtmlTag } from '@/lib/layer-utils';
import type { Layer } from '@/types';

/**
 * Fallback id the renderer posts for a form layer with no `settings.id`. Must stay in step with
 * LayerRendererPublic's `form_id: formId || 'unnamed-form'`, or a server lookup for an unnamed
 * form finds nothing and silently stops sending mail that used to be sent.
 */
export const UNNAMED_FORM_ID = 'unnamed-form';

export interface StoredFormEmailNotification {
  enabled: boolean;
  to: string;
  subject?: string;
}

/** One layer tree to search, plus a label used only for logging where a match came from. */
export interface FormLayerTree {
  label: string;
  layers: Layer[];
}

export type FormEmailResolution =
  | { outcome: 'send'; to: string; subject?: string; matchedIn: string[] }
  | { outcome: 'form-not-found' }
  /** The form exists but stores no `email_notification` key at all — never configured. */
  | { outcome: 'unconfigured'; matchedIn: string[] }
  /** The form stores an `email_notification` whose `enabled` is not true — deliberately off. */
  | { outcome: 'disabled'; matchedIn: string[] }
  | { outcome: 'no-recipient'; matchedIn: string[] }
  | { outcome: 'ambiguous'; recipients: string[]; matchedIn: string[] };

/**
 * The id a form layer submits under. Mirrors the renderer exactly: it posts
 * `layer.settings?.id || 'unnamed-form'`, and identifies a form by its resolved HTML tag rather
 * than by layer name, so we reuse `getLayerHtmlTag` instead of hand-rolling a second rule that
 * could drift from the renderer's.
 */
export function submissionFormId(layer: Layer): string {
  return layer.settings?.id || UNNAMED_FORM_ID;
}

function isFormLayer(layer: Layer): boolean {
  return getLayerHtmlTag(layer) === 'form';
}

/** Depth-first walk collecting every form layer in `layers` that submits under `formId`. */
function collectMatchingFormLayers(
  layers: Layer[] | null | undefined,
  formId: string,
  label: string,
  found: Array<{ label: string; layer: Layer }>
): void {
  if (!Array.isArray(layers)) return;

  for (const layer of layers) {
    if (!layer || typeof layer !== 'object') continue;

    if (isFormLayer(layer) && submissionFormId(layer) === formId) {
      found.push({ label, layer });
    }

    // Keep descending even after a match: forms can nest inside other layers, and a tree may
    // legitimately hold several (a page with both a contact form and a newsletter form).
    collectMatchingFormLayers(layer.children, formId, label, found);
  }
}

/**
 * Resolve the stored notification for `formId` across a set of layer trees.
 *
 * Duplicate matches are expected rather than exceptional: Ycode's duplicated pages share layer
 * ids (and therefore `settings.id`), so the same form legitimately appears in several trees. That
 * is only a problem when the copies DISAGREE about the recipient — then we refuse to send rather
 * than pick one arbitrarily, because guessing here means mailing a lead to the wrong address.
 */
export function resolveFormEmailFromTrees(trees: FormLayerTree[], formId: string): FormEmailResolution {
  const matches: Array<{ label: string; layer: Layer }> = [];
  for (const tree of trees) {
    collectMatchingFormLayers(tree.layers, formId, tree.label, matches);
  }

  if (matches.length === 0) {
    return { outcome: 'form-not-found' };
  }

  const matchedIn = [...new Set(matches.map(m => m.label))];

  const configured = matches
    .map(m => m.layer.settings?.form?.email_notification)
    .filter((n): n is StoredFormEmailNotification => !!n && typeof n === 'object');

  // "Never configured" and "deliberately switched off" look the same from a boolean but must be
  // treated differently by the published/draft fallback below.
  if (configured.length === 0) {
    return { outcome: 'unconfigured', matchedIn };
  }

  const enabled = configured.filter(n => n.enabled === true);

  if (enabled.length === 0) {
    return { outcome: 'disabled', matchedIn };
  }

  const withRecipient = enabled.filter(n => typeof n.to === 'string' && n.to.trim() !== '');
  if (withRecipient.length === 0) {
    return { outcome: 'no-recipient', matchedIn };
  }

  const recipients = [...new Set(withRecipient.map(n => n.to.trim()))];
  if (recipients.length > 1) {
    return { outcome: 'ambiguous', recipients, matchedIn };
  }

  const chosen = withRecipient[0];
  const subject = typeof chosen.subject === 'string' && chosen.subject.trim() !== '' ? chosen.subject : undefined;

  return { outcome: 'send', to: recipients[0], subject, matchedIn };
}

/**
 * Where to look for form layers. `published` is what a visitor's page was rendered from;
 * `draft` is the staging/preview fallback so a form configured but not yet published still
 * notifies on :3002. Both are OUR stored config — neither is client input.
 */
export interface FormLayerSources {
  published(): Promise<FormLayerTree[]>;
  draft(): Promise<FormLayerTree[]>;
}

export interface ResolvedFormEmail {
  resolution: FormEmailResolution;
  /** Which store answered. 'none' when neither held the form. */
  source: 'published' | 'draft' | 'none';
}

/**
 * Published wins, because that is what the visitor's page was rendered from — so an unpublished
 * edit cannot silently redirect live leads to a different address.
 *
 * Draft is consulted only when the published tree has nothing to say: the form is absent, or it
 * is present but has never had an `email_notification` written to it. A published notification
 * with `enabled: false` is a deliberate "off" and deliberately does NOT fall through, or an
 * editor switching notifications off would find a stale draft turning them back on.
 *
 * The unconfigured case is not hypothetical: as of 2026-09-03 the published `Contact + final CTA`
 * component carries no notification while its draft holds the real hello@scalability.us config,
 * so treating "never configured" as "off" would mean the contact form never notifies anyone.
 */
export async function resolveStoredFormEmailNotification(
  formId: string,
  sources: FormLayerSources
): Promise<ResolvedFormEmail> {
  const published = await sources.published();
  const fromPublished = resolveFormEmailFromTrees(published, formId);

  const publishedIsSilent =
    fromPublished.outcome === 'form-not-found' || fromPublished.outcome === 'unconfigured';

  if (!publishedIsSilent) {
    return { resolution: fromPublished, source: 'published' };
  }

  const draft = await sources.draft();
  const fromDraft = resolveFormEmailFromTrees(draft, formId);
  if (fromDraft.outcome !== 'form-not-found' && fromDraft.outcome !== 'unconfigured') {
    return { resolution: fromDraft, source: 'draft' };
  }

  // Neither store had anything actionable — report the more specific of the two.
  return fromPublished.outcome === 'unconfigured'
    ? { resolution: fromPublished, source: 'published' }
    : { resolution: fromDraft, source: fromDraft.outcome === 'form-not-found' ? 'none' : 'draft' };
}

export interface FormNotificationEmailData {
  formId: string;
  submissionId: string;
  payload: Record<string, unknown>;
  metadata: {
    page_url?: string;
    user_agent?: string;
    referrer?: string;
    submitted_at: string;
  };
  replyTo?: string;
}

export interface FormNotificationDeps {
  resolve(formId: string): Promise<ResolvedFormEmail>;
  /**
   * Returns `false` when the mailer declined to send (SMTP off or incomplete) — `emailService`
   * catches its own errors and reports that boolean rather than rejecting, so a throw-only
   * catch here would see almost nothing.
   */
  send(to: string, subject: string, data: FormNotificationEmailData): Promise<unknown>;
  /** Structured trace sink. The server module points this at console.error. */
  logError(event: Record<string, unknown>): void;
}

export type FormNotificationOutcome =
  | FormEmailResolution['outcome']
  | 'send-failed'
  | 'not-sent'
  | 'lookup-failed';

/**
 * Resolve the stored config and send. NEVER throws and never rejects: the caller stores the
 * submission first, and a lead that is already saved must not be lost — or turned into a 500 —
 * because the mailer or the lookup fell over. Failures leave a structured trace instead of the
 * silent swallow this replaced.
 */
export async function notifyFormSubmission(
  data: FormNotificationEmailData,
  deps: FormNotificationDeps
): Promise<FormNotificationOutcome> {
  let resolved: ResolvedFormEmail;
  try {
    resolved = await deps.resolve(data.formId);
  } catch (error) {
    deps.logError({
      event: 'form_email_lookup_failed',
      form_id: data.formId,
      submission_id: data.submissionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 'lookup-failed';
  }

  const { resolution, source } = resolved;

  if (resolution.outcome === 'ambiguous') {
    deps.logError({
      event: 'form_email_ambiguous_recipient',
      form_id: data.formId,
      submission_id: data.submissionId,
      source,
      recipients: resolution.recipients,
      matched_in: resolution.matchedIn,
      detail: 'Several stored copies of this form name different recipients; refusing to guess.',
    });
    return resolution.outcome;
  }

  if (resolution.outcome !== 'send') {
    // Not an error: a form with notifications switched off, or one that stores no recipient, is
    // a normal configuration. No trace, or every submission would log noise.
    return resolution.outcome;
  }

  const subject = resolution.subject ?? `New form submission: ${data.formId}`;

  try {
    const sent = await deps.send(resolution.to, subject, data);

    if (sent === false) {
      // The old route dropped this on the floor: a form configured to notify would quietly
      // notify nobody whenever SMTP was off or misconfigured, with nothing in the logs tying
      // the silence to a submission.
      deps.logError({
        event: 'form_email_not_sent',
        form_id: data.formId,
        submission_id: data.submissionId,
        source,
        to: resolution.to,
        matched_in: resolution.matchedIn,
        detail: 'Mailer declined to send (SMTP disabled or incomplete). Submission was stored.',
      });
      return 'not-sent';
    }

    return 'send';
  } catch (error) {
    deps.logError({
      event: 'form_email_send_failed',
      form_id: data.formId,
      submission_id: data.submissionId,
      source,
      to: resolution.to,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      detail: 'Submission was stored; only the notification email failed.',
    });
    return 'send-failed';
  }
}
