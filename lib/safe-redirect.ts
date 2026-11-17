/**
 * Filters a redirect target that came from user input.
 *
 * `callbackUrl` reaches the login page through the query string, so it is
 * attacker-controlled. Redirecting to it unchecked turns the app into an open
 * redirect: a link to our own domain that lands on someone else's, which is
 * what makes phishing pages look legitimate.
 *
 * Only same-site paths survive. Note that rejecting `//host` and `/\host`
 * matters as much as rejecting `https://host` — browsers read both as
 * protocol-relative URLs and leave the site, even though they look like paths.
 */
export function safeCallbackUrl(
  value: string | undefined | null
): string | null {
  if (!value) return null;
  if (!value.startsWith("/")) return null;
  if (value.startsWith("//") || value.startsWith("/\\")) return null;
  return value;
}
