/**
 * Security plan 2026-09-06, item C2 — OAuth redirect-URI scheme validation.
 *
 * `app/(builder)/ycode/api/oauth/register/route.ts` rejected a URI only when it
 * was BOTH non-HTTPS AND not localhost/127.0.0.1. So `javascript://localhost/x`
 * and `data://localhost/x` registered cleanly, and `ConsentForm.tsx:56` assigns
 * the server's `redirect_to` to `window.location.href` — where a `javascript:`
 * URL executes. Registration is anonymous and unbounded.
 *
 * The unit test is the proof here, not a served probe: the client table is
 * empty, so any request-level check would be measuring an empty population and
 * would return the same clean result before and after the fix.
 *
 * The rows marked OLD-PASS are the ones that discriminate — each was ACCEPTED
 * by the previous predicate and must now be refused. Running this file against
 * the pre-change logic fails on exactly those.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { isAllowedRedirectUri } from '@/lib/oauth-redirect-uri';

/** The predicate as it stood before the fix, so the test can prove the delta. */
function previousPredicate(uri: string): boolean {
  try {
    const parsed = new URL(uri);
    return !(parsed.protocol !== 'https:'
      && parsed.hostname !== 'localhost'
      && parsed.hostname !== '127.0.0.1');
  } catch {
    return false;
  }
}

const CASES: Array<{ uri: string; allowed: boolean; why: string }> = [
  // --- must be accepted ---
  { uri: 'https://claude.ai/api/mcp/auth_callback', allowed: true, why: 'plain https' },
  { uri: 'https://evil.com', allowed: true, why: 'https to any host — PKCE + registration are the control, not the hostname' },
  { uri: 'http://localhost:3002/cb', allowed: true, why: 'loopback http, RFC 8252' },
  { uri: 'http://127.0.0.1/cb', allowed: true, why: 'loopback http by IPv4 literal' },
  { uri: 'http://[::1]:8080/cb', allowed: true, why: 'loopback http by IPv6 literal' },
  { uri: 'https://localhost:3002/cb', allowed: true, why: 'https on loopback' },

  // --- must be refused ---
  { uri: 'javascript://localhost/x', allowed: false, why: 'OLD-PASS: the XSS payload the old check let through' },
  { uri: 'javascript://localhost/%0aalert(1)', allowed: false, why: 'OLD-PASS: newline-smuggled payload' },
  { uri: 'data://localhost/x', allowed: false, why: 'OLD-PASS: data scheme on a loopback host' },
  { uri: 'JavaScript://LOCALHOST/x', allowed: false, why: 'uppercase scheme AND host: `new URL()` lowercases the scheme but NOT the host of a non-special scheme, so hostname stays "LOCALHOST" — measured, not assumed' },
  { uri: 'JAVASCRIPT://127.0.0.1/x', allowed: false, why: 'OLD-PASS: uppercase scheme, IPv4 loopback' },
  { uri: 'file://localhost/etc/passwd', allowed: false, why: 'file: normalises a localhost host to the empty string, so this was already refused — kept because the normalisation is non-obvious' },
  { uri: 'vbscript://localhost/x', allowed: false, why: 'OLD-PASS: any scheme at all passed with a loopback host' },
  { uri: 'http://evil.com/cb', allowed: false, why: 'plain http off loopback' },
  { uri: 'http://localhostx.com/cb', allowed: false, why: 'the near-miss: hostname starts with localhost but is not it' },
  { uri: 'http://localhost.evil.com/cb', allowed: false, why: 'the other near-miss: loopback as a subdomain label' },
  { uri: 'http://127.0.0.1.evil.com/cb', allowed: false, why: 'IPv4 loopback as a label' },
  { uri: ' https://claude.ai/cb', allowed: false, why: 'leading whitespace — URL strips it, so it would validate in one form and be compared in another' },
  { uri: 'https://claude.ai/cb ', allowed: false, why: 'trailing whitespace, same reason' },
  { uri: 'not-a-url', allowed: false, why: 'malformed' },
  { uri: '', allowed: false, why: 'empty' },
  { uri: '//claude.ai/cb', allowed: false, why: 'protocol-relative — no scheme to allow' },
];

describe('isAllowedRedirectUri (C2)', () => {
  for (const { uri, allowed, why } of CASES) {
    test(`${allowed ? 'accepts' : 'refuses'} ${JSON.stringify(uri)} — ${why}`, () => {
      assert.equal(isAllowedRedirectUri(uri), allowed);
    });
  }

  test('non-string input is refused without throwing', () => {
    for (const value of [null, undefined, 42, {}, [], true]) {
      assert.equal(isAllowedRedirectUri(value), false);
    }
  });

  test('the OLD-PASS rows really were accepted before — the check discriminates', () => {
    const oldPass = CASES.filter((c) => c.why.startsWith('OLD-PASS:'));
    // Population check: an empty list here would make the loop below vacuous.
    // Five, not seven — the count was MEASURED against `previousPredicate`
    // rather than assumed. `JavaScript://LOCALHOST/x` and
    // `file://localhost/etc/passwd` were already refused, for two different
    // and non-obvious URL-normalisation reasons noted on their rows.
    assert.equal(oldPass.length, 5, 'expected 5 discriminating cases');
    for (const { uri } of oldPass) {
      assert.equal(previousPredicate(uri), true, `${uri} should have passed the OLD predicate`);
      assert.equal(isAllowedRedirectUri(uri), false, `${uri} must fail the NEW predicate`);
    }
  });

  test('the only NEW acceptance is IPv6 loopback, and it is deliberate', () => {
    // A security fix that quietly widens something is the failure mode this
    // guards against, so the widening is enumerated rather than tolerated.
    // `new URL('http://[::1]:8080/cb').hostname` is '[::1]', which matched
    // neither 'localhost' nor '127.0.0.1', so the old predicate refused a
    // legitimate RFC 8252 loopback redirect. The plan's LOOPBACK set includes
    // it on purpose.
    const INTENDED_NEW_ACCEPTANCES = new Set(['http://[::1]:8080/cb']);

    const widened = CASES
      .filter((c) => c.allowed && !previousPredicate(c.uri))
      .map((c) => c.uri);

    assert.deepEqual(widened, [...INTENDED_NEW_ACCEPTANCES]);
  });
});
