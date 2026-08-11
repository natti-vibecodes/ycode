import type { Knex } from 'knex';

/**
 * Add per-token scopes to mcp_tokens (SCA-1233).
 *
 * An MCP token is a bearer credential that today grants the FULL builder API — every tool,
 * no role check — and on the URL-token endpoint it travels in the URL path. There is no way
 * to hand an agent a token that can, say, edit collection content but not delete pages.
 *
 * NULL means "all scopes", deliberately. Every existing token — including the ones live agent
 * sessions are mid-work on — keeps working untouched, so this can land without stranding
 * anyone. Least privilege arrives by minting NEW scoped tokens and migrating sessions onto
 * them, not by silently narrowing tokens already in use.
 *
 * Stored as jsonb rather than text[] to match how the rest of this schema carries structured
 * values (payload/metadata/settings), and so a future scope entry can grow fields without
 * another migration.
 */

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('mcp_tokens', (table) => {
    table.jsonb('scopes').nullable().comment('Array of granted scope names; NULL = all scopes (legacy tokens)');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('mcp_tokens', (table) => {
    table.dropColumn('scopes');
  });
}
