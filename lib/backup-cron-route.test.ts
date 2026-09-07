/**
 * Cover for `GET /api/cron/backup` — the nightly off-machine project backup.
 *
 * Two properties are load-bearing and neither is provable by reading the handler:
 *
 *   1. AUTH FAILS CLOSED. With no `CRON_SECRET` configured the route must refuse, and must
 *      refuse *before* the export runs. The assertion is not just `status === 401`: it is that
 *      `exportProject` was never reached, so the test still bites if someone returns 401 after
 *      already dumping the project.
 *   2. THE ARCHIVE CARRIES NO SECRETS. The fixture below deliberately contains a Supabase
 *      secret key, a service-role JWT, an SMTP password and an Anthropic API key — because an
 *      archive that never held them would pass a "no secrets" assertion vacuously, which is the
 *      exact shape the population law warns about. Every one of those values is asserted
 *      PRESENT in the fixture and ABSENT from the emitted bytes.
 *
 * The route handler is driven for real; only `exportProject` (which needs a database) is faked.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'zlib';
import { NextRequest } from 'next/server';

/* eslint-disable @typescript-eslint/no-require-imports */
// require(), not import: projectService is stubbed in require.cache before the route loads,
// and hoisted imports cannot express that ordering.

// `server-only` throws on import; pre-seed require.cache so the route's graph loads.
const serverOnlyPath = require.resolve('server-only');
require.cache[serverOnlyPath] = {
  id: serverOnlyPath,
  filename: serverOnlyPath,
  loaded: true,
  exports: {},
} as unknown as NodeModule;

// `migrations-loader` uses webpack's `require.context`, which does not exist under node --test.
// projectService imports it for the import path only; the export path never touches it.
const migrationsLoaderPath = require.resolve('@/lib/migrations-loader');
require.cache[migrationsLoaderPath] = {
  id: migrationsLoaderPath,
  filename: migrationsLoaderPath,
  loaded: true,
  exports: { migrations: [] },
} as unknown as NodeModule;

const projectService = require('@/lib/services/projectService');
const { findSecretMarkers } = require('@/lib/services/backup-redaction');

/** Credential-shaped values planted in the fixture. None is a real key. */
const PLANTED = {
  supabaseSecret: 'sb_secret_TESTONLY0000000000000000000000',
  serviceRoleJwt:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIiwiaWF0IjoxfQ.TESTONLYsignature',
  smtpPassword: 'hunter2-smtp-TESTONLY',
  anthropicKey: 'sk-ant-TESTONLY-0000000000',
  airtableToken: 'patTESTONLY.0000000000',
  leadEmail: 'a-real-lead@example.com',
};

/** How many times the (faked) privileged export was reached. */
let exportCalls = 0;
/** Options the route passed to exportProject on its last call. */
let lastExportOptions: unknown;

const realExportProject = projectService.exportProject;

