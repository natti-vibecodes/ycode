/**
 * Publish gate (SCA-1227).
 *
 * Publishing in Ycode is GLOBAL — one publish ships every pending draft across the whole
 * site, not just the caller's own work. With several agent sessions editing one instance
 * in parallel, any session that publishes also ships everyone else's work-in-progress.
 * That happened repeatedly on 2026-08-11, so the standing rule is that only Natalia
 * publishes. This module makes that a permission instead of a promise.
 *
 * Both publish entry points call in here — the MCP `publish` tool and the builder UI's
 * POST /ycode/api/publish route. They are separate implementations with no shared service,
 * so this module is the single policy choke point; anything new that publishes must call
 * assertPublishAllowed() too.
 *
 * DEFAULT-DENY. With no env set, nothing can publish.
 *
 *   PUBLISH_ALLOWED=1        enables the builder UI (Natalia's own publish button)
 *   PUBLISH_ALLOWED_MCP=1    additionally enables the MCP tool (agent publishing)
 *
 * Two flags rather than one on purpose. A single flag would mean that while Natalia has
 * publishing switched on for herself, any agent session could publish through MCP in the
 * same window — which is the exact failure this is meant to stop. The MCP path therefore
 * needs its own opt-in, and stays off even while she is publishing.
 *
 * INTERIM. This is env-level, so it governs the whole server rather than the individual
 * user: it cannot tell one caller from another beyond UI-vs-MCP. The durable fix is
 * editor-role accounts with no Publish permission, once Workspaces lands upstream —
 * see SCA-1227.
 */

export const PUBLISH_ALLOWED_ENV = 'PUBLISH_ALLOWED';
export const PUBLISH_ALLOWED_MCP_ENV = 'PUBLISH_ALLOWED_MCP';

export type PublishCaller = 'ui' | 'mcp';

type Env = Record<string, string | undefined>;

/** Unset, empty, "0", "false" and "no" all read as off, so the flag can be disabled without unsetting it. */
function flagEnabled(raw: string | undefined): boolean {
  if (typeof raw !== 'string') return false;
  const v = raw.trim().toLowerCase();
  if (v === '') return false;
  return v !== '0' && v !== 'false' && v !== 'no' && v !== 'off';
}

export function isPublishAllowed(caller: PublishCaller, env: Env = process.env): boolean {
  if (!flagEnabled(env[PUBLISH_ALLOWED_ENV])) return false;
  if (caller === 'mcp') return flagEnabled(env[PUBLISH_ALLOWED_MCP_ENV]);
  return true;
}

export function publishBlockedMessage(caller: PublishCaller): string {
  return caller === 'mcp'
    ? `Publishing is disabled for agent sessions. Ycode publishes GLOBALLY, so one publish ships every other session's pending drafts too — publishing is Natalia's to run (SCA-1227). Save your changes and leave them queued; report what is pending instead. To enable deliberately, set ${PUBLISH_ALLOWED_ENV} and ${PUBLISH_ALLOWED_MCP_ENV}.`
    : `Publishing is disabled. Set ${PUBLISH_ALLOWED_ENV} to enable it (SCA-1227).`;
}

/** Throws when the caller may not publish. Use where an exception is the natural control flow. */
export function assertPublishAllowed(caller: PublishCaller, env: Env = process.env): void {
  if (!isPublishAllowed(caller, env)) {
    throw new PublishNotAllowedError(publishBlockedMessage(caller));
  }
}

export class PublishNotAllowedError extends Error {
  readonly statusCode = 403;
  constructor(message: string) {
    super(message);
    this.name = 'PublishNotAllowedError';
  }
}
