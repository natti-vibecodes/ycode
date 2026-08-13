import type { NextConfig } from 'next';

const imageRemotePatterns: NonNullable<NonNullable<NextConfig['images']>['remotePatterns']> = [
  {
    protocol: 'https',
    hostname: '**.supabase.co',
    pathname: '/storage/v1/object/public/**',
  },
];

// Self-hosted Supabase: allow the custom domain for storage image optimization.
// Supports both "https://supabase.example.com" and bare "supabase.example.com".
if (process.env.SUPABASE_URL) {
  try {
    const parsed = new URL(
      process.env.SUPABASE_URL.startsWith('http')
        ? process.env.SUPABASE_URL
        : `https://${process.env.SUPABASE_URL}`,
    );
    imageRemotePatterns.push({
      protocol: (parsed.protocol.replace(':', '') as 'http' | 'https') || 'https',
      hostname: parsed.hostname,
      pathname: '/storage/v1/object/public/**',
    });
  } catch {
    // Invalid SUPABASE_URL — skip adding remote pattern
  }
}

/**
 * The commit this server process is booting from (SCA-1272, SCA-1298).
 *
 * Read HERE, in the Next config, because this file is evaluated once in a plain Node context
 * before the server starts and is never bundled for any runtime. The previous home for this —
 * `instrumentation.ts` importing a module that used `node:child_process` — was compiled for the
 * EDGE runtime too, where both `child_process` and `process.cwd()` are illegal. That failed to
 * build on every on-demand compile and buried the log (1,544 errors in 21 minutes), which is
 * what made a tester's page churn while she tried to work.
 *
 * The value is inlined only into modules that reference it, and the sole reference is
 * server-side, so it does not reach client bundles.
 */
function bootCommit(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execFileSync } = require('node:child_process');
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3_000,
    }).trim();
  } catch {
    return ''; // no git (container, deploy artifact) — the drift check simply stays quiet
  }
}

const nextConfig: NextConfig = {
  /**
   * Build output directory (SCA-1316). The REVIEW server on :3003 must not share `.next` with
   * the dev server on :3002 — two Next processes over one build dir is what produced
   * MODULE_UNPARSABLE and a dead site on 2026-08-12. `npm run review` sets NEXT_DIST_DIR.
   */
  distDir: process.env.NEXT_DIST_DIR || '.next',
  env: {
    YCODE_BOOT_COMMIT: bootCommit(),
  },
  trailingSlash: false,
  staticPageGenerationTimeout: 120,
  experimental: {
    proxyClientMaxBodySize: '500mb',
  },
  images: {
    remotePatterns: imageRemotePatterns,
  },

  // Ensure sharp works properly in serverless environments (Vercel)
  // Also externalize Knex database drivers (we only use PostgreSQL)
  // This works for both webpack and Turbopack
  serverExternalPackages: [
    'sharp',
    'oracledb',
    'mysql',
    'mysql2',
    'sqlite3',
    'better-sqlite3',
    'tedious',
    'pg-query-stream',
  ],

  // Turbopack configuration
  // Map unused database drivers to stub modules (we only use PostgreSQL)
  // This prevents Turbopack from trying to resolve packages that aren't installed
  turbopack: {
    resolveAlias: {
      // Map unused database drivers to stub module to prevent resolution errors
      'oracledb': './lib/stubs/db-driver-stub.ts',
      'mysql': './lib/stubs/db-driver-stub.ts',
      'mysql2': './lib/stubs/db-driver-stub.ts',
      'sqlite3': './lib/stubs/db-driver-stub.ts',
      'better-sqlite3': './lib/stubs/db-driver-stub.ts',
      'tedious': './lib/stubs/db-driver-stub.ts',
      'pg-query-stream': './lib/stubs/db-driver-stub.ts',
    },
  },

  async headers() {
    return [
      {
        // Asset proxy: immutable caching (content-addressed by hash)
        source: '/a/:path*',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=31536000, immutable',
          },
        ],
      },
      {
        // Apply to public pages ONLY (exclude /ycode/*, /_next/*, /a/*)
        // NOTE: Do NOT set Cache-Control here. Vercel recommends letting
        // ISR manage cache headers automatically so per-URL cache-tag
        // tracking works for selective revalidateTag invalidations.
        // Manual s-maxage breaks per-URL purging on catch-all routes.
        source: '/:path((?!ycode|_next|a/).*)*',
        headers: [
          {
            // Open the TLS connection to fonts.gstatic.com while the document
            // is still streaming so woff2 binaries can be fetched the moment
            // the inlined @font-face rules are parsed. Sending this as a
            // response header (vs. <link rel=preconnect> in <head>) lets the
            // browser act on it before parsing the document.
            key: 'Link',
            value: '<https://fonts.gstatic.com>; rel=preconnect; crossorigin',
          },
        ],
      },
    ];
  },

  webpack: (config, { isServer }) => {
    if (isServer) {
      // Ignore optional dependencies that Knex tries to load
      // We only use PostgreSQL, so we don't need these drivers
      config.externals = config.externals || [];
      config.externals.push({
        'oracledb': 'commonjs oracledb',
        'mysql': 'commonjs mysql',
        'mysql2': 'commonjs mysql2',
        'sqlite3': 'commonjs sqlite3',
        'better-sqlite3': 'commonjs better-sqlite3',
        'tedious': 'commonjs tedious',
        'pg-query-stream': 'commonjs pg-query-stream',
      });
    }

    // Suppress Knex migration warnings (we don't use migrations in Next.js runtime)
    config.ignoreWarnings = [
      ...(config.ignoreWarnings || []),
      {
        module: /node_modules\/knex\/lib\/migrations\/util\/import-file\.js/,
        message: /Critical dependency: the request of a dependency is an expression/,
      },
    ];

    return config;
  },
};

export default nextConfig;