function buildFixture() {
  return {
    success: true,
    export: {
      manifest: {
        version: '1.0.0',
        exportedAt: '2026-09-07T03:11:00.000Z',
        source: 'opensource' as const,
        projectName: 'Scalability',
        tables: [],
        stats: { pages: 55, components: 13, collections: 4, assets: 441 },
        lastMigration: '0042_something',
      },
      data: {
        settings: [
          { key: 'site_name', value: '"Scalability"' },
          { key: 'custom_code_head', value: '"<link rel=stylesheet>"' },
          { key: 'published_css', value: '".a{color:red}"' },
          // Secret-bearing rows — must not survive.
          { key: 'email', value: JSON.stringify({ smtp_host: 'smtp.example.com', smtp_user: 'u', smtp_password: PLANTED.smtpPassword }) },
          { key: 'ai_anthropic_api_key', value: JSON.stringify(PLANTED.anthropicKey) },
          { key: 'ai_openai_api_key:user-123', value: JSON.stringify('sk-TESTONLY') },
          { key: 'supabase_service_secret', value: JSON.stringify(PLANTED.supabaseSecret) },
        ],
        pages: [{ id: 'p1', slug: 'home' }, { id: 'p2', slug: 'about' }],
        page_layers: [{ id: 'l1', page_id: 'p1', layers: '[]' }],
        components: [{ id: 'c1', name: 'Nav' }],
        collections: [{ id: 'col1', name: 'Articles' }],
        collection_items: [{ id: 'ci1', collection_id: 'col1' }],
        assets: [{ id: 'a1', storage_path: 'assets/hero.webp', name: 'hero' }],
        // Excluded tables — each carries a planted credential or personal datum.
        api_keys: [{ id: 'k1', token: PLANTED.serviceRoleJwt }],
        app_settings: [{ app_id: 'airtable', settings: JSON.stringify({ access_token: PLANTED.airtableToken }) }],
        webhooks: [{ id: 'w1', url: `https://hooks.example.com/${PLANTED.airtableToken}` }],
        webhook_deliveries: [{ id: 'd1', webhook_id: 'w1' }],
        form_submissions: [{ id: 's1', data: JSON.stringify({ email: PLANTED.leadEmail }) }],
        ai_chats: [{ id: 'ch1', messages: '[]' }],
      },
      files: undefined,
    },
  };
}

projectService.exportProject = async (options: unknown) => {
  exportCalls += 1;
  lastExportOptions = options;
  return buildFixture();
};

const { GET } = require('@/app/(site)/api/cron/backup/route');

function get(authHeader?: string): NextRequest {
  return new NextRequest('http://localhost:3002/api/cron/backup', {
    headers: authHeader ? { authorization: authHeader } : {},
  });
}

async function readArchive(response: Response): Promise<{ text: string; parsed: Record<string, unknown> }> {
  const packed = Buffer.from(await response.arrayBuffer());
  const text = gunzipSync(packed).toString('utf-8');
  return { text, parsed: JSON.parse(text) };
}

describe('GET /api/cron/backup — authorization', () => {
  beforeEach(() => {
    exportCalls = 0;
    lastExportOptions = undefined;
  });

  test('refuses when CRON_SECRET is unset, without running the export', async () => {
    delete process.env.CRON_SECRET;

    const response = await GET(get('Bearer anything'));

    assert.equal(response.status, 401);
    assert.equal(exportCalls, 0, 'the project must not be dumped before the gate answers');
  });

  test('refuses a blank CRON_SECRET', async () => {
    process.env.CRON_SECRET = '   ';

    const response = await GET(get('Bearer    '));

    assert.equal(response.status, 401);
    assert.equal(exportCalls, 0);
  });

  test('refuses a missing Authorization header', async () => {
    process.env.CRON_SECRET = 'correct-horse';

    const response = await GET(get());

    assert.equal(response.status, 401);
    assert.equal(exportCalls, 0);
  });

  test('refuses a wrong secret', async () => {
    process.env.CRON_SECRET = 'correct-horse';

    const response = await GET(get('Bearer battery-staple'));

    assert.equal(response.status, 401);
    assert.equal(exportCalls, 0);
  });

  test('accepts the configured secret', async () => {
    process.env.CRON_SECRET = 'correct-horse';

    const response = await GET(get('Bearer correct-horse'));

    assert.equal(response.status, 200);
    assert.equal(exportCalls, 1);
  });
});

