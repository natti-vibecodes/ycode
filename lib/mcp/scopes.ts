/**
 * MCP token scopes (SCA-1233).
 *
 * An MCP token is a bearer credential that grants the full builder API — every tool, no role
 * check — and on the URL-token endpoint it rides in the URL path. Scopes make least privilege
 * possible: a token can be minted that reads pages and writes collection content without also
 * being able to delete pages, rewrite global custom code, or mint further tokens.
 *
 * Scopes are named after the existing tool GROUPS rather than individual tools. The modules in
 * lib/mcp/tools already draw the lines an operator cares about, one scope per module keeps the
 * catalogue readable, and a token holder can reason about what they hold. Per-tool grants would
 * be 121 entries nobody audits.
 *
 * NULL/absent scopes means ALL scopes. That is what makes this landable while agent sessions are
 * mid-work: existing tokens keep behaving exactly as before, and least privilege arrives by
 * minting new scoped tokens and migrating sessions onto them.
 *
 * NOT YET ENFORCED. This is the decision model only; wiring it into the live auth path (token
 * record through handler + routes + token cache, conditional tool registration) is a separate,
 * coordinated step — it changes the path every active session depends on.
 */

export const MCP_SCOPES = {
  pages: 'Create, update and delete pages and page folders',
  layers: 'Read and modify page layer trees, layouts and batch layer operations',
  collections: 'CMS collections, fields, items and collection-bound layers',
  styles: 'Layer styles, colour variables and fonts',
  assets: 'Upload and manage assets and asset folders',
  components: 'Create and modify reusable components and their variants',
  locales: 'Locales and translations',
  forms: 'Read form configuration and submissions',
  settings: 'Global site settings, including sitewide custom code',
  publishing: 'Inspect pending changes and publish the site',
  animations: 'Layer animations and interactions',
} as const;

export type McpScope = keyof typeof MCP_SCOPES;

export const ALL_SCOPES = Object.keys(MCP_SCOPES) as McpScope[];

/**
 * A sensible default for a content-editing agent: everything needed to build and edit pages,
 * but not to change global settings or publish. Publishing is separately gated (SCA-1227);
 * `settings` is excluded because sitewide custom code is the nav/footer/script surface for
 * every page at once.
 */
export const DEFAULT_AGENT_SCOPES: McpScope[] = [
  'pages', 'layers', 'collections', 'styles', 'assets', 'components', 'locales', 'forms', 'animations',
];

export function isMcpScope(value: unknown): value is McpScope {
  return typeof value === 'string' && value in MCP_SCOPES;
}

/**
 * Normalise whatever is stored in mcp_tokens.scopes.
 *
 * Returns null for "all scopes" — NULL column, absent, or an unusable value. Failing OPEN here
 * is deliberate and is the safe direction *for this column only*: the column is new, every
 * existing row is NULL, and a token that mysteriously lost access mid-session would strand a
 * working agent. Unknown scope names are dropped rather than rejected, so a token minted by a
 * newer build does not break on an older one.
 */
export function normalizeScopes(raw: unknown): McpScope[] | null {
  if (raw === null || raw === undefined) return null;

  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }

  if (!Array.isArray(value)) return null;

  const known = value.filter(isMcpScope);
  // An explicit empty array is a real grant of nothing; distinguish it from "unset".
  if (value.length > 0 && known.length === 0) return [];
  return known;
}

/** Whether a token carrying `scopes` may use tools from `scope`. */
export function hasScope(scopes: McpScope[] | null, scope: McpScope): boolean {
  if (scopes === null) return true; // legacy/unscoped token: full access
  return scopes.includes(scope);
}

/** Human-readable summary for logs and the token UI. */
export function describeScopes(scopes: McpScope[] | null): string {
  if (scopes === null) return 'all scopes (unscoped legacy token)';
  if (scopes.length === 0) return 'no scopes';
  return scopes.join(', ');
}
