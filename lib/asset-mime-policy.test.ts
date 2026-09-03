/**
 * Regression cover for the stored-XSS hole in the asset pipeline (audit H3).
 *
 * `/ycode/api/files/register` stored the client's `mimeType` verbatim, and
 * `/a/{hash}/{name}` echoed it back as Content-Type on the BUILDER'S OWN
 * origin — so a member, or a stolen member session, could register bytes as
 * `text/html` and get a same-origin URL that executes.
 *
 * These tests drive the REAL route handlers with the real policy, faking only
 * storage and the database. Mutation-checked: deleting the
 * `validateStorableMimeType` call in the register route fails the store-rule
 * assertions, and dropping either header from `resolveAssetResponseSecurity`
 * fails the serve-rule ones.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import {
  normalizeMimeType,
  isAllowedAssetMimeType,
  isServeableMimeType,
  isActiveDocumentMimeType,
  validateStorableMimeType,
  resolveAssetResponseSecurity,
  FALLBACK_MIME_TYPE,
} from '@/lib/asset-mime-policy';
import { ALLOWED_MIME_TYPES } from '@/lib/asset-constants';

/**
 * Every MIME type actually reachable at /a/ in this project, counted from the
 * `assets` table on 2026-09-03 (rows with a storage_path). Serving any of these
 * as an attachment or as application/octet-stream breaks the live site — the
 * CSS and JS rows fatally, since `nosniff` makes a browser REFUSE a stylesheet
 * or script whose Content-Type is wrong.
 */
const LIVE_SERVED_MIME_TYPES: ReadonlyArray<[string, number]> = [
  ['image/webp', 595],
  ['text/css', 132],
  ['text/javascript', 112],
  ['video/mp4', 22],
  ['font/woff2', 8],
  ['video/webm', 4],
];

// `server-only` throws on import; pre-seed require.cache so the routes'
// dependency graphs load.
const serverOnlyPath = require.resolve('server-only');
require.cache[serverOnlyPath] = {
  id: serverOnlyPath,
  filename: serverOnlyPath,
  loaded: true,
  exports: {},
} as unknown as NodeModule;

// ---------------------------------------------------------------------------
// Fixture sanity (population law): if these drift, the assertions below pass
// vacuously — "HTML was rejected" means nothing if SVG was rejected too.
// ---------------------------------------------------------------------------

describe('asset mime policy — fixture sanity', () => {
  test('SVG really is an allowed type (the icons category depends on it)', () => {
    assert.ok(ALLOWED_MIME_TYPES.icons.includes('image/svg+xml'));
    assert.equal(isAllowedAssetMimeType('image/svg+xml'), true);
  });

  test('a plain image really is allowed, so rejection tests are not vacuous', () => {
    assert.equal(isAllowedAssetMimeType('image/png'), true);
    assert.equal(validateStorableMimeType('image/png'), null);
  });

  test('text/html is on no category list at all', () => {
    const every = Object.values(ALLOWED_MIME_TYPES).flat();
    assert.ok(!every.includes('text/html'));
  });
});

// ---------------------------------------------------------------------------
// The store rule.
// ---------------------------------------------------------------------------

describe('asset mime policy — store rule', () => {
  test('text/html cannot be stored', () => {
    assert.equal(validateStorableMimeType('text/html'), 'File type is not allowed');
  });

  test('a missing or empty type cannot be stored', () => {
    assert.ok(validateStorableMimeType(''));
    assert.ok(validateStorableMimeType(null));
    assert.ok(validateStorableMimeType(undefined));
  });

  test('a made-up image/* type cannot be stored (prefix matching is not enough)', () => {
    // getAssetCategoryFromMimeType would happily call this 'images' on a
    // startsWith check. Membership, not prefix, is the rule.
    assert.ok(validateStorableMimeType('image/evil'));
  });

  test('case and parameters cannot smuggle a type past the allowlist', () => {
    assert.ok(validateStorableMimeType('TEXT/HTML'));
    assert.ok(validateStorableMimeType('text/html; charset=utf-8'));
    assert.ok(validateStorableMimeType('  text/html  '));
  });

  test('case and parameters do not reject a legitimate type either', () => {
    assert.equal(validateStorableMimeType('IMAGE/PNG'), null);
    assert.equal(validateStorableMimeType('image/svg+xml; charset=utf-8'), null);
  });

  test('normalizeMimeType strips parameters, case and whitespace', () => {
    assert.equal(normalizeMimeType('  IMAGE/SVG+XML ; charset=utf-8 '), 'image/svg+xml');
    assert.equal(normalizeMimeType(null), '');
  });
});