describe('GET /api/cron/backup — archive contents', () => {
  beforeEach(() => {
    exportCalls = 0;
    process.env.CRON_SECRET = 'correct-horse';
  });

  test('the fixture really does contain the secrets the next tests look for', () => {
    // Without this, "no secrets in the archive" could pass on an archive built from a
    // secret-free fixture — a clean result from an empty population.
    const fixture = JSON.stringify(buildFixture());
    for (const [name, value] of Object.entries(PLANTED)) {
      assert.ok(fixture.includes(value), `fixture is missing its planted ${name}`);
    }
    assert.deepEqual(
      findSecretMarkers(fixture).sort(),
      ['jwt', 'smtp credentials', 'supabase secret key'],
      'the marker scanner must fire on the un-redacted fixture, or it proves nothing on the archive',
    );
  });

  test('carries pages, layers, components, settings, collections and the asset manifest', async () => {
    const response = await GET(get('Bearer correct-horse'));
    const { parsed } = await readArchive(response);

    const data = parsed.data as Record<string, unknown[]>;
    for (const table of ['pages', 'page_layers', 'components', 'settings', 'collections', 'collection_items', 'assets']) {
      assert.ok(Array.isArray(data[table]) && data[table].length > 0, `archive is missing ${table}`);
    }
    assert.equal((data.assets[0] as Record<string, unknown>).storage_path, 'assets/hero.webp');

    const manifest = parsed.manifest as Record<string, unknown>;
    assert.deepEqual(manifest.stats, { pages: 55, components: 13, collections: 4, assets: 441 });
    assert.equal(manifest.assetFilesIncluded, false);
    assert.deepEqual(manifest.tables, Object.keys(data), 'the manifest must list what the archive actually holds');
  });

  test('asks the exporter to skip asset binaries', async () => {
    await GET(get('Bearer correct-horse'));
    assert.deepEqual(lastExportOptions, { includeAssetFiles: false });
  });

  test('drops every credential-bearing and personal-data table', async () => {
    const response = await GET(get('Bearer correct-horse'));
    const { parsed } = await readArchive(response);
    const data = parsed.data as Record<string, unknown>;

    for (const table of ['api_keys', 'app_settings', 'webhooks', 'webhook_deliveries', 'form_submissions', 'ai_chats']) {
      assert.equal(data[table], undefined, `${table} must not be in an automated backup`);
    }
  });

  test('drops secret-bearing settings rows and keeps the rest', async () => {
    const response = await GET(get('Bearer correct-horse'));
    const { parsed } = await readArchive(response);
    const settings = (parsed.data as Record<string, Record<string, unknown>[]>).settings;
    const keys = settings.map((row) => row.key);

    assert.deepEqual(keys, ['site_name', 'custom_code_head', 'published_css']);
    for (const secretKey of ['email', 'ai_anthropic_api_key', 'ai_openai_api_key:user-123', 'supabase_service_secret']) {
      assert.ok(!keys.includes(secretKey), `${secretKey} must be stripped`);
    }
  });

  test('the emitted bytes contain none of the planted credentials', async () => {
    const response = await GET(get('Bearer correct-horse'));
    const { text } = await readArchive(response);

    for (const [name, value] of Object.entries(PLANTED)) {
      assert.ok(!text.includes(value), `archive leaked the planted ${name}`);
    }
    assert.deepEqual(findSecretMarkers(text), [], 'archive matched a credential marker');
  });

  test('records what it redacted, by name', async () => {
    const response = await GET(get('Bearer correct-horse'));
    const { parsed } = await readArchive(response);
    const redactions = (parsed.manifest as Record<string, { tables: string[]; settingKeys: string[] }>).redactions;

    assert.deepEqual(redactions.tables, [
      'api_keys',
      'app_settings',
      'webhooks',
      'webhook_deliveries',
      'form_submissions',
      'ai_chats',
    ]);
    assert.deepEqual(redactions.settingKeys, [
      'ai_anthropic_api_key',
      'ai_openai_api_key:user-123',
      'email',
      'supabase_service_secret',
    ]);
  });

  test('names the file by date and declares its type', async () => {
    const response = await GET(get('Bearer correct-horse'));

    assert.equal(response.headers.get('content-type'), 'application/gzip');
    assert.match(
      response.headers.get('content-disposition') || '',
      /filename="scalability-backup-2026-09-07\.ycode\.gz"/,
    );
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });
});

describe('exportProject stub hygiene', () => {
  test('the real exportProject is still exported (the stub replaced, not deleted, it)', () => {
    assert.equal(typeof realExportProject, 'function');
  });
});
