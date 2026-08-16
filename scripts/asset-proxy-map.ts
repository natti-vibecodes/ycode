/**
 * Emit a storage-URL -> /a/ proxy-URL mapping for every asset (Supabase egress).
 *
 *   set -a; . .env; set +a; npm run assets:proxy-map -- --tsv
 *
 * Why this exists: chrome and page custom code hardcode `…supabase.co/storage/v1/object/public/…`
 * URLs. Those bypass the fork's own `/a/` route, which `next.config.ts` already serves with
 * `public, max-age=31536000, immutable`. Rewriting them to `/a/…` puts the app (and its CDN) in
 * front of Supabase for the EXISTING asset set — no re-upload, no new assets, and therefore none
 * of the asset-library litter a re-upload pass would create (Ycode has no upsert; every upload
 * mints a new asset).
 *
 * Measured: 129 distinct storage URLs are referenced from custom code, every one of them resolving
 * to an asset row, ~22 MB including 10 videos. Four background mp4s are 93% of a cold homepage's
 * 11.81 MB.
 *
 * The mapping is computed with `getAssetProxyUrl` itself rather than by reimplementing its base62
 * id encoding and slug rules. A hand-rolled copy that drifted would produce URLs that look right
 * and 404 — and a 404 on a background video is invisible until someone views the page.
 */

// A client built here rather than `lib/supabase-server`'s: that module imports `server-only`,
// which throws the moment it is loaded outside a Next server component. `lib/asset-utils` is safe
// to import — it is already used on both sides of the boundary, which is why the proxy-URL logic
// can be shared with this script instead of copied into it.
import { createClient } from '@supabase/supabase-js';
import { parseConnectionUrl } from '@/lib/supabase-config-parser';
import { getAssetProxyUrl } from '@/lib/asset-utils';

const STORAGE_PREFIX = '/storage/v1/object/public/assets/';

async function main() {
  const tsv = process.argv.includes('--tsv');
  // Derive the API URL exactly the way the app does, via `parseConnectionUrl`. `SUPABASE_URL` is
  // EMPTY in this repo's .env — the project URL is derived from the connection string's project
  // id — so a script reading `process.env.SUPABASE_URL` gets an empty string and reports missing
  // credentials for a correctly configured repo. Reusing the parser is the same principle as
  // reusing `getAssetProxyUrl` below: the app's rule lives in one place.
  const conn = process.env.SUPABASE_CONNECTION_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!conn || !key) {
    throw new Error(
      'SUPABASE_CONNECTION_URL / SUPABASE_SECRET_KEY not in the environment.\n'
      + 'Pass them without echoing the values, e.g.\n'
      + "  SUPABASE_CONNECTION_URL=\"$(grep '^SUPABASE_CONNECTION_URL=' .env | cut -d= -f2-)\" \\\n"
      + "  SUPABASE_SECRET_KEY=\"$(grep '^SUPABASE_SECRET_KEY=' .env | cut -d= -f2-)\" npm run assets:proxy-map",
    );
  }
  const { projectUrl } = parseConnectionUrl(conn, process.env.SUPABASE_URL || undefined);
  const client = createClient(projectUrl, key);

  const { data, error } = await client
    .from('assets')
    .select('id,filename,mime_type,storage_path,public_url')
    .not('storage_path', 'is', null);
  if (error) throw new Error(`assets query failed: ${error.message}`);

  const rows: { from: string; to: string; filename: string }[] = [];
  const skipped: string[] = [];

  for (const a of data ?? []) {
    const proxy = getAssetProxyUrl(a as Parameters<typeof getAssetProxyUrl>[0]);
    if (!proxy) { skipped.push(a.storage_path as string); continue; }
    // Prefer the stored public_url; fall back to composing it, since that is the exact string
    // the custom code will contain.
    const from = (a.public_url as string | null)
      ?? `${STORAGE_PREFIX}${a.storage_path}`;
    rows.push({ from, to: proxy, filename: a.filename as string });
  }

  rows.sort((x, y) => x.from.localeCompare(y.from));

  if (tsv) {
    for (const r of rows) console.log(`${r.from}\t${r.to}`);
  } else {
    console.log(JSON.stringify({ generated_for: 'chrome custom-code URL rewrite', count: rows.length, mapping: rows }, null, 2));
  }

  if (skipped.length) {
    console.error(`\n${skipped.length} asset(s) have no storage_path and cannot be proxied:`);
    for (const s of skipped.slice(0, 10)) console.error(`  ${s}`);
  }
  console.error(`\n${rows.length} assets mapped.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