// ---------------------------------------------------------------------------
// The serve rule.
// ---------------------------------------------------------------------------

describe('asset mime policy — serve rule', () => {
  test('every response carries nosniff', () => {
    for (const mime of ['image/png', 'image/svg+xml', 'video/mp4', 'application/pdf', 'text/html']) {
      const { headers } = resolveAssetResponseSecurity(mime);
      assert.equal(headers['X-Content-Type-Options'], 'nosniff', `missing on ${mime}`);
    }
  });

  test('an ordinary image is served inline, unchanged', () => {
    const { contentType, headers } = resolveAssetResponseSecurity('image/png');
    assert.equal(contentType, 'image/png');
    assert.equal(headers['Content-Disposition'], undefined);
    assert.equal(headers['Content-Security-Policy'], undefined);
  });

  test('SVG keeps its real type but gets BOTH execution guards', () => {
    const { contentType, headers } = resolveAssetResponseSecurity('image/svg+xml');
    // Serving SVG as octet-stream would break every legitimate icon, so the
    // type stays honest and the guards do the work.
    assert.equal(contentType, 'image/svg+xml');
    assert.equal(headers['Content-Disposition'], 'attachment');
    assert.equal(headers['Content-Security-Policy'], 'sandbox');
  });

  test('a legacy row storing text/html is downgraded, not echoed', () => {
    // Rows written before the store rule existed still hold whatever they were
    // given. The serve path must not trust them.
    const { contentType, headers } = resolveAssetResponseSecurity('text/html');
    assert.equal(contentType, FALLBACK_MIME_TYPE);
    assert.equal(headers['Content-Disposition'], 'attachment');
    assert.equal(headers['Content-Security-Policy'], 'sandbox');
  });

  test('a null or unrecognised stored type is downgraded and pinned shut', () => {
    for (const stored of [null, undefined, '', 'application/x-msdownload']) {
      const { contentType, headers } = resolveAssetResponseSecurity(stored);
      assert.equal(contentType, FALLBACK_MIME_TYPE, `type for ${String(stored)}`);
      assert.equal(headers['Content-Disposition'], 'attachment', `disposition for ${String(stored)}`);
    }
  });

  test('a scriptable type wearing a charset parameter is still caught', () => {
    const { contentType, headers } = resolveAssetResponseSecurity('IMAGE/SVG+XML; charset=utf-8');
    assert.equal(contentType, 'image/svg+xml');
    assert.equal(headers['Content-Security-Policy'], 'sandbox');
  });

  test('isActiveDocumentMimeType knows SVG is scriptable and PNG is not', () => {
    assert.equal(isActiveDocumentMimeType('image/svg+xml'), true);
    assert.equal(isActiveDocumentMimeType('text/html'), true);
    assert.equal(isActiveDocumentMimeType('image/png'), false);
    assert.equal(isActiveDocumentMimeType('video/mp4'), false);
  });

  test('no allowed non-SVG type is accidentally treated as scriptable', () => {
    // Guards against a future category addition quietly turning every video
    // into an attachment.
    const nonSvg = Object.values(ALLOWED_MIME_TYPES).flat().filter((m) => m !== 'image/svg+xml');
    for (const mime of nonSvg) {
      const { headers } = resolveAssetResponseSecurity(mime);
      assert.equal(headers['Content-Disposition'], undefined, `${mime} became an attachment`);
    }
  });
});

// ---------------------------------------------------------------------------
// The live-site guard. This is the regression the first draft of the serve rule
// actually caused: deriving it from the UPLOAD allowlist alone downgraded 252
// real assets — every stylesheet, script and font on the site.
// ---------------------------------------------------------------------------

