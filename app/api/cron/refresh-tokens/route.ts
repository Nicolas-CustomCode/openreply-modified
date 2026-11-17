import { NextResponse } from "next/server";
import { assertCronAuthorized } from "@/lib/jobs/http";
import { refreshExpiringTokens } from "@/lib/jobs/refresh-tokens";

/**
 * Manual trigger. The scheduled run lives in the worker
 * (see lib/queue/scheduled-jobs.ts).
 */
export async function GET(request: Request) {
  const unauthorized = assertCronAuthorized(request);
  if (unauthorized) return unauthorized;

  const data = await refreshExpiringTokens();
  return NextResponse.json({ success: true, data });
}
