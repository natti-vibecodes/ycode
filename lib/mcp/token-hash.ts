import { createHash } from 'crypto';

/**
 * SHA-256 of an MCP token, hex encoded.
 *
 * Lives in its own module because three places need it and none of them may
 * import each other: the repository (hash lookup at validate time), the token
 * cache (so the map is keyed on a fixed-width digest rather than on whatever
 * string an anonymous caller presented), and the tests.
 *
 * Must stay byte-identical to the SQL backfill in
 * `20260906000001_hash_mcp_url_tokens.ts`:
 *   encode(sha256(convert_to(token, 'UTF8')), 'hex')
 * Both derivations were computed against the live row before the switch and
 * agreed — that agreement is what keeps existing `.mcp.json` URLs working.
 */
export function hashMcpToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