describe('asset mime policy — types the live site serves through /a/', () => {
  test('fonts, stylesheets and scripts are absent from the UPLOAD allowlist', () => {
    // The trap, stated outright: these are legitimate served assets that no
    // file-manager category accepts. Any serve rule keyed on the upload
    // allowlist breaks them. If this ever fails, the two lists have merged and
    // the distinction below can be simplified.
    for (const mime of ['font/woff2', 'text/css', 'text/javascript']) {
      assert.equal(isAllowedAssetMimeType(mime), false, `${mime} is now uploadable`);
      assert.equal(isServeableMimeType(mime), true, `${mime} is not serveable`);
    }
  });

  for (const [mime, count] of LIVE_SERVED_MIME_TYPES) {
    test(`${mime} (${count} live rows) serves inline with its real type`, () => {
      const { contentType, headers } = resolveAssetResponseSecurity(mime);
      assert.equal(contentType, mime, `${mime} was rewritten to ${contentType}`);
      assert.equal(headers['Content-Disposition'], undefined, `${mime} became a download`);
      assert.equal(headers['Content-Security-Policy'], undefined, `${mime} was sandboxed`);
      assert.equal(headers['X-Content-Type-Options'], 'nosniff');
    });
  }

  test('CSS and JS are NOT treated as active documents', () => {
    // They are code only when something trusted includes them; navigating to
    // one renders inert text. Sandboxing them would break the site for no gain.
    assert.equal(isActiveDocumentMimeType('text/css'), false);
    assert.equal(isActiveDocumentMimeType('text/javascript'), false);
  });

  test('XML stays guarded — XSLT can turn it into HTML', () => {
    for (const mime of ['text/xml', 'application/xml', 'application/xslt+xml']) {
      assert.equal(isActiveDocumentMimeType(mime), true, `${mime} is unguarded`);
    }
  });
});

// ---------------------------------------------------------------------------
// Route level: the real POST /ycode/api/files/register handler.
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-require-imports */
// require(), not import: these modules are monkey-patched per test, which needs
// the live module object rather than a bound ES import binding.
const supabaseServer = require('@/lib/supabase-server');
const assetRepo = require('@/lib/repositories/assetRepository');
const registerRoute = require('@/app/(builder)/ycode/api/files/register/route');

interface CreatedAsset { mime_type: string; filename: string }

