/**
 * SCA-1432 — the off-canonical CMS-slug redirect ran BEFORE the page password gate, so an
 * unauthenticated request to a protected dynamic page got a 308 whose `Location` header
 * disclosed the canonical slug: precisely the thing the gate exists to withhold.
 *
 * Adopted as-is with upstream 1.30.11. Latent at adoption time (page passwords are
 * plaintext and nothing is currently protected), which is exactly why it needed a test
 * rather than a memo — the day something IS protected, nothing else would catch this.
 *
 * WHY AN AST TEST. The property under test is *statement order inside one server
 * component*, which has no import-time seam to unit-test: `Page()` awaits Supabase reads
 * and throws Next.js redirect control-flow signals. The honest options were a source
 * grep or the parsed artifact, and greps read comments as code — this file's own
 * SECURITY comments name both functions, so a regex would match the warning text
 * explaining the fix and report the ordering correct no matter what the code did.
 * So: parse the file, walk the real statement list of the real function body, compare
 * positions. Comments are not statements and cannot be mistaken for one.
 *
 * Population law: both anchors are asserted to exist before their order is compared. If
 * the gate or the redirect is ever renamed away, this fails loudly instead of passing
 * on an empty search.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';

const PAGE_PATH = join(__dirname, '..', 'app', '(site)', '[...slug]', 'page.tsx');

/** Top-level statements of the default-exported `Page` component, in source order. */
function pageBodyStatements(): ts.NodeArray<ts.Statement> {
  const source = ts.createSourceFile(
    PAGE_PATH,
    readFileSync(PAGE_PATH, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );

  const fn = source.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement)
      && statement.name?.text === 'Page'
      && statement.modifiers?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword) === true,
  );

  assert.ok(fn, 'expected a default-exported `Page` function declaration in page.tsx');
  assert.ok(fn.body, 'expected `Page` to have a body');
  return fn.body.statements;
}

/**
 * Index of the first top-level statement whose subtree calls `callee`.
 * Walks nodes, so comments mentioning the callee are invisible here by construction.
 */
function statementCalling(statements: ts.NodeArray<ts.Statement>, callee: string): number {
  return statements.findIndex(statement => {
    let found = false;
    const visit = (node: ts.Node) => {
      if (found) return;
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === callee) {
        found = true;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(statement);
    return found;
  });
}

describe('SCA-1432 — the password gate runs before the off-canonical redirect', () => {
  test('both anchors exist (population check before the ordering claim)', () => {
    const statements = pageBodyStatements();

    assert.notEqual(
      statementCalling(statements, 'getPasswordProtection'),
      -1,
      'password gate not found — it was renamed or removed, so this test is no longer checking anything',
    );
    assert.notEqual(
      statementCalling(statements, 'getOffCanonicalDynamicRedirect'),
      -1,
      'off-canonical redirect not found — it was renamed or removed',
    );
  });

  test('the redirect is positioned AFTER the gate, not before it', () => {
    const statements = pageBodyStatements();

    const gate = statementCalling(statements, 'getPasswordProtection');
    const redirect = statementCalling(statements, 'getOffCanonicalDynamicRedirect');

    assert.ok(
      gate < redirect,
      `the off-canonical redirect must not precede the password gate `
      + `(gate at statement ${gate}, redirect at statement ${redirect}). `
      + `Running it first answers an unauthenticated request with a 308 disclosing the canonical slug.`,
    );
  });

  test('the redirect also sits after the protected-branch early return', () => {
    const statements = pageBodyStatements();
    const redirect = statementCalling(statements, 'getOffCanonicalDynamicRedirect');

    // The gate's `if (protectionCheck.isProtected) { ... }` block is what returns the 401.
    // The redirect must come after that whole block, not merely after the gate's declaration.
    const protectedBranch = statements.findIndex(
      statement =>
        ts.isIfStatement(statement)
        && statement.expression.getText().includes('protectionCheck.isProtected'),
    );

    assert.notEqual(protectedBranch, -1, 'protected-branch `if` not found');
    assert.ok(
      protectedBranch < redirect,
      `the redirect (statement ${redirect}) must follow the protected-branch block `
      + `(statement ${protectedBranch}) so a locked visitor is already answered with the 401`,
    );
  });
});
