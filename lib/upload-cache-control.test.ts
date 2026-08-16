import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Storage uploads: a long cache lifetime is only safe on a path that is never reused.
 *
 * Supabase sent a free-tier egress overage on 2026-08-16. A cold homepage pulls 11.81 MB of
 * storage — 93% of it four background mp4s — and every asset was served `max-age=3600`, so a
 * visitor re-downloaded the whole set every hour. `lib/file-upload.ts` now uploads with
 * `max-age=31536000`.
 *
 * That is safe there for one specific reason: `generateStoragePath` mints
 * `{folder}/{timestamp}-{random}.{ext}`, so a URL is never reused and same URL always means same
 * bytes. Some upload sites do the opposite — `thumbnail-upload.ts` writes
 * `components/{componentId}.webp` and the avatar route reuses a per-user path, both with
 * `upsert: true`. A year-long max-age on those pins a stale image with no way to bust it, and the
 * failure is invisible to whoever changes the image.
 *
 * So the rule is a PAIRING, not a value: immutable caching requires a unique path. Asserted across
 * every upload call rather than on the one file that prompted it, because the next upload site
 * will be written by copy-paste from one of these.
 *
 * (An earlier version of the egress investigation reported these assets as `no-cache`. That was a
 * HEAD-vs-GET artifact — Supabase answers HEAD with `no-cache` and GET with the real value. The
 * stored metadata on all 441 objects said `max-age=3600` and the code said `3600`; the probe was
 * wrong, not both of them.)
 */

const LIB = join(__dirname);
const LONG_CACHE_SECONDS = 86_400; // anything at/above a day counts as "long-lived" here

function tsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) tsFiles(full, acc);
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) acc.push(full);
  }
  return acc;
}

/**
 * Strip comments before matching. The first version of this suite failed on `file-upload.ts`,
 * whose options object is `upsert: false` — because the comment above it says "do NOT copy this
 * to the upload sites that pass `upsert: true`", and the regex read the warning as the violation.
 * Same trap as the sync-chrome docstring guard: a text check cannot tell code from the prose
 * documenting it, and a well-written comment quotes the thing it warns about.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Every `.upload(...)` options object in lib/, as code with comments removed. */
function uploadCalls(): { file: string; body: string }[] {
  const out: { file: string; body: string }[] = [];
  for (const file of tsFiles(LIB)) {
    const src = stripComments(readFileSync(file, 'utf8'));
    for (const m of src.matchAll(/\.upload\(([\s\S]*?)\n\s*\}\);/g)) {
      out.push({ file: file.slice(LIB.length + 1), body: m[1] });
    }
  }
  return out;
}

describe('storage upload cache-control (Supabase egress)', () => {
  const calls = uploadCalls();

  test('the scan finds the upload sites at all', () => {
    // A regex that silently matches nothing would make every assertion below vacuously pass —
    // the exact shape of failure this suite exists to catch elsewhere.
    assert.ok(calls.length >= 3, `expected several upload sites, found ${calls.length}`);
    assert.ok(calls.some((c) => c.file === 'file-upload.ts'), 'file-upload.ts must be scanned');
  });

  test('REGRESSION: long-lived caching is never paired with upsert:true', () => {
    for (const { file, body } of calls) {
      const seconds = Number(body.match(/cacheControl:\s*'(\d+)'/)?.[1] ?? 0);
      if (seconds < LONG_CACHE_SECONDS) continue;
      assert.doesNotMatch(
        body, /upsert:\s*true/,
        `${file} caches for ${seconds}s on an upsert (reused) path — a stale asset would be pinned `
        + 'with no way to bust it. Long max-age requires a unique-per-upload path.',
      );
    }
  });

  test('the website asset path caches for a year', () => {
    // The fix itself. `uploadFile` is what serves site.js, the fonts, the images and the mp4s.
    const fileUpload = calls.find((c) => c.file === 'file-upload.ts');
    assert.ok(fileUpload, 'file-upload.ts should contain an upload call');
    assert.match(fileUpload!.body, /cacheControl:\s*'31536000'/);
    assert.match(fileUpload!.body, /upsert:\s*false/, 'the unique path is the precondition');
  });

  test('mutable-path uploads stay short-lived', () => {
    for (const name of ['thumbnail-upload.ts']) {
      const call = calls.find((c) => c.file === name);
      if (!call) continue;
      const seconds = Number(call.body.match(/cacheControl:\s*'(\d+)'/)?.[1] ?? 0);
      assert.ok(seconds < LONG_CACHE_SECONDS,
        `${name} reuses its path, so it must not cache long-lived (found ${seconds}s)`);
    }
  });
});