function postRegister(body: Record<string, unknown>): Promise<Response> {
  const request = new Request('http://localhost:3002/ycode/api/files/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return registerRoute.POST(request);
}

/** A body that differs from a legitimate one ONLY in its mimeType. */
function registerBody(mimeType: string, extra: Record<string, unknown> = {}) {
  return {
    storagePath: 'website/1234-abcd.svg',
    filename: 'logo.svg',
    mimeType,
    fileSize: 2048,
    source: 'file-manager',
    ...extra,
  };
}

describe('POST /ycode/api/files/register — client mimeType is not trusted', () => {
  let created: CreatedAsset[];
  let originalGetSupabaseAdmin: unknown;
  let originalCreateAsset: unknown;

  beforeEach(() => {
    created = [];
    originalGetSupabaseAdmin = supabaseServer.getSupabaseAdmin;
    originalCreateAsset = assetRepo.createAsset;

    supabaseServer.getSupabaseAdmin = async () => ({
      storage: {
        from: () => ({
          getPublicUrl: (path: string) => ({
            data: { publicUrl: `https://storage.test/${path}` },
          }),
        }),
      },
    });
    assetRepo.createAsset = async (data: CreatedAsset) => {
      created.push(data);
      return { id: 'asset_1', ...data };
    };
  });

  afterEach(() => {
    supabaseServer.getSupabaseAdmin = originalGetSupabaseAdmin;
    assetRepo.createAsset = originalCreateAsset;
  });

  test('the happy path still registers (otherwise every rejection below is vacuous)', async () => {
    const response = await postRegister(registerBody('image/png', { filename: 'hero.png' }));
    assert.equal(response.status, 200);
    assert.equal(created.length, 1);
    assert.equal(created[0].mime_type, 'image/png');
  });

  test('registering as text/html is refused and NOTHING is written', async () => {
    const response = await postRegister(registerBody('text/html'));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'File type is not allowed');
    // The row is the whole payload of the attack — a 400 that still wrote would
    // be no fix at all.
    assert.equal(created.length, 0);
  });

  test('a forged type is refused even though presign already ran on this file', async () => {
    // The attack: presign an SVG (a legitimately allowed icon type), PUT
    // whatever bytes you like into the signed URL, then register under a type
    // presign never saw. Register cannot lean on presign's verdict.
    const response = await postRegister(registerBody('text/html; charset=utf-8'));
    assert.equal(response.status, 400);
    assert.equal(created.length, 0);
  });

  test('a made-up image/* type is refused', async () => {
    const response = await postRegister(registerBody('image/evil'));
    assert.equal(response.status, 400);
    assert.equal(created.length, 0);
  });

  test('a legitimate SVG icon still registers — the store rule is not the SVG defense', async () => {
    const response = await postRegister(registerBody('image/svg+xml'));
    assert.equal(response.status, 200);
    assert.equal(created[0].mime_type, 'image/svg+xml');
  });

  test('the category rule matches presign when a category IS declared', async () => {
    const response = await postRegister(
      registerBody('image/svg+xml', { category: 'videos' })
    );
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'Only video files are allowed');
    assert.equal(created.length, 0);
  });

  test('a null category does not disable the mime check', async () => {
    // The file manager uploads with category: null. If the category check were
    // the only guard, this request would sail through.
    const response = await postRegister(registerBody('text/html', { category: null }));
    assert.equal(response.status, 400);
    assert.equal(created.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Route level: the real GET /a/{hash}/{name} handler.
// ---------------------------------------------------------------------------

const proxyAssetRepo = require('@/lib/repositories/assetRepository');
const proxyRoute = require('@/app/a/[hash]/[...name]/route');
const { uuidToBase62 } = require('@/lib/convertion-utils');

const ASSET_UUID = '11111111-2222-3333-4444-555555555555';

describe('GET /a/{hash}/{name} — stored mime is re-derived, not echoed', () => {
  let originalGetAssetForProxy: unknown;
  let originalGetSupabaseAdmin: unknown;
  let originalFetch: typeof globalThis.fetch;

  /** Serve one asset row through the real handler and hand back the response. */
  async function getAsset(mimeType: string | null, filename: string): Promise<Response> {
    proxyAssetRepo.getAssetForProxy = async () => ({
      id: ASSET_UUID,
      filename,
      mime_type: mimeType,
      storage_path: `website/stored-${filename}`,
    });

    const hash = uuidToBase62(ASSET_UUID);
    // Ask for the canonical name the route derives, so we get the asset itself
    // rather than the 301 that a mismatched cosmetic name would produce.
    const probe = await proxyRoute.GET(
      new Request(`http://localhost:3002/a/${hash}/x`),
      { params: Promise.resolve({ hash, name: ['x'] }) }
    );
    const canonicalName =
      probe.status === 301
        ? new URL(probe.headers.get('location')!).pathname.split('/').slice(3)
        : ['x'];

    return proxyRoute.GET(
      new Request(`http://localhost:3002/a/${hash}/${canonicalName.join('/')}`),
      { params: Promise.resolve({ hash, name: canonicalName }) }
    );
  }

  beforeEach(() => {
    originalGetAssetForProxy = proxyAssetRepo.getAssetForProxy;
    originalGetSupabaseAdmin = supabaseServer.getSupabaseAdmin;
    originalFetch = globalThis.fetch;

    supabaseServer.getSupabaseAdmin = async () => ({
      storage: {
        from: () => ({
          getPublicUrl: (path: string) => ({
            data: { publicUrl: `https://storage.test/${path}` },
          }),
        }),
      },
    });
    globalThis.fetch = (async () =>
      new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', {
        status: 200,
        headers: { 'content-length': '39' },
      })) as typeof globalThis.fetch;
  });

  afterEach(() => {
    proxyAssetRepo.getAssetForProxy = originalGetAssetForProxy;
    supabaseServer.getSupabaseAdmin = originalGetSupabaseAdmin;
    globalThis.fetch = originalFetch;
  });

  test('an ordinary image serves 200 inline (the control for every case below)', async () => {
    const response = await getAsset('image/png', 'hero.png');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('content-disposition'), null);
  });

  test('SVG is served with both execution guards', async () => {
    const response = await getAsset('image/svg+xml', 'logo.svg');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/svg+xml');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('content-disposition'), 'attachment');
    assert.equal(response.headers.get('content-security-policy'), 'sandbox');
  });

  test('a row that already stores text/html never serves as text/html', async () => {
    // The exact shape of the reported attack, for an asset registered before
    // the store rule shipped.
    const response = await getAsset('text/html', 'payload.html');
    assert.equal(response.headers.get('content-type'), FALLBACK_MIME_TYPE);
    assert.equal(response.headers.get('content-disposition'), 'attachment');
    assert.equal(response.headers.get('content-security-policy'), 'sandbox');
  });

  test('the served type never comes from the filename', async () => {
    // The `/a/` name segment is cosmetic and attacker-influenced. A row whose
    // stored type is a PNG must serve as a PNG no matter what the URL says.
    const response = await getAsset('image/png', 'actually-a.html');
    assert.equal(response.headers.get('content-type'), 'image/png');
  });
});
