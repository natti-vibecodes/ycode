/**
 * Resolve the site's base URL from settings and environment.
 *
 * Priority: globalCanonicalUrl > primaryDomainUrl > NEXT_PUBLIC_SITE_URL
 *         > VERCEL_PROJECT_PRODUCTION_URL > VERCEL_URL > requestOrigin
 *
 * `requestOrigin` is a last-resort fallback (client-controllable) used when
 * nothing is configured, so absolute URLs can still be emitted on self-hosted
 * deploys without env vars or a canonical URL. Prefer `resolveSiteBaseUrl`,
 * which only pays for the request origin when every configured source misses.
 */
export function getSiteBaseUrl(options?: {
  globalCanonicalUrl?: string | null;
  primaryDomainUrl?: string | null;
  requestOrigin?: string | null;
}): string | null {
  const raw =
    options?.globalCanonicalUrl
    || options?.primaryDomainUrl
    || process.env.NEXT_PUBLIC_SITE_URL
    || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : null)
    || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
    || options?.requestOrigin
    || null;

  return raw ? raw.replace(/\/$/, '') : null;
}

/**
 * Parse the `TRUSTED_FORWARDED_HOSTS` allowlist: a comma-separated list of hosts
 * whose `x-forwarded-host` header we are willing to believe in production.
 * Unset/empty means "trust no forwarded host", which is the safe default.
 */
export function parseTrustedForwardedHosts(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map(host => host.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Decide whether an `x-forwarded-host` value may be believed.
 *
 * Off production the header is honored as-is: local and preview deploys sit behind
 * proxies and tunnels whose hostnames nobody wants to enumerate, and there is no
 * SEO surface to poison there.
 *
 * In production it must appear in the allowlist. `x-forwarded-host` is set by
 * whatever spoke to us last, so an unlisted value is an unauthenticated client's
 * claim about who we are — not a fact.
 */
export function isForwardedHostTrusted(
  forwardedHost: string,
  trustedHosts: string[],
  nodeEnv: string | undefined,
): boolean {
  if (nodeEnv !== 'production') return true;
  if (trustedHosts.length === 0) return false;
  return trustedHosts.includes(forwardedHost.toLowerCase());
}

/**
 * Derive the request origin (protocol + host) from request headers.
 *
 * SECURITY (SCA-1431): `x-forwarded-host` is client-controllable and this function is
 * reached from the UNAUTHENTICATED /robots.txt and /sitemap.xml routes, where the result
 * becomes every absolute URL in the emitted file. Trusting it unconditionally let any
 * caller steer those URLs at a host of their choosing — an SEO/cache-poisoning primitive.
 *
 * So the forwarded host is only believed when `isForwardedHostTrusted` says so; otherwise
 * we fall back to `Host`, the header the server actually routed on. `Host` is not a
 * guarantee either, but in a correctly configured deployment it is constrained by the
 * front door, and this whole path is already the last resort for a site with no canonical
 * URL and no env configuration. The real defense is configuring one — see
 * `resolveSiteBaseUrl`, which skips this function entirely when anything is configured.
 */
export function getRequestOrigin(
  headers: Headers,
  options?: { trustedForwardedHosts?: string | null; nodeEnv?: string },
): string | null {
  const firstValue = (value: string | null) => value?.split(',')[0].trim() || null;

  const forwardedHost = firstValue(headers.get('x-forwarded-host'));
  const trustedHosts = parseTrustedForwardedHosts(
    options?.trustedForwardedHosts !== undefined
      ? options.trustedForwardedHosts
      : process.env.TRUSTED_FORWARDED_HOSTS,
  );
  const nodeEnv = options?.nodeEnv !== undefined ? options.nodeEnv : process.env.NODE_ENV;

  const useForwarded =
    forwardedHost !== null && isForwardedHostTrusted(forwardedHost, trustedHosts, nodeEnv);

  const host = useForwarded ? forwardedHost : firstValue(headers.get('host'));
  if (!host) return null;

  // Only believe a forwarded protocol from a proxy we already decided to trust.
  const proto = (useForwarded ? firstValue(headers.get('x-forwarded-proto')) : null) || 'https';
  return `${proto}://${host}`;
}

/**
 * Resolve the site base URL, consulting the request origin ONLY when every configured
 * source has missed.
 *
 * Why this exists (SCA-1431): callers used to compute the request origin eagerly and hand
 * it to `getSiteBaseUrl`, which then discarded it in the common case where a canonical URL
 * or env var was set. That cost two things — it read request headers that were never used,
 * which opts a route into dynamic rendering (upstream `cf55f10` flipped /robots.txt from
 * static this way), and it kept a client-controllable value in play on requests where it
 * could not possibly be needed. `resolveRequestOrigin` is a thunk so an unconfigured
 * fallback is the only thing that ever awaits `headers()`.
 */
export async function resolveSiteBaseUrl(options: {
  globalCanonicalUrl?: string | null;
  primaryDomainUrl?: string | null;
  resolveRequestOrigin: () => Promise<string | null>;
}): Promise<string | null> {
  const configured = getSiteBaseUrl({
    globalCanonicalUrl: options.globalCanonicalUrl,
    primaryDomainUrl: options.primaryDomainUrl,
  });
  if (configured) return configured;

  return getSiteBaseUrl({ requestOrigin: await options.resolveRequestOrigin() });
}

/**
 * Join a base URL with a page path into an absolute URL.
 * Returns the base (without trailing slash) for the homepage path.
 */
export function buildAbsolutePageUrl(baseUrl: string, pagePath: string): string {
  const base = baseUrl.replace(/\/$/, '');
  if (pagePath === '/' || pagePath === '') {
    return base;
  }
  return `${base}${pagePath.startsWith('/') ? pagePath : '/' + pagePath}`;
}

/**
 * Prefix a relative URL (e.g. asset proxy path `/a/...`) with the site base URL.
 * Leaves already-absolute or non-root URLs (http, data:, etc.) untouched, and
 * returns the URL as-is when no base URL is available.
 */
export function buildAbsoluteAssetUrl(baseUrl: string | null, url: string | null): string | null {
  if (!url || !baseUrl || !url.startsWith('/')) return url;
  return `${baseUrl.replace(/\/$/, '')}${url}`;
}
