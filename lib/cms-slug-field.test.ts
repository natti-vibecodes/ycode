import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { collectSlugFieldIds, pickSlugFieldId } from './cms-slug-field';

/**
 * SCA-1486. Three copies of "find the slug field" in cacheService.ts each did
 * `.eq('key', 'slug')`, and `collection_fields.key` is NULL on every field in this workspace —
 * 70 of 70 on Insights, 36 of 36 on Case Studies, measured against the live database on
 * 2026-09-07. All three matched nothing and failed silently: dynamic pages expanded to zero
 * routes, deleted items' old URLs were never purged, and CMS locale routes were never rebuilt.
 */
describe('pickSlugFieldId', () => {
  /** The shape of a real collection here: `key` NULL on every row, human `name` set. */
  const LIVE_SHAPE = [
    { id: 'f-title', key: null, name: 'Title' },
    { id: 'f-slug', key: null, name: 'Slug' },
    { id: 'f-dek', key: null, name: 'Dek' },
  ];

  test('REGRESSION: resolves by name when every key is NULL', () => {
    assert.equal(pickSlugFieldId(LIVE_SHAPE), 'f-slug');
  });

  test('the page\'s configured slug_field_id wins outright', () => {
    assert.equal(pickSlugFieldId(LIVE_SHAPE, 'f-configured'), 'f-configured');
  });

  test('a key match beats a name match', () => {
    const fields = [
      { id: 'f-named', key: 'permalink', name: 'Slug' },
      { id: 'f-keyed', key: 'slug', name: 'URL' },
    ];
    assert.equal(pickSlugFieldId(fields), 'f-keyed');
  });

  test('matching is case-insensitive on both key and name', () => {
    assert.equal(pickSlugFieldId([{ id: 'a', key: 'SLUG', name: 'x' }]), 'a');
    assert.equal(pickSlugFieldId([{ id: 'b', key: null, name: 'SLUG' }]), 'b');
  });

  test('a collection with no slug field resolves to null, not a wrong guess', () => {
    // Never fall back to "first text field" — that is how llms.txt put read times where the
    // summary belonged (SCA-1121).
    assert.equal(pickSlugFieldId([{ id: 'f-title', key: null, name: 'Title' }]), null);
    assert.equal(pickSlugFieldId([]), null);
  });

  test('a substring is not a match', () => {
    assert.equal(pickSlugFieldId([{ id: 'f', key: null, name: 'Slug source' }]), null);
  });
});

describe('collectSlugFieldIds', () => {
  const FIELDS = [
    { id: 'f-a-slug', collection_id: 'col-a', key: null, name: 'Slug' },
    { id: 'f-a-title', collection_id: 'col-a', key: null, name: 'Title' },
    { id: 'f-b-slug', collection_id: 'col-b', key: null, name: 'Slug' },
    { id: 'f-c-title', collection_id: 'col-c', key: null, name: 'Title' },
  ];

  test('REGRESSION: one id per collection that has a slug field, keys all NULL', () => {
    assert.deepEqual([...collectSlugFieldIds(FIELDS, [])].sort(), ['f-a-slug', 'f-b-slug']);
  });

  test('a configured binding overrides its collection and is included even if unlisted', () => {
    const ids = collectSlugFieldIds(FIELDS, [{ collection_id: 'col-a', slug_field_id: 'f-bound' }]);
    assert.equal(ids.has('f-bound'), true);
    assert.equal(ids.has('f-a-slug'), false, 'the bound field replaces the name match');
    assert.equal(ids.has('f-b-slug'), true, 'other collections still resolve by name');
  });

  test('duplicate draft/published field rows collapse to one id', () => {
    const withDuplicates = [...FIELDS, ...FIELDS.map((f) => ({ ...f }))];
    assert.deepEqual([...collectSlugFieldIds(withDuplicates, [])].sort(), ['f-a-slug', 'f-b-slug']);
  });

  test('fields with no collection_id are ignored rather than pooled together', () => {
    assert.deepEqual([...collectSlugFieldIds([{ id: 'orphan', key: null, name: 'Slug' }], [])], []);
  });

  test('empty inputs yield an empty set', () => {
    assert.equal(collectSlugFieldIds([], []).size, 0);
  });
});
