/**
 * SCA-1433 — wave-3 audit of the proxy's public exemptions.
 *
 * `/ycode/api/setup/` is a PUBLIC prefix in proxy.ts, so nothing under it is authenticated by
 * the proxy: each route is responsible for its own refusal. Wave 2 locked the two mutation
 * routes (`connect`, `migrate`) with `requireSetupOpen`. The audit found the rule had been
 * applied per-route by hand, and `check-email-confirm` had been missed — a GET, so it did not
 * read as a "mutation route", but still an anonymous answer about live auth configuration on a
 * claimed workspace plus an outbound fetch per request.
 *
 * A rule enforced by remembering it eventually meets someone without the memory. So this test
 * enforces it by enumeration instead: EVERY route under `/ycode/api/setup/` must call
 * `requireSetupOpen`, and any exemption must be listed here with a reason. A new setup route
 * added without the guard fails this test on the way in.
 *
 * Population law: the discovered route list is asserted non-empty and asserted to contain the
 * routes we know exist. A glob that silently matched nothing would otherwise pass as "all
 * routes are guarded".
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';

const SETUP_DIR = join(__dirname, '..', 'app', '(builder)', 'ycode', 'api', 'setup');

/**
 * Routes that are deliberately reachable on a claimed workspace.
 * Adding an entry here is a security decision — state the reason.
 */
const EXEMPT: Record<string, string> = {
  status:
    'Must stay anonymous forever: the app polls it to discover whether setup is needed at all, '
    + 'and it answers with booleans only (is_configured / is_setup_complete / is_vercel).',
};

function setupRoutes(): string[] {
  return readdirSync(SETUP_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
}

/** True when the route's module calls `requireSetupOpen` anywhere in its body. */
function callsGuard(routeName: string): boolean {
  const file = join(SETUP_DIR, routeName, 'route.ts');
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);

  let found = false;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'requireSetupOpen'
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('SCA-1433 — every public setup route refuses once the workspace is claimed', () => {
  test('the route population is real and contains the routes we know about', () => {
    const routes = setupRoutes();

    assert.ok(routes.length > 0, 'found no setup routes — the path is wrong and this suite proves nothing');
    for (const known of ['connect', 'migrate', 'status', 'check-email-confirm']) {
      assert.ok(routes.includes(known), `expected setup route "${known}" to exist; found: ${routes.join(', ')}`);
    }
  });

  test('every non-exempt setup route calls requireSetupOpen', () => {
    const unguarded = setupRoutes().filter(route => !(route in EXEMPT) && !callsGuard(route));

    assert.deepEqual(
      unguarded,
      [],
      `these setup routes are anonymous on a claimed workspace and do not call requireSetupOpen: `
      + `${unguarded.join(', ')}. Add the guard, or add an entry to EXEMPT with a reason.`,
    );
  });

  test('check-email-confirm specifically — the route this audit found unguarded', () => {
    assert.ok(
      callsGuard('check-email-confirm'),
      'check-email-confirm must call requireSetupOpen: anonymous on a claimed workspace it '
      + 'disclosed the mailer autoconfirm flag and issued an outbound fetch per request',
    );
  });

  test('every exemption carries a stated reason', () => {
    for (const [route, reason] of Object.entries(EXEMPT)) {
      assert.ok(reason.trim().length > 40, `exemption for "${route}" needs a real reason, not a placeholder`);
      assert.ok(setupRoutes().includes(route), `EXEMPT lists "${route}", which is not a setup route any more`);
    }
  });
});
