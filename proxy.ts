import { NextResponse, type NextRequest } from "next/server";

const PROTECTED_PREFIXES = [
  "/dashboard",
  "/automations",
  "/logs",
  "/settings",
  "/comments",
];

function hasSessionCookie(request: NextRequest): boolean {
  return (
    request.cookies.has("authjs.session-token") ||
    request.cookies.has("__Secure-authjs.session-token") ||
    request.cookies.has("next-auth.session-token") ||
    request.cookies.has("__Secure-next-auth.session-token")
  );
}

/**
 * Optimistic only: this can see that a session cookie exists, never that it is
 * still valid. So it may send someone to the login page who turns out to be
 * signed in, but it must never do the reverse and wave someone through.
 *
 * Sending a cookie-holder from /login to /dashboard used to live here, and it
 * deadlocked against the real check. A cookie that no longer decodes — expired,
 * or issued before the session strategy changed — left proxy bouncing the
 * browser to /dashboard while the dashboard layout bounced it back to /login,
 * forever. The authoritative version of that redirect is in app/login/page.tsx,
 * where auth() can tell a live session from a dead cookie.
 */
export function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const isProtected = PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );

  if (isProtected && !hasSessionCookie(request)) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/automations/:path*",
    "/logs/:path*",
    "/settings/:path*",
    "/comments/:path*",
  ],
};
