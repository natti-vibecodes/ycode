import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeScopes,
  hasScope,
  describeScopes,
  isMcpScope,
  ALL_SCOPES,
  DEFAULT_AGENT_SCOPES,
  MCP_SCOPES,
} from './scopes';

describe('MCP token scopes (SCA-1233)', () => {
  describe('backwards compatibility — the property that lets this land mid-flight', () => {
    test('an unscoped token keeps full access', () => {
      // Every existing row is NULL, including the token live agent sessions are using.
      // If this ever returns false, landing the enforcement step strands every lane.
      for (const scope of ALL_SCOPES) {
        assert.equal(hasScope(normalizeScopes(null), scope), true, `scope ${scope}`);
        assert.equal(hasScope(normalizeScopes(undefined), scope), true, `scope ${scope}`);
      }
    });

    test('an unusable stored value falls back to full access rather than locking a token out', () => {
      for (const v of ['not json', '{"a":1}', 42, {}, true]) {
        assert.equal(normalizeScopes(v), null, `value ${JSON.stringify(v)}`);
      }
    });
  });

  describe('normalizeScopes', () => {
    test('accepts an array and a JSON-encoded array (jsonb can arrive either way)', () => {
      assert.deepEqual(normalizeScopes(['pages', 'layers']), ['pages', 'layers']);
      assert.deepEqual(normalizeScopes('["pages","layers"]'), ['pages', 'layers']);
    });

    test('drops unknown scope names so a newer token does not break an older build', () => {
      assert.deepEqual(normalizeScopes(['pages', 'time-travel']), ['pages']);
    });

    test('an explicit empty array grants nothing — distinct from unset', () => {
      // The distinction that matters: [] is a real grant of nothing, null is "not configured".
      assert.deepEqual(normalizeScopes([]), []);
      assert.equal(normalizeScopes(null), null);
      assert.equal(hasScope([], 'pages'), false);
      assert.equal(hasScope(null, 'pages'), true);
    });

    test('an array of only-unknown names grants nothing rather than everything', () => {
      // Failing open here would turn a typo'd scope list into full builder access.
      assert.deepEqual(normalizeScopes(['nonsense', 'also-nonsense']), []);
      assert.equal(hasScope(normalizeScopes(['nonsense']), 'settings'), false);
    });
  });

  describe('hasScope', () => {
    test('grants only what is listed', () => {
      const scopes = normalizeScopes(['pages', 'collections']);
      assert.equal(hasScope(scopes, 'pages'), true);
      assert.equal(hasScope(scopes, 'collections'), true);
      assert.equal(hasScope(scopes, 'settings'), false);
      assert.equal(hasScope(scopes, 'publishing'), false);
    });
  });

  describe('DEFAULT_AGENT_SCOPES', () => {
    test('excludes publishing and settings — the two that reach beyond one page', () => {
      // publishing is globally destructive (SCA-1227); settings carries sitewide custom code,
      // i.e. the nav/footer/script surface of every page at once.
      assert.equal(DEFAULT_AGENT_SCOPES.includes('publishing'), false);
      assert.equal(DEFAULT_AGENT_SCOPES.includes('settings'), false);
    });

    test('still covers ordinary page building', () => {
      for (const scope of ['pages', 'layers', 'collections', 'assets', 'components'] as const) {
        assert.equal(DEFAULT_AGENT_SCOPES.includes(scope), true, `scope ${scope}`);
      }
    });

    test('every default is a real scope', () => {
      for (const s of DEFAULT_AGENT_SCOPES) assert.equal(isMcpScope(s), true, `scope ${s}`);
    });
  });

  test('every scope is documented — the catalogue is the audit surface', () => {
    for (const scope of ALL_SCOPES) {
      assert.ok(MCP_SCOPES[scope]?.length > 10, `scope ${scope} needs a real description`);
    }
  });

  test('describeScopes distinguishes unscoped from empty', () => {
    assert.match(describeScopes(null), /all scopes/);
    assert.match(describeScopes([]), /no scopes/);
    assert.equal(describeScopes(['pages', 'layers']), 'pages, layers');
  });
});
