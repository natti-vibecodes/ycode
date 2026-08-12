import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildLlmsTxt, findSummaryField } from './llms-txt';
import { isIndexablePage } from './sitemap-utils';
import type { CollectionField, Page } from '@/types';

const page = (overrides: Partial<Page>): Page => ({
  id: 'p', slug: 's', name: 'Page', page_folder_id: null, order: 0, depth: 0,
  is_index: false, is_dynamic: false, error_page: null, settings: {},
  is_published: true, is_publishable: true,
  created_at: '', updated_at: '', deleted_at: null,
  ...overrides,
});

describe('isIndexablePage (shared by sitemap.xml and llms.txt)', () => {
  test('REGRESSION: noindex and error pages are excluded — by ONE rule, not two copies', () => {
    // Two independent copies of this rule would look identical the day they were written and
    // drift the first time one was edited, leaving llms.txt advertising a noindex page.
    assert.equal(isIndexablePage(page({})), true);
    assert.equal(isIndexablePage(page({ settings: { seo: { noindex: true, title: '', description: '', image: null } } })), false);
    assert.equal(isIndexablePage(page({ error_page: 404 })), false);
  });
});

const field = (over: Partial<CollectionField>): CollectionField =>
  ({ id: 'f', key: null, name: 'F', type: 'text', fillable: true, ...over } as CollectionField);

describe('findSummaryField', () => {
  test('REGRESSION: matches on NAME, because every field key here is null', () => {
    // Matching only on `key` produced a file with no descriptions at all — which read as a
    // formatting choice rather than a miss. This workspace names the summary field "Dek".
    const fields = [field({ id: 'title', name: 'Title' }), field({ id: 'dek', name: 'Dek' })];
    assert.equal(findSummaryField(fields)?.id, 'dek');
  });

  test('rich text is a body, not a description', () => {
    const fields = [field({ id: 'body', name: 'Description', type: 'rich_text' })];
    assert.equal(findSummaryField(fields), null);
  });

  test('an SEO description outranks a generic one', () => {
    const fields = [field({ id: 'd', name: 'Description' }), field({ id: 's', name: 'SEO description' })];
    assert.equal(findSummaryField(fields)?.id, 's');
  });

  test('a key still matches when one is set, punctuation and case aside', () => {
    assert.equal(findSummaryField([field({ id: 'x', key: 'SEO_Description', name: 'Whatever' })])?.id, 'x');
  });

  test('no summary-shaped field returns null rather than the first text field', () => {
    // Falling back to "some text field" would put a cost label or read time in every line.
    const fields = [field({ id: 'r', name: 'Read time' }), field({ id: 'c', name: 'Cost label' })];
    assert.equal(findSummaryField(fields), null);
  });
});

describe('buildLlmsTxt', () => {
  test('renders the llmstxt.org shape', () => {
    const out = buildLlmsTxt({
      siteName: 'Scalability',
      siteDescription: 'Design and engineering studio.',
      sections: [{
        name: 'Services',
        entries: [{ url: 'https://x/services/design-branding', title: 'Design & Branding', description: 'Brand systems.' }],
      }],
    });
    assert.match(out, /^# Scalability\n/);
    assert.match(out, /\n> Design and engineering studio\.\n/);
    assert.match(out, /\n## Services\n/);
    assert.match(out, /- \[Design & Branding\]\(https:\/\/x\/services\/design-branding\): Brand systems\./);
  });

  test('an entry with no description renders without a trailing colon', () => {
    const out = buildLlmsTxt({ siteName: 'S', sections: [{ name: 'Pages', entries: [{ url: '/a', title: 'A' }] }] });
    assert.match(out, /- \[A\]\(\/a\)\n/);
    assert.doesNotMatch(out, /\/a\):/);
  });

  test('empty sections are dropped, not rendered as bare headings', () => {
    // A heading with nothing under it reads as "this section is broken".
    const out = buildLlmsTxt({
      siteName: 'S',
      sections: [{ name: 'Pages', entries: [] }, { name: 'Services', entries: [{ url: '/x', title: 'X' }] }],
    });
    assert.doesNotMatch(out, /## Pages/);
    assert.match(out, /## Services/);
  });

  test('newlines in a CMS description cannot break the list format', () => {
    const out = buildLlmsTxt({
      siteName: 'S',
      sections: [{ name: 'Insights', entries: [{ url: '/i', title: 'Multi\nline  title', description: 'a\n\nb' }] }],
    });
    assert.match(out, /- \[Multi line title\]\(\/i\): a b\n/);
  });

  test('a title containing link syntax cannot forge a second link', () => {
    // Stripping the brackets is what does the work: the label can no longer close early, so the
    // leftover parens are inert text inside it. The line must still resolve to exactly one link,
    // pointing where we said it points.
    const out = buildLlmsTxt({
      siteName: 'S',
      sections: [{ name: 'Pages', entries: [{ url: '/p', title: 'Read [this](http://evil)' }] }],
    });
    const links = [...out.matchAll(/\[[^\]]*\]\(([^)]*)\)/g)].map((m) => m[1]);
    assert.deepEqual(links, ['/p']);
  });

  test('a titleless entry falls back to its URL rather than an empty link', () => {
    const out = buildLlmsTxt({ siteName: 'S', sections: [{ name: 'Pages', entries: [{ url: '/p', title: '  ' }] }] });
    assert.match(out, /- \[\/p\]\(\/p\)/);
  });
});
