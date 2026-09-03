/**
 * Regression cover for proxy.ts failing OPEN on an unusable Supabase config
 * (security audit, 2026-09-02).
 *
 * proxy.ts had:
 *
 *   const config = getSupabaseEnvConfig();
 *   // If env vars aren't set (pre-setup or local dev without .env.local), let through
 *   if (!config) return null;
 *
 * The comment describes one of the two states that produce null. The other is
 * "credentials ARE configured but cannot be parsed" — an anon key with no connection URL, or
 * a connection URL whose project-ref regex misses. In that state every builder API route
 * became unauthenticated, silently, from a single typo'd env var.
 *
 * The cases that fail against the old code are the misconfiguration ones: each must resolve
 * to `unavailable`, never `allow-pre-setup`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProxyAuth } from './proxy-auth-config';

const ANON = 'sb_publishable_abc123';
const CONNECTION = 'postgresql://postgres.abcdefghijklm:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres';

describe('proxy auth config — the happy paths still work', () => {
  test('hosted Supabase derives the project URL from the connection string', () => {
    const decision = resolveProxyAuth(
      { SUPABASE_PUBLISHABLE_KEY: ANON, SUPABASE_CONNECTION_URL: CONNECTION },
      'production',
    );

    assert.equal(decision.mode, 'authenticate');
    assert.equal((decision as { url: string }).url, 'https://abcdefghijklm.supabase.co');
    assert.equal((decision as { anonKey: string }).anonKey, ANON);
  });

  test('self-hosted uses SUPABASE_URL and strips trailing slashes', () => {
    const decision = resolveProxyAuth(
      {
        SUPABASE_ANON_KEY: ANON,
        SUPABASE_CONNECTION_URL: CONNECTION,
        SUPABASE_URL: 'https://supabase.my-company.com//',
      },
      'production',
    );

    assert.equal(decision.mode, 'authenticate');
    assert.equal((decision as { url: string }).url, 'https://supabase.my-company.com');
  });

  test('SUPABASE_ANON_KEY is honoured when the publishable key is absent', () => {
    const decision = resolveProxyAuth(
      { SUPABASE_ANON_KEY: ANON, SUPABASE_CONNECTION_URL: CONNECTION },
      'development',
    );
    assert.equal(decision.mode, 'authenticate');
  });
});

describe('proxy auth config — genuine pre-setup stays permissive in dev', () => {
  test('nothing configured at all lets requests through outside production', () => {
    assert.equal(resolveProxyAuth({}, 'development').mode, 'allow-pre-setup');
    assert.equal(resolveProxyAuth({}, undefined).mode, 'allow-pre-setup');
    assert.equal(resolveProxyAuth({}, 'test').mode, 'allow-pre-setup');
  });

  test('blank strings count as unconfigured, not as a misconfiguration', () => {
    const decision = resolveProxyAuth(
      { SUPABASE_ANON_KEY: '   ', SUPABASE_CONNECTION_URL: '' },
      'development',
    );
    assert.equal(decision.mode, 'allow-pre-setup');
  });
});

describe('proxy auth config — production never opens up', () => {
  test('nothing configured in production is a refusal, not a pass', () => {
    const decision = resolveProxyAuth({}, 'production');
    assert.equal(decision.mode, 'unavailable');
  });
});

describe('proxy auth config — a parse failure is NEVER permissive', () => {
  test('anon key set but no connection URL refuses, in dev too', () => {
    for (const nodeEnv of ['development', 'production', 'test', undefined]) {
      const decision = resolveProxyAuth({ SUPABASE_PUBLISHABLE_KEY: ANON }, nodeEnv);
      assert.equal(decision.mode, 'unavailable', `nodeEnv=${nodeEnv}`);
    }
  });

  test('connection URL set but no anon key refuses, in dev too', () => {
    for (const nodeEnv of ['development', 'production', 'test', undefined]) {
      const decision = resolveProxyAuth({ SUPABASE_CONNECTION_URL: CONNECTION }, nodeEnv);
      assert.equal(decision.mode, 'unavailable', `nodeEnv=${nodeEnv}`);
    }
  });

  test('an unparseable connection URL refuses instead of disabling auth', () => {
    for (const connectionUrl of [
      'postgresql://postgres:pw@localhost:5432/postgres',
      'postgresql://postgres.ABCDEF:pw@host:5432/postgres',
      'not-a-url-at-all',
      'postgresql://user@host/db',
    ]) {
      const decision = resolveProxyAuth(
        { SUPABASE_PUBLISHABLE_KEY: ANON, SUPABASE_CONNECTION_URL: connectionUrl },
        'development',
      );
      assert.equal(decision.mode, 'unavailable', connectionUrl);
    }
  });

  test('a typo in one variable does not silently disable auth', () => {
    // The realistic incident: the key name is misspelled, so anonKey resolves blank while
    // the connection URL is perfectly valid. Old code: null -> let through -> no auth
    // anywhere. New code: refuse.
    const decision = resolveProxyAuth(
      { SUPABASE_CONNECTION_URL: CONNECTION, SUPABASE_URL: 'https://supabase.my-company.com' },
      'development',
    );

    assert.equal(decision.mode, 'unavailable');
    assert.notEqual(decision.mode, 'allow-pre-setup');
  });
});
