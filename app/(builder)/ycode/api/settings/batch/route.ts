import { NextRequest, NextResponse } from 'next/server';
import { setSettings } from '@/lib/repositories/settingsRepository';
import { isConflictError } from '@/lib/errors/conflict';
import { isDraftOnlySettingKey } from '@/lib/settings-keys';
import { clearAllCache, getAllPublishedRoutes, warmRoutes } from '@/lib/services/cacheService';

/**
 * PUT /ycode/api/settings/batch
 *
 * Update multiple settings at once.
 * Invalidates the public page cache so ISR pages pick up the new values.
 * Request body: { settings: { key1: value1, key2: value2, ... } }
 */
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { settings, expected_updated_at: expectedUpdatedAt } = body;

    if (!settings || typeof settings !== 'object') {
      return NextResponse.json(
        { error: 'Missing or invalid settings object in request body' },
        { status: 400 }
      );
    }

    // This is the builder's Settings → General save. It reads the settings once at editor init
    // and writes back whatever is in the form — including `custom_code_head`, the whole global
    // chrome — so without a precondition it silently replays a stale head over a chrome sync
    // (SCA-1480). Preconditions are per-key and optional; unguarded keys behave as before.
    const { count, updatedAt } = await setSettings(settings, {
      expectedUpdatedAt,
      caller: 'route:PUT /ycode/api/settings/batch',
    });

    // Only invalidate caches if any of the updated keys actually affect
    // public page rendering. Skips builder-only autosaves.
    const touchesPublicKeys = Object.keys(settings).some(
      (key) => !isDraftOnlySettingKey(key)
    );
    if (touchesPublicKeys) {
      await clearAllCache();

      // Prime the cache so the first visit to any public page after this
      // settings change doesn't pay the cold-cache cost. warmRoutes batches
      // and self-chains through every route up to the overall cap; anything
      // beyond that self-warms on first real visit.
      try {
        const routes = await getAllPublishedRoutes();
        const warmResult = await warmRoutes(routes, request);
        if (warmResult) {
          console.log(
            `[Cache] settings batch: warming ${warmResult.warmed}${warmResult.total > warmResult.warmed ? ` of ${warmResult.total}` : ''} route(s) in background`,
          );
        }
      } catch {
        // Non-fatal: warming is an optimization
      }
    }

    return NextResponse.json({
      data: { count, updated_at: updatedAt },
      message: `Updated ${count} setting(s) successfully`,
    });
  } catch (error) {
    if (isConflictError(error)) {
      return NextResponse.json(
        {
          error: error.message,
          code: 'conflict',
          key: error.key,
          expected_updated_at: error.expected,
          current: error.current,
        },
        { status: 409 }
      );
    }
    console.error('[API] Error updating settings:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update settings' },
      { status: 500 }
    );
  }
}
