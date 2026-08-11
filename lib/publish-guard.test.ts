import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  isPublishAllowed,
  assertPublishAllowed,
  PublishNotAllowedError,
  publishBlockedMessage,
  PUBLISH_ALLOWED_ENV,
  PUBLISH_ALLOWED_MCP_ENV,
} from './publish-guard';

/**
 * SCA-1227. Publishing in Ycode is global — one publish ships every session's pending
 * drafts — so the two properties that matter are:
 *   (a) an agent/MCP session cannot publish
 *   (b) Natalia's builder UI publish still works once she flips the flag
 */
describe('publish guard', () => {
  describe('default-deny', () => {
    test('nothing publishes with no env set', () => {
      assert.equal(isPublishAllowed('ui', {}), false);
      assert.equal(isPublishAllowed('mcp', {}), false);
    });

    test('an unrelated env var does not enable it', () => {
      const env = { SOME_OTHER_FLAG: '1' };
      assert.equal(isPublishAllowed('ui', env), false);
      assert.equal(isPublishAllowed('mcp', env), false);
    });
  });

  describe('(b) Natalia flips the flag — the UI publishes', () => {
    test('PUBLISH_ALLOWED enables the builder UI', () => {
      assert.equal(isPublishAllowed('ui', { [PUBLISH_ALLOWED_ENV]: '1' }), true);
    });

    test('any non-empty value works, so the flag is not fiddly to set', () => {
      for (const v of ['1', 'true', 'yes', 'natalia', 'ON']) {
        assert.equal(isPublishAllowed('ui', { [PUBLISH_ALLOWED_ENV]: v }), true, `value ${v}`);
      }
    });

    test('explicit off values read as disabled, so it can be turned off without unsetting', () => {
      for (const v of ['', '   ', '0', 'false', 'FALSE', 'no', 'off']) {
        assert.equal(isPublishAllowed('ui', { [PUBLISH_ALLOWED_ENV]: v }), false, `value ${JSON.stringify(v)}`);
      }
    });
  });

  describe('(a) an agent session cannot publish', () => {
    test('MCP stays blocked while the UI flag alone is on — the key property', () => {
      // This is the failure the gate exists to prevent: while Natalia has publishing
      // switched on for herself, a parallel agent session must still not be able to
      // publish and ship everyone else's drafts.
      const env = { [PUBLISH_ALLOWED_ENV]: '1' };
      assert.equal(isPublishAllowed('ui', env), true);
      assert.equal(isPublishAllowed('mcp', env), false);
    });

    test('the MCP flag alone does not enable MCP either — both are required', () => {
      assert.equal(isPublishAllowed('mcp', { [PUBLISH_ALLOWED_MCP_ENV]: '1' }), false);
    });

    test('MCP publishes only when both flags are set deliberately', () => {
      const env = { [PUBLISH_ALLOWED_ENV]: '1', [PUBLISH_ALLOWED_MCP_ENV]: '1' };
      assert.equal(isPublishAllowed('mcp', env), true);
      assert.equal(isPublishAllowed('ui', env), true);
    });
  });

  describe('assertPublishAllowed', () => {
    test('throws a 403-carrying error when blocked', () => {
      assert.throws(
        () => assertPublishAllowed('mcp', {}),
        (err: unknown) => err instanceof PublishNotAllowedError && err.statusCode === 403,
      );
    });

    test('does not throw when allowed', () => {
      assert.doesNotThrow(() => assertPublishAllowed('ui', { [PUBLISH_ALLOWED_ENV]: '1' }));
    });
  });

  test('the block message tells an agent what to do instead of retrying', () => {
    const msg = publishBlockedMessage('mcp');
    assert.match(msg, /global/i);
    assert.match(msg, /queued|save/i);
    assert.ok(msg.includes(PUBLISH_ALLOWED_MCP_ENV));
  });
});
