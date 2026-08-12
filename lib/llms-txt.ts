import type { CollectionField } from '@/types';

/**
 * llms.txt generation (SCA-1121).
 *
 * `/llms.txt` served a 404 unless someone pasted the whole file into settings by hand — which
 * means in practice it was never served at all, and every page added since would have had to be
 * pasted in again. This generates it from the same live pages the sitemap draws from.
 *
 * The one rule that matters here: llms.txt and sitemap.xml must never disagree about what is
 * live. Both go through `isIndexablePage`, so a page marked noindex or an error page cannot
 * appear in one and be missing from the other. A second, independently-drifting list of "the
 * site's pages" is exactly the kind of thing that looks right for months and is quietly wrong.
 *
 * Format follows https://llmstxt.org/ — an H1 site name, an optional blockquote summary, then
 * H2 sections of `- [Title](url): description` links.
 */

/**
 * Fields that carry a one-line summary, best first.
 *
 * Matched against BOTH `key` and `name`, case-insensitively. In this workspace every field's
 * `key` is null and the summary field is named "Dek" — a key-only match silently produced a
 * file with no descriptions at all, which looked like a formatting choice rather than a miss.
 */
const SUMMARY_NAMES = ['seo description', 'meta description', 'dek', 'description', 'excerpt', 'summary', 'intro'];

/** Types that can hold a one-line summary. Rich text is a body, not a description. */
const SUMMARY_TYPES = new Set(['text', 'textarea', 'long_text']);

export function findSummaryField(fields: CollectionField[]): CollectionField | null {
  const candidates = fields.filter((f) => SUMMARY_TYPES.has(f.type));
  for (const wanted of SUMMARY_NAMES) {
    const match = candidates.find(
      (f) => f.key?.toLowerCase().replace(/[-_]/g, ' ') === wanted
        || f.name?.toLowerCase().trim() === wanted,
    );
    if (match) return match;
  }
  return null;
}

export interface LlmsEntry {
  url: string;
  title: string;
  description?: string;
}

export interface LlmsSection {
  /** Section heading, e.g. "Services". */
  name: string;
  entries: LlmsEntry[];
}

export interface LlmsTxtInput {
  siteName: string;
  /** One-line summary rendered as the blockquote directly under the title. */
  siteDescription?: string;
  sections: LlmsSection[];
}

/** Collapse whitespace and strip markdown link syntax that would break a list line. */
function clean(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/[[\]]/g, '').trim();
}

function renderEntry(entry: LlmsEntry): string {
  const title = clean(entry.title) || entry.url;
  const description = entry.description ? clean(entry.description) : '';
  return description
    ? `- [${title}](${entry.url}): ${description}`
    : `- [${title}](${entry.url})`;
}

/**
 * Render an llms.txt document. Sections with no entries are dropped rather than rendered as an
 * empty heading — a heading with nothing under it reads as "this section is broken".
 */
export function buildLlmsTxt(input: LlmsTxtInput): string {
  const lines: string[] = [`# ${clean(input.siteName)}`];

  if (input.siteDescription?.trim()) {
    lines.push('', `> ${clean(input.siteDescription)}`);
  }

  for (const section of input.sections) {
    if (!section.entries.length) continue;
    lines.push('', `## ${clean(section.name)}`, '');
    for (const entry of section.entries) lines.push(renderEntry(entry));
  }

  return lines.join('\n') + '\n';
}
