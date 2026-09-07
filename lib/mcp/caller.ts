/**
 * Who is on the other end of an MCP session (SCA-1480).
 *
 * The token record already carried an id and a user id; the handler read them for scopes and
 * then dropped them, so no write could name its writer. When `custom_code_head` was clobbered on
 * 2026-09-06 the question "which session wrote it?" had no answer in any log, and the row keeps
 * only the winner. This threads the identity as far as the settings tools so every write is
 * attributable.
 */

export interface McpCaller {
  /** `mcp_tokens.id` for the token that authenticated this session. */
  tokenId?: string;
  /** The user the token belongs to, when it has one. */
  userId?: string | null;
}

/** A short, log-safe label. Never includes the token itself — only its row id. */
export function describeCaller(caller?: McpCaller): string {
  if (!caller) return 'mcp';
  const parts = ['mcp'];
  if (caller.tokenId) parts.push(`token:${caller.tokenId}`);
  if (caller.userId) parts.push(`user:${caller.userId}`);
  return parts.join(' ');
}
