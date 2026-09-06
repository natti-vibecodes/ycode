import type { Knex } from 'knex';

/**
 * Migration: Hash MCP URL tokens at rest (step 2 of 2 — drop the plaintext).
 *
 * Runs only after 20260906000001 backfilled `token_hash` and the hash lookup
 * was proven against the live MCP session.
 *
 * 🔴 `down()` re-adds the column but CANNOT restore the values — that one-way
 * property is the entire point of hashing. The real rollback for a broken hash
 * lookup is "issue a new token", i.e. the rotation path, which breaks every
 * live MCP session at that instant and requires editing `.mcp.json`.
 */

export async function up(knex: Knex): Promise<void> {
  const hasPlaintext = await knex.schema.hasColumn('mcp_tokens', 'token');
  if (hasPlaintext) {
    await knex.schema.alterTable('mcp_tokens', (table) => {
      table.dropColumn('token');
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  const hasPlaintext = await knex.schema.hasColumn('mcp_tokens', 'token');
  if (!hasPlaintext) {
    await knex.schema.alterTable('mcp_tokens', (table) => {
      // Values are gone for good; the column comes back empty.
      table.string('token', 128).nullable().unique();
    });
  }
}
