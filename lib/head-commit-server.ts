import 'server-only';

/**
 * Reads the working tree's CURRENT HEAD (SCA-1272).
 *
 * Split out from `lib/boot-commit.ts` on purpose. That module is a plain env-var read and is safe
 * anywhere; this one shells out to git, so it must never be reachable from an Edge-bundled graph.
 * `server-only` makes that a build error instead of a silent 1,544-errors-per-21-minutes log
 * flood, which is exactly how this went wrong the first time (SCA-1298).
 *
 * Re-read on every call, on purpose: the point is to compare the running process against the tree
 * as it stands now.
 */

import { execFileSync } from 'node:child_process';

export function readHeadCommit(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3_000,
    }).trim() || null;
  } catch {
    return null; // no git available — the manifest omits the drift check rather than inventing one
  }
}
