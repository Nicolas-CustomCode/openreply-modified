/**
 * Client IP resolution for the login rate limiter.
 *
 * `x-forwarded-for` is a list the client can start: anything the caller sends
 * arrives as the leftmost entries, and each proxy in front of us appends the
 * address it actually saw. So the only entries we can trust are the rightmost
 * ones, and exactly how many depends on how many proxies sit in front of this
 * deployment. Reading the *first* entry — the obvious thing to do — hands the
 * attacker full control of the value we rate limit on.
 *
 * TRUSTED_PROXY_HOPS is that proxy count. The default of 1 matches Vercel and
 * any single reverse proxy (nginx, Caddy, Traefik). Behind Cloudflare *and*
 * your own proxy it is 2. Set it to 0 only when nothing rewrites the header,
 * in which case the header is ignored entirely.
 */

/**
 * Returned when no address can be established — a direct connection with no
 * proxy headers, which is the normal case in local development. Callers must
 * treat it as a shared bucket rather than one visitor: every such request
 * collapses into this single key.
 */
export const UNKNOWN_IP = "unknown";

function getTrustedProxyHops(): number {
  const raw = process.env.TRUSTED_PROXY_HOPS;
  if (raw === undefined) return 1;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 1;
  return parsed;
}

type HeaderSource = Headers | { get(name: string): string | null | undefined };

export function getClientIp(headers: HeaderSource): string {
  const hops = getTrustedProxyHops();

  if (hops > 0) {
    const forwarded = headers.get("x-forwarded-for");
    if (forwarded) {
      const entries = forwarded
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
      // Count from the right: entries[length - hops] is the address seen by the
      // outermost proxy we trust. A client that pads the header only grows the
      // left side, which never reaches this index.
      const candidate = entries[entries.length - hops];
      if (candidate) return candidate;
    }

    // x-real-ip is set by the proxy wholesale rather than appended to, so it is
    // only worth reading when we already trust a proxy to be in front of us.
    const realIp = headers.get("x-real-ip")?.trim();
    if (realIp) return realIp;
  }

  return UNKNOWN_IP;
}
