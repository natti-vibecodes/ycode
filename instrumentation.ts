/**
 * Next.js boot hook. Runs once per server process, before the first request.
 *
 * The only job here is to import `lib/boot-commit` early enough that the commit it records is
 * genuinely the one this process STARTED from. Imported lazily instead, it would read whatever
 * HEAD happens to be at the moment something first asks — and the running-code drift check in
 * the publish manifest would report "no drift" forever (SCA-1272).
 */
export async function register(): Promise<void> {
  await import('./lib/boot-commit');
}
