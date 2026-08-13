import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * SCA-1278 — CMS content edits were invisible to the publish queue.
 *
 * `getUnpublishedCollections` compared a collection's `name` and `order` and nothing else, so any
 * change to ITEMS or VALUES reported as fully published. On 2026-08-13 the Insights collection had
 * genuinely divergent content while its name and order were untouched — the old predicate returned
 * NO and the queue said nothing was pending.
 *
 * A full press ships those edits anyway (publish-all iterates every collection rather than the
 * diff), so this was a reporting lie rather than lost work. It still mattered: every lane uses that
 * queue to decide whether their work is pending, and one that edits CMS content, checks the queue,
 * sees nothing and concludes "already published" is misled by design.
 *
 * The fingerprint is verified against live data in the commit message rather than mocked here —
 * these guard the wiring and the failure DIRECTION, which is the part a mock would hide.
 */
const collectionRepo = readFileSync(new URL('./repositories/collectionRepository.ts', import.meta.url), 'utf8');
const valueRepo = readFileSync(new URL('./repositories/collectionItemValueRepository.ts', import.meta.url), 'utf8');

describe('collection change detection (SCA-1278)', () => {
  test('REGRESSION: the unpublished check consults content, not just name/order', () => {
    assert.match(collectionRepo, /getCollectionContentFingerprints/,
      'getUnpublishedCollections must compare content fingerprints');
  });

  test('the metadata-only predicate is NAMED metadata-only', () => {
    // The old name (`hasCollectionChanged`) plus a caller that consulted nothing else is what made
    // this survive: the function did exactly what it said, and its name said too much.
    assert.match(collectionRepo, /hasCollectionMetadataChanged/);
    assert.doesNotMatch(collectionRepo, /function hasCollectionChanged\b/);
  });

  test('REGRESSION: a fingerprint failure OVER-reports rather than under-reports', () => {
    // The failure direction is the whole point. Over-reporting costs a redundant publish of
    // identical rows; under-reporting is the silent bug being fixed. A catch that returned [] here
    // would restore the original defect precisely, and every test above would still pass.
    const guard = collectionRepo.slice(collectionRepo.indexOf('content fingerprint failed'));
    assert.match(guard.slice(0, 200), /return draftCollections/,
      'on error it must report ALL collections as unpublished, never none');
  });

  test('membership and publishability are in the fingerprint, not just values', () => {
    // Adding or removing an item, or flipping is_publishable, changes what serves even when no
    // value moved. A values-only fingerprint would miss all three.
    assert.match(valueRepo, /is_publishable/);
    assert.match(valueRepo, /collection_items/);
  });

  test('the fingerprint is aggregated in the database, not in memory', () => {
    // A large collection would otherwise pull its entire value table twice on every queue check.
    assert.match(valueRepo, /md5\(string_agg/);
  });
});
