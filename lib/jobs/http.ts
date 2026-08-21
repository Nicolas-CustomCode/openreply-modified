import { NextResponse } from "next/server";

/**
 * Guards the manual trigger endpoints for the scheduled jobs.
 *
 * The jobs themselves are scheduled inside the worker, so these routes exist for
 * running one on demand — checking a token refresh during an incident, say. They
 * still have to be authenticated, because they are public URLs that reach the
 * Instagram Graph API on every connected account.
 */
export function assertCronAuthorized(request: Request): NextResponse | null {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET || process.env.NEXTAUTH_SECRET;

  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  return null;
}
