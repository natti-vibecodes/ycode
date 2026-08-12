/**
 * The fork commit the RUNNING server was started from (SCA-1272), and the working tree's HEAD.
 *
 * A fix can be committed, present in the working tree, and reviewed clean while the process
 * serving requests predates it — or, as with `adea726`, reach a running dev server only through
 * hot-reload, so the next restart would silently lose it. Neither state announces itself: the
 * file says the fix is there, the served output disagrees, and nothing connects the two.
 *
 * BOOT_COMMIT is stamped by `next.config.ts` at server start and read here as a plain string.
 * It used to be captured by an `instrumentation.ts` hook that shelled out to git, and that was a
 * mistake: Next compiles `instrumentation.ts` for the EDGE runtime as well as Node, where
 * `node:child_process` and `process.cwd()` are both illegal. The Edge bundle failed to build on
 * every compile — 1,544 errors in 21 minutes, drowning the dev log and churning a tester's page
 * (SCA-1298). Reading an env var has no runtime, no imports, and nothing for Edge to object to.
 *
 * `readHeadCommit()` still shells out, deliberately: it must reflect the tree RIGHT NOW, not at
 * boot. It lives in this module's server-only sibling so nothing Edge-bundled can reach it.
 */

/** Commit this process booted from. Empty string (→ null) when git was unavailable at start. */
export const BOOT_COMMIT: string | null = process.env.YCODE_BOOT_COMMIT || null;
