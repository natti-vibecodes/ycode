import { NextRequest, NextResponse } from 'next/server';
import { isAgentSecretSettingKey } from '@/lib/agent/config';
import { getSettingRecordByKey } from '@/lib/repositories/settingsRepository';
import { setSettingAndInvalidate } from '@/lib/services/settingsService';
import { isConflictError } from '@/lib/errors/conflict';

/**
 * GET /ycode/api/settings/[key]
 *
 * Get a setting value by key
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ key: string }> }
) {
  try {
    const { key } = await params;

    if (isAgentSecretSettingKey(key)) {
      return NextResponse.json(
        { error: 'This setting cannot be read directly' },
        { status: 403 }
      );
    }

    const record = await getSettingRecordByKey(key);

    if (record === null || record.value === null) {
      return NextResponse.json(
        { error: 'Setting not found' },
        { status: 404 }
      );
    }

    // `updated_at` is the concurrency token: a client that reads here can write back with
    // `expected_updated_at` and be refused rather than clobber (SCA-1480).
    return NextResponse.json({ data: record.value, updated_at: record.updated_at ?? null });
  } catch (error) {
    console.error('[API] Error fetching setting:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch setting' },
      { status: 500 }
    );
  }
}

/**
 * PUT /ycode/api/settings/[key]
 *
 * Update a setting value
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ key: string }> }
) {
  try {
    const { key } = await params;
    const body = await request.json();
    const { value, expected_updated_at: expectedUpdatedAt } = body;

    if (value === undefined) {
      return NextResponse.json(
        { error: 'Missing value in request body' },
        { status: 400 }
      );
    }

    // Writes, then purges the public cache for render-affecting keys and warms the routes back
    // up. Shared with the MCP `set_setting` tool (SCA-1345) — this logic living only here is
    // exactly why agent-written settings never invalidated anything.
    const saved = await setSettingAndInvalidate(key, value, request, {
      // Absent precondition = unconditional write, exactly as before. Present and stale = 409.
      expectedUpdatedAt,
      caller: 'route:PUT /ycode/api/settings/[key]',
    });

    return NextResponse.json({
      data: { key, value, updated_at: saved?.updated_at ?? null },
      message: 'Setting updated successfully',
    });
  } catch (error) {
    if (isConflictError(error)) {
      // 409 with the CURRENT row: nothing was written, and the caller can diff before retrying.
      return NextResponse.json(
        {
          error: error.message,
          code: 'conflict',
          expected_updated_at: error.expected,
          current: error.current,
        },
        { status: 409 }
      );
    }
    console.error('[API] Error updating setting:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update setting' },
      { status: 500 }
    );
  }
}
