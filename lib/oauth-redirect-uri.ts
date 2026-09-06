/**
 * OAuth redirect-URI validation — one positive allowlist, shared by every
 * code path that writes or reads a `redirect_uri` (security plan 2026-09-06,
 * item C2).
 *
 * The bug this replaces was a NEGATIVE test in the DCR route:
 *
 *   if (protocol !== 'https:' && hostname !== 'localhost' && hostname !== '127.0.0.1')
 *       reject
 *
 * — reject only when BOTH non-HTTPS AND non-loopback. So `javascript://localhost/x`
 * and `data://localhost/x` passed registration, and `ConsentForm.tsx:56` later
 * assigns the server's `redirect_to` straight to `window.location.href`, where
 * a `javascript:` URL executes. Client registration is anonymous and unbounded,
 * so that is an anonymous-write → authenticated-execute path.
 *
 * A negative test has to enumerate every dangerous scheme and will always be
 * one scheme behind. A positive one enumerates the two we actually support.
 *
 * 🔴 Validate at BOTH ends. Registration is not a sufficient gate on its own:
 * a value written by one code path is read by another, and the rows already in
 * `mcp_oauth_clients` were written under the old check. So `/api/oauth/authorize`
 * and the consent page re-validate before producing or rendering a redirect.
 */

/**
 * Loopback hosts, per RFC 8252 §7.3. `new URL()` reports a bracketed IPv6
 * hostname (`[::1]`); the bare form is listed too so a caller that has already
 * stripped the brackets is handled the same way.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function isAllowedRedirectUri(uri: unknown): uri is string {
  if (typeof uri !== 'string' || uri.length === 0) return false;

  // Reject surrounding whitespace rather than tolerating it. `new URL()` strips
  // leading/trailing spaces, so ' https://evil.com' would parse as valid — but
  // the stored string is later compared with `redirect_uris.includes(uri)`,
  // and a value that validates in one form and matches in another is exactly
  // the kind of gap this function exists to close.
  if (uri !== uri.trim()) return false;

  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }

  // `URL` lowercases the scheme, so `JavaScript:` arrives here as `javascript:`
  // and is refused by falling off the end — no case handling needed.
  if (parsed.protocol === 'https:') return true;
  if (parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname)) return true;

  return false;
}
