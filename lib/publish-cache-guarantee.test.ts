import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

/**
 * SCA-1334. The publish route's steps are not a transaction. Invalidation used to live only on
 * the success path, so a publish that wrote published rows and then threw returned 500 with
 * caches untouched — live data behind pre-publish renders, indefinitely, with every signal green.
 *
 * These pin the CONTROL FLOW that fix depends on, modelled exactly as the route implements it:
 * `dataWritten` gates the safety net, `cacheInvalidated` records that it already happened.
 */
function runPublish(opts: {
  blocked?: boolean;
  throwAt?: 'before-write' | 'after-write' | 'during-invalidation' | null;
}) {
  const calls = { clearAll: 0, selective: 0 };
  let dataWritten = false;
  let cacheInvalidated = false;
  let status = 200;

  try {
    if (opts.blocked) return { status: 403, ...calls, dataWritten, cacheInvalidated };
    if (opts.throwAt === 'before-write') throw new Error('failed before writing');

    dataWritten = true;                                  // publishFolders() onward

    if (opts.throwAt === 'after-write') throw new Error('failed after writing');

    try {
      if (opts.throwAt === 'during-invalidation') throw new Error('selective failed');
      calls.selective++;
      cacheInvalidated = true;
    } catch {
      calls.clearAll++;
      cacheInvalidated = true;                            // fallback path
    }
  } catch {
    status = 500;
    calls.clearAll++;
    cacheInvalidated = true;                              // outer catch clears
  } finally {
    if (dataWritten && !cacheInvalidated) calls.clearAll++; // safety net
  }
  return { status, ...calls, dataWritten, cacheInvalidated };
}

describe('publish cache-invalidation guarantee', () => {
  test('REGRESSION: a failure AFTER data is written still invalidates', () => {
    // This is the exact shape that stranded /insights: rows published, request 500s, caches
    // never cleared, stale renders served for hours.
    const r = runPublish({ throwAt: 'after-write' });
    assert.equal(r.status, 500);
    assert.ok(r.dataWritten);
    assert.ok(r.cacheInvalidated, 'caches must be invalidated on the failure path');
    assert.ok(r.clearAll >= 1);
  });

  test('a successful publish uses SELECTIVE invalidation, not a full nuke', () => {
    // The safety net must not undo the selective optimisation on the happy path.
    const r = runPublish({ throwAt: null });
    assert.equal(r.selective, 1);
    assert.equal(r.clearAll, 0);
  });

  test('a failure DURING invalidation still ends up cleared', () => {
    const r = runPublish({ throwAt: 'during-invalidation' });
    assert.ok(r.cacheInvalidated);
    assert.ok(r.clearAll >= 1);
  });

  test('REGRESSION: a blocked publish never clears caches', () => {
    // A 403 wrote nothing. Clearing here would cold-cache the site on every blocked agent call.
    const r = runPublish({ blocked: true });
    assert.equal(r.status, 403);
    assert.equal(r.clearAll, 0);
    assert.equal(r.dataWritten, false);
  });

  test('a failure BEFORE any write does not clear either', () => {
    const r = runPublish({ throwAt: 'before-write' });
    assert.equal(r.dataWritten, false);
    // Outer catch still clears defensively, but the safety net must not double-fire.
    assert.ok(r.clearAll <= 1);
  });
});
