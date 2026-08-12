/**
 * The fork commit the RUNNING server was started from (SCA-1272).
 *
 * A fix can be committed, present in the working tree, and reviewed clean while the process
 * serving requests predates it — or, as with `adea726`, reach a running dev server only through
 * hot-reload, so the next restart would silently lose it. Neither state announces itself: the
 * file says the fix is there, the served output disagrees, and nothing connects the two.
 *
 * This module records the commit ONCE, at process start, so the publish manifest can compare it
 * against the working tree's current HEAD. That is the whole reason `instrumentation.ts` imports
 * it: if the first import happened lazily, at manifest time, it would read today's HEAD and
 * report "no drift" forever — a signal that is always green is worse than no signal.
 *
 * `git` may be absent (container, deploy artifact). Both readers return null there, and the
 * manifest simply omits the drift check rather than inventing a verdict.
 */

import { execFileSync } from 'node:child_process';

function gitHead(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3_000,
    }).trim() || null;
  } catch {
    return null;
  }
}

/** Commit this process booted from. Captured at module load — see the note above. */
export const BOOT_COMMIT: string | null = gitHead();

/** The working tree's HEAD right now. Re-read on every call, on purpose. */
export function readHeadCommit(): string | null {
  return gitHead();
}
