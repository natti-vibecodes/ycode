import type { Knex } from 'knex';

/**
 * Migration: Hash MCP URL tokens at rest (step 1 of 2 — add + backfill).
 *
 * `mcp_tokens.token` held the bearer value itself and `validateToken` looked it
 * up with `.eq('token', token)`. Combined with the "any authenticated user"
 * write policies, any account that could read the table read a live credential
 * granting MCP write access to the whole site (security-plan 2026-09-06, #3).
 *
 * Only the OAuth *refresh* token was ever hashed
 * (20260528000002_hash_mcp_refresh_tokens.ts). This does the same for the
 * legacy URL token that Cursor and Claude Code use.
 *
 * Deliberately split in two migrations. This one ADDS and BACKFILLS only, so
 * the plaintext column survives until the hash lookup has been proven against
 * the live MCP session; 20260906000002 drops the plaintext. The backfill is
 * why nobody's `.mcp.json` has to change.
 *
 * `sha256()` is core Postgres (>= 11), so this does not depend on where
 * pgcrypto happens to be installed. Verified against Node's
 * `createHash('sha256').update(token).digest('hex')` on the live row before
 * applying — the two derivations agreed.
 */

export async function up(knex: Knex): Promise<void> {
  const hasHash = await knex.schema.hasColumn('mcp_tokens', 'token_hash');
  if (!hasHash) {
    await knex.schema.alterTable('mcp_tokens', (table) => {
      table.string('token_hash', 128).nullable().unique();
    });
  }

  const hasPlaintext = await knex.schema.hasColumn('mcp_tokens', 'token');
  if (hasPlaintext) {
    await knex.raw(`
      UPDATE mcp_tokens
      SET token_hash = encode(sha256(convert_to(token, 'UTF8')), 'hex')
      WHERE token IS NOT NULL
        AND token_hash IS NULL;
    `);
  }
}

export async function down(knex: Knex): Promise<void> {
  const hasHash = await knex.schema.hasColumn('mcp_tokens', 'token_hash');
  if (hasHash) {
    await knex.schema.alterTable('mcp_tokens', (table) => {
      table.dropColumn('token_hash');
    });
  }
}
