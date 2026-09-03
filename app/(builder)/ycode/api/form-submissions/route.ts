import { NextRequest, NextResponse } from 'next/server';
import {
  getAllFormSubmissions,
  getFormSummaries,
  createFormSubmission,
  deleteFormSubmissionsByFormId,
  bulkDeleteFormSubmissions,
} from '@/lib/repositories/formSubmissionRepository';
import { dispatchFormSubmittedEvent } from '@/lib/services/webhookService';
import { extractReplyToEmail } from '@/lib/services/emailService';
import { dispatchStoredFormNotification } from '@/lib/services/form-email-config.server';
import { processAppIntegrations } from '@/lib/apps/integration-service';
import { noCache } from '@/lib/api-response';
import { buildSubmissionMetadata, formatLeadWriteFailure } from '@/lib/form-attribution';

// Disable caching for this route
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /ycode/api/form-submissions
 * Get all form submissions or form summaries
 *
 * Query params:
 * - form_id: Filter by form ID
 * - status: Filter by status
 * - summary: If 'true', returns form summaries instead of submissions
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const formId = searchParams.get('form_id') || undefined;
    const status = searchParams.get('status') as 'new' | 'read' | 'archived' | 'spam' | undefined;
    const summary = searchParams.get('summary') === 'true';

    if (summary) {
      const summaries = await getFormSummaries();
      return noCache({ data: summaries });
    }

    const submissions = await getAllFormSubmissions(formId, status);
    return noCache({ data: submissions });
  } catch (error) {
    console.error('Error fetching form submissions:', error);
    return noCache(
      { error: error instanceof Error ? error.message : 'Failed to fetch form submissions' },
      500
    );
  }
}

/**
 * POST /ycode/api/form-submissions
 * Create a new form submission (public endpoint for form submissions)
 *
 * Body:
 * - form_id: string (required)
 * - payload: object (required)
 * - metadata: object (optional - IP, user agent, etc.)
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    // Validate required fields
    if (!body.form_id) {
      return NextResponse.json(
        { error: 'Missing required field: form_id' },
        { status: 400 }
      );
    }

    if (!body.payload || typeof body.payload !== 'object') {
      return NextResponse.json(
        { error: 'Missing or invalid field: payload' },
        { status: 400 }
      );
    }

    // Merge client-sent metadata (page_url) with what the server can see, and parse the
    // hidden attribution field into queryable JSON. Previously this was `body.metadata || {…}`,
    // so user_agent and referrer were never captured: the client always sends a metadata
    // object, which meant the fallback branch never ran. See lib/form-attribution.ts.
    const metadata = buildSubmissionMetadata({
      clientMetadata: body.metadata,
      payload: body.payload,
      userAgent: request.headers.get('user-agent'),
      referrer: request.headers.get('referer'),
    });

    // A lead that reaches us must never be lost to an error page. If the write fails, record
    // everything needed to recover it by hand and still tell the visitor it worked — they have
    // already decided to get in touch, and an error costs us the prospect, not just the row.
    let submission;
    try {
      submission = await createFormSubmission({
        form_id: body.form_id,
        payload: body.payload,
        metadata,
      });
    } catch (dbError) {
      console.error(
        formatLeadWriteFailure({
          formId: body.form_id,
          payload: body.payload,
          metadata,
          error: dbError,
        })
      );
      return NextResponse.json(
        { data: null, message: 'Form submitted successfully' },
        { status: 201 }
      );
    }

    // Dispatch webhook event (fire and forget)
    dispatchFormSubmittedEvent({
      form_id: body.form_id,
      submission_id: submission.id,
      fields: body.payload,
      metadata,
    });

    // Send the email notification (fire and forget).
    //
    // SECURITY: `body.email` is IGNORED. This route is public and unauthenticated, and it used
    // to pass the client-posted `{enabled, to, subject}` straight to the mailer — so once SMTP
    // credentials exist, any visitor could POST an arbitrary `to` and use the site as a mail
    // relay with an attacker-chosen subject. The recipient and subject now come only from the
    // submitting form's own stored `settings.form.email_notification`, resolved server-side.
    // The renderer may keep posting `email`; nothing it sends affects routing.
    dispatchStoredFormNotification({
      formId: body.form_id,
      submissionId: submission.id,
      payload: body.payload,
      metadata: {
        ...metadata,
        submitted_at: submission.created_at,
      },
      // Reply-To still comes from the payload the visitor typed, which is the point of it — it
      // only ever populates a Reply-To header on mail sent to OUR stored address.
      replyTo: extractReplyToEmail(body.payload),
    }).catch(error => {
      // notifyFormSubmission is written not to reject; this is a belt-and-braces trace so a
      // future change there can never go back to failing silently. Storage already succeeded.
      console.error(
        '[form-submissions]',
        JSON.stringify({
          event: 'form_email_dispatch_threw',
          form_id: body.form_id,
          submission_id: submission.id,
          error: error instanceof Error ? error.message : String(error),
        })
      );
    });

    // Process app integrations (fire and forget)
    processAppIntegrations(body.form_id, submission.id, body.payload);

    return NextResponse.json(
      { data: submission, message: 'Form submitted successfully' },
      { status: 201 }
    );
  } catch (error) {
    console.error('Error creating form submission:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to submit form' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /ycode/api/form-submissions
 * Delete submissions - either by form_id (all submissions) or by ids (bulk delete)
 *
 * Query params:
 * - form_id: string - Delete all submissions for this form
 *
 * OR Body:
 * - ids: string[] - Array of submission IDs to delete
 */
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const formId = searchParams.get('form_id');

    // If form_id is provided, delete all submissions for that form
    if (formId) {
      await deleteFormSubmissionsByFormId(formId);
      return noCache({ message: 'All submissions for form deleted successfully' });
    }

    // Otherwise, try to parse body for bulk delete
    const body = await request.json().catch(() => ({}));
    const ids = body.ids;

    if (Array.isArray(ids) && ids.length > 0) {
      await bulkDeleteFormSubmissions(ids);
      return noCache({ message: `${ids.length} submissions deleted successfully` });
    }

    return noCache({ error: 'Missing required param: form_id or ids in body' }, 400);
  } catch (error) {
    console.error('Error deleting form submissions:', error);
    return noCache(
      { error: error instanceof Error ? error.message : 'Failed to delete form submissions' },
      500
    );
  }
}
